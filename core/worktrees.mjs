// worktree（git worktree）の台帳・作成・片付け（docs/design.md「worktree」、ADR 0089）。
//
//   - 作るのは、人が明示したときか委譲で isolate: true が指定されたときだけ（判定は core/server.mjs）。画面から任意のパスを受けない:
//     置き場は <リポジトリの親>/<リポジトリ名>.pleiad/<短い id>、ブランチは pleiad/<短い id>、ベースは今の HEAD。依存（node_modules など）は張らない
//   - 台帳（<データ置き場>/worktrees.json）に「作成中」を書いてから作り、途中で落ちたら巻き戻す（起動時に reconcile で台帳と git worktree list を突き合わせる）
//   - 片付け（settle）: 変更なし → 消す / 元のブランチへ取り込み済み → 消す / 未取り込み → 残す。状態が分からない・使っているものがある → 消さない。
//     消す前に中の ReparsePoint（ジャンクション・シンボリックリンク）を全部列挙してリンクだけを外し（リンク先を辿らない）、外せなければ中止する。
//     消す前にフォルダーを一時の名前へ rename して戻し、掴まれていない（cwd が中に無い）ことを確かめてから git を呼ぶ。
//     Windows で掴まれたまま `git worktree remove` を呼ぶと、中身と登録を消してから落ちてフォルダーとブランチだけ残るので、
//     登録が外れていれば続きを自分で消しきる。フォルダーだけ残ったら台帳に leftover の印を付け、settle のたびに消し直す。
//     片付けの失敗（試した回数ごとのエラー）とブランチの残りは <データ置き場>/worktrees.log（追記）と台帳の lastError・removeAttempts に残す。
//     強制の削除（--force・branch -D）は使わない。例外は「退避して消す」だけ（退避の隠し ref を撮って検証した後。archive）
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as git from './git-info.mjs';
import * as wt from './git-worktree.mjs';
import { writeAtomic } from './atomic-file.mjs';

const slash = (p) => String(p ?? '').replaceAll('\\', '/');
const trimEnd = (p) => slash(p).replace(/\/+$/, '');
const fold = (p) => trimEnd(p).toLowerCase();
export const sameDir = (a, b) => Boolean(a) && Boolean(b) && fold(a) === fold(b);
/** dir が parent の中（同じ場所を含む）か */
export const insideDir = (dir, parent) => {
  if (!dir || !parent) return false;
  const d = fold(dir), p = fold(parent);
  return d === p || d.startsWith(`${p}/`);
};

/** 退避を残す期間（隠し ref。ADR 0089） */
export const ARCHIVE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const REMOVE_RETRY_MS = [200, 500, 1000, 2000];
const LINK_WALK_LIMIT_MS = 120_000;
/** 作ったばかりのものを、使われていない（予約の前）と見て自動で消さない時間 */
const NEW_GRACE_MS = 60_000;
/** rename の確かめで使う一時の名前の語尾（落ちても分かるよう、フォルダー名から決まる） */
const PROBE_SUFFIX = '.ply-removing';
/** 片付けの出来事の記録（worktrees.log）の大きさの上限。超えたら新しい半分だけ残す */
const LOG_MAX_BYTES = 64 * 1024;
/** 台帳に残す、消す呼び出し 1 回分のエラーの数 */
const ATTEMPTS_KEEP = 5;

/** 退避の時刻の印（ref の名前に使う。20261003T031500Z） */
export const archiveStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * dir の中の ReparsePoint（Windows のジャンクション・シンボリックリンク。ほかは symlink）を全部列挙する。リンクの先は辿らない。
 * 列挙は dir の中だけ。読めないフォルダーがあれば ok: false（外せないまま消さない）
 */
export async function findLinks(dir, { io = fs, deadline = Date.now() + LINK_WALK_LIMIT_MS } = {}) {
  const links = [];
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return { ok: false, links, error: 'timeout' };
    const cur = stack.pop();
    let entries;
    try { entries = await io.readdir(cur, { withFileTypes: true }); }
    catch (e) { return { ok: false, links, error: `readdir ${cur}: ${e?.code ?? e}` }; }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isSymbolicLink()) { links.push(full); continue; }
      if (entry.isDirectory()) { stack.push(full); continue; }
      // Dirent が種類を返さない FS（まれ）は lstat で確かめる
      if (!entry.isFile()) {
        const st = await io.lstat(full).catch(() => null);
        if (st?.isSymbolicLink()) links.push(full);
        else if (st?.isDirectory()) stack.push(full);
      }
    }
  }
  return { ok: true, links };
}

/** リンクだけを外す（先の中身には触れない）。Windows のジャンクションは unlink か rmdir のどちらかで外れる。外した後に残っていれば失敗 */
export async function removeLink(link, { io = fs } = {}) {
  try { await io.unlink(link); }
  catch (e) {
    if (!['EPERM', 'EISDIR', 'EACCES', 'ENOTDIR'].includes(e?.code)) throw e;
    await io.rmdir(link);
  }
  const left = await io.lstat(link).then(() => true, () => false);
  if (left) throw Object.assign(new Error(`link still exists: ${link}`), { code: 'ELINKLEFT' });
}

/** dir の中のリンクを全部外す。外せなければ ok: false（呼び出し側は消さずに中止する） */
export async function unlinkAll(dir, opts = {}) {
  const found = await findLinks(dir, opts);
  if (!found.ok) return { ok: false, error: found.error, removed: [] };
  const removed = [];
  for (const link of found.links) {
    try { await removeLink(link, opts); removed.push(link); }
    catch (e) { return { ok: false, error: `unlink ${link}: ${e?.code ?? e}`, removed }; }
  }
  return { ok: true, removed };
}

/** 画面・エージェントへ返す形（台帳の中の秘密は無いが、内部の状態は出さない） */
export const publicEntry = (e) => ({
  id: e.id, branch: e.branch, path: e.path, origin: e.origin, root: e.root, baseBranch: e.baseBranch ?? null, purpose: e.purpose,
  sessionId: e.sessionId ?? null, parentSessionId: e.parentSessionId ?? null, taskId: e.taskId ?? null, createdAt: e.createdAt, kept: Boolean(e.kept), state: e.state,
});

/**
 * @param {object} o
 * @param {string} o.dataDir 台帳（worktrees.json）の置き場
 * @param {(entry) => Promise<{ busy: string[], attached: { sessionId: string, kind: string }[] }>} [o.users] 使っているもの。
 *   busy は走っているターン・シェル・委譲の子（あれば消さない）、attached は cwd（予約を含む）がその中の会話
 * @param {(entry, sessionIds: string[]) => Promise<void>} [o.release] 消す前に、会話の cwd を元の場所へ戻す
 * @param {(entry) => Promise<unknown>} [o.unhold] 消す直前に、その中を cwd に持つプロセス（外部 MCP など）を畳む（Windows で cwd が掴まれていると消せない。Issue #142）
 * @param {boolean} [o.disabled] 作らない（create は reason: 'disabled'）。テストのサーバーが開発中のリポジトリに作業場所を残さないため（AGENT_HOST_WORKTREES=off）
 */
export function createWorktrees({ dataDir, users = async () => ({ busy: [], attached: [] }), release = async () => {}, unhold = async () => {}, now = Date.now, io = fs,
  disabled = false, retryMs = REMOVE_RETRY_MS, graceMs = NEW_GRACE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), archiveKeepMs = ARCHIVE_KEEP_MS, log = () => {},
  // 消す git の呼び出し（テストが「掴まれている」を差し込む）
  remove = wt.worktreeRemove, removeForced = wt.worktreeRemoveForced } = {}) {
  const file = path.join(dataDir, 'worktrees.json');
  const logFile = path.join(dataDir, 'worktrees.log');
  let entries = null;          // id -> entry
  let chain = Promise.resolve();
  const busyIds = new Set();   // 作成・片付けの途中の id（同じものを二重に動かさない）

  /** 台帳の読み書きを 1 本に並べる */
  const serial = (work) => { const next = chain.then(work, work); chain = next.catch(() => {}); return next; };
  async function load() {
    if (entries) return entries;
    try {
      const v = JSON.parse(await io.readFile(file, 'utf8'));
      entries = v && typeof v === 'object' && v.entries && typeof v.entries === 'object' ? v.entries : {};
    } catch { entries = {}; }
    return entries;
  }
  async function save() {
    await io.mkdir(dataDir, { recursive: true });
    await writeAtomic(file, JSON.stringify({ version: 1, entries }, null, 2), { io });
  }
  const mutate = (fn) => serial(async () => { await load(); const r = await fn(entries); await save(); return r; });

  /** 台帳の形が Pleiad の決めたもの（置き場・ブランチ）か。外れていれば消す操作はしない */
  function owned(e) {
    if (!e || !/^ply-[0-9a-f]{4,12}$/.test(e.id ?? '') || e.branch !== `pleiad/${e.id}` || !e.repoDir || !e.path) return false;
    return sameDir(e.path, `${path.dirname(slash(e.repoDir))}/${path.basename(slash(e.repoDir))}.pleiad/${e.id}`);
  }

  async function exists(p) { return (await io.stat(p).catch(() => null))?.isDirectory() === true; }
  /** worktree の直下に .git（ファイルかフォルダー）があるか。git は消しにかかるとき先にこれを消すので、無ければ半分消えた形の印 */
  async function hasGitDir(dir) { return (await io.stat(path.join(dir, '.git')).catch(() => null)) != null; }

  /** 片付けの出来事をデータ置き場のログに残す（追記だけ。失敗しても止めない） */
  async function writeLog(event) {
    try {
      await io.mkdir(dataDir, { recursive: true });
      await io.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      const st = await io.stat(logFile).catch(() => null);
      if (st && st.size > LOG_MAX_BYTES) {
        const text = await io.readFile(logFile, 'utf8');
        const cut = text.indexOf('\n', Math.ceil(text.length / 2));
        await io.writeFile(logFile, cut >= 0 ? text.slice(cut + 1) : '');
      }
    } catch { /* 記録の失敗で片付けは止めない */ }
  }

  const probeName = (dir) => `${trimEnd(dir)}${PROBE_SUFFIX}`;

  /**
   * git を呼ぶ前の確かめ: フォルダーを一時の名前へ rename して戻す。
   * Windows は cwd（またはその下のフォルダー）を掴んでいるプロセスがあると rename が失敗する（EBUSY・EPERM）。
   * git は掴まれたまま呼ぶと中身と登録を消してから落ちるので、消せないことを先に確かめる。
   * 戻せなければ busy + moved（一時名はフォルダー名から決まるので、次の機会に restoreProbe が戻す）
   */
  async function probeMovable(dir) {
    const tmp = probeName(dir);
    try { await io.rename(dir, tmp); }
    catch (e) {
      if (e?.code === 'ENOENT') return { ok: true };
      return { ok: false, busy: true, error: `probe: ${e?.code ?? e}` };
    }
    let last = null;
    for (let i = 0; i < 10; i++) {
      try { await io.rename(tmp, dir); return { ok: true }; }
      catch (e) { last = e; await sleep(30); }
    }
    return { ok: false, busy: true, moved: true, error: `probe restore: ${last?.code ?? last}` };
  }

  /** probeMovable で残った一時名を元に戻す（落ちた・戻せなかった次の機会）。戻せなければ busy。残っていなければ ok */
  async function restoreProbe(entry) {
    const tmp = probeName(entry.path);
    if (await exists(entry.path)) { await io.rmdir(tmp).catch(() => {}); return { ok: true }; }
    if (!await exists(tmp)) return { ok: true };
    try { await io.rename(tmp, entry.path); return { ok: true }; }
    catch (e) { return { ok: false, busy: true, error: `probe restore: ${e?.code ?? e}` }; }
  }

  /** ブランチの取り込み先として確かめるコミット（ベースのブランチの先頭 → ルートの HEAD → ベース。消えたものの台帳・ブランチを片付けるときに使う） */
  async function containerFor(entry) {
    return (entry.baseBranch ? await wt.branchTip(entry.root, entry.baseBranch) : null) ?? (await git.headCommit(entry.root)) ?? entry.base ?? null;
  }

  /**
   * 登録が外れた後の続き: リンクを外し、残りを消し、ブランチと台帳を片付ける（登録だけ外れた形を最後まで片付ける）。
   * フォルダーが残ったら（また掴まれた）台帳に leftover の印を付け、次の settle・sweep で消し直す
   */
  async function cleanupLeftovers(entry, container) {
    await unlinkAll(entry.path, { io }).catch(() => {});
    await io.rm(entry.path, { recursive: true, force: true }).catch(() => {});
    if (await exists(entry.path)) {
      await finishRemoval(entry, container, { keepEntry: true });
      await setState(entry.id, 'ready', { leftover: 'folder' });
      await writeLog({ ev: 'leftover', id: entry.id });
      return { action: 'kept', why: 'leftover' };
    }
    return finishRemoval(entry, container);
  }

  // ---------------------------------------------------------------- 作る

  /**
   * cwd の Git ルートから、今の HEAD で worktree を作る。失敗は { ok: false, reason }（reason: not-git / no-commits / git / disabled）。
   * purpose: 'conversation'（人が分けた会話）か 'task'（委譲の子）。sessionId は使う会話、parentSessionId は取り込みを頼む相手（子なら依頼元）。
   * nested: worktree の中からも作る（worktree の中で動く依頼元が子を分けるとき）
   */
  async function create({ cwd, sessionId = null, parentSessionId = null, taskId = null, purpose = 'conversation', nested = false, from = null }) {
    if (disabled) return { ok: false, reason: 'disabled' };
    const info = await git.repoInfo(cwd);
    if (!info) return { ok: false, reason: 'not-git' };
    await load();
    if (!nested && Object.values(entries).some((e) => insideDir(info.root, e.path))) return { ok: false, reason: 'already-split' };
    const head = from?.startPoint ?? await git.headCommit(info.root);
    if (!head) return { ok: false, reason: 'no-commits' };
    const status = await git.readGit(info.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']);
    const parsed = status.ok ? git.parseStatus(status.stdout) : null;
    const repoDir = path.basename(info.commonDir) === '.git' ? path.dirname(info.commonDir) : info.root;
    const parent = `${path.dirname(slash(repoDir))}/${path.basename(slash(repoDir))}.pleiad`;
    // Git が返すルートは実体のパスなので、cwd が 8.3 の短い名前（RUNNER~1 など）だとルートの外に見える。
    // そのときだけ実体のパスで比べ直す（origin は利用者が開いた形のまま残す）
    const subOf = (p) => trimEnd(path.relative(info.root, p) ?? '');
    const within = (s) => !s.startsWith('..') && !path.isAbsolute(s);
    let sub = subOf(cwd);
    if (!within(sub)) {
      const real = await io.realpath(cwd).catch(() => null);
      if (real) sub = subOf(real);
    }
    let id = null;
    for (let i = 0; i < 30 && !id; i++) {
      const pick = `ply-${crypto.randomBytes(2).toString('hex')}`;
      if (entries[pick] || await exists(`${parent}/${pick}`) || await wt.branchTip(info.root, `pleiad/${pick}`)) continue;
      id = pick;
    }
    if (!id) return { ok: false, reason: 'git', error: 'no free id' };
    const entry = { id, state: 'creating', purpose, repoDir: slash(repoDir), root: info.root, origin: slash(cwd), sub: within(sub) ? sub : '',
      path: `${parent}/${id}`, branch: `pleiad/${id}`, base: from?.base ?? head, baseBranch: from ? from.baseBranch ?? null : parsed?.branch ?? null,
      sessionId, parentSessionId, taskId, createdAt: now(), kept: false };
    busyIds.add(id);
    try {
      await mutate((all) => { all[id] = entry; });
      try { await io.mkdir(parent, { recursive: true }); } catch (e) { await rollbackCreating(entry); return { ok: false, reason: 'git', error: String(e?.message ?? e) }; }
      const added = await wt.worktreeAdd(info.root, { path: entry.path, branch: entry.branch, startPoint: head });
      if (!added.ok) { await rollbackCreating(entry); return { ok: false, reason: 'git', error: added.error }; }
      await mutate(() => { entry.state = 'ready'; });
      log(`worktree created ${id}`);
      return { ok: true, entry: { ...entry } };
    } catch (e) {
      await rollbackCreating(entry).catch(() => {});
      return { ok: false, reason: 'git', error: String(e?.message ?? e) };
    } finally { busyIds.delete(id); }
  }

  /** 作成の途中で落ちた・失敗したものを、何も残さず戻す（フォルダー・登録・ブランチ・台帳） */
  async function rollbackCreating(entry) {
    if (owned(entry)) {
      const removed = await wt.worktreeRemove(entry.root, entry.path);
      if (!removed.ok && await exists(entry.path)) {
        // 作ったばかりのチェックアウトの途中。中は git が書いたものだけなので、リンクを外してから消す
        const links = await unlinkAll(entry.path, { io });
        if (links.ok) await io.rm(entry.path, { recursive: true, force: true }).catch(() => {});
      }
      await wt.worktreePrune(entry.root);
      const tip = await wt.branchTip(entry.root, entry.branch);
      if (tip === entry.base && !await wt.branchDelete(entry.root, entry.branch)) await wt.branchDeleteContained(entry.root, entry.branch, tip, tip);
    }
    await mutate((all) => { delete all[entry.id]; });
    await io.rmdir(path.dirname(entry.path)).catch(() => {});
  }

  // ---------------------------------------------------------------- 状態

  /**
   * 状態。{ exists, ok, dirty（未コミット・未追跡のファイル数）, ahead（ベースからの新しいコミット）, merged, tip, files（ベースとの差のファイル数。files: true のとき）, at }
   * ok: false は分からない（git が応答しない・壊れている）
   */
  async function inspect(entry, { files = false } = {}) {
    if (!await exists(entry.path)) return { exists: false, ok: true, dirty: 0, ahead: 0, merged: false, tip: null };
    // 互いに依らない git の呼び出しは並べて走らせる（右パネルを開いたときの待ちを縮める。1 回が数十 ms かかる）
    const [status, tip] = await Promise.all([git.readStatus(entry.path), git.headCommit(entry.path)]);
    if (!status || !tip) return { exists: true, ok: false };
    const [ahead, baseTip, rootHead] = await Promise.all([wt.countCommits(entry.root, entry.base, tip),
      entry.baseBranch ? wt.branchTip(entry.root, entry.baseBranch) : null, git.headCommit(entry.root)]);
    if (ahead == null) return { exists: true, ok: false };
    let merged = ahead === 0;
    if (!merged) {
      const targets = [baseTip, rootHead].filter(Boolean);
      merged = (await Promise.all(targets.map((target) => wt.isAncestor(entry.root, tip, target)))).some((r) => r === true);
    }
    const out = { exists: true, ok: true, dirty: status.dirty, ahead, merged, tip, branch: status.branch, at: entry.createdAt };
    if (!(out.dirty === 0 && merged)) {
      const [last, tree] = await Promise.all([ahead > 0 ? git.readGit(entry.root, ['log', '-1', '--format=%ct', tip]) : null, files ? git.snapshotTree(entry.path) : null]);
      if (last) {
        const ms = Number(last.stdout.trim()) * 1000;
        if (last.ok && Number.isFinite(ms)) out.at = Math.max(out.at, ms);
      }
      if (files) {
        const diff = tree ? await git.diffFiles(entry.root, entry.base, tree) : null;
        out.files = diff ? diff.total.files : status.dirty;
        out.fileList = diff ? diff.files.slice(0, 30).map((f) => f.path) : [];
      }
    }
    return out;
  }

  /** 'empty'（変更なし）/ 'merged'（取り込み済み）/ 'unmerged'（残す）/ 'unknown'（分からない）/ 'missing'（フォルダーが無い） */
  function classify(info) {
    if (!info.exists) return 'missing';
    if (!info.ok) return 'unknown';
    if (info.dirty === 0 && info.ahead === 0) return 'empty';
    if (info.dirty === 0 && info.merged) return 'merged';
    return 'unmerged';
  }

  // ---------------------------------------------------------------- 消す

  /** 消す前の最後の確かめ。使っているもの（走っているターン・シェル・委譲の子）があれば止める。releasing 以外の会話が居ても止める */
  async function guard(entry, releasing) {
    const u = await users(entry).catch(() => null);
    if (!u) return 'unknown';
    if (u.busy.length) return 'busy';
    if (u.attached.some((a) => !releasing.includes(a.sessionId))) return 'attached';
    return null;
  }

  const setState = (id, state, extra = {}) => mutate((all) => { if (all[id]) Object.assign(all[id], { state }, extra); });

  /** worktree remove をやり直し付きで。busy（掴まれている）は数回待つ */
  async function removeWithRetry(entry, doRemove) {
    let last = null;
    for (let attempt = 0; ; attempt++) {
      last = await doRemove(entry.root, entry.path);
      if (last.ok || !last.busy || attempt >= retryMs.length) return last;
      await sleep(retryMs[attempt]);
    }
  }

  /** 消した後の片付け: 登録の掃除・ブランチ・台帳・空になった置き場。keepEntry はフォルダーが残ったとき（台帳に leftover の印を付けて消し直す分） */
  async function finishRemoval(entry, container = null, { keepEntry = false } = {}) {
    await wt.worktreePrune(entry.root);
    const tip = await wt.branchTip(entry.root, entry.branch);
    let branchLeft = false;
    if (tip) {
      const ok = (await wt.branchDelete(entry.root, entry.branch)) || (container && await wt.branchDeleteContained(entry.root, entry.branch, tip, container));
      branchLeft = !ok;
      if (branchLeft) await writeLog({ ev: 'branch-left', id: entry.id, branch: entry.branch, tip, container });
    }
    if (!keepEntry) await mutate((all) => { delete all[entry.id]; });
    await io.rmdir(path.dirname(entry.path)).catch(() => {});
    log(`worktree removed ${entry.id}`);
    return { action: 'removed', branchLeft };
  }

  /**
   * 消す。kind は classify の結果（'empty' | 'merged'）。archive は退避の撮影の結果（退避して消すとき）。
   * 戻り: { action: 'removed' | 'kept' | 'failed', why? }。失敗したら台帳は ready に戻し、フォルダーはそのまま
   */
  async function removeEntry(entry, { kind, release: releasing = [], archived = null }) {
    if (!owned(entry)) return { action: 'kept', why: 'unowned' };
    const attempts = [];
    const revert = async (why, error) => {
      await setState(entry.id, 'ready', { ...(error ? { lastError: String(error).slice(0, 300) } : {}), ...(attempts.length ? { removeAttempts: attempts.slice(-ATTEMPTS_KEEP) } : {}) });
      if (error || attempts.length) await writeLog({ ev: 'remove-failed', id: entry.id, why, error: error ?? null, attempts });
      return { action: 'failed', why, ...(error ? { error } : {}) };
    };
    await setState(entry.id, 'removing');
    const g = await guard(entry, releasing);
    if (g) { await setState(entry.id, 'ready'); return { action: 'kept', why: g }; }
    // 前の回の rename の確かめで残った一時名を先に戻す（戻せなければまだ掴まれている）
    const restored = await restoreProbe(entry);
    if (!restored.ok) { await setState(entry.id, 'ready'); return { action: 'kept', why: 'busy' }; }
    const links = await unlinkAll(entry.path, { io });
    if (!links.ok) return revert('links', links.error);
    if (releasing.length) await release(entry, releasing).catch(() => {});
    // 消す直前に、その中を cwd に持つもの（warm に残った MCP・保持役の子・Pleiad が起こした子と子孫）を畳む。畳めなくても消すのを止めない（probe が掴まれたことを見る）
    await unhold(entry).catch(() => {});
    const doRemove = async (root, dir) => {
      // git は掴まれたまま呼ぶと中身と登録を消してから落ちる（Windows）。先に rename で消せるか確かめ、掴まれていれば git を呼ばない
      const again = await restoreProbe(entry);
      if (!again.ok) { attempts.push(again.error); return { ok: false, busy: true, error: again.error }; }
      const probe = await probeMovable(dir);
      if (!probe.ok) { attempts.push(probe.error); return { ok: false, busy: true, error: probe.error }; }
      const r = await (archived ? removeForced : remove)(root, dir);
      if (!r.ok) attempts.push(String(r.error ?? '').slice(0, 300));
      return r;
    };
    const removed = await removeWithRetry(entry, doRemove);
    let container = archived?.commit ?? null;
    if (!container && kind === 'merged') container = await containerFor(entry);
    if (!container && kind === 'empty') container = entry.base;
    if (removed.ok) return finishRemoval(entry, container);
    // git が中身と登録を消してから落ちた形を拾う: 登録が外れ、直下の .git も無い（git は消しにかかるとき先に .git を消す）なら、
    // 失敗にせず残りを自分で消しきる。.git が残るなら登録だけ失われた無傷の作業場所かもしれないので触らない
    const list = await wt.worktreeList(entry.root);
    if (!list || list.some((w) => sameDir(w.path, entry.path)) || await hasGitDir(entry.path)) return revert(removed.busy ? 'busy' : 'git', removed.error);
    await writeLog({ ev: 'half-removed', id: entry.id, error: removed.error ?? null, attempts });
    return cleanupLeftovers(entry, container);
  }

  /**
   * 片付け。状態を見て、変更なし・取り込み済みなら消し、未取り込み・分からない・使っているものがあれば残す。
   * release: 消してよい会話（その cwd を元の場所へ戻してから消す。委譲の子が終わったとき・人が元の場所へ戻したとき）
   * 戻り: { action: 'removed' | 'kept' | 'failed' | 'skip', kind?, why?, info? }
   */
  async function settle(id, { release: releasing = [] } = {}) {
    await load();
    const entry = entries[id];
    if (!entry || entry.state !== 'ready' || busyIds.has(id)) return { action: 'skip' };
    busyIds.add(id);
    try {
      // フォルダーだけ残ったもの（登録は外れている）を消し直す
      if (entry.leftover === 'folder') {
        if (entry.kept) return { action: 'kept', why: 'kept' };
        const g = await guard(entry, releasing);
        if (g) return { action: 'kept', why: g };
        return cleanupLeftovers(entry, await containerFor(entry));
      }
      // 前の回の rename の確かめで残った一時名を先に戻す
      const restored = await restoreProbe(entry);
      if (!restored.ok) return { action: 'kept', why: 'busy' };
      const g = await guard(entry, releasing);
      if (g) return { action: 'kept', why: g };
      const info = await inspect(entry);
      const kind = classify(info);
      if (kind === 'missing') {
        if (!owned(entry)) return { action: 'kept', why: 'unowned' };
        await finishRemoval(entry, await containerFor(entry)).catch(() => {});
        return { action: 'removed', kind };
      }
      if (kind === 'unknown' && owned(entry)) {
        // git が中身と登録を消してから落ちた形（半分消えた）なら、続きを自分で消しきる。
        // 直下に .git が残るものは登録だけ失われた無傷の作業場所かもしれない（元のリポジトリの clone し直しなど）ので残す
        const list = await wt.worktreeList(entry.root);
        if (list && !list.some((w) => sameDir(w.path, entry.path)) && !await hasGitDir(entry.path)) return cleanupLeftovers(entry, await containerFor(entry));
      }
      if (kind !== 'empty' && kind !== 'merged') return { action: 'kept', kind, info };
      const result = await removeEntry(entry, { kind, release: releasing });
      return { ...result, kind };
    } finally { busyIds.delete(id); }
  }

  /**
   * 退避して消す。作業ツリー全体（未追跡を含む。.gitignore のものは含めない）を隠し ref（refs/pleiad/archive/<id>/<時刻>）に撮り、
   * 撮り直した tree が同じことを確かめてから消す（撮影のあとに変わっていたら消さない）。使っているものがあれば消さない
   */
  async function archive(id, { release: releasing = [] } = {}) {
    await load();
    const entry = entries[id];
    if (!entry || entry.state !== 'ready' || busyIds.has(id)) return { action: 'skip' };
    if (!owned(entry)) return { action: 'kept', why: 'unowned' };
    busyIds.add(id);
    try {
      const g = await guard(entry, releasing);
      if (g) return { action: 'kept', why: g };
      if (!await exists(entry.path)) return { action: 'failed', why: 'missing' };
      const shot = await wt.archiveWorktree(entry.path, entry.root, entry.id, archiveStamp(now()),
        { id: entry.id, base: entry.base, baseBranch: entry.baseBranch, origin: entry.origin, purpose: entry.purpose, sessionId: entry.sessionId, parentSessionId: entry.parentSessionId, taskId: entry.taskId });
      if (!shot) return { action: 'failed', why: 'archive' };
      const [again, archivedTree] = await Promise.all([git.snapshotTree(entry.path), wt.treeOf(entry.root, shot.commit)]);
      if (!again || again !== archivedTree) return { action: 'failed', why: 'changed' };
      const result = await removeEntry(entry, { kind: 'archived', release: releasing, archived: shot });
      return { ...result, ref: shot.ref };
    } finally { busyIds.delete(id); }
  }

  // ---------------------------------------------------------------- 台帳と git の突き合わせ

  /**
   * 起動時の突き合わせ。作成中のまま残ったものは巻き戻し、片付けの途中で落ちたものは終わらせる（フォルダーが無ければ登録とブランチを外し、
   * あれば通常の状態に戻す）。フォルダーも登録も無いものは台帳から外す。リポジトリが読めない（ドライブが外れている）ものは触らない
   */
  async function reconcile() {
    await load();
    const report = { rolledBack: [], finished: [], dropped: [], restored: [] };
    for (const entry of Object.values(entries)) {
      if (!owned(entry)) continue;
      const rootOk = await exists(entry.root);
      if (!rootOk) continue;
      const list = await wt.worktreeList(entry.root);
      if (!list) continue;
      const dir = await exists(entry.path);
      const registered = list.some((w) => sameDir(w.path, entry.path));
      if (entry.state === 'creating') { await rollbackCreating(entry); report.rolledBack.push(entry.id); continue; }
      if (entry.state === 'removing') {
        // 片付けの途中で落ちた。rename の確かめで残った一時名を先に戻してから、フォルダーの有無で終わらせるか戻すか決める
        const restored = await restoreProbe(entry);
        if (restored.ok && !await exists(entry.path)) { await finishRemoval(entry, await containerFor(entry)); report.finished.push(entry.id); }
        else { await setState(entry.id, 'ready'); report.restored.push(entry.id); }
        continue;
      }
      if (!dir) {
        await finishRemoval(entry, await containerFor(entry));
        report.dropped.push(entry.id);
      } else if (!registered) {
        if (entry.leftover === 'folder') {
          // 前の回でフォルダーだけ残った（自分が付けた印。登録は外れている）→ 消し直す
          const r = await cleanupLeftovers(entry, await containerFor(entry));
          if (r.action === 'removed') report.dropped.push(entry.id);
          continue;
        }
        // フォルダーはあるのに git が知らない（登録だけ外れた）。ブランチと台帳は container で片付けるが、
        // 中身は利用者のものかもしれないので触らない（空なら置き場ごと畳む）。半分消えた残りは settle の側で消しきる
        await finishRemoval(entry, await containerFor(entry));
        const names = await io.readdir(entry.path).catch(() => null);
        if (names && names.length === 0) await io.rmdir(entry.path).catch(() => {});
        report.dropped.push(entry.id);
      }
    }
    return report;
  }

  /**
   * 全部の片付け（使っているものは残る）。起動の後・ターンの終わり・パネルを開いたときに呼ぶ。
   * root はその作業場所から作ったものだけ、repoDir はそのリポジトリ（同じ .git）から作ったものだけ（パネルを開いたときは、開いたリポジトリだけ）
   */
  async function sweep({ root = null, repoDir = null } = {}) {
    await load();
    const out = [];
    const inScope = (e) => (!root || sameDir(e.root, root)) && (!repoDir || sameDir(e.repoDir, repoDir));
    for (const entry of Object.values(entries)) {
      if (entry.state !== 'ready' || entry.kept || !inScope(entry) || now() - entry.createdAt < graceMs) continue;
      out.push({ id: entry.id, ...(await settle(entry.id)) });
    }
    const roots = new Set(Object.values(entries).filter((e) => e.state === 'ready' && inScope(e)).map((e) => e.root));
    for (const r of roots) wt.pruneArchiveRefs(r, archiveKeepMs, now()).catch(() => {});
    return out;
  }

  return {
    create, inspect, classify, settle, archive, reconcile, sweep, owned,
    async list() { await load(); return Object.values(entries).map((e) => ({ ...e })); },
    async get(id) { await load(); return entries[id] ? { ...entries[id] } : null; },
    /** パスが台帳の worktree の中なら、その入口。作成・片付けの途中のものも返す */
    async byPath(p) { await load(); return Object.values(entries).map((e) => ({ ...e })).find((e) => insideDir(p, e.path)) ?? null; },
    /** 台帳にある id（読み込み済みのときだけ。画面の「未取り込み」の印に使う。同期） */
    ids() { return entries ? Object.values(entries).filter((e) => e.state !== 'creating').map((e) => ({ id: e.id, kept: Boolean(e.kept) })) : []; },
    /** パスが台帳の worktree の中なら、その入口（同期。読み込み済みのときだけ。一覧の行の印に使う） */
    lookup(p) { return entries ? Object.values(entries).find((e) => e.state !== 'creating' && insideDir(p, e.path)) ?? null : null; },
    /** 台帳のパス（ファイルのプレビューの基準。読み取りの許可には使わない。ADR 0050） */
    paths() { return entries ? Object.values(entries).map((e) => e.path) : []; },
    /** 会話が使う作業場所（分けた場所の中の、元の cwd と同じサブフォルダー） */
    cwdOf(entry) { return entry.sub ? `${entry.path}/${entry.sub}` : entry.path; },
    /** 「残す」を押した／戻した */
    async keep(id, kept = true) { await mutate((all) => { if (all[id]) all[id].kept = Boolean(kept); }); },
    /** 取り込みを頼む相手など、台帳の項目の更新（owner のみ） */
    async update(id, patch) { await mutate((all) => { if (all[id]) for (const k of ['sessionId', 'parentSessionId', 'taskId', 'purpose']) if (k in patch) all[id][k] = patch[k]; }); },
    /** 作成・片付けの途中か */
    isBusy: (id) => busyIds.has(id),
  };
}
