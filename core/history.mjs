// 履歴の読み出しと present の永続化。
//
// 通常の会話本文はバックエンド、切り替え済みの会話は conversations.mjs が正本を持つ。
// 読み出しは backend.getMessages に委譲し、ここは形を知らない。
// present だけはどのバックエンドも持たないので sidecar に JSONL で積む。
//   ~/.agent-host/presents/<sessionId>.jsonl
//
// ステータスの候補一覧も「事前定義された設定」ではなく、
// バックエンドの tag と sidecar の history から**既に使われたもの**を集めて作る（設計メモ §6）。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from 'node:crypto';
import * as store from "./store.mjs";
import { writeAtomic } from "./atomic-file.mjs";
import { splitLeadingNotes } from "./system-messages.mjs";
import { cleanBundle, entryName, htmlOnlyBundle } from "./viz-bundle.mjs";
import { inputSig } from "../web/history-sync.mjs";

const PRESENT_DIR = path.join(store.dataDir, "presents");

// present の上限。これを超える content/dataUri は落として印だけ残す。
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** プロフィールを切り替えた行の中身。決まった項目だけを、長さをそろえて残す */
const shortText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const chromeProfileLine = (value) => ({
  browser: value?.browser === 'edge' ? 'edge' : 'chrome', dir: shortText(value?.dir, 64), name: shortText(value?.name, 100), agent: shortText(value?.agent, 100),
});
/** ダウンロードが決着した行の中身。状態は completed・canceled（人が止めた）・failed だけで、保存したパスは終わったものにだけ残す */
export const chromeDownloadLine = (value) => ({
  name: shortText(value?.name, 300),
  state: ['completed', 'canceled', 'failed'].includes(value?.state) ? value.state : 'failed',
  size: Number.isFinite(value?.size) && value.size > 0 ? Math.floor(value.size) : 0,
  path: value?.state === 'completed' && typeof value?.path === 'string' && value.path ? value.path.slice(0, 1000) : null,
});

/** ファイルごとの追記を直列化する（同一セッションへの並行 present で行が壊れないように）。 */
const appendChains = new Map();

function serialize(key, work) {
  const prev = appendChains.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  appendChains.set(key, next.catch(() => {}));
  return next;
}

/** sessionId をそのままファイル名にしない。UUID 以外が来ても外に出さない。 */
function presentFile(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(PRESENT_DIR, `${safe}.jsonl`);
}

// ---------------------------------------------------------------- transcript

/**
 * セッションの会話履歴と、そこで提示された成果物を読み出す。
 * セッションが無くても throw しない（{messages: [], presents: []} を返す）。
 *
 * messages はバックエンドが返す NormalizedMessage:
 *   { role, text, uuid, at, thinking?, tools?, toolCalls? }
 *   tools     … 名前だけの配列（旧形。後方互換で残している）
 *   toolCalls … [{ id, name, input, result: { text, isError, truncated } | null,
 *                  at?, startedAt?, endAt? }]
 *   at / startedAt … 呼び出しの始まり（バックエンドが記録を持つときだけ。時計はバックエンドのまま。
 *                    stream.events を畳んだ仮の発言は、サーバーが付けた tool.start の at と startedAt）
 *   endAt          … 対応する tool_result の時刻（同じく記録があるときだけ。捏造しない）
 * ライブと履歴で同じ表示ができるよう、toolCalls は web/render.mjs の
 * renderToolCall / applyToolResult にそのまま渡せる形にしてある。
 */
export async function loadTranscript(sessionId, backend, options) {
  if (!sessionId) return { messages: [], presents: [] };

  const [raw, stored] = await Promise.all([
    backend?.getMessages ? backend.getMessages(sessionId, options) : Promise.resolve([]),
    backend?.getPresents ? backend.getPresents(sessionId) : readPresents(sessionId),
  ]);
  const presents = await withLegacyBundles(stored);
  const preparing = performance.now();
  const messages = await prepareMessages(sessionId, raw);
  // 圧縮の要約は発言ではなく区切りの中身。分けて返し、server が区切りに入れる（core/compaction-history.mjs の attachCompactSummaries）
  const compactSummaries = messages.filter(m => m?.kind === 'compactSummary');
  options?.timing?.('history.prepare', performance.now() - preparing);
  return { messages: compactSummaries.length ? messages.filter(m => m?.kind !== 'compactSummary') : messages, presents, compactSummaries };
}

/**
 * バックエンドが返した行を、画面に出す前の形へ整える。
 * 中断の後に添えた「止めたもの」の文・bot の会話の先頭の包み（記憶・チャンネルの出来事）は、人の発言から切り分ける（どのバックエンドの行も通る。完了通知の見分けより先に）。
 * 委譲の完了通知として送った発言には internalTaskNotice を、別の会話の AI が送った発言（sessions.send。ADR 0104）には送り手（sentBy）を付ける。
 * loadTranscript とセッション検索の写しが同じ整え方を使う。
 */
export async function prepareMessages(sessionId, raw) {
  const messages = splitLeadingNotes(raw);
  const side = await store.get(sessionId);
  const notices = new Set(side.taskNotices ?? []);
  const relayed = new Map((side.relayed ?? []).map(r => [r.hash, r.sentBy]));
  // 委譲の子の会話へ実際に渡った発言の台帳（core/server.mjs の recordDelivery。ADR 0317）。人が直接送った発言か、依頼元の AI の追加の指示かを決める元
  const human = humanMessages(messages, side.deliveries ?? []);
  for (const m of messages) {
    if (m.role !== 'user' || m.kind) continue;
    const hash = crypto.createHash('sha256').update(m.text ?? '').digest('hex');
    if (notices.has(hash)) m.internalTaskNotice = true;
    else if (relayed.has(hash)) m.sentBy = relayed.get(hash);
    else if (human.has(m)) m.sentByHuman = true;
  }
  return messages;
}

/**
 * 履歴の発言のうち、人が直接送ったもの（台帳の by: human）の集合。台帳の行に ID を持つ（nativeId = バックエンドが付けた発言の uuid）ものは、
 * その uuid の発言と 1 対 1 で結ぶ。uuid を返さないバックエンド（codex など）と、まだ uuid が付いていない行は、同じ本文の発言どうしを
 * 末尾から数えて結ぶ（履歴の最後の「続けて」は台帳の最後の「続けて」）。台帳の上限で古い行が落ちても、履歴の古い発言が結ばれないだけで
 * 新しい発言の判定は変わらない。同じ本文が AI からも人からも来ていても、台帳の by で見分ける。
 */
function humanMessages(messages, ledger) {
  const human = new Set();
  if (!ledger.length) return human;
  const byNative = new Map(messages.filter(m => m.role === 'user' && !m.kind && m.uuid).map(m => [m.uuid, m]));
  const taken = new Set();
  const loose = new Map();
  for (const entry of ledger) {
    const m = entry.nativeId ? byNative.get(entry.nativeId) : null;
    if (m && !taken.has(m)) { taken.add(m); if (entry.by === 'human') human.add(m); continue; }
    if (!loose.has(entry.hash)) loose.set(entry.hash, []);
    loose.get(entry.hash).push(entry);
  }
  const rest = new Map();
  for (const m of messages) {
    if (m.role !== 'user' || m.kind || taken.has(m)) continue;
    const hash = crypto.createHash('sha256').update(m.text ?? '').digest('hex');
    if (!rest.has(hash)) rest.set(hash, []);
    rest.get(hash).push(m);
  }
  for (const [hash, entries] of loose) {
    const shown = rest.get(hash) ?? [];
    for (let i = 1; i <= Math.min(entries.length, shown.length); i++) {
      if (entries.at(-i).by === 'human') human.add(shown.at(-i));
    }
  }
  return human;
}

// ------------------------------------------------------------------ present

export async function readPresents(sessionId, { strict = false } = {}) {
  await appendChains.get(presentFile(sessionId));
  let raw;
  try {
    raw = await fs.readFile(presentFile(sessionId), "utf8");
  } catch (e) {
    if (strict && e.code !== "ENOENT") throw e;
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      if (strict) throw e;
      // 書き込み途中で落ちた行は捨てる。1行壊れても残りは読める
    }
  }
  return out;
}

/**
 * present を1件記録する。payload は present イベントと同じ形。
 * dataUri は数 MB になるので、上限を超えるものは中身を落として印だけ残す
 * （履歴として「出した」ことは残り、開き直しても一覧が壊れない）。
 */
export async function recordPresent(sessionId, payload) {
  if (!sessionId || !payload) return null;

  const record = {
    // git の要約の行（kind: 'git'。ADR 0085）は、ターンの終わりの時刻を渡されて、その並びで会話に出る
    at: (payload.kind === 'git' || payload.kind === 'worktree') && typeof payload.at === 'string' ? payload.at : new Date().toISOString(),
    kind: payload.kind ?? "text",
    caption: payload.caption ?? null,
    // 添付の caption は日本語の文のまま残し、画面はキーで今の言語に訳す（core/server.mjs presentAttachments・web/saved-text.mjs）
    ...(payload.captionKey ? { captionKey: payload.captionKey, captionParams: payload.captionParams ?? null } : {}),
    path: payload.path ?? null,
    // id は可視化を後から指すため（隔離の origin の束・ファイルのページの一覧）。以前の記録は at で指す
    ...(payload.kind === 'visualization' ? { id: crypto.randomUUID(), mode: payload.mode, error: payload.error, reference: payload.reference } : {}),
    // 可視化の束（core/visualize.mjs が載せる。ADR 0295 の 3 の 4）。隔離の origin が /viz/<hash>/ で配る
    ...(payload.kind === 'visualization' && cleanBundle(payload.bundle) ? { bundle: cleanBundle(payload.bundle) } : {}),
    // 誰が置いたか。人間の添付と AI の提示は同じ流れに並ぶので、履歴でも区別できるようにする
    by: payload.by === "human" ? "human" : "ai",
    // 人間の添付の出どころ（host: ホストのファイルをパスで渡した / device: この端末から送った）と大きさ。一覧の面が出す（web/attachment-list.mjs）
    ...(payload.origin === "host" || payload.origin === "device" ? { origin: payload.origin } : {}),
    ...(Number.isFinite(payload.size) && payload.size >= 0 ? { size: payload.size } : {}),
    ...(payload.turnKey ? { turnKey: payload.turnKey } : {}),
    ...(payload.kind === 'git' ? { git: payload.git ?? null } : {}),
    // worktree で始めた印の行（ADR 0089）: { id, branch, origin, conflicts: [別の会話の題], count }
    ...(payload.kind === 'worktree' ? { worktree: payload.worktree ?? null } : {}),
    // 引き継いで戻した行（core/chrome/control.mjs）: { seconds }（引き継いでいた秒数）
    ...(payload.kind === 'chromeHandover' ? { chromeHandover: { seconds: Number.isFinite(payload.chromeHandover?.seconds) ? Math.max(0, Math.round(payload.chromeHandover.seconds)) : 0 } } : {}),
    // エージェントがプロフィールを切り替えた行（core/chrome/profile-choice.mjs）: { browser, dir, name, agent }（表示名とフォルダー名だけ）
    ...(payload.kind === 'chromeProfile' ? { chromeProfile: chromeProfileLine(payload.chromeProfile) } : {}),
    // 会話の Chrome のウィンドウのダウンロードが決着した行（core/chrome/downloads.mjs）: { name, state, size, path }（path は終わったものだけ）
    ...(payload.kind === 'chromeDownload' ? { chromeDownload: chromeDownloadLine(payload.chromeDownload) } : {}),
    ...(payload.kind === 'chromeClosed' ? { chromeClosed: { by: ['agent', 'human', 'idle'].includes(payload.chromeClosed?.by) ? payload.chromeClosed.by : 'human' } } : {}),
  };

  const inline =
    Buffer.byteLength(payload.content ?? "", "utf8") + Buffer.byteLength(payload.dataUri ?? "", "utf8");
  // truncated: 載せる前から中身を外したもの（大きな添付の画像。core/server.mjs の presentAttachments）
  if (inline > MAX_INLINE_BYTES || payload.truncated === true) {
    record.truncated = true;
  } else {
    if (payload.content != null) record.content = payload.content;
    if (payload.dataUri != null) record.dataUri = payload.dataUri;
  }

  const file = presentFile(sessionId);
  await serialize(file, async () => {
    await fs.mkdir(PRESENT_DIR, { recursive: true });
    await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  });
  return record;
}

// 束の無い可視化の行（束を持つ前の版の記録）は、読むときに HTML だけの束を書いて付ける（ADR 0295 の 3 の 4）。
// 記録の行は書き換えない（付けるのは返す写し）。同じ中身は書き直さないよう、中身のハッシュで覚えておく。
// 書いた束は記録に名前が出ないので、起動の片付けの猶予（1 時間）を過ぎれば消え、次に読むときにまた書く
const legacyBundles = new Map();
const LEGACY_CACHE = 500;
async function legacyBundle(row) {
  const key = crypto.createHash('sha256').update(`${row.path ?? ''}\u0000${row.content}`).digest('hex');
  if (legacyBundles.has(key)) return legacyBundles.get(key);
  const bundle = await htmlOnlyBundle(store.dataDir, { entry: entryName(row.path), body: row.content, reason: 'legacy' }).catch(() => null);
  if (bundle) {
    while (legacyBundles.size >= LEGACY_CACHE) legacyBundles.delete(legacyBundles.keys().next().value);
    legacyBundles.set(key, bundle);
  }
  return bundle;
}

/** 束の無い可視化の行に HTML だけの束を付けた写しを返す */
export async function withLegacyBundles(presents) {
  if (!Array.isArray(presents)) return presents;
  const out = [];
  for (const p of presents) {
    if (p?.kind === 'visualization' && typeof p.content === 'string' && !p.error && !cleanBundle(p.bundle)) {
      const bundle = await legacyBundle(p);
      out.push(bundle ? { ...p, bundle } : p);
    } else out.push(p);
  }
  return out;
}

/**
 * 会話に保存された提示の本文（content・dataUri）を 1 つ探す（画面が /present-body で取りに行く。ADR 0182）。
 * 画面が持っている通し番号 i を先に見て、その時刻（at）が合えば採る。ずれていたら（走っているターンの提示の並びと記録の並びが違うとき）時刻で探す。
 * 本文が文字列で無いもの・上限を超えて落とした提示は null
 */
export async function findPresentBody(sessionId, backend, { i, at, field }) {
  if (!sessionId || (field !== 'content' && field !== 'dataUri')) return null;
  const presents = backend?.getPresents ? await backend.getPresents(sessionId) : await readPresents(sessionId);
  const body = (p) => typeof p?.[field] === 'string' ? p[field] : null;
  const direct = Number.isInteger(i) ? presents[i] : null;
  if (direct && body(direct) !== null && (!at || direct.at === at)) return body(direct);
  if (!at) return null;
  const found = presents.find(p => p?.at === at && body(p) !== null);
  return found ? body(found) : null;
}

/**
 * 会話のツール呼び出しの入力（input）の全文を 1 つ探す（画面が /tool-input で取りに行く。ADR 0334）。
 * loadSession は入力の大きい文字列を頭だけにして運び、呼び出しの id と入力の署名（inputSig）を印にする。ここはその 2 つが合う呼び出しの入力を返す。
 * 署名が合わなければ（記録が書き換わった・巻き戻した後）別の入力を返さず null。
 * extra は走っているターンの発言（まだ記録に載っていない呼び出し）。記録より先に見る（メモリの中だけで済む）
 */
export async function findToolInput(sessionId, backend, { id, sig, extra = [] }) {
  if (!sessionId || typeof id !== 'string' || !id || !Number.isFinite(sig)) return null;
  const find = (messages) => {
    for (const message of messages ?? []) {
      for (const call of message?.toolCalls ?? []) {
        if (call?.id === id && call.input !== null && typeof call.input === 'object' && inputSig(call.input) === sig) return call.input;
      }
    }
    return null;
  };
  return find(extra) ?? find(backend?.getMessages ? await backend.getMessages(sessionId) : []);
}

/** Bind human attachments to a durable message UUID (some agents do not record timestamps). */
export async function anchorAttachments(sessionId, turnKey, messageId) {
  if (!messageId) return;
  const file = presentFile(sessionId);
  await serialize(file, async () => {
    let raw;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    const rows = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
    for (const row of rows) if (row.turnKey === turnKey && row.by === "human") row.messageId = messageId;
    // 一意な一時ファイル＋一時的に開けないときだけ rename をやり直す（core/atomic-file.mjs）
    await writeAtomic(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  });
}

/**
 * 巻き戻しで、切り口より後の提示を捨てる。keep は readPresents（strict）が返す並びの添字のうち残すもの。
 * 読み取りと同じ並びで数えるので、呼ぶ前に別の present を足さないこと（巻き戻しの間は会話を排他で押さえている）
 */
export async function keepPresents(sessionId, keep) {
  const file = presentFile(sessionId);
  await serialize(file, async () => {
    let raw;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    const rows = raw.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    const kept = rows.filter((_, i) => keep.has(i));
    if (kept.length === rows.length) return;
    await writeAtomic(file, kept.map(row => JSON.stringify(row)).join("\n") + (kept.length ? "\n" : ""));
  });
}

/** 分岐した会話の提示の記録を、元の会話から選んだ行で始める（ネイティブの分岐は transcript だけを写す。core/conversations.mjs の fork） */
export async function seedPresents(sessionId, rows) {
  if (!rows.length) return;
  const file = presentFile(sessionId);
  await serialize(file, async () => {
    await fs.mkdir(PRESENT_DIR, { recursive: true });
    await writeAtomic(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  });
}

/** 会話を消したときに、その会話の提示（添付・present・可視化の写し）の記録を消す（sessions.delete。ADR 0147） */
export async function forgetPresents(sessionId) {
  const file = presentFile(sessionId);
  await serialize(file, () => fs.rm(file, { force: true }));
}

// ----------------------------------------------------------------- statuses

/**
 * これまで使われた状態の一覧 [{ status, count, firstUsedAt, lastUsedAt, icon, kept }]。
 * 既出順（初めて使われた順、firstUsedAt）。一覧のグループも候補もこの順で出す。並べ直すのはここだけ。
 * **事前定義された選択肢ではない。** 既出のものを補完候補として出すだけで、
 * 人間も AI も新しい語をその場で作ってよい（設計メモ §6）。
 *
 * 候補とグループは違う。ここに出る状態が全部グループになるわけではない:
 *   候補   … ここに出るもの全部（履歴にだけ残っている旧名も。語彙は消さない）
 *   グループ … 今どれかのセッションに付いている状態、または kept（statuses.json にある = 人が作った器）
 * グループの削除は「付いているセッションの状態を外し、器を捨てる」。履歴は残るので候補には残る
 * （web/side.mjs の groupOrder がこの規則で出し分ける）。
 *
 * 集める先は2つ:
 *   sidecar history         … いつ変えたかが分かる。同じ状態を何度使ったかも数えられる
 *   バックエンドの tag       … 公式 CLI など agent-host の外で付けたものも拾える
 *                              （ネイティブに tag を持てるバックエンドだけ）
 * list はネイティブ一覧の読み方。サーバーは使い回しの一覧（core/server.mjs の nativeSessions）を渡す
 */
export async function listStatuses(backends = [], { list = (b, limit) => b.listSessions({ limit }), extra = [] } = {}) {
  const [side, entries, ...lists] = await Promise.all([
    store.getAll().catch(() => ({})),
    store.getStatusEntries().catch(() => ({})),
    ...backends.map((b) =>
      b.capabilities?.tag ? Promise.resolve().then(() => list(b, 500)).catch(() => []) : Promise.resolve([]),
    ),
  ]);

  const seen = new Map(); // status -> { status, count, firstUsedAt, lastUsedAt }

  const bump = (status, at) => {
    if (typeof status !== "string" || !status.trim()) return;
    const hit = seen.get(status);
    if (!hit) {
      seen.set(status, { status, count: 1, firstUsedAt: at ?? null, lastUsedAt: at ?? null });
      return;
    }
    hit.count += 1;
    if (at && (!hit.lastUsedAt || at > hit.lastUsedAt)) hit.lastUsedAt = at;
    if (at && (!hit.firstUsedAt || at < hit.firstUsedAt)) hit.firstUsedAt = at;
  };

  // 1) sidecar の history。ここが「いつ・何度」の一次情報
  const recorded = new Map(); // sessionId -> Set<status>
  for (const [sessionId, entry] of Object.entries(side)) {
    const names = new Set();
    for (const h of entry?.history ?? []) {
      if (h?.field !== "status") continue;
      bump(h.to, h.at);
      if (typeof h.to === "string") names.add(h.to);
    }
    recorded.set(sessionId, names);
  }

  // 2) バックエンドの tag。history に無い分だけ足す（同じ変更を二重に数えない）
  for (const sessions of lists) {
    for (const s of sessions) {
      if (!s.tag) continue;
      if (recorded.get(s.sessionId)?.has(s.tag)) continue;
      const at = side[s.sessionId]?.statusChangedAt ?? isoOrNull(s.lastModified);
      bump(s.tag, at);
    }
  }

  // 3) 会話の外で付いた状態（チャンネルのスレッドの状態。{ status, at }）。脇の「状態」の並べ方で会話と同じ器に入る
  for (const e of extra) bump(e?.status, isoOrNull(e?.at));

  // 4) statuses.json。人が作った（まだ誰も付いていない）グループはここにしか無い。
  //    ある限り存在する（count 0、firstUsedAt は作った時刻）。アイコンも合流。付いていない状態は icon: null
  for (const [status, e] of Object.entries(entries)) {
    const hit = seen.get(status);
    if (!hit) seen.set(status, { status, count: 0, firstUsedAt: e.createdAt ?? null, lastUsedAt: null });
    else if (e.createdAt && (!hit.firstUsedAt || e.createdAt < hit.firstUsedAt)) hit.firstUsedAt = e.createdAt;
  }
  const out = [...seen.values()].map((s) => ({ ...s, icon: entries[s.status]?.icon ?? null, kept: Boolean(entries[s.status]) }));
  // 既出順。いつ使われたか分からないものは後ろ
  return out.sort(
    (a, b) => String(a.firstUsedAt ?? "￿").localeCompare(String(b.firstUsedAt ?? "￿")),
  );
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
