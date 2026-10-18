// バックエンドのレジストリ。
//
// 有効にするものは環境変数 AGENT_HOST_BACKENDS（カンマ区切り、既定は core/backends/agents.mjs の fake を除く全部）で選ぶ。
// 読み込みは動的 import にしてある。理由: claude.mjs は Agent SDK を引き込むので、
// `AGENT_HOST_BACKENDS=fake` のテストでは**そもそも読み込みたくない**
// （SDK 無しでサーバが起動できることが、バックエンド抽象化ができている証拠になる）。
import * as store from "../store.mjs";
import { wrapBackend as wrapNative, conversationBackend } from "../conversations.mjs";
import { t } from "../i18n.mjs";
import { NO_CAPABILITIES } from "./contract.mjs";
import { AGENTS, DEFAULT_AGENT_IDS, agentPresentation } from "./agents.mjs";

// id -> そのモジュールの場所（エージェントの記述 core/backends/agents.mjs の module）。ここに無い id は無視する（環境変数からの任意 import は許さない）
const KNOWN = Object.fromEntries(Object.entries(AGENTS).map(([id, a]) => [id, a.module]));

const enabled = new Map();   // id -> backend
const nativeBackends = new WeakMap();

// 対応を終えたバックエンド。その会話は一覧に残し、開いて読めるが続けられない（送信・設定の変更・分岐・切り替えは断る）。
// 新しい会話の既定や委譲の行き先には出さない（getBackend / listBackends には載らない）。
export const RETIRED = {
  // 告知は言語が実行中に変わるので、読むたびに引く
  procway: { label: "procway-code", get notice() { return t("backends.retired.procway"); } },
};
/**
 * conversations.mjs の wrapBackend は native をスプレッドで写すので、ゲッター（description など、言語で変わる文言）が
 * 包んだ時点の値で固まる。ゲッターだけ包んだ側へ付け直し、読むたびに今の言語で引けるようにする
 */
function wrapBackend(native) {
  const wrapped = wrapNative(native);
  nativeBackends.set(wrapped, native);
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(native))) {
    if (desc.get) Object.defineProperty(wrapped, key, { get: desc.get.bind(native), enumerable: true, configurable: true });
  }
  return wrapped;
}

/** 先に認証を束縛してから会話のラッパーをかける。入れ子の履歴取得・分岐でも認証を落とさない。 */
export async function backendForAccount(backend, account) {
  if (!backend || backend.capabilities?.accounts !== 'agent') return backend;
  const native = nativeBackends.get(backend) ?? backend;
  if (!account) return wrapBackend(native);
  const scoped = wrapBackend(await native.forAccount(account));
  nativeBackends.set(scoped, native);
  return scoped;
}

/** 資格情報を削除しても保存済みの会話は読める。ネイティブの別アカウントへは問い合わせない。 */
export function offlineAccountBackend(backend, error) {
  const native = nativeBackends.get(backend) ?? backend;
  const unavailable = async () => { throw error; };
  return wrapBackend({ id: native.id, label: native.label,
    capabilities: { ...native.capabilities, title: false, tag: false, forkMessage: false },
    modes: () => native.modes(), models: unavailable,
    listSessions: async () => [], getSession: async () => null, getMessages: async () => [], getCompactions: async () => [],
    setTitle: async () => {}, setTag: undefined, listSubagents: async () => [], getSubagentMessages: async () => [],
    getSubagentOrigin: async () => null, getSubagentState: async () => null,
    runTurn: unavailable, compact: unavailable, rewind: unavailable, shell: unavailable,
  });
}

const retired = new Map(Object.entries(RETIRED).map(([id, info]) => [id, retiredBackend(id, info)]));

/**
 * 対応を終えたバックエンドの代わり。履歴は Pleiad が持っている分（切り替え・分岐で写した会話）だけ読め、
 * エージェントの手元にしか無い履歴は読めない（空）。ターンは始めない。
 */
function retiredBackend(id, info) {
  const native = {
    id, label: info.label,
    get retired() { return info.notice; },
    capabilities: { ...NO_CAPABILITIES },
    modes: () => ({}),
    models: async () => ({}),
    listSessions: async () => [],
    getSession: async (sessionId) => {
      const entry = await store.get(sessionId).catch(() => null);
      if (entry?.backend !== id) return null;
      return { sessionId, title: entry.title ?? null, tag: entry.status ?? null, cwd: entry.cwd ?? null,
        createdAt: entry.createdAt ?? null, lastModified: entry.lastModified ?? null };
    },
    getMessages: async () => [],
    runTurn: async () => { throw new Error(info.notice); },
  };
  const wrapped = wrapBackend(native);
  wrapped.capabilities = { ...wrapped.capabilities, fork: false, forkMessage: false };
  delete wrapped.fork;
  return wrapped;
}

// 既定は記述にある試験用以外の全部。読み込めないものは skip され、CLI を使うものは
// 最初に使うまでプロセスを起こさないので、使う CLI だけ入っていれば動く
// （一覧の取得はバックエンドごとに失敗を握るので巻き添えにならない）。
const wanted = String(process.env.AGENT_HOST_BACKENDS ?? DEFAULT_AGENT_IDS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const id of wanted) {
  const where = KNOWN[id];
  if (!where) {
    if (Object.hasOwn(RETIRED, id)) continue;
    console.error(`  知らないバックエンド: ${id}（無視した）`);
    continue;
  }
  try {
    const mod = await import(where);
    if (mod?.backend?.id) enabled.set(mod.backend.id, wrapBackend(mod.backend));
  } catch (err) {
    // 1つ読めなくても他は動かす。SDK が入っていない環境で fake だけ使う、が成り立つように。
    console.error(`  バックエンド ${id} を読み込めなかった: ${String(err?.message ?? err)}`);
  }
}

if (enabled.size === 0) console.error("  有効なバックエンドが1つも無い（AGENT_HOST_BACKENDS を確認）");

/** id で引く。無効・未知・対応を終えたものなら null。 */
export function getBackend(id) {
  return enabled.get(id) ?? null;
}

/** 会話の持ち主として引く。対応を終えたバックエンドなら、その代わり（retired に断る理由を持つ）を返す。 */
export function sessionBackend(id) {
  return enabled.get(id) ?? retired.get(id) ?? null;
}

/** 有効なバックエンドを、AGENT_HOST_BACKENDS に書かれた順で返す。 */
export function listBackends() {
  return [...enabled.values()];
}

/** 有効なものが1つだけならそれ。web の backend 未指定を補うのに使う。 */
export function defaultBackend() {
  return enabled.values().next().value ?? null;
}

/**
 * web に渡す一覧。capabilities には「メソッドがあるか」も畳み込む。
 * UI はこれだけを見てボタンを出し分ける（バックエンドの中身は知らない）。
 */
export function describeBackends() {
  return listBackends().map((b) => ({
    id: b.id,
    label: b.label ?? b.id,
    description: b.description ?? "",
    // 短い名前・ロゴ・自動の圧縮の設定の行（エージェントの記述）。画面は id の表を持たずにこれを使う
    ...agentPresentation(b.id),
    capabilities: {
      ...b.capabilities,
      suggestTitle: typeof b.suggestTitle === "function",
      // ターンの外の裏の作業を止められるか（codex のバックグラウンド端末。§2.7）
      stopBackground: typeof b.stopBackground === "function",
      backgroundDetails: typeof b.getBackgroundTask === "function",
      subagents: Boolean(b.capabilities?.subagents && typeof b.listSubagents === "function"),
      // サブエージェントの状態（running / completed / failed / stopped）を返せるか。無ければ status は null
      subagentState: typeof b.getSubagentState === "function",
      fork: Boolean(b.capabilities?.fork && typeof b.fork === "function"),
      login: Boolean(b.capabilities?.login && b.auth),
      // 貼り戻し（authSubmit）を受けられるか。**受けられないのに入力欄を出さない**ため。
      // agy はブラウザの折り返しを端末でしか受け取れず、Pleiad から渡す口が無い
      submitCode: typeof b.auth?.submitCode === "function",
      // 宣言だけで書き口が無いものは「持てない」と同じ。UI に書けると思わせない
      title: Boolean(b.capabilities?.title && typeof b.setTitle === "function"),
      tag: Boolean(b.capabilities?.tag && typeof b.setTag === "function"),
    },
    toolHints: b.toolHints ?? {},
    // サブエージェントを呼ぶツールの名前の申告。画面は固定の一覧を持たず、これで委譲のカード・過去の一覧を見分ける
    subagentTools: [...new Set(b.subagentTools ?? [])],
  }));
}

/**
 * このセッションはどのバックエンドのものか。
 *
 * sidecar の backend を一次情報にする（書いた本人が記録している）。
 * 無いときだけ各バックエンドに順に聞く。v1 から引き継いだセッションは
 * sidecar に backend が無いので、この経路で claude に落ちる。
 */
export async function resolveBackendForSession(sessionId) {
  if (!sessionId) return null;
  const managed = await conversationBackend(sessionId);
  if (managed) return sessionBackend(managed);

  const entry = await store.get(sessionId).catch(() => null);
  const known = entry?.backend ? sessionBackend(entry.backend) : null;
  if (known) return known;

  // どのバックエンドも知らない id（消えたセッション、sidecar にだけ残った行）は、
  // 触るたびに全バックエンドへ聞きに行くことになる。短時間だけ「無かった」を覚えて
  // 連打を避ける。sidecar に backend が書かれた時点で上の分岐が先に効くので、
  // 後から作られたセッションがこのキャッシュに邪魔されることはない。
  const missedAt = missed.get(sessionId);
  if (missedAt !== undefined) {
    if (Date.now() - missedAt < MISS_TTL_MS) return null;
    missed.delete(sessionId);
  }

  // 直列で聞くと、バックエンドが増えるほど一覧のクリック1回が遅くなる（codex は
  // stdio JSON-RPC の往復）。同時に聞いて、書かれた順で最初のヒットを採る。
  const backends = listBackends();
  const hits = await Promise.all(backends.map((b) => b.getSession(sessionId).catch(() => null)));
  const i = hits.findIndex(Boolean);
  if (i < 0) {
    rememberMiss(sessionId);
    return null;
  }
  // 次からは聞かなくて済むように覚える
  await store.setMeta(sessionId, { backend: backends[i].id }).catch(() => {});
  return backends[i];
}

const MISS_TTL_MS = 30_000;
const MISS_MAX = 256;
const missed = new Map();   // sessionId -> 「どこにも無い」と分かった時刻

function rememberMiss(sessionId) {
  if (missed.size >= MISS_MAX) {
    const cutoff = Date.now() - MISS_TTL_MS;
    for (const [k, at] of missed) if (at < cutoff) missed.delete(k);
    // それでも減らないなら（短時間に大量の未知 id）諦めて捨てる。上限を超えて持たない
    if (missed.size >= MISS_MAX) missed.clear();
  }
  missed.set(sessionId, Date.now());
}
