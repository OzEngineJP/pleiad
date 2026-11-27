// 記憶の正本（ADR 0110）。markdown（<dir>/user.md・<dir>/bots/<botId>.md）と変更履歴（rev・墓石・誰がしたか）。
// 履歴は <dir>/log.jsonl。bot の削除時には既存 memory_state の memory.log / memory.log.meta へ移し、以降は行単位で保存・削除する（ADR 0293）。
// 索引（index.mjs）は派生で、ここが持つのは正本だけ。
//
// markdown の形（docs/channels.md の元の計画 §1.6）:
//   <!-- pleiad-memory v1 layer=user -->
//   # あなたについて
//
//   - 本文 <!-- {"id":"m_…","at":…,"up":…,"by":{…},"why":"…","src":[{…}],"k":"promise","w":3,"st":"open"} -->
//   1 行 1 件。本文は人が読めて直せる。メタは行末の HTML コメントの JSON（読めない・無い行は「出どころ不明」の人の記憶として読む）。
//   k（種類）・w（重み 1〜3）・st（状態）は任意（ADR 0118。無い行は strength.mjs の既定）。tier（段 always/workspace/archive）・ws（作業場所。
//   スラッシュ形・末尾なし・500 字まで）も任意で、無い行は未振り分け（公開の欄は tier / workspace）。知らないキーは捨てずに、書き直しでもそのまま残す
//   （新しい版が足した欄を古い版が読んで書き直しても消さないため。版の印 v1 は変えない）。
//   人が markdown を直接直したら、次に読むとき（sync）に差分を人の変更として log.jsonl に記録する。
//
// log.jsonl の 1 行: { rev, at, op: 'add'|'edit'|'forget'|'unforget', layer, id, text, fp, by, via?, entry? }
//   forget は entry（消した記憶の全体）と fp（墓石。正規化した本文の sha256 の先頭 16 字）を残す。unforget は forget の entry から戻し、墓石を外す。
//   via は書いた会話の sessionId（その会話の末尾の差分には同じ記憶を重ねて出さないため）。
//   edit で段・作業場所が変わったときは place: { from, to }（それぞれ { tier?, workspace? }）も残す。コードの一括移行（既存の約束を保存だけにするなど）は
//   migration: '<名前>' を付け、by は { kind: 'system' }。段を外せば元に戻り、同じ名前の移行は同じ id にやり直さない（migrated(name)）。
//   夜の整理の振り分け（core/memory/sort.mjs）も同じ印（migration: 'sort:<走りの id>'）と、短い理由 reason を付ける。取り消しは 'sort-undo:<走りの id>'。
//   migrations(name) は、その移行が変えた段・作業場所の前後（from・to）を id ごとに返す。
// 変更はすべて 1 本のキューで直列にする（rev を欠番なく進めるため）。md を先に書き、log を後に足す。
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from '../atomic-file.mjs';
import { openData } from '../data-schema.mjs';
import { memoryStateTable } from '../db.mjs';
import { newId, isId, isAuthor, authorKey } from '../channels/types.mjs';
import { isMemoryKind, isMemoryStatus, isWeight } from './strength.mjs';

export const MEMORY_TEXT_MAX = 300;
export const USER_LAYER = 'user';

/** 段（ADR 0110 の段 2）。always = いつも渡す・workspace = その作業場所の会話にだけ渡す・archive = 保存だけ。段なし = 未振り分け（従来どおり） */
export const MEMORY_TIERS = ['always', 'workspace', 'standard', 'archive'];
export const isTier = (tier) => MEMORY_TIERS.includes(tier);
export const WORKSPACE_MAX = 500;
/** 作業場所の形か（スラッシュ形・末尾なし・500 字まで）。canonical は core/git-root.mjs の canonicalWorkspace が作る */
export const isWorkspace = (value) => typeof value === 'string' && value.length >= 1 && value.length <= WORKSPACE_MAX
  && !value.includes('\\') && !value.includes('\0') && !/[\r\n]/.test(value) && (value.length === 1 || !value.endsWith('/') || /^[A-Za-z]:\/$/.test(value));

/** 層の id か（'user' か bot の id）。ファイル名になるので、それ以外は通さない */
export const isLayer = (layer) => layer === USER_LAYER || isId(layer, 'bot');

/** 指紋用の正規化: NFKC・小文字・空白と記号を落とす（言い回しの細かい違いで墓石をすり抜けない） */
export const fingerprintOf = (text) => crypto.createHash('sha256')
  .update(String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')).digest('hex').slice(0, 16);

/** 本文を 1 行にそろえる（改行・連続の空白を 1 つに） */
export const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ markdown
const HEADER = (layer) => `<!-- pleiad-memory v1 layer=${layer} -->`;
// JSON の中の < と > は \u003c \u003e にする（-->  が本文に入っても、行末のコメントを閉じない）
const metaJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** メタの JSON のうち、この版が読むキー。ほかは extraMeta に入れて、書き直しで戻す */
const META_KEYS = new Set(['id', 'at', 'up', 'by', 'ob', 'why', 'src', 'k', 'w', 'st', 'tier', 'ws']);

/** 種類・重み・状態・段・作業場所（どれも任意）。正しくない値は無いものとして読む */
const tagsOf = (value) => ({
  ...(isMemoryKind(value?.kind) ? { kind: value.kind } : {}),
  ...(isWeight(value?.weight) ? { weight: value.weight } : {}),
  ...(isMemoryStatus(value?.status) ? { status: value.status } : {}),
  ...(isTier(value?.tier) ? { tier: value.tier } : {}),
  ...(isWorkspace(value?.workspace) ? { workspace: value.workspace } : {}),
});

/** 本文だけから決める id（メタの無い手書きの行用。同じ本文は同じ id なので、読むたびに変わらない） */
export const derivedId = (layer, text) => `m_h${crypto.createHash('sha256').update(`${layer}\n${text}`).digest('hex').slice(0, 12)}`;

/** 1 層の markdown を読む。メタの無い・壊れた行は hadMeta: false（出どころ不明の人の記憶） */
export function parseLayer(markdown, layer) {
  const entries = [];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const m = /^[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    let body = m[1];
    let meta = null;
    const open = body.lastIndexOf('<!--');
    if (open >= 0 && /-->$/.test(body)) {
      const inner = /^<!--\s*([\s\S]*?)\s*-->$/.exec(body.slice(open))?.[1] ?? '';
      try { const parsed = JSON.parse(inner); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed; } catch { /* 壊れたメタは本文だけ残す */ }
      body = body.slice(0, open);
    }
    const text = oneLine(body);
    if (!text) continue;
    const id = isId(meta?.id, 'memory') ? meta.id : derivedId(layer, text);
    const extra = meta ? Object.fromEntries(Object.entries(meta).filter(([key]) => !META_KEYS.has(key))) : {};
    entries.push({
      id, layer, text,
      ...(typeof meta?.why === 'string' && meta.why ? { why: meta.why } : {}),
      sources: Array.isArray(meta?.src) ? meta.src.filter((s) => s && typeof s === 'object') : [],
      at: Number.isFinite(meta?.at) ? meta.at : 0,
      updatedAt: Number.isFinite(meta?.up) ? meta.up : Number.isFinite(meta?.at) ? meta.at : 0,
      by: isAuthor(meta?.by) ? meta.by : { kind: 'human' },
      ...(isAuthor(meta?.ob) ? { origBy: meta.ob } : {}),
      ...tagsOf({ kind: meta?.k, weight: meta?.w, status: meta?.st, tier: meta?.tier, workspace: meta?.ws }),
      ...(Object.keys(extra).length ? { extraMeta: extra } : {}),
      hadMeta: Boolean(meta),
    });
  }
  return entries;
}

/** 1 層の markdown を作る。title は見出し（辞書の文。呼び出し側が言語を決める） */
export function renderLayer(layer, entries, title) {
  const lines = entries.map((e) => `- ${oneLine(e.text)} <!-- ${metaJson({
    ...(e.extraMeta ?? {}),
    id: e.id, at: e.at, up: e.updatedAt, by: e.by, ...(e.origBy ? { ob: e.origBy } : {}), ...(e.why ? { why: e.why } : {}), src: e.sources ?? [],
    ...(e.kind ? { k: e.kind } : {}), ...(e.weight ? { w: e.weight } : {}), ...(e.status ? { st: e.status } : {}),
    ...(e.tier ? { tier: e.tier } : {}), ...(e.workspace ? { ws: e.workspace } : {}),
  })} -->`);
  return `${HEADER(layer)}\n# ${title}\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

/** 段と作業場所だけの形（記録の place の前後） */
const placeOf = (entry) => ({ ...(entry.tier ? { tier: entry.tier } : {}), ...(entry.workspace ? { workspace: entry.workspace } : {}) });

/** 外へ出す形（hadMeta・extraMeta を落とす） */
const publicEntry = (entry) => { const { hadMeta: _hadMeta, extraMeta: _extraMeta, ...rest } = entry; return rest; };
/** 忘れた記録に残す形（戻したときに知らないキーも戻す） */
const keptEntry = (entry) => ({ ...publicEntry(entry), ...(entry.extraMeta ? { extraMeta: entry.extraMeta } : {}) });

// ------------------------------------------------------------------ store
const sigOf = (st) => `${st.mtimeMs}:${st.size}`;

/**
 * createMemoryStore({ dir, now, titleOf }) — titleOf(layer) は markdown の見出し（無ければ層の名前）
 *   init(): 記録を読み、markdown と突き合わせる（アプリが止まっている間の手書きの直しも拾う）
 *   sync(): markdown の外からの直しを拾って記録する。変わった層の配列を返す（変わらなければ空）
 *   entries(layer?) / get(id) / layers()
 *   add / edit / forget / unforget … 変更。返りは { entry, rev }（forget は { entry, rev, fp }）
 *   rev() / recordsSince(rev) / isTombstoned(fp) / hash(layers?)  … 索引の鮮度の印
 */
export function createMemoryStore({ dir, now = Date.now, titleOf = (layer) => layer } = {}) {
  const logFile = path.join(dir, 'log.jsonl');
  const layerFile = (layer) => (layer === USER_LAYER ? path.join(dir, 'user.md') : path.join(dir, 'bots', `${layer}.md`));
  /** @type {Map<string, any[]>} */
  const cache = new Map();           // layer → entries（hadMeta を持つ）
  const sigs = new Map();            // layer → ファイルの印（mtime:size）。自分で書いた後の値を入れる
  const known = new Map();           // id → { layer, text }（記録から組んだ「記録が知っている今の記憶」。手書きの直しの差分を取る相手）
  const forgotten = new Map();       // id → 最後の forget の記録（unforget の元）
  const tombstones = new Map();      // fp → forget した記憶の id
  let records = [];
  let rev = 0;
  let queue = Promise.resolve();
  let ready = false;
  let handle = null, journal = null, inDatabase = false;
  const openJournal = () => {
    if (!handle) { handle = openData(path.dirname(dir)); journal = memoryStateTable(handle.db); }
    return journal;
  };

  /** 変更・読み込みを 1 本に並べる */
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  function apply(rec) {
    if (rec.op === 'add' || rec.op === 'edit' || rec.op === 'unforget') {
      known.set(rec.id, { layer: rec.layer, text: rec.text });
      if (rec.op === 'unforget') {
        forgotten.delete(rec.id);
        if (rec.fp && tombstones.get(rec.fp) === rec.id) tombstones.delete(rec.fp);
      }
    } else if (rec.op === 'forget') {
      known.delete(rec.id);
      forgotten.set(rec.id, rec);
      if (rec.fp) tombstones.set(rec.fp, rec.id);
    }
  }

  async function readLog() {
    const exists = await fs.access(path.join(path.dirname(dir), 'pleiad.db')).then(() => true, () => false);
    const table = exists ? openJournal() : null;
    inDatabase = table?.get('memory.log.meta', 'migrated') === true;
    let raw = '';
    if (!inDatabase) try { raw = await fs.readFile(logFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    records = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (Number.isInteger(rec?.rev) && typeof rec.op === 'string') records.push(rec);
      } catch { /* 最後の行が書きかけで壊れていたら捨てる */ }
    }
    if (inDatabase) {
      records = Object.values(table.ofKind('memory.log')).sort((a, b) => a.rev - b.rev);
      // 移行の保存後、旧ログの削除前に停止しても、旧い本文を残さず再開する。
      const legacy = await fs.readFile(logFile).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (legacy && crypto.createHash('sha256').update(legacy).digest('hex') !== table.get('memory.log.meta', 'legacyHash')) throw new Error('memory/log.jsonl changed after migration; restore or reconcile the history before continuing');
      if (legacy) await fs.unlink(logFile);
    }
    known.clear(); forgotten.clear(); tombstones.clear();
    for (const rec of records) apply(rec);
    rev = records.reduce((max, r) => Math.max(max, r.rev), 0);
  }

  /** 最後の 1 バイトが改行か（ファイルが無い・空なら真）。追記の途中で落ちた壊れた行の後ろに、次の行をつなげないため（channels/store.mjs と同じ） */
  async function endsWithNewline() {
    const st = await fs.stat(logFile).catch(() => null);
    if (!st || st.size === 0) return true;
    const fh = await fs.open(logFile, 'r');
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, st.size - 1);
      return buf[0] === 0x0a;
    } finally { await fh.close(); }
  }

  async function appendLog(rec) {
    const full = { rev: rev + 1, at: now(), ...rec };
    if (inDatabase) openJournal().save([['memory.log', String(full.rev), full]]);
    else {
      await fs.mkdir(dir, { recursive: true });
      const lead = (await endsWithNewline()) ? '' : '\n';
      await fs.appendFile(logFile, `${lead}${JSON.stringify(full)}\n`, 'utf8');
    }
    rev = full.rev;
    records.push(full);
    apply(full);
    return full;
  }

  async function listLayerNames() {
    const names = [];
    try { await fs.access(path.join(dir, 'user.md')); names.push(USER_LAYER); } catch { /* 無ければ空の層 */ }
    try {
      for (const f of await fs.readdir(path.join(dir, 'bots'))) {
        const id = f.endsWith('.md') ? f.slice(0, -3) : null;
        if (id && isId(id, 'bot')) names.push(id);
      }
    } catch { /* bots/ が無い */ }
    return names;
  }

  async function writeLayer(layer) {
    const file = layerFile(layer);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, renderLayer(layer, cache.get(layer) ?? [], titleOf(layer)));
    sigs.set(layer, sigOf(await fs.stat(file)));
  }

  /** 1 層を読み直す。手書きの直しは記録に足す（by: 人）。メタの無い行には id と at を付けて書き戻す */
  async function reload(layer, changedLayers) {
    const file = layerFile(layer);
    let raw = null, st = null;
    try { raw = await fs.readFile(file, 'utf8'); st = await fs.stat(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parsed = raw === null ? [] : parseLayer(raw, layer);
    const seen = new Set();
    const entries = [];
    let rewrite = false;
    for (const e of parsed) {
      if (seen.has(e.id)) continue;   // 手でコピーした行の重複は 1 つにする
      seen.add(e.id);
      if (!e.hadMeta) { e.at = e.updatedAt = now(); e.by = { kind: 'human' }; rewrite = true; }
      entries.push(e);
    }
    if (parsed.length !== entries.length) rewrite = true;
    cache.set(layer, entries);
    // 記録が知っている今の記憶と比べる
    let changed = false;
    for (const e of entries) {
      const k = known.get(e.id);
      if (!k) { await appendLog({ op: 'add', layer, id: e.id, text: e.text, fp: fingerprintOf(e.text), by: { kind: 'human' } }); changed = true; }
      else if (k.text !== e.text || k.layer !== layer) { await appendLog({ op: 'edit', layer, id: e.id, text: e.text, fp: fingerprintOf(e.text), by: { kind: 'human' } }); changed = true; }
    }
    for (const [id, k] of [...known]) {
      if (k.layer !== layer || seen.has(id)) continue;
      const gone = { id, layer, text: k.text, sources: [], at: 0, updatedAt: now(), by: { kind: 'human' } };
      await appendLog({ op: 'forget', layer, id, text: k.text, fp: fingerprintOf(k.text), by: { kind: 'human' }, entry: gone });
      changed = true;
    }
    if (rewrite) await writeLayer(layer);
    else if (st) sigs.set(layer, sigOf(st));
    else sigs.delete(layer);
    if (changed || rewrite) changedLayers.add(layer);
  }

  async function syncNow() {
    const changedLayers = new Set();
    const names = new Set([...(await listLayerNames()), ...cache.keys(), ...[...known.values()].map((k) => k.layer)]);
    for (const layer of names) {
      let st = null;
      try { st = await fs.stat(layerFile(layer)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const sig = st ? sigOf(st) : null;
      if (cache.has(layer) && (sigs.get(layer) ?? null) === sig) continue;
      await reload(layer, changedLayers);
    }
    return [...changedLayers];
  }

  const ensureReady = async () => {
    if (ready) return;
    await readLog();
    ready = true;
  };

  const entriesOf = (layer) => (cache.get(layer) ?? []).map(publicEntry);

  const api = {
    /** 起動時: 記録を読み、markdown と突き合わせる。直された層の配列 */
    init: () => serial(async () => { ready = false; await ensureReady(); return syncNow(); }),
    sync: () => serial(async () => { await ensureReady(); return syncNow(); }),
    entries: (layer) => (layer ? entriesOf(layer) : [...cache.keys()].flatMap(entriesOf)),
    get: (id) => { for (const list of cache.values()) { const e = list.find((x) => x.id === id); if (e) return publicEntry(e); } return null; },
    layers: () => [...cache.keys()],
    rev: () => rev,
    close() { handle?.release(); handle = null; journal = null; ready = false; },
    // bot 削除では「忘れる」の取り消しも残さない。共通層の履歴は保持する。
    purgeLayer: (layer) => serial(async () => {
      if (layer === USER_LAYER || !isLayer(layer)) throw new Error('invalid bot memory layer');
      await ensureReady();
      await fs.unlink(layerFile(layer)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      const next = records.filter(r => r.layer !== layer);
      next.push({ rev: rev + 1, at: now(), op: 'purge', layer });
      // 初回の削除で履歴を行へ移す。以降は対象の行だけ消す（全件のファイル書き直しを増やさない）。
      const changes = inDatabase
        ? records.filter(r => r.layer === layer).map(r => ['memory.log', String(r.rev), undefined])
        : next.slice(0, -1).map(r => ['memory.log', String(r.rev), r]);
      const purge = next.at(-1);
      changes.push(['memory.log', String(purge.rev), purge], ['memory.log.meta', 'migrated', true]);
      const legacy = await fs.readFile(logFile).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (legacy) changes.push(['memory.log.meta', 'legacyHash', crypto.createHash('sha256').update(legacy).digest('hex')]);
      openJournal().save(changes);
      inDatabase = true;
      records = next; rev++;
      cache.delete(layer); sigs.delete(layer);
      known.clear(); forgotten.clear(); tombstones.clear();
      for (const rec of records) apply(rec);
      await fs.unlink(logFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }),
    recordsSince: (since) => records.filter((r) => r.rev > since),
    isTombstoned: (fp) => tombstones.has(fp),
    /** 忘れた直後で、戻せる記憶（最後の操作が forget）の写し。無ければ null */
    forgottenEntry: (id) => { const gone = forgotten.get(id); return gone?.entry && !known.has(id) ? publicEntry(gone.entry) : null; },
    /** 索引の鮮度の印（全層の entries の内容から） */
    hash: () => crypto.createHash('sha256').update(JSON.stringify([...cache.keys()].sort().map((l) => [l, cache.get(l).map((e) => [e.id, e.text, e.why ?? '', e.updatedAt, e.tier ?? '', e.workspace ?? ''])]))).digest('hex'),

    /** 追加。by は発言者、via は書いた会話。entry は id・at 以外が入った形 */
    add: ({ layer, text, why, sources = [], by, via, unique = false, kind, weight, status, tier, workspace, runId, reason }) => serial(async () => {
      await ensureReady(); await syncNow();
      // 同じ文を同時に 2 回書いても、直列化の中で見れば後の 1 つは弾ける（呼び出し側の事前の検査は直列化の外）
      if (unique && (cache.get(layer) ?? []).some((e) => fingerprintOf(e.text) === fingerprintOf(text))) return { duplicate: true };
      const at = now();
      const entry = { id: newId('memory', at), layer, text: oneLine(text), ...(why ? { why } : {}), sources, at, updatedAt: at, by,
        ...tagsOf({ kind, weight, status, tier, workspace }), hadMeta: true };
      const previous = cache.get(layer) ?? [];
      const record = { op: 'add', layer, id: entry.id, text: entry.text, fp: fingerprintOf(entry.text), by, ...(via ? { via } : {}),
        ...(runId ? { runId, reason, after: keptEntry(entry) } : {}) };
      let rec = runId ? await appendLog(record) : null;
      cache.set(layer, [...previous, entry]);
      try { await writeLayer(layer); } catch (error) { cache.set(layer, previous); throw error; }
      rec ??= await appendLog(record);
      return { entry: publicEntry(entry), rev: rec.rev };
    }),

    /** 本文・理由・出どころ・種類・重み・状態・段・作業場所を直す。種類・重み・状態・段・作業場所は null で外す（undefined は触らない）。
     *  段・作業場所だけの直し（振り分け）は updatedAt を進めない（記憶の強さ・並び・「直した」の表示を、振り分けで動かさないため）。無い id は null */
    edit: ({ id, text, why, sources, by, via, kind, weight, status, tier, workspace, migration, reason, runId }) => serial(async () => {
      await ensureReady(); await syncNow();
      for (const [layer, list] of cache) {
        const i = list.findIndex((e) => e.id === id);
        if (i < 0) continue;
        const old = list[i];
        // by は今の本文を書いた者なので、本文が変わるときだけ替える（理由・種類・重みだけの直しや同じ本文の直しで、
        // AI が人の行を自分の行にしてしまわないため。そうすると次から承認なしで本文を書き換えられる）。直した者は log.jsonl の by に残る
        const textChanged = text !== undefined && oneLine(text) !== old.text;
        const placementOnly = [text, why, sources, kind, weight, status].every((v) => v === undefined) && (tier !== undefined || workspace !== undefined);
        const entry = {
          ...old,
          ...(text !== undefined ? { text: oneLine(text) } : {}),
          ...(why !== undefined ? (why ? { why } : { why: undefined }) : {}),
          sources: sources ? [...old.sources, ...sources] : old.sources,
          updatedAt: placementOnly ? old.updatedAt : now(), by: textChanged ? by : old.by,
        };
        for (const [key, value] of [['kind', kind], ['weight', weight], ['status', status], ['tier', tier], ['workspace', workspace]]) {
          if (value === null) delete entry[key];
          else if (value !== undefined) Object.assign(entry, tagsOf({ [key]: value }));
        }
        // 書き手が替わったら、元の書き手を残す（人の行を AI が直したときに、元が人だったと分かるように）
        if (authorKey(old.by) !== authorKey(entry.by)) entry.origBy = old.origBy ?? old.by;
        if (!entry.why) delete entry.why;
        // 段・作業場所が変わったときは前後を記録に残す（戻すとき・後から見るとき用）。migration はコードの一括移行の名前（同じ名前では 1 つの id に 1 度だけ行う）
        const from = placeOf(old), to = placeOf(entry);
        const placed = JSON.stringify(from) !== JSON.stringify(to);
        const record = { op: 'edit', layer, id, text: entry.text, fp: fingerprintOf(entry.text), by,
          ...(entry.origBy ? { origBy: entry.origBy } : {}), ...(via ? { via } : {}),
          ...(placed ? { place: { from, to } } : {}), ...(migration ? { migration } : {}), ...(reason ? { reason } : {}),
          ...(runId ? { runId, before: keptEntry(old), after: keptEntry(entry) } : {}) };
        let rec = runId ? await appendLog(record) : null;
        const next = [...list]; next[i] = entry;
        cache.set(layer, next);
        try { await writeLayer(layer); } catch (error) { cache.set(layer, list); throw error; }
        rec ??= await appendLog(record);
        return { entry: publicEntry(entry), rev: rec.rev };
      }
      return null;
    }),

    /** コードの一括移行 name（edit の migration）を、すでに行った記憶の id。人が段を外しても、次の起動で同じ移行をやり直さないために使う */
    runChanges(runId) {
      const changes = new Map();
      const last = new Map(records.map(record => [record.id, record.rev]));
      const entries = new Map([...cache.values()].flat().map(entry => [entry.id, entry]));
      for (const record of records) {
        if (record.runId !== runId) continue;
        const first = changes.get(record.id);
        const current = entries.get(record.id);
        changes.set(record.id, { id: record.id, layer: record.layer, rev: record.rev,
          before: first ? first.before : record.before ?? null, after: record.after, reason: record.reason ?? 'organizer',
          canUndo: Boolean(current && last.get(record.id) === record.rev && isDeepStrictEqual(keptEntry(current), record.after)) });
      }
      return [...changes.values()];
    },

    undoRunChange: (runId, id, rev) => serial(async () => {
      await ensureReady(); await syncNow();
      const change = api.runChanges(runId).find(row => row.id === id && row.rev === rev && row.canUndo);
      if (!change) return false;
      const { layer, before } = change;
      const old = cache.get(layer);
      const next = before ? old.map(entry => entry.id === id ? { ...before, hadMeta: true } : entry) : old.filter(entry => entry.id !== id);
      cache.set(layer, next);
      try { await writeLayer(layer); } catch (error) { cache.set(layer, old); throw error; }
      await appendLog({ op: before ? 'edit' : 'forget', id, layer, text: (before ?? change.after).text,
        fp: fingerprintOf((before ?? change.after).text), by: { kind: 'human' }, reason: 'undo',
        ...(before ? { place: { from: placeOf(change.after), to: placeOf(before) } } : { entry: change.after }) });
      return true;
    }),

    migrated: (name) => {
      const latest = new Map(records.map(record => [record.id, record.rev]));
      const entries = new Map([...cache.values()].flat().map(entry => [entry.id, entry]));
      return new Set(records.filter(record => record.op === 'edit' && record.migration === name
        && (record.rev !== latest.get(record.id) || !entries.has(record.id)
          || !isDeepStrictEqual(keptEntry(entries.get(record.id)), record.before)))
        .map(record => record.id));
    },

    /** 一括移行 name が段・作業場所を変えた記憶ごとの、最初の前（from）と最後の後（to）。振り分けを取り消すとき、今も to のままのものだけ戻すために使う */
    migrations: (name) => {
      const out = new Map();
      for (const r of records) {
        if (r.op !== 'edit' || r.migration !== name || !r.place) continue;
        const prev = out.get(r.id);
        out.set(r.id, { from: prev?.from ?? r.place.from, to: r.place.to });
      }
      return out;
    },

    /** 記憶 id の段・作業場所を最後に変えた記録の by（無ければ null）。夜の整理が、人が選んだ段を付け直さないために使う */
    lastPlacedBy: (id) => {
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r.id === id && r.op === 'edit' && r.place) return r.by ?? null;
      }
      return null;
    },

    /** 忘れる（墓石を残す）。無い id は null */
    forget: ({ id, by, via }) => serial(async () => {
      await ensureReady(); await syncNow();
      for (const [layer, list] of cache) {
        const old = list.find((e) => e.id === id);
        if (!old) continue;
        cache.set(layer, list.filter((e) => e !== old));
        await writeLayer(layer);
        const fp = fingerprintOf(old.text);
        const rec = await appendLog({ op: 'forget', layer, id, text: old.text, fp, by, ...(via ? { via } : {}), entry: keptEntry(old) });
        return { entry: publicEntry(old), rev: rec.rev, fp };
      }
      return null;
    }),

    /** 忘れたものを戻す（人の操作の取り消しとして記録）。墓石も外す。戻せるもの（最後の操作が forget）が無ければ null */
    unforget: ({ id, by, via }) => serial(async () => {
      await ensureReady(); await syncNow();
      const gone = forgotten.get(id);
      if (!gone?.entry || known.has(id)) return null;
      const layer = gone.layer;
      const at = now();
      const entry = { ...gone.entry, updatedAt: at, by, hadMeta: true };
      cache.set(layer, [...(cache.get(layer) ?? []), entry]);
      await writeLayer(layer);
      const rec = await appendLog({ op: 'unforget', layer, id, text: entry.text, fp: gone.fp ?? fingerprintOf(entry.text), by, ...(via ? { via } : {}) });
      return { entry: publicEntry(entry), rev: rec.rev };
    }),
  };
  return api;
}
