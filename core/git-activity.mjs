// 会話ごとの git の動き（docs/design.md「git の動き」、ADR 0085・0354）。サーバーが 1 つ持つ。
//
//   - 状態（ブランチ・ahead/behind・変更の数）: cwd ごとに短い TTL のキャッシュ。取り直しは呼び出し側が決める
//   - パネル用の変更の一覧（コミットしていない変更）・差分・コミットの履歴（開いたときだけ）
//   - 撮影をやめた後に残っている隠し ref（refs/pleiad/turn/…）の片付け（作業場所を初めて読んだとき 1 回。ADR 0354）
// ターンの始まりと終わりの撮影（ADR 0085 の決定 2・3・6）は、ADR 0354 でやめた。
// 会話ごとに直列化する。git が無い・git 管理外は、どの口も null（画面は「情報なし」）。
import * as git from './git-info.mjs';
import * as history from './git-history.mjs';

const TTL_MS = 2_000;
// 片付けが読めなかった（遅い場所で止まっている・git が断った）ときの、次に試すまでの間。止まっている場所は見張りが止めるので、ここは普通の失敗用
const TIDY_RETRY_MS = 60_000;
const EMPTY_TREE = git.EMPTY_TREE;

export function createGitActivity({ now = Date.now } = {}) {
  const chains = new Map();
  /** 同じ鍵の仕事を順に走らせる（会話ごと。鍵の無いものは cwd） */
  function serial(key, work) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }
  const cache = new Map();      // cwd → { at（読み終えた時刻）, value }
  const lastGood = new Map();   // 場所 → 最後に読めた状態（場所が BUSY・REST のとき、これを返す）

  // ------------------------------------------------------------ 隠し ref の片付け（1 回だけ）

  const tidied = new Set();     // 片付けが済んだ根（この起動の間。もう無いと分かったものも）
  const tidyTried = new Map();  // 根 → 最後に試した時刻（読めなかったときの、やり直しの間隔）
  /**
   * 撮影をやめた後に残っている refs/pleiad/turn/ の ref を、リポジトリごとに 1 回だけ消す。呼び出し元は待たない（結果を返さない）。
   * 触るのは refs/pleiad/turn/ の ref だけ（ブランチ・index・作業ツリーには触れない。git-info の writeGit が refs/pleiad/ 以外の update-ref を断る）。
   * 他の git と同じ見張りに乗る: 同じ場所の片付けは 1 本ずつ（合流）、場所が BUSY・REST のときは起こさない・止めても終われない子は数える。
   * ただし片付けの時間切れは休みに数えない（数千本を数百本ずつ消すので、長い上限を使う。git-info の dropTurnRefs）。
   * 読めなかった・消せなかった・途中までのときは済みにせず、TIDY_RETRY_MS あけて次の読み取りでやり直す（残りだけから続く）
   */
  function tidy(root) {
    if (!root || tidied.has(root)) return;
    const last = tidyTried.get(root);
    if (last != null && now() - last < TIDY_RETRY_MS) return;
    if (git.placeBlocked(root)) return;
    tidyTried.set(root, now());
    git.placeGuard.coalesce(`tidy:${git.placeGuard.placeOf(root)}`, async () => {
      const removed = await git.dropTurnRefs(root);
      if (removed != null) { tidied.add(root); tidyTried.delete(root); }
    }, { mode: 'join' }).catch(() => {});
  }

  /**
   * 状態。fresh でなければ TTL（読み終えた時刻から）内の前回の値を返す。git 管理外は null。
   * 同じリポジトリの取り直しは 1 本ずつ: fresh でなければ走っているものに合流し、fresh は走っているものの次の 1 回を共有する
   * （走り始めた後に頼まれた fresh に、前の結果は渡さない）。場所が BUSY・REST（遅いファイルシステムで止まっている）のときは、
   * 読み直さず、前に読めた値を返す（無ければ null）
   */
  function status(cwd, { fresh = false } = {}) {
    if (!cwd) return Promise.resolve(null);
    const hit = cache.get(cwd);
    if (!fresh && hit && now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
    const key = `status:${git.placeGuard.placeOf(cwd)}`;
    return git.placeGuard.coalesce(key, async () => {
      const s = await git.readStatus(cwd);
      const place = git.placeGuard.placeOf(cwd);
      if (s) {
        const value = { ...s, at: now() };
        lastGood.set(place, value);
        return value;
      }
      return git.placeBlocked(cwd) ? lastGood.get(place) ?? null : null;
    }, { mode: fresh ? 'trailing' : 'join' }).then((value) => {
      // 失敗（null）・前の値を返したものは覚えない。git の出入りがすぐ反映されるように
      if (value && value.at >= now() - TTL_MS && !git.placeBlocked(cwd)) cache.set(cwd, { at: now(), value }); else cache.delete(cwd);
      if (value?.root) tidy(value.root);
      return value;
    });
  }
  const invalidate = (cwd) => { if (cwd) cache.delete(cwd); else cache.clear(); };

  // ------------------------------------------------------------ パネル

  /**
   * パネルの変更の一覧（コミットしていない変更。HEAD と今の作業ツリー）。
   * groups = { staged, work }（ステージ済みと変更。ファイルは名前の変更も見つける）も返し、files の各行に staged / unstaged の印を付ける。
   * sessionId は直列にする単位（会話ごと）だけに使う
   */
  function changes(cwd, sessionId) {
    return serial(`session:${sessionId ?? cwd}`, async () => {
      const info = await git.repoInfo(cwd);
      if (!info) return null;
      tidy(info.root);
      const head = await git.headCommit(info.root);
      const failed = { range: 'uncommitted', files: [], total: { files: 0, add: 0, del: 0 }, failed: true };
      const groups = await history.uncommittedGroups(info.root);
      if (!groups?.tree) return failed;
      const diff = await git.diffFiles(info.root, head ?? EMPTY_TREE, groups.tree);
      if (!diff) return failed;
      const stagedPaths = new Set(groups.staged.flatMap((f) => [f.path, f.orig].filter(Boolean)));
      const workPaths = new Set(groups.work.flatMap((f) => [f.path, f.orig].filter(Boolean)));
      const files = diff.files.map((f) => ({ ...f, ...(stagedPaths.has(f.path) ? { staged: true } : {}), ...(workPaths.has(f.path) ? { unstaged: true } : {}) }));
      return { range: 'uncommitted', files, total: diff.total, groups: { staged: groups.staged, work: groups.work } };
    });
  }

  /**
   * 新しいタブの「変更 N ファイル」の N だけを軽く数える。変更のページと同じ定義（HEAD と今の作業ツリーの差のファイル数。
   * 未追跡を含み、.gitignore は守る）で、撮影 → 名前だけの差の 2 手で済む（行数・ステージの内訳・2 回目の差を読まない）。
   * 撮影は一時 index の上なので、変更のページの問い合わせ（会話ごとの直列）を待たせず、待たされもしない。git 管理外・失敗は null
   */
  const counting = new Map();   // 作業ツリーの根 → 進行中の数え（同じ根への問い合わせは 1 回の撮影を共有する）
  async function changeCount(cwd) {
    const info = await git.repoInfo(cwd);
    if (!info) return null;
    tidy(info.root);
    // 新しいタブの描画・refreshNewTabs・複数の会話が重なっても、大きいリポジトリで git add -A（撮影）を並べて走らせない
    const running = counting.get(info.root);
    if (running) return running;
    const run = (async () => {
      const head = await git.headCommit(info.root);
      const tree = await git.snapshotTree(info.root);
      if (!tree) return null;
      return git.countDiffFiles(info.root, head ?? EMPTY_TREE, tree);
    })().finally(() => counting.delete(info.root));
    counting.set(info.root, run);
    return run;
  }

  /** 差分の比べる元と先（tree-ish）。commit・from/to は hash だけ。ステージ済みは HEAD と index、変更は index と作業ツリー */
  async function diffSource(root, { stage, commit, from, to } = {}) {
    if (history.isHash(commit)) {
      const c = await history.resolveCommit(root, commit);
      if (!c) return null;
      const parent = await git.readGit(root, ['rev-parse', '--verify', '-q', `${c}^1`]);
      return { from: parent.ok && parent.stdout.trim() ? parent.stdout.trim() : EMPTY_TREE, to: c, range: 'commit' };
    }
    if (history.isHash(from) && history.isHash(to)) {
      const [a, z] = await Promise.all([history.resolveCommit(root, from), history.resolveCommit(root, to)]);
      return a && z ? { from: a, to: z, range: 'commits' } : null;
    }
    const head = (await git.headCommit(root)) ?? EMPTY_TREE;
    if (stage === 'staged') {
      const index = await git.indexTree(root);
      return index ? { from: head, to: index, range: 'uncommitted', stage } : null;
    }
    if (stage === 'work') {
      const [index, tree] = await Promise.all([git.indexTree(root), git.snapshotTree(root)]);
      return tree ? { from: index ?? head, to: tree, range: 'uncommitted', stage } : null;
    }
    const tree = await git.snapshotTree(root);
    return tree ? { from: head, to: tree, range: 'uncommitted' } : null;
  }

  /**
   * 1 ファイルの統一差分（path はルート相対）。コミットしていない変更が基本で、押したコミット（commit）・2 つのコミットの間（from・to）・
   * ステージ済み／変更の区別（stage）も選べる。orig は名前の変更の元のパス、context は前後の行数。
   * after: true なら、畳んだ「変更なし」の行を開くための差分の後ろ側のファイルの全行（大きい・消えたものは null）も返す
   */
  function diff(cwd, sessionId, file, opts = {}) {
    return serial(`session:${sessionId ?? cwd}`, async () => {
      const info = await git.repoInfo(cwd);
      if (!info || typeof file !== 'string' || !file || file.includes('\0')) return null;
      const src = await diffSource(info.root, opts);
      if (!src) return null;
      const orig = typeof opts.orig === 'string' && opts.orig && !opts.orig.includes('\0') ? opts.orig : null;
      const result = await git.diffFile(info.root, src.from, src.to, file, { orig, context: opts.context });
      if (!result) return null;
      const after = opts.after && !result.binary && !result.truncated ? await git.fileLines(info.root, src.to, file) : null;
      return { range: src.range, ...(src.stage ? { stage: src.stage } : {}), path: file, ...result, ...(opts.after ? { after } : {}) };
    });
  }

  /** コミットの履歴の 1 ページ（グラフ）。git 管理外・読めないときは null */
  async function commits(cwd, { limit, skip } = {}) {
    const info = await git.repoInfo(cwd);
    if (!info) return null;
    tidy(info.root);
    const page = await history.readHistory(info.root, { limit, skip: Math.max(Number(skip) || 0, 0) });
    return page ? { ...page, root: info.root } : null;
  }

  /** コミット 1 つの題・本文と変わったファイル */
  async function commit(cwd, hash) {
    const info = await git.repoInfo(cwd);
    return info ? history.commitFiles(info.root, hash) : null;
  }

  return { status, invalidate, changes, changeCount, diff, commits, commit };
}
