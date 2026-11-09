// Pleiad のページ（ファイルのページ）から Pleiad への頼みの検査（ADR 0295 の 2 の 6）。
// 中継の口（core/chrome/page-bridge.mjs）が、人が操作中のタブのページ自身から届いた頼みだけをここへ渡す。ここでは
//   - 頼みの形を検査し、知っている欄だけを写す（形の外・知らない欄は捨てる。頼みが開くのはメニューと確認だけで、外で開くなどの操作の欄は無い）
//   - 頼みに載ったパスを、ファイルのページの API と同じ検査（ADR 0050。core/file-preview.mjs の inspectFile）でかけ直し、検査した実体のパスに置き換える
//   - 通った頼みは中継が 'tab:page-request' で出し、画面への配り（core/browser-unify-ws.mjs）は by（最後に触った画面）だけへ送る
// 書き込みの頼み（worktree）は、画面が確認と実行を終えたら result で結果を返す。テーマと言語の変化は env でページへ知らせる。
// ログにパス・文・頼みの中身を書かない。
import { inspectFile as defaultInspect } from './file-preview.mjs';

/** 受ける頼みの種類（web/pages/README.md の「ホストへの操作要求」。commit は今のページが送らないので受けない） */
export const REQUEST_TYPES = Object.freeze(['file-menu', 'use-file', 'use-text', 'jump', 'worktree', 'open-viz']);
/** 作業場所の書き込みの頼みの action */
export const WORKTREE_ACTIONS = Object.freeze(['keep', 'ask', 'unask', 'archive', 'restore']);
/** 作成欄へ渡す文の上限（文字数） */
export const TEXT_LIMIT = 20_000;
/** パスの上限（ファイルのページの API と同じ） */
export const PATH_LIMIT = 32_768;
/** worktree の行などの、写して渡すオブジェクトの上限（JSON の文字数）と深さ */
export const OBJECT_LIMIT = 16 * 1024;
export const OBJECT_DEPTH = 6;
/** 結果のオブジェクトの上限（JSON の文字数） */
export const RESULT_LIMIT = 16 * 1024;

const THEMES = ['light', 'dark', 'auto'];
const LANGS = ['ja', 'en'];
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

const str = (value, max, { min = 1 } = {}) => typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
/** 可視化の情報（open-viz・可視化の行の file-menu に載る）。束の印は 64 hex、入口と題は上限まで。形の外は undefined */
const VIZ_LIMIT = 2000;
function vizShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.hash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.hash)) return undefined;
  const viz = { hash: raw.hash };
  if (raw.entry != null) { if (!str(raw.entry, VIZ_LIMIT)) return undefined; viz.entry = raw.entry; }
  if (raw.title != null) { if (!str(raw.title, VIZ_LIMIT)) return undefined; viz.title = raw.title; }
  return viz;
}
/** 消えたファイルの印（inspectFile の投げる fs の失敗。権限・通信の失敗は含めない） */
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const coord = value => Number.isFinite(value) ? Math.min(100_000, Math.max(0, Math.round(value))) : undefined;
/** JSON で写せる、上限と深さの内の素のオブジェクトなら写し、それ以外は undefined */
function plainCopy(value, limit = OBJECT_LIMIT) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let text;
  try { text = JSON.stringify(value); } catch { return undefined; }
  if (typeof text !== 'string' || text.length > limit) return undefined;
  const depth = (v, d) => d > OBJECT_DEPTH ? Infinity : v && typeof v === 'object' ? Math.max(d, ...Object.values(v).map(x => depth(x, d + 1))) : d;
  const copy = JSON.parse(text);
  return depth(copy, 1) > OBJECT_DEPTH ? undefined : copy;
}

/**
 * 頼みの形を検査し、知っている欄だけの写しを返す（パスはまだ検査しない）
 * @returns {{ ok: true, request: object } | { ok: false, reason: string }}
 */
export function checkShape(raw, { sessionId } = {}) {
  const no = reason => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('not-object');
  if (!REQUEST_TYPES.includes(raw.type)) return no('type');
  // 頼みの会話はタブの会話と同じでなければならない（ページは自分の会話の id を載せる）
  if (raw.sessionId !== sessionId || typeof sessionId !== 'string' || !sessionId) return no('session');
  const base = { type: raw.type, sessionId };
  switch (raw.type) {
    case 'file-menu': {
      const viz = vizShape(raw.viz);
      const hasPath = str(raw.path, PATH_LIMIT);
      // 可視化の行（元パスの記録が無いもの）は viz の情報だけでメニューを開く。パスはあれば検査する
      if (!hasPath && !viz) return no('path');
      if (raw.base != null && !str(raw.base, PATH_LIMIT)) return no('base');
      const x = coord(raw.x), y = coord(raw.y);
      return { ok: true, request: { ...base, ...(hasPath ? { path: raw.path } : {}), ...(viz ? { viz } : {}),
        ...(raw.base != null ? { base: raw.base } : {}), ...(x != null && y != null ? { x, y } : {}),
        ...(raw.missing === true ? { missing: true } : {}) } };
    }
    case 'open-viz': {
      const viz = vizShape(raw.viz);
      if (!viz) return no('viz');
      return { ok: true, request: { ...base, viz,
        ...(str(raw.path, PATH_LIMIT) ? { path: raw.path } : {}), ...(raw.missing === true ? { missing: true } : {}) } };
    }
    case 'use-file':
      if (!str(raw.path, PATH_LIMIT)) return no('path');
      return { ok: true, request: { ...base, path: raw.path } };
    case 'use-text':
      if (!str(raw.text, TEXT_LIMIT)) return no('text');
      return { ok: true, request: { ...base, text: raw.text } };
    case 'jump': {
      const e = raw.event;
      if (!e || typeof e !== 'object' || Array.isArray(e)) return no('event');
      const event = {};
      for (const key of ['kind', 'uuid', 'toolId', 'at']) if (e[key] != null) { if (!str(e[key], 200)) return no('event'); event[key] = e[key]; }
      if (e.hash != null) { if (typeof e.hash !== 'string' || !/^[0-9a-f]{4,64}$/i.test(e.hash)) return no('event'); event.hash = e.hash; }
      if (!event.uuid && !event.toolId) return no('event');
      return { ok: true, request: { ...base, event } };
    }
    case 'worktree': {
      if (!WORKTREE_ACTIONS.includes(raw.action)) return no('action');
      if (typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) return no('requestId');
      const out = { ...base, action: raw.action, requestId: raw.requestId };
      switch (raw.action) {
        case 'keep':
          if (!str(raw.id, 200) || typeof raw.kept !== 'boolean') return no('detail');
          return { ok: true, request: { ...out, id: raw.id, kept: raw.kept } };
        case 'unask': {
          const ask = plainCopy(raw.ask);
          return ask ? { ok: true, request: { ...out, ask } } : no('detail');
        }
        default: {   // ask・archive・restore は行を持つ。restore は戻す先の ref も持てる
          const row = plainCopy(raw.row);
          if (!row) return no('detail');
          if (raw.action === 'restore' && raw.ref != null && !str(raw.ref, 512)) return no('detail');
          return { ok: true, request: { ...out, row, ...(raw.action === 'restore' && raw.ref != null ? { ref: raw.ref } : {}) } };
        }
      }
    }
  }
  return no('type');
}

/**
 * @param {object} deps サーバーから渡すもの（core/server.mjs が作る。ファイルのページの経路 core/pages-routes.mjs と同じもの）
 * @param [deps.relay] Chrome の中継（core/chrome/relay.mjs。無ければ頼みは届かない）。作ったときに relay.unify.pageBridge へ検査をつなぐ
 * @param deps.store   会話の置き場（getAll()）
 * @param deps.fileAccessFor (sessionId) => inspectFile の access
 * @param deps.fileRoots (sessions) => 読めるフォルダーの一覧
 * @param deps.resolveSessionFile ({ path, sessionId, base }, sessions, roots) => { path }（会話の作業フォルダーで相対パスを解く）
 * @param [deps.inspect] 試験が差し替える inspectFile
 * @param [deps.log]   ログの 1 行
 * @returns
 *   - accept(raw, { sessionId, targetId, by }): 検査した頼みか null（中継の口が呼ぶ）
 *   - result(reply): 画面が終えた書き込みの頼みの結果をページへ返す（{ sessionId, targetId?, requestId, ok, result?, error? }）。返せたら true
 *   - env(change): テーマ・言語の変化（{ theme?, lang? }）。変わった分だけファイルのページのタブへ知らせる
 *   - envOf(sessionId): ページが開くときに読む env（core/pages-routes.mjs の deps.env に渡す）
 */
export function createPageRequests(deps = {}) {
  const inspect = deps.inspect ?? defaultInspect;
  const log = deps.log ?? (() => {});
  const bridge = () => deps.relay?.unify?.pageBridge ?? null;
  const tabHolder = () => deps.relay?.unify?.tabHolder ?? null;
  let current = {};   // 最後に知らされたテーマと言語

  /** パスを ADR 0050 の検査にかけ直し、検査した実体のパスと種類を返す（ファイルのページの API の resolve と同じ順） */
  async function recheck(sessionId, raw, base) {
    const sessions = await deps.store.getAll();
    if (!Object.hasOwn(sessions, sessionId)) throw new Error('session-not-found');
    const access = deps.fileAccessFor(sessionId), roots = deps.fileRoots(sessions);
    if (base != null) await inspect(base, access);
    const ref = await deps.resolveSessionFile({ path: raw, sessionId, ...(base != null ? { base } : {}) }, sessions, roots);
    const { file, stat } = await inspect(ref.path, access);
    return { path: file, kind: stat.isDirectory() ? 'directory' : 'file' };
  }

  async function accept(raw, { sessionId, by } = {}) {
    if (typeof by !== 'string' || !by) return null;   // 届ける画面が無い
    const shape = checkShape(raw, { sessionId });
    if (!shape.ok) { log(`page-requests: dropped (${shape.reason})`); return null; }
    const request = shape.request;
    if (request.type === 'file-menu' || request.type === 'use-file' || request.type === 'open-viz') {
      // 可視化の行で元パスの記録が無いものはパスの検査をしない（開くのは保存版。OS の操作は出さない）
      if (request.path == null) return request.viz ? request : null;
      try {
        const checked = await recheck(sessionId, request.path, request.base);
        if (request.type === 'use-file' && checked.kind !== 'file') { log('page-requests: dropped (not a file)'); return null; }
        // ページが言った種類・相対の基準は使わず、検査した実体で置き換える
        const { base: _base, ...rest } = request;
        return { ...rest, path: checked.path, kind: checked.kind };
      } catch (error) {
        if (request.viz) {
          // 可視化の元のファイル: 消えたもの（ENOENT・ENOTDIR）は missing を付けてパスを残す（画面が保存版へ切り替えて知らせる）。
          // 権限・読めないパスなどほかの断られはパスだけ落とす（元パス不明と同じ、保存版をそのまま開く正常系）
          const { base: _base, kind: _kind, ...rest } = request;
          if (GONE.has(error?.code)) return { ...rest, missing: true };
          const { path: _path, ...withoutPath } = rest;
          return withoutPath;
        }
        log(`page-requests: dropped (${error?.code ?? error?.message ?? 'path'})`);
        return null;
      }
    }
    return request;
  }

  function result(reply) {
    if (!reply || typeof reply !== 'object') return Promise.resolve(false);
    const { sessionId, targetId, requestId, ok } = reply;
    if (!str(sessionId, 200) || (targetId != null && !str(targetId, 200)) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || typeof ok !== 'boolean') return Promise.resolve(false);
    let out;
    if (ok) {
      const value = reply.result ?? null;
      if (value !== null && typeof value === 'object') { out = plainCopy(value, RESULT_LIMIT); if (out === undefined) return Promise.resolve(false); }
      else if (value === null || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 2000) || Number.isFinite(value)) out = value;
      else return Promise.resolve(false);
    }
    const error = ok ? undefined : (typeof reply.error === 'string' && reply.error.length <= 200 ? reply.error : 'unavailable');
    return Promise.resolve(bridge()?.result({ sessionId, ...(targetId != null ? { targetId } : {}), requestId, ok, ...(ok ? { result: out } : { error }) }) ?? false).catch(() => false);
  }

  function env(change = {}) {
    const next = { ...current };
    if (THEMES.includes(change?.theme)) next.theme = change.theme;
    if (LANGS.includes(change?.lang)) next.lang = change.lang;
    const detail = {};
    for (const key of ['theme', 'lang']) if (next[key] !== current[key] && next[key] != null) detail[key] = next[key];
    current = next;
    if (!Object.keys(detail).length) return Promise.resolve(0);
    return Promise.resolve(bridge()?.env(detail) ?? 0).catch(() => 0);
  }

  // 中継の口へ検査をつなぐ（中継が無い・口が古い形なら、ページからの頼みは届かないまま）
  bridge()?.attach?.({ holder: (sessionId, targetId) => tabHolder()?.holder(sessionId, targetId) ?? { holder: 'ai' }, accept });

  return { accept, result, env, envOf: () => ({ ...current }) };
}
