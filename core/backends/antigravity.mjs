// Google Antigravity CLI（`agy`）のバックエンド。
//
// これが Pleiad で **Google のサブスク枠（AI Pro / Ultra）を正規の手段で使える唯一の道**。
// gemini-cli の個人向けログインは 2026-06-18 に終了し、Gemini API キーは別建ての従量課金、
// Antigravity SDK は API キーか Vertex しか受けない（docs/multi-backend.md §2.8）。
//
// **代わりに諦めているもの**（プロトコルの制約。こちらの手抜きではない）:
//   1. **ターン中の対話承認が無い。** 公式に非対応。承認が取れないツールは soft-deny され、
//      ターンは止まらない。Pleiad の承認カードは出せず、**承認モードも「全部自動」1 つだけ**
//      （それ以外を選ばせると黙って何もできないだけになる。MODES のコメント参照）
//   2. **思考が流れない。** `thinking_tokens` は完了時の集計にしか出ない
// 本文のデルタは流れ、ツールも「実行中」から出る（同じ step_index で state: ACTIVE -> DONE の
// 2 回来るのを分けている。docs/multi-backend.md §2.8）ので、会話が流れる見た目そのものは
// 他のバックエンドと変わらない。
//
// **出力の打ち切りに気をつける。** agy の `--print-timeout`（既定 5m0s）はターンを打ち切り、
// 本文が空のまま `status:"SUCCESS"` を返す。しかも agy 自身は裏で走り続ける。
// そこで (a) 十分長い `--print-timeout` を渡し（antigravity-cli.mjs）、
// (b) それでも打ち切られたら失敗として畳み、その agy を落とす（onPrintTimeout）。
import { cliCommand, spawnCli } from "../cli-installation.mjs";
import { AgySession, START_TIMEOUT_MS } from "./antigravity-cli.mjs";
import { AGENT_NAME, adoptHome, prepareAgent, sweep } from "./antigravity-context.mjs";
import { nativeInstructionEntries } from "../context-session.mjs";
import * as pids from "./antigravity-pids.mjs";
import * as transcript from "./antigravity-store.mjs";
import { AGY_LEVELS, agyTarget, buildAgyModels, defaultLabelFromLog, parseAgyModels } from "./antigravity-models.mjs";
import { MAX_RESULT_CHARS, cutText } from "./shared.mjs";
import { writeAtomic } from "../atomic-file.mjs";
import { antigravityLimit } from "./antigravity-limit.mjs";
import { undelivered } from "./undelivered.mjs";
import { agyComputerName, computerFailed, computerPrompt, computerResult, computerToolInput } from "./computer-delivery.mjs";
import { createHeldAgy, heldPlan, sweepIdle } from "./antigravity-held.mjs";
// antigravity-suggest.mjs（使い捨てホームで候補を作る）は、内部呼出しを分離して呼べる保証が無いため使わない（Issue #180）
import { commandLabel, killTree, listProcesses, pickCommandProcess, pickHeldAgy } from "./antigravity-background.mjs";
import { t, agentT } from "../i18n.mjs";
import { mcpContacted, mcpContactsWatched } from "../mcp-contact.mjs";
import { createLoginWatch, loginTimeoutError } from "../auth/login-watch.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from '../store.mjs';
import { recordBackendShapeMismatch } from '../backend-shape-diagnostics.mjs';
import { readAgyRuns, rotateAgyRuns } from '../hooks-unify.mjs';
import { CAPABILITY_STATES, AGENT_TRAITS } from './agent-marks.mjs';

/**
 * 本文の無い SUCCESS を確定するまでに、打ち切りの印（stderr）を待つ時間。
 * 印は stderr、result は stdout と**別のパイプ**で届くので、着く順は保証されない
 * （agy は印を先に書くが、Linux では result が先に読めることがある）。
 */
const EMPTY_SUCCESS_GRACE_MS = Number(process.env.AGENT_HOST_AGY_EMPTY_SUCCESS_MS ?? 500);
const LATE = Symbol("late");

/** ターンの途中で本文を控えに書き足す間隔。ツールの完了はすぐ書く */
const TEXT_SAVE_MS = Number(process.env.AGENT_HOST_AGY_SAVE_MS ?? 2_000);

/**
 * run_command が ACTIVE のままこれだけたったら、裏のコマンドとして一覧（background）に出す。agy は WaitMsBeforeAsync（20 秒）を過ぎた
 * コマンドを裏へ回し、AI は wait で待ち続ける（終わるまで DONE が来ない）。止める口は stopBackground（antigravity-background.mjs）
 */
const BACKGROUND_AFTER_MS = Number(process.env.AGENT_HOST_AGY_BACKGROUND_MS ?? 30_000);

/** 裏のコマンドを落とした後、agy の DONE を待つ上限 */
const STOP_WAIT_MS = Number(process.env.AGENT_HOST_AGY_STOP_WAIT_MS ?? 15_000);

/** setTimeout が受ける最大の遅れ（2^31−1 ms。約 24.8 日）。これを超える値と Infinity を、Node は 1 ms にする */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * AGENT_HOST_AGY_IDLE_MS の値を、タイマーに渡す ms にする。止めないときは null（`0` 以下・数でない・setTimeout の上限を超える・Infinity）。
 * 上限を超えた値をそのまま渡すと 1 ms になり、ターンのたびに止まって起こし直しになる。大きい値を入れた人の意図（止めない）に合わせる
 */
export function idleDelay(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS ? ms : null;
}

/**
 * ターンを終えて次の発言を待つ agy を止めるまでの ms（`0` 以下・setTimeout の上限を超える値で止めない。idleDelay）。次のターンは `--conversation` で起こし直す。
 * 動いている agy は起動の時にしかキーチェーンの資格情報を読まず、1 時間ごとにメモリのトークンを更新して書き戻す。
 * ログインを切り替えた後も、前から生きている agy が古い方の資格情報で上書きし、切り替えが戻る（docs/multi-backend.md §2.8）。
 * 既定を 30 分にしたのは、極端に長く残る agy（数時間〜数日）だけを拾えればよいため。
 * 10 分（Pleiad のコンテキストの接続の WARM_IDLE_MS）だと、少し間を空けて続ける会話のたびに起こし直しになり、起動を待たせる。
 * 30 分なら、書き戻しの間隔（1 時間）より短く、普通の会話の間では起こし直さない
 */
const IDLE_MS = idleDelay(process.env.AGENT_HOST_AGY_IDLE_MS ?? 30 * 60_000);

/**
 * 承認モード。**`yolo` の 1 つだけ**にしてある。
 *
 * `agy --help` には `--mode plan` と `--mode accept-edits` もあるが、**ヘッドレスでは使い物にならない**。
 * ターン中の対話承認がプロトコルに無いため、`--dangerously-skip-permissions` を付けない限り
 * 許可の要るツールは **soft-deny** される（ターンは止まらず、stderr に通知が出るだけ）。
 * しかも `--print` モードは settings.json の `permissions.allow` を見ない（[antigravity-cli#548]）ので、
 * 事前付与で埋めることもできない。
 *
 * つまり plan / accept-edits を選べるようにすると、「モードを選んだのにエージェントが
 * 黙って何もできない」だけになる。**選べる形で出さない**。
 * 同じ理由で「都度確認」も無い（聞くと言って聞かないものを作らない）。
 *
 * **組織の管理ポリシーは skip より強い。** Gemini Enterprise の管理者が確認を求める設定にしていると、
 * `--dangerously-skip-permissions` を付けても init の `permission_mode` は `request-review` になり、
 * 確認の要るツールは拒否される。黙らせずに知らせる（下の adminNotice。docs/multi-backend.md §2.8「組織の管理ポリシー」）
 *
 * [antigravity-cli#548]: https://github.com/google-antigravity/antigravity-cli/issues/548
 */
const MODES = {
  yolo: {
    // label / note はゲッター（サーバーの言語は実行中に変わる。core/i18n.mjs）
    get label() { return t("modes.full"); },
    get short() { return t("modesShort.full"); },
    get note() { return t("antigravity.modes.yolo"); },
    skip: true,
    // 軸（core/modes.mjs）。範囲を絞る手段が無いので full、強制もできない。
    scope: "full",
    autonomy: "never",
    enforced: false,
  },
};

/**
 * `--effort` の値（`agy --help` で確認）。画面に出す段の候補はモデル一覧の efforts から取る（core/effort.mjs）。
 * agy の段は「段違いの id を選ぶ」ことなので、`--effort` はそのまま渡さない（antigravity-models.mjs の agyTarget）
 */
const EFFORTS = AGY_LEVELS;

/**
 * ツールの表示ヒント。`agy` は `tool_name` を素の文字列で出す
 * （実機の例では `run_command`）。よく出るものだけ名前で拾い、残りは総称にする。
 */
// label はゲッター（共有キー tools.*。言語は実行中に変わる）
// i18n-dynamic: tools.
const hint = (key, shape) => ({ get label() { return t(`tools.${key}`); }, shape });
const TOOL_HINTS = {
  run_command:   hint("run", "shell"),
  read_file:     hint("read", "read"),
  write_file:    hint("write", "write"),
  edit_file:     hint("edit", "edit"),
  replace:       hint("edit", "edit"),
  grep_search:   hint("search", "search"),
  find_by_name:  hint("find", "search"),
  list_dir:      hint("list", "read"),
  read_url:      hint("fetch", "web"),
  search_web:    hint("webSearch", "web"),
};

/** 会話ごとの生きたプロセス。**1 プロセス = 1 会話**（antigravity-cli.mjs 冒頭）。 */
const live = new Map();   // conversationId -> AgySession

// 前の起動が残した孤児を掃除する（強制終了・クラッシュでは下の exit が走らないため）。
// 待たない。**実行ファイル名を確かめたものしか落とさない**（antigravity-pids.mjs）
const reaped = pids.reap().catch(() => []);
// 前の起動が残した、Pleiad のコンテキストを渡すためのエージェント定義も消す（antigravity-context.mjs）
sweep();

/** 会話から手を引く。生かしている印（live / pid の控え）を揃って落とす。 */
/**
 * Pleiad が渡した hooks の発火（アダプターが置き場の runs.jsonl に書いたもの）を記録にする。agy は hooks の実行を stream に出さないため。
 * ネイティブの定義の発火は分からない（止めたはずの定義が走ったかは観測できない）
 */
async function reportHookRuns(session, hooksRuntime, emit) {
  const at = session?.hookRuns;
  if (!at) return;
  // 入れ替えた古いファイルの続き（入れ替えの間に書かれた行）を先に読む。新しい行が無くなったら捨てる
  const runs = [];
  if (at.old) {
    const r = await readAgyRuns(at.old.file, at.old.offset);
    runs.push(...r.runs);
    if (r.offset === at.old.offset && !r.more) { await fs.promises.rm(at.old.file, { force: true }).catch(() => {}); at.old = null; }
    else at.old.offset = r.offset;
  }
  // 上限ずつ、最後の改行まで読む（書きかけの行は次のターンに回す）
  for (let i = 0; i < 16; i++) {
    const r = await readAgyRuns(at.file, at.offset);
    runs.push(...r.runs);
    at.offset = r.offset;
    if (!r.more) break;
  }
  // 長く続く会話でファイルが育たないように、読み終えた分が大きくなったら入れ替える
  const rotated = !at.old && await rotateAgyRuns(at.file, at.offset);
  if (rotated) { at.old = { file: rotated.old, offset: rotated.oldOffset }; at.offset = 0; }
  const names = new Map((hooksRuntime?.supplied ?? []).map(s => [s.hook.id, s.hook.name]));
  for (const r of runs) emit({ type: 'hookRun', phase: r.phase === 'started' ? 'started' : 'response', hookId: r.runId, name: names.get(r.id) ?? r.id, event: String(r.event ?? ''),
    pleiad: true, id: r.id, ...(r.phase === 'response' ? { outcome: ['success', 'error', 'cancelled'].includes(r.outcome) ? r.outcome : 'error',
      ...(Number.isInteger(r.exitCode) ? { exitCode: r.exitCode } : {}), ...(Number.isInteger(r.ms) ? { ms: r.ms } : {}) } : {}) });
}

function release(conversationId, session) {
  disarmIdle(session);
  if (conversationId && live.get(conversationId) === session) live.delete(conversationId);
  if (session?.pid) pids.forget(session.pid);
}

/** 次のターンを待ち始めた agy に、IDLE_MS で止めるタイマーを付ける。止めた後の次のターンは起こし直す（会話は --conversation で続く） */
function armIdle(conversationId, session) {
  disarmIdle(session);
  if (IDLE_MS === null || !conversationId || !session?.proc || live.get(conversationId) !== session) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (live.get(conversationId) !== session) return;
    try { session.kill(); } catch {}
    release(conversationId, session);
  }, IDLE_MS);
  session.idleTimer.unref?.();
}

function disarmIdle(session) {
  if (!session?.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

/** 直近に引けたモデル一覧。`agy models` は認証が要るので、引けたときだけ覚える。 */
let modelCache = null;
/** 一覧を引いた（写しから戻した）時刻。古い形の写しには時刻が無いので 0（＝古い） */
let modelCacheAt = 0;
/** 一覧の写し（AGENT_HOST_DATA/antigravity/models.json）の読み込み。全員が同じ 1 本を待つ */
let modelsCacheLoad = null;
/** 進行中の `agy models`。並ぶ取得は同じ 1 本を待つ（single-flight） */
let modelsFetch = null;
/** 最後に一覧の取得を試みた時刻（成否を問わない）。失敗の繰り返しを止める間隔に使う */
let modelsFetchTriedAt = 0;
/**
 * 覚えた一覧を古いとみなすまでの ms（`AGENT_HOST_AGY_MODELS_TTL_MS`。既定 5 分）。
 * agy の既定（/model の選択）は Pleiad の外で変わり得るので、過ぎた一覧は読み取りをきっかけに裏で引き直す（issue #161）。
 * 読み取りごとに評価する（試験が途中で変えられるように）
 */
const modelsTtlMs = () => Number(process.env.AGENT_HOST_AGY_MODELS_TTL_MS ?? 5 * 60_000);

/** ログインを 2 本同時に走らせないための印。 */
let pendingAuth = null;
/**
 * 最後に分かったログインの見通し（'unknown'|'in'|'out'。プロセス内だけ）。
 * 受動の照会が `agy` を起こさないための状態表示用。`agy models`（未ログインだと「Please sign in」で落ちるか、
 * 環境によっては認証待ちになるサブコマンド）は、このプロセスでログイン済みと確かめられた所
 * （人の明示の確認・ログイン・使用量の読み・認証を通ったターン）でだけ起こす。
 * `--print` 系（公式の headless 保証）は受動でも起こせる
 */
let authGuess = "unknown";
/** 未認証の印（`agy models` の「Please sign in」と `--print` 系の authentication required） */
const AUTH_REQUIRED = /sign in|authentication required/i;

/** 待っているログインの見張りをやめる口（authCancel）。 */
const loginWatch = createLoginWatch("Antigravity");

/** 端末でのログインを待つ上限。 */
const LOGIN_TIMEOUT_MS = Number(process.env.AGENT_HOST_AGY_LOGIN_MS ?? 10 * 60_000);

/** 待っている間に `agy models` を叩く間隔。 */
const LOGIN_POLL_MS = Number(process.env.AGENT_HOST_AGY_POLL_MS ?? 3_000);

const cut = (s) => {
  const text = String(s ?? "");
  return text.length > MAX_RESULT_CHARS
    ? { text: cutText(text, MAX_RESULT_CHARS, t("antigravity.truncated")), truncated: true }
    : { text, truncated: false };
};

const modeFor = (id) => (Object.hasOwn(MODES, id) ? id : "yolo");
const effortFor = (e) => (EFFORTS.includes(e) ? e : "");

/** `result.status` -> turnResult（公式ドキュメントの 7 値）。使用量の上限の失敗は limited と解除の時刻にそろえる（antigravity-limit.mjs。ADR 0119） */
function turnResultFor(result, { finishedReply = false } = {}) {
  const status = result?.status;
  if (status === "SUCCESS") return { type: "turnResult", outcome: "ok", turns: result?.num_turns ?? 1 };
  // agy can fail in a later internal request after completing the answer. Keep the
  // failure as a diagnostic, but do not discard the already completed reply.
  if (finishedReply) return { type: "turnResult", outcome: "ok", turns: result?.num_turns ?? 1,
    backendFailure: { status: String(status ?? ''), error: String(result?.error ?? '') } };
  if (status === "CANCELED" || status === "INTERRUPTED") return { type: "turnResult", outcome: "aborted", turns: 1 };
  const limit = antigravityLimit(result?.error);
  if (limit) return { type: "turnResult", outcome: "limited", turns: result?.num_turns ?? 1, error: String(result.error), resetsAt: limit.resetsAt, window: null };
  return {
    type: "turnResult", outcome: "error", turns: result?.num_turns ?? 1,
    error: String(result?.error || t("antigravity.errors.endedWith", { status: status ?? t("antigravity.errors.unknownStatus") })),
  };
}

/**
 * agy が何も実行せずに断ったターンか（docs/multi-backend.md §2.8「思考の署名が通らない会話」）。
 * 再開した会話で、前のターンの思考の署名を API が受け付けないと、step を 1 つも始めないまま
 * `INVALID_ARGUMENT (code 400): Invalid thought signature.` の ERROR だけが返る（実機の記録）。同じ会話へ何度送っても同じく断られる。
 * step が始まった・本文が出たターンは、何かを実行したかもしれないので当てない
 */
function rejectedBeforeRun(result, { steps = 0, sawText = false } = {}) {
  return String(result?.status ?? "").toUpperCase() === "ERROR"
    && /invalid thought signature/i.test(String(result?.error ?? ""))
    && steps === 0 && !sawText && !String(result?.response ?? "").trim();
}

/** 確認を出せずに拒否されたツールの文面（実機の `tool_info.error.message`。組織の管理ポリシーの「要審査」など） */
const DENIED_RE = /permission check failed|denied permission/i;

/**
 * 確認なしで渡したのに init が返したら、管理側の設定（「ターミナル自動実行モード」が「要審査」）が勝っていると分かる permission_mode（実機 1.5 系で確認）。
 * 知らない値（「サンドボックスで続行」のときなど）は確認が要るとは限らないので知らせない
 */
const REVIEW_MODES = new Set(["request-review"]);

/** 中継に渡したトークン（antigravity-context.mjs の prepareAgent の env）。1 本でも口へ来れば、agy は Pleiad の MCP を起こしている */
const RELAY_AUTH_KEYS = ["PLY_CONTEXT_AUTHORIZATION", "PLY_AGENTS_AUTHORIZATION", "PLY_COMPUTER_AUTHORIZATION", "PLY_BROWSER_AUTHORIZATION", "PLY_CONTROL_AUTHORIZATION"];
const relayTokens = (env) => RELAY_AUTH_KEYS.map((k) => env?.[k]).filter((v) => typeof v === "string" && /^Bearer [a-f0-9]{64}$/.test(v));

/**
 * agy の最初の result で 1 度だけ出す、組織の管理ポリシーの知らせ（無ければ ""）。
 * 確認の要るモードで動いている・中継に 1 度も接続が無い、のどちらか（両方なら両方）。
 * 拒否で失敗にしたターン（deniedTurn）は失敗の理由に案内を書くので、モードの分は重ねない
 */
function adminNotice(session, { askedSkip, deniedTurn }) {
  const parts = [];
  const mode = String(session.permissionMode ?? "");
  if (!session.reviewNoticed && askedSkip && REVIEW_MODES.has(mode.toLowerCase())) {
    session.reviewNoticed = true;
    if (!deniedTurn) parts.push(t("antigravity.admin.reviewMode", { mode, ask: t("antigravity.admin.askTools") }));
  }
  if (!session.mcpChecked && session.mcpTokens?.length && mcpContactsWatched()) {
    session.mcpChecked = true;
    if (!session.mcpTokens.some(mcpContacted)) parts.push(t("antigravity.admin.mcpMissing", { ask: t("antigravity.admin.askMcp") }));
  }
  return parts.map((body) => `> ${t("antigravity.admin.notice", { body })}`).join("\n>\n");
}

/**
 * `result.usage`（またはその差）-> Pleiad の usage イベント。
 * agy の usage は分けて数える（input_tokens はキャッシュ読みを含まない。total_tokens = input + output + thinking）。Claude・Codex と同じく
 * 「入力はキャッシュ読みを含み、cachedTokens はその内訳」「出力は考えた分を含む」にそろえる。
 * そろえないと、入力よりキャッシュ読みが大きくなって、キャッシュの割合が 100% に張り付く。
 */
function usageFor(usage) {
  if (!usage) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const cached = n(usage.cache_read_tokens);
  return {
    type: "usage",
    inputTokens: n(usage.input_tokens) + cached,
    outputTokens: n(usage.output_tokens) + n(usage.thinking_tokens),
    cachedTokens: cached,
  };
}

const USAGE_KEYS = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"];
/** `result.usage` の数（agy の会話の始まりからの累計。1.5.2 で実測）。無ければ null */
function usageTotal(usage) {
  if (!usage || typeof usage !== "object") return null;
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, Number.isFinite(usage[key]) && usage[key] > 0 ? usage[key] : 0]));
}
/**
 * このターンの分 = 累計 - 前のターンの累計（base）。base が分からなければ null（多めに数えない）。
 * どれかが前より減っていたら、agy が数え直した（会話が変わった）とみなして累計をそのまま使う
 */
function usageDelta(total, base) {
  if (!total || !base) return null;
  if (USAGE_KEYS.some((key) => total[key] < base[key])) return total;
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, total[key] - base[key]]));
}
/**
 * 前のターンの累計。控えのターンの記録（turnResults）に、このターンより前に送った分で残した最後のもの。
 * 同じ送信の時刻（付け直し・再生で読み直す同じターン）は除くので、同じ result を何度読んでも差は変わらない
 */
function usageBaseOf(record, sentAt) {
  let base = null;
  for (const r of record?.turnResults ?? []) if (r?.usage && r.sentAt < sentAt && (!base || r.sentAt > base.sentAt)) base = r;
  return base ? usageTotal(base.usage) : null;
}

const toolName = (name) => (name && Object.hasOwn(TOOL_HINTS, name) ? name : name || "tool");

// ---------------------------------------------------------------- backend

const digest = (value) => (value == null ? null : crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32));

/**
 * 起動時にしか渡せないもの（Pleiad のコンテキスト・ブラウザー・Hooks・ply_computer・ply_control・bot の人格）の印。起動時と違う渡し方になる次のターンは agy を起こし直す。
 * トークンを含むものは頭の文字列ではなくダイジェストで持つ: 保持役に載せた agy の札（server の takeCard）にそのまま置いても秘密が出ず、付け直した先が同じ印で比べられる
 */
function keysOf({ contextKey, contextShape, browserEnv, hooksShape, computerKey, agentsKey = null, browserKey, controlKey, botKey, secretsKey = null, useAgent = false, target = {} }) {
  return { context: digest(contextKey), shape: contextShape ?? null, browser: browserEnv?.AGENT_BROWSER_CONFIG ?? null, hooks: hooksShape ?? null,
    computer: digest(computerKey), agents: digest(agentsKey), browserTool: digest(browserKey), control: digest(controlKey), bot: botKey ?? null,
    // custom: カスタムエージェント（agent.md）で動いているか。ターンが注入で読み替える口の判定にも使う（agent.md の本文は再開で持ち越されるため印に入れない）
    custom: useAgent ? 1 : 0,
    // 秘密情報と変数（ADR 0217）。値はハッシュだけ（札に残る）。無い会話は今までと同じ印
    ...(secretsKey ? { secrets: digest(secretsKey) } : {}),
    // 渡す --model / --effort（agyTarget）も起動時にしか渡せない。モデルを選び直した・覚えた既定が変わったら起こし直す（issue #161）。
    // 何も渡さない会話は今までと同じ印
    ...(target.model || target.effort ? { target: [target.model ?? null, target.effort ?? null] } : {}) };
}
/**
 * agy 自身が認証・接続先に読む環境変数（Gemini CLI と同じ名前）。秘密情報と変数に同じ名前があっても agy のプロセスには入れない
 * （agy はシェルを自分の子として起こし、プロセスの env を継がせるので、入れると agy 自身の認証が替わる。ADR 0217）
 */
export const AGY_OWN_ENV = Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA']);
const agyOwn = new Set(AGY_OWN_ENV);
/** agy のプロセスへ渡す秘密情報と変数（agy 自身の名前は除く） */
export const agySecretsEnv = env => Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !agyOwn.has(name.toUpperCase())));
const sameKeys = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** bot の起こし直しの判定の印: 人格の文のハッシュとフォルダー。bot の会話でなければ null */
function botSessionKey(botInstructions, botFolders) {
  if (!botInstructions) return null;
  return crypto.createHash('sha256').update(`${botInstructions}\0${(botFolders?.additionalDirectories ?? []).join('\0')}`).digest('hex').slice(0, 32);
}

/** 付け直しの発言の本文。旧サーバーが控えに書いた発言（uuid は送信の時刻から決まる）から引く。ハッシュが合わなければ null（控えの発言を書き換えない） */
async function adoptedSent(conversationId, sentAt, hash) {
  const record = await transcript.getRecord(conversationId).catch(() => null);
  const text = record?.messages?.find((m) => m.uuid === `${conversationId}:u${sentAt}`)?.text;
  return typeof text === "string" && (!hash || digest(text) === hash) ? text : null;
}

export const backend = {
  id: "antigravity",
  label: "Antigravity",
  get description() { return t("antigravity.description"); },

  // `--print /usage` は公式の headless 保証（未認証なら authentication required で落ち、OAuth を始めない。対応版 1.1.11+）で
  // 受動の照会から呼べる。未ログインと分かっている間は起こさない。
  // 'in' は `--print /usage` が実際に読めた（attempted）ときだけ（古い CLI の needsUpdate は認証を試していない）。
  // 'out' は未認証の確定（AUTH_REQUIRED コード）だけ。理由は quota store の構造化の行（no-login）で伝える
  async usage() {
    if (authGuess === 'out') return { windows: [], reason: 'no-login', message: t("antigravity.auth.notLoggedIn") };
    try {
      const result = await (await import('./antigravity-usage.mjs')).readAntigravityUsage();
      if (result?.attempted === true) {
        authGuess = 'in';
        // 使用量が読めた＝このプロセスでログイン済みが確かめられた。一覧（メモリにも写しにも）が無ければ裏で 1 回取る
        //（この呼び出しは待たない。間隔の制限は refreshModelsSoon。一覧があるのに定期の読みで起こし続ける形にはしない）
        if (modelCache === null) {
          await loadModelsCache();
          if (modelCache === null) refreshModelsSoon();
        }
      }
      return result;
    } catch (e) {
      if (e?.code === 'AUTH_REQUIRED' || AUTH_REQUIRED.test(String(e?.message ?? e))) {
        authGuess = 'out';
        return { windows: [], reason: 'no-login', message: t("antigravity.auth.notLoggedIn") };
      }
      throw e;
    }
  },

  // 能力の印と性質は core/backends/agent-marks.mjs（公開文書も同じデータから作る）
  capabilities: CAPABILITY_STATES.antigravity,
  traits: AGENT_TRAITS.antigravity,

  toolHints: TOOL_HINTS,

  // skip は agy の内部事情なので出さない。語彙と軸だけを返す。
  modes: () => Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, { label: m.label, note: m.note, scope: m.scope, autonomy: m.autonomy, enforced: m.enforced }])),

  /**
   * モデル一覧。段違い（-low / -medium / -high）は系統ごとに 1 行にまとめ、段はエフォートで選ぶ（antigravity-models.mjs）。
   * 段の候補も各行の efforts に載せる（core/effort.mjs がそれを読む）。
   * 既定のモデルは `agy models` を起こしたときのログから読む（listModels）。一覧を引けていなければ「既定（agy の設定）」だけ
   */
  async models() {
    // `agy models` は headless の保証が無いので、未確認（'unknown'）・未ログイン（'out'）では起こさない。
    // 'in' の間だけ、一覧が無い・TTL を過ぎた一覧を、この読み取りをきっかけに裏で引き直す
    //（この呼び出しは待たない。今の一覧（無ければ空）を返す。issue #161）。
    // 写し（認証の証拠ではない）があれば、再起動直後も保存済みの明示モデル・エフォート（models[id].efforts）を戻す
    if (modelCache === null) await loadModelsCache();
    refreshModelsSoon();
    return modelCache ?? buildAgyModels([], null);
  },

  // 一覧を引けていない間（受動では `agy models` を起こさない）は、保存済みの明示モデルを
  // 「一覧に無い」で既定へ戻さない（claude.mjs の validModel と同じ考え。不実な id は CLI が断る）。
  // 一覧（メモリか写し）があるあとは一覧どおりに見る
  async validModel(model) {
    if (typeof model !== "string" || model.length > 200 || /[\r\n\x00]/.test(model)) return false;
    if (!model) return true;
    if (modelCache === null) await loadModelsCache();
    if (modelCache !== null) return Object.hasOwn(modelCache, model);
    return /^[\w.\-\[\]]+$/.test(model);
  },

  // 一覧が無い（このプロセスで未取得・写しも無い）ときは、このプロセスでログイン済みと確かめてから自分で取りに行く。
  // 段はモデル id に入るので、一覧が無いまま検査を省いて別の強さで黙って走らせない。終わり方は:
  //   - 一覧を取れた（呼ぶ側は取れた一覧でもう一度候補を引く）
  //   - 未ログイン確定（'out'。一覧の取得が「sign in」で落ちた場合も）: ログインの案内を投げる。agy は起こさない
  //   - 未確認（'unknown'）: まず /usage で見通しを確かめる（公式の headless 保証。未認証なら OAuth を始めず即落ちる）。
  //     'in' なら一覧を取り、'out' ならログインの案内、確かめられなければ checkNeeded（`agy models` は起こさない）
  //   - 取得のほかの失敗・直前の試みから間隔が浅い再試行: checkNeeded（失敗を連発しない）
  async requireModelCatalog() {
    await loadModelsCache();
    if (modelCache !== null) return;
    if (authGuess === 'out') throw new Error(t('antigravity.auth.notLoggedIn'));
    if (authGuess === 'unknown') {
      await backend.usage().catch(() => null);   // 受動でも起こせる /usage（起こしてよいのはこの読み取り専用だけ）
      if (authGuess === 'out') throw new Error(t('antigravity.auth.notLoggedIn'));
      if (authGuess !== 'in') throw new Error(t('antigravity.models.checkNeeded'));   // 古い CLI・分からない失敗
    }
    // 取れたのか取れないのか分からないまま、短い間に何度も `agy models` を起こさない。
    // 進行中の取得には相乗りする（並ぶ呼び出しは fetchModels が 1 本に束ねる）
    if (!modelsFetch && Date.now() - modelsFetchTriedAt < modelsTtlMs()) throw new Error(t('antigravity.models.checkNeeded'));
    try {
      await fetchModels();
    } catch (e) {
      if (AUTH_REQUIRED.test(String(e?.message ?? e))) {
        authGuess = 'out';
        throw new Error(t('antigravity.auth.notLoggedIn'));
      }
      throw new Error(t('antigravity.models.checkNeeded'));
    }
  },

  // ---- 実行 ---------------------------------------------------------------

  // adopt は付け直し（{ source, card }。adoptTurn だけが渡す）。無ければ普通のターン（保持役に載せるかは antigravity-held.mjs の heldPlan が決める）
  async runTurn({ prompt, sessionId, cwd, mode, model, effort, emit, signal, control, contextRuntime, browserEnv, browserInstructions, browserRuntime = null, agentRuntime = null, addedInstructions, visualizeInstructions = null, shellAppends = [], computerRuntime = null, controlRuntime = null, hooksRuntime = null, secretsRuntime = null, locale, notes = [], botInstructions = null, botFolders = null, account = null, scanOptions = {} }, adopt = null) {
    if (account != null) {
      const error = new Error(t('antigravity.accounts.unavailable'));
      error.code = 'AGY_ACCOUNTS_UNSUPPORTED';
      throw error;
    }
    const m = MODES[modeFor(mode)];
    const k = adopt?.card?.agy ?? null;   // 付け直しの札のバックエンドの欄（backendCard）

    // **控えはターンの途中から書き足すが、ユーザー発言の時刻は送信の時刻で打つ。**
    // AI の発言は書くたびにその時刻、終わりで完了の時刻に打ち直す。
    // ユーザー発言まで後の時刻で打つと、長いターンでは送信が数分ずれて見えるうえ、
    // ターンの途中で出た提示（visualization は生成時刻を持つ）がユーザー発言より前に並ぶ。
    // その並びは分岐の切り口にそのまま効く（core/conversations.mjs の buildItems）ので、
    // ユーザー発言で切った枝に、まだ走っていないはずの成果物が入り込む。
    const sentAt = k ? Number(k.sentAt) || Date.now() : Date.now();
    // 中断の後に Pleiad が添える文（core/interrupt-stops.mjs）。agy は 1 行 1 ターンで入力を分けられないので、本文の前に置く。
    // 付け直しは、旧サーバーが控えに書いた発言（同じ uuid）から引く。引けなければ null（控えの発言を書き換えない）
    const sent = k ? await adoptedSent(sessionId, sentAt, k.sentHash) : [...shellAppends, [...notes, String(prompt ?? "")].join("")].filter(Boolean).join("\n\n");

    let conversationId = sessionId ?? null;
    // 再開した会話の途中の書き込みでは控えを作らない（--conversation が撥ねられて forget した控えを作り直さない）
    const resumed = k ? Boolean(k.resumed) : Boolean(sessionId);
    // agy の usage は会話の累計なので、前のターンの累計（控えのターンの記録）との差を使用量にする
    const usageBase = resumed ? usageBaseOf(await transcript.getRecord(sessionId).catch(() => null), sentAt) : null;
    let sawText = false;
    let text = "";                 // 控えに残す本文
    let finishedReply = false;     // agent_response の DONE。途中までの文とは分ける
    let replyTextSinceTool = "";
    const toolCalls = [];          // 控えに残すツール呼び出し
    let settle = null;
    let failed = null;
    let retracted = false;         // agy が何も実行せずに断った（rejectedBeforeRun）。発言を控えから外す
    let resultTrace = null;        // 終了経路と生の status。本文や usage だけでは後から分からない
    let timedOut = false;          // agy が出力を打ち切った（下の onPrintTimeout）
    const started = new Map();     // tool.start を出した step -> { name, input }
    let closed = false;            // このターンを畳み終えた（settle 済み）
    // 裏へ回ったコマンド（run_command が BACKGROUND_AFTER_MS を超えて ACTIVE のまま）。一覧（background）は全量で出す。
    // id はツールの id（委譲の取り消し cancelBackground がツールの id で引く）。DONE とターンの終わり（settle）で外す
    const behind = {
      timers: new Map(),   // tool id -> まだ一覧に出していない run_command の見張り
      tasks: new Map(),    // tool id -> { task, command }
      gone: new Map(),     // tool id -> 外れたときに呼ぶもの（stopBackground が DONE を待つ）
      wait(id, ms) {
        return new Promise((resolve) => {
          if (!behind.tasks.has(id)) return resolve();
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
          behind.gone.set(id, [...(behind.gone.get(id) ?? []), () => { clearTimeout(timer); resolve(); }]);
        });
      },
    };
    const sendBehind = (out = emit) => out({ type: "background", tasks: [...behind.tasks.values()].map((b) => b.task) });
    const dropBehind = (id, out) => {
      clearTimeout(behind.timers.get(id));
      behind.timers.delete(id);
      const had = behind.tasks.delete(id);
      for (const done of behind.gone.get(id) ?? []) done();
      behind.gone.delete(id);
      if (had) sendBehind(out);
    };
    const clearBehind = () => {
      for (const timer of behind.timers.values()) clearTimeout(timer);
      behind.timers.clear();
      const had = behind.tasks.size > 0;
      behind.tasks.clear();
      for (const list of behind.gone.values()) for (const done of list) done();
      behind.gone.clear();
      if (had) sendBehind();
    };
    const finished = new Promise((resolve) => { settle = () => { closed = true; clearBehind(); resolve(); }; });

    // ---- 控え。**ターンの途中から書き足す**（agy に履歴の取り出し口が無い。antigravity-store.mjs 冒頭）
    // ユーザー発言は id が分かって本文を渡したら、AI の発言はツールの完了ごと・本文は間を空けて、同じ uuid で差し替える。
    // 失敗・中断・打ち切りでも、終わりにそこまでの分を書く。書き込みは 1 本ずつ（控えの read-modify-write を重ねない）
    let delivered = Boolean(adopt);   // プロンプトを渡した（渡せなかったターンは控えに残さない）。付け直しは旧サーバーが渡し済み
    // このターンで発言の前に足したネイティブの指示ファイル（カスタムエージェントが読めない分の補填）。server が会話の記録（contextRecord）に載せる
    let nativeInjected = null;
    let writes = Promise.resolve();
    let queued = false;            // 積んだまま、まだ始まっていない書き込みがある（次のを積まない。始まるときに最新を読む）
    let final = null;              // 終わりに書く分（畳んだ後に遅れて届いた出来事を混ぜない）
    let textTimer = null;
    const userUuid = () => `${conversationId}:u${sentAt}`;
    const snapshot = (at) => [
      ...(sent === null || retracted ? [] : [{ role: "user", text: sent, uuid: userUuid(), at: new Date(sentAt).toISOString() }]),
      // uuid はターンの間変えない（送信の時刻から作る）。変えると控えにも写しの会話（core/conversations.mjs の mergeMessages）にも二重に並ぶ
      ...(text || toolCalls.length ? [{
        role: "assistant", text, uuid: `${conversationId}:a${sentAt}`, at: new Date(at).toISOString(),
        ...(toolCalls.length ? { tools: toolCalls.map((c) => c.name), toolCalls: [...toolCalls] } : {}),
      }] : []),
    ];
    const save = ({ last = false } = {}) => {
      // 畳んだ後は終わりの分（seal）だけを書く。遅れて届いた出来事で書き直さない
      if (!delivered || !conversationId || queued || (final && !last)) return writes;
      queued = true;
      writes = writes.then(() => {
        queued = false;
        const messages = final?.messages ?? snapshot(Date.now());
        return transcript.appendMessages(conversationId, { cwd, messages, create: final?.create ?? !resumed,
          ...(final?.turnResult ? { turnResult: final.turnResult } : {}), ...(final?.drop ? { drop: final.drop } : {}) });
      }).catch((err) => console.error("  agy の控えを書けなかった:", String(err?.message ?? err)));
      return writes;
    };
    // 本文のデルタは細かいので、間を空けてまとめて書く
    const saveSoon = () => {
      if (textTimer || final) return;
      textTimer = setTimeout(() => { textTimer = null; if (!final) save(); }, TEXT_SAVE_MS);
      textTimer.unref?.();
    };
    /** ターンの終わりの分を書く。成功なら完了の時刻で、控えが無ければ作る（今までどおり） */
    const seal = ({ ok }) => {
      clearTimeout(textTimer);
      if (final || !delivered) return writes;
      final = { messages: snapshot(Date.now()), create: ok || !resumed,
        turnResult: resultTrace ? { sentAt, at: new Date().toISOString(), ...resultTrace } : null,
        // 何も実行せずに断られたターンの発言は、途中（session.prompt の直後・init）で書いた分も外す。送り直しで二重に入らない
        ...(retracted ? { drop: [userUuid()] } : {}) };
      return save({ last: true });
    };

    // 生きているプロセスを使い回す。落ちていれば立て直す（会話は --conversation で拾える）
    let session = !adopt && conversationId ? live.get(conversationId) : null;
    disarmIdle(session);
    if (session && !session.proc) { live.delete(conversationId); session = null; }
    // Pleiad のコンテキストは起動時にしか渡せない（エージェント定義と env）。起動時と違う渡し方になるなら起こし直す。
    // 担当や渡すツール（shape）が変わったときも同じ（コンテキストの設定の変更を次のターンから効かせる。会話は --conversation で続く）
    const contextKey = contextRuntime?.headers?.Authorization ?? null, contextShape = contextRuntime?.shape ?? null;
    // 内蔵ブラウザーの接続（browserEnv）と、Hooks を Pleiad がそろえる会話（ADR 0049）の置き場の .agents/hooks.json も起動時にしか渡せない。
    // ブラウザーの設定・登録・止める名前が変われば起こし直す
    const hooksShape = hooksRuntime?.shape ?? null;
    // ply_computer（中継）も起動時にしか渡せない。渡す・渡さない・接続先が変われば起こし直す
    const computerKey = computerRuntime ? `${computerRuntime.url} ${computerRuntime.headers?.Authorization ?? ''}` : null;
    // ply_agents（委譲の橋）も起動時にしか渡せない（中継の接続先は agent.md の MCP として書く）。口は会話のあいだ同じ
    const agentsKey = agentRuntime ? `${agentRuntime.url} ${agentRuntime.headers?.Authorization ?? ''}` : null;
    // ply_browser（ADR 0148。ply_context・ply_computer と同じ 1 本の中継に束ねる）も同じ。口は会話のあいだ同じなので、渡す・渡さないが変わったときだけ
    const browserKey = browserRuntime ? `${browserRuntime.url} ${browserRuntime.headers?.Authorization ?? ''}` : null;
    // ply_control（操作の一覧。ADR 0081）と、会話のシェルへ渡す CLI の接続情報（PLEIAD_CONTROL_*）も起動時にしか渡せない。口は会話のあいだ同じ
    const controlKey = controlRuntime ? `${controlRuntime.url} ${controlRuntime.headers?.Authorization ?? ''}` : null;
    // bot の人格（エージェント定義の本文）と触れてよいフォルダー（--add-dir）も起動時にしか渡せない。人格を直した・フォルダーを変えたら起こし直す。
    // 起動中のプロセスは指示の文そのものを比べないので、人格のハッシュで判定する（bot でなければ null で、今までと同じ）
    const botKey = botSessionKey(botInstructions, botFolders);
    // 秘密情報と変数（ADR 0217）も起動時にしか渡せない（プロセスの env と指示）。変われば起こし直す
    const secretsEnv = agySecretsEnv(secretsRuntime?.env);
    const secretsKey = Object.keys(secretsEnv).length || secretsRuntime?.instructions ? JSON.stringify([secretsEnv, secretsRuntime?.instructions ?? '']) : null;
    // カスタムエージェントを使うか。agent.md の本文は keys に入れない: 同じ会話を --conversation で再開すると agy は
    // 開始時のエージェント定義を持ち越す（既知の制約）ので、本文の変化で起こし直しても届かない。確実に届ける文
    // （Pleiad の指示・補填したネイティブの指示）は発言への前置きで毎ターン渡す（issue #107）
    const computerInstructions = computerPrompt(computerRuntime, { locale: contextRuntime?.locale ?? locale, agent: 'antigravity' });
    const agentPrompt = [contextRuntime?.prompt, browserInstructions, computerInstructions, controlRuntime?.instructions, secretsRuntime?.instructions, botInstructions].filter(Boolean).join('\n\n');
    const useAgent = Boolean(contextRuntime || browserInstructions || agentRuntime || computerRuntime || controlRuntime || secretsRuntime?.instructions || botInstructions);
    // --model と --effort は同時に渡さない。段は同じ系統の段違いの id に解決し、「既定」は覚えた既定のモデルを明示する（antigravity-models.mjs）
    const target = agyTarget(model, effortFor(effort), modelCache ?? {});
    const keys = keysOf({ contextKey, contextShape, browserEnv, hooksShape, computerKey, agentsKey, browserKey, controlKey, botKey, secretsKey, useAgent, target });
    if (session && !sameKeys(session.keys, keys)) { session.kill(); release(conversationId, session); session = null; }

    const fresh = !session && !adopt;
    if (adopt) {
      // 付け直す子（保持役が持つ agy）。起動の引数・env は要らない（子はもう走っている）。agent の置き場は札の home。次のターンの印の比べは札の keys
      if (!conversationId) throw new Error("antigravity: the card has no conversation id");
      session = new AgySession({ cwd, conversationId, held: createHeldAgy({ source: adopt.source }), onGone: adoptHome(k.home) });
      session.keys = k.keys ?? null;
      session.home = k.home ?? null;
      session.hookRuns = k.hookRuns ?? null;
      session.onShapeMismatch = () => { void recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'antigravity', kind: 'stream-json-shape', detectedVersion: null }); };
    }
    if (fresh) {
      // 保持役に載せるか（antigravity-held.mjs）。載せるなら、前のサーバーが残した idle の子を最初に 1 回片付けてから起こす
      const plan = await heldPlan({ dataDir: store.dataDir, argv: cliCommand("antigravity"), bot: Boolean(botInstructions) });
      if (plan) await sweepIdle(plan.client);
      // 会話ごとのエージェント定義（Pleiad の置き場）と、中継に渡す接続先・トークン（env）
      // カスタムエージェントを使うのは、Pleiad のコンテキスト・ブラウザーの指示・委譲の橋（ply_agents の中継）を渡すときだけ。
      // Pleiad の指示（addedInstructions / agentRuntime.instructions）は発言の前に毎ターン足すので、それだけではカスタムエージェントを作らない。
      // Hooks だけを Pleiad がそろえるときは、置き場（--add-dir）だけを作る（既定のエージェントのまま。inheritCustomizations に頼らない）
      const botDirs = botFolders?.additionalDirectories ?? [];
      const agent = useAgent || hooksRuntime ? await prepareAgent({ owners: contextRuntime?.owners ?? { instruction: 'native', skill: 'native', mcp: 'native' },
        prompt: agentPrompt, cwd, url: contextRuntime?.url, authorization: contextKey, locale: contextRuntime?.locale ?? locale,
        context: useAgent, hooks: hooksRuntime, computer: computerRuntime ? { url: computerRuntime.url, authorization: computerRuntime.headers?.Authorization } : null,
        agents: agentRuntime ? { url: agentRuntime.url, authorization: agentRuntime.headers?.Authorization } : null,
        browser: browserRuntime ? { url: browserRuntime.url, authorization: browserRuntime.headers?.Authorization } : null,
        control: controlRuntime ? { url: controlRuntime.url, authorization: controlRuntime.headers?.Authorization, env: controlRuntime.env } : null, held: Boolean(plan) }) : null;
      session = new AgySession({
        cwd,
        conversationId,
        ...target,
        mode: m.flag,
        skipPermissions: Boolean(m.skip),
        // agy のヘッドレスは cwd だけではワークスペースを設定しないため、--add-dir で渡す
        addDirs: [...(cwd ? [cwd] : []), ...botDirs],
        ...(agent ? { addDirs: [...(cwd ? [cwd] : []), ...botDirs, agent.home], ...(useAgent ? { agent: AGENT_NAME } : {}), env: { ...secretsEnv, ...agent.env, ...browserEnv }, onGone: agent.cleanup }
          : browserEnv || Object.keys(secretsEnv).length ? { env: { ...secretsEnv, ...browserEnv } } : {}),
        ...(plan ? { held: createHeldAgy({ client: plan.client }) } : {}),
      });
      session.hookRuns = agent?.runs ? { file: agent.runs, offset: 0 } : null;
      session.home = plan && agent ? agent.home : null;
      session.onShapeMismatch = () => { void recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'antigravity', kind: 'stream-json-shape', detectedVersion: null }); };
      session.keys = keys;
      // agy が Pleiad の MCP を起こしたかを見るトークン（adminNotice）。付け直しでは見ない（前のサーバーが受けた接続は分からない）
      session.mcpTokens = useAgent && agent ? relayTokens(agent.env) : [];
    }

    // opts は feedLine から来る（付け直しの再生の行は { replay: true }。server の makeEmit が画面へ流さず、実行中のスナップショットとメモリの状態だけを作る）
    const handle = (ev, opts) => {
      const out = (event) => emit(event, opts?.replay ? { replay: true } : undefined);
      switch (ev?.event) {
        case "init": {
          const id = ev.conversation_id ?? ev.init?.conversation_id ?? null;
          if (!id) return;
          const isNew = !conversationId;
          conversationId = id;
          live.set(id, session);
          // 組織の管理ポリシーが skip より勝っていれば request-review などになる（adminNotice）
          if (ev.init?.permission_mode) session.permissionMode = String(ev.init.permission_mode).slice(0, 100);
          if (isNew) {
            // **これを出さないと web が id を受け取れない。**`first: true` は
            // 「id が確定した最初の1本」の印で、再開ターンでは出さない
            out({
              type: "session", sessionId: id, first: true,
              ...(ev.init?.model ? { model: ev.init.model } : {}),
            });
          }
          // 新しい会話は id がここで分かる。ユーザー発言を控えに書く
          save();
          return;
        }

        case "step_update": {
          // Step updates without a history entry still show that the child is active.
          // 握手（init）や終了の制御（result）では出さない。委譲の「仕事を始める前に断られた」（ADR 0302）の untouched は、
          // この出来事を仕事の痕跡として数えるので、制御の往復だけで立つと任せ直せなくなる
          out({ type: 'task.activity', output: true });
          const s = ev.step_update ?? {};
          if (s.step_type === "agent_response") {
            if (String(s.state ?? "").toUpperCase() === "DONE" && (replyTextSinceTool.trim() || String(s.text_delta ?? '').trim())) finishedReply = true;
            const delta = s.text_delta;
            if (!delta) return;
            if (!sawText) { sawText = true; out({ type: "activity", state: "writing" }); }
            text += delta;
            replyTextSinceTool += delta;
            saveSoon();
            return out({ type: "text.delta", text: String(delta) });
          }
          if (s.step_type === "tool") {
            finishedReply = false; // 返事の後に道具が続けば、その返事はまだ最終文ではない
            replyTextSinceTool = "";
            // **同じ step_index で 2 回来る**: `ACTIVE`（output 無し）-> `DONE`（output あり）。
            // 開始と完了に分ける。同じに扱うとツールが二重に並び、1 つ目は結果が空になる
            // （実測。docs/multi-backend.md §2.8）
            const id = `${conversationId ?? "agy"}:${s.step_index ?? started.size}`;
            const prev = started.get(id);
            // ply_computer は call_mcp_tool（{ ServerName, ToolName, Arguments }）で出る。3 つのエージェントでそろえた
            // mcp__ply_computer__<ツール> と、その引数に直す（docs/computer-use.md「tool.start / tool.result」）
            const params = s.tool_info?.parameters;
            const computer = prev?.computer ?? (s.tool_name === "call_mcp_tool" ? agyComputerName(params) : null);
            const name = computer ?? toolName(s.tool_name ?? s.tool_info?.name ?? prev?.name);
            const input = computer ? prev?.input ?? computerToolInput(computer, params?.Arguments && typeof params.Arguments === "object" ? params.Arguments : {})
              : params ?? prev?.input ?? {};
            const output = s.tool_info?.output;
            const state = String(s.state ?? "").toUpperCase();
            // 拒否・失敗したツールは output 無しの ERROR と tool_info.error で来る（組織の管理ポリシーの「要審査」など。実機で確認）
            const toolError = s.tool_info?.error;
            const failedStep = state !== "ACTIVE" && (state === "ERROR" || Boolean(toolError));
            // 知らない state・state 無しでも取りこぼさない: output があれば完了、無ければ開始
            const done = state === "ACTIVE" ? false
              : state === "DONE" || failedStep ? true
              : output !== undefined && output !== null && output !== "";

            if (!started.has(id)) {
              started.set(id, { name, input, computer });
              out({ type: "activity", state: "running", label: t("activity.tool", { label: TOOL_HINTS[name]?.label ?? name }) });
              out({ type: "tool.start", id, name, input });
              // 終わらないコマンドは agy が裏へ回し、DONE が来ないまま AI が wait で待ち続ける。しばらく ACTIVE のままなら裏のコマンドとして出す
              if (!done && name === "run_command" && !closed) {
                const command = String(input?.CommandLine ?? "");
                const timer = setTimeout(() => {
                  behind.timers.delete(id);
                  if (closed) return;
                  behind.tasks.set(id, { task: { id, kind: "shell", label: commandLabel(command) || name }, command });
                  sendBehind();
                }, BACKGROUND_AFTER_MS);
                timer.unref?.();
                behind.timers.set(id, timer);
              }
            }
            if (!done) return;
            dropBehind(id, out);
            const errorText = failedStep ? String(toolError?.message ?? toolError?.type ?? (typeof toolError === "string" ? toolError : "")) : "";
            const raw = failedStep && (output === undefined || output === null || output === "") ? errorText
              : typeof output === "string" ? output : JSON.stringify(output ?? "");
            // ply_computer: 画像を退避した行を除き、印の行から images と computer を作る。控えにもその形で残す（読み直しで印を読み直さない）
            const cutResult = computer ? computerResult(raw, cut) : cut(raw);
            // 確認を出せずに拒否された: 管理者に頼む設定を添え、委譲の結果へ拒否として集める（server が tool.result の rejection を拾う）
            const denied = failedStep && DENIED_RE.test(errorText);
            const r = denied ? { ...cutResult, text: `${cutResult.text}\n\n${t("antigravity.admin.toolDenied", { ask: t("antigravity.admin.askTools") })}` } : cutResult;
            const isError = failedStep || (computer ? computerFailed(r.computer) : false);
            const rejection = denied ? { tool: name, kind: "policy", via: "antigravity",
              command: String(input?.CommandLine ?? input?.AbsolutePath ?? input?.TargetFile ?? input?.Path ?? "") || null,
              reason: t("antigravity.admin.reason"), raw: errorText.slice(0, 1000) } : null;
            out({ type: "tool.result", id, ...r, isError, ...(rejection ? { rejection } : {}) });
            toolCalls.push({ id, name, input, result: { ...r, isError } });
            save();
            return;
          }
          // user_input / checkpoint。会話には出さない
          return;
        }

        case "result": {
          // 打ち切られた後の result は SUCCESS でも信じない（onPrintTimeout が畳んでいる）
          if (timedOut || closed) return;
          const r = ev.result ?? {};
          // 認証の要るターンが通った＝このプロセスでログイン済みが確かめられた（一覧の自動の引き直しを開ける）
          if (String(r.status ?? "").toUpperCase() === "SUCCESS") authGuess = 'in';
          // 本文の無い SUCCESS は、打ち切り（onPrintTimeout）と見分けがつかない。印が遅れて
          // 届く分だけ待ってから確定する。その間に印が来れば onPrintTimeout が失敗として畳む
          if (!ev[LATE] && !opts?.replay && !sawText && !r.response && String(r.status ?? "").toUpperCase() === "SUCCESS") {
            // 保持役の読みは、確定するまで ack しない（待つ間に手を離しても、新しいサーバーが同じ result を読み直す）
            return new Promise((resolve) => setTimeout(() => resolve(handle({ ...ev, [LATE]: true }, opts)), EMPTY_SUCCESS_GRACE_MS));
          }
          conversationId ||= r.conversation_id || null;
          // 返答の無いまま拒否された操作だけが残った SUCCESS は、普通の完了にしない（組織の管理ポリシー。docs/multi-backend.md §2.8）
          const deniedActions = Array.isArray(r.denied_actions) ? r.denied_actions : [];
          const deniedTurn = deniedActions.length > 0 && !sawText && !r.response && String(r.status ?? "").toUpperCase() === "SUCCESS";
          // agy の最初の result で 1 度だけ、管理ポリシーの知らせを返答の後ろに足す（本文として控えにも残る。付け直しの再生では足さない）
          // 認証の失敗などで終わったターンは見ない（中継を起こす前に終わる。次の成功したターンで見る）
          const notice = opts?.replay || String(r.status ?? "").toUpperCase() !== "SUCCESS" ? "" : adminNotice(session, { askedSkip: Boolean(m.skip), deniedTurn });
          if (notice) {
            const add = `${text ? "\n\n" : ""}${notice}`;
            if (!sawText) { sawText = true; out({ type: "activity", state: "writing" }); }
            text += add;
            out({ type: "text.delta", text: add });
          }
          if (sawText) out({ type: "text.end" });
          // 新しい agy の会話（再開でない・別の会話になった）は 0 から数える。基準の無い再開（更新前から続く会話）は出さない。
          // 全部 0 は数えていない result（打ち切りなど）なので、出さず、再開では基準にもしない
          const total = usageTotal(r.usage);
          const usageFresh = !resumed || conversationId !== sessionId;
          const counted = total && USAGE_KEYS.some((key) => total[key]);
          const usage = counted ? usageFor(usageDelta(total, usageFresh ? usageTotal({}) : usageBase)) : null;
          if (usage) out(usage);
          const actions = deniedActions.map((a) => String(a?.display_name ?? a?.action ?? "").slice(0, 100)).filter(Boolean);
          const outcome = deniedTurn ? { type: "turnResult", outcome: "error", turns: r.num_turns ?? 1,
            error: t("antigravity.admin.deniedTurn", { actions: [...new Set(actions)].join(", "), ask: t("antigravity.admin.askTools") }) }
            : turnResultFor(r, { finishedReply });
          resultTrace = { source: "result", status: String(r.status ?? "").slice(0, 100), outcome: outcome.outcome,
            ...(r.error ? { error: String(r.error).slice(0, 1000) } : {}),
            ...(deniedActions.length ? { denied: deniedActions.length } : {}), ...(total && (counted || usageFresh) ? { usage: total } : {}) };
          if (outcome.outcome === "error" && !deniedTurn && rejectedBeforeRun(r, { steps: started.size, sawText })) {
            // 何も実行していないので、送信待ちは「失敗」にする（undelivered。「2 回届くことがあります」にしない）。
            // 再開した会話は同じ会話へ送っても断られ続けるので、作り直す印（nativeUnusable）を付けて返す。
            // conversations.mjs の wrapped.runTurn が記録を新しい会話へ引き継いで 1 回だけ送り直すので、ここでは失敗を出さない
            // （作り直せなければ server が失敗を出す）。新しい会話で断られたときは作り直さず、そのまま失敗にする
            retracted = true;
            failed = Object.assign(undelivered(new Error(outcome.error)), { retracted: [userUuid()] }, resumed ? { nativeUnusable: true } : {});
            clearBehind();
            if (!resumed) out(outcome);
            return settle?.();
          }
          if (outcome.outcome === "error") failed = new Error(outcome.error);
          clearBehind();
          out(outcome);
          return settle?.();
        }

        default:
          return;
      }
    };
    session.onEvent = handle;
    session.behind = behind;   // stopBackground が引く（このターンの裏のコマンド）

    // 未ログインのままターンを投げた。**ここから Pleiad がログインを回すことはできない**
    // （認可コードは端末からしか読まれない。auth.login のコメント参照）。
    // 出た URL ではなく、端末で叩くコマンドを案内する。このターン自体は 60 秒で失敗する
    session.onAuthUrl = () => {
      authGuess = 'out';   // agy が自ら認証を求めた＝未ログインが確定
      const argv = cliCommand("antigravity");
      emit({
        type: "auth", backend: "antigravity", phase: "url",
        url: argv ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "agy",
        message: t("antigravity.auth.notLoggedInTurn"),
      });
    };

    /**
     * agy が出力を打ち切った（`--print-timeout`）。**ここが空の SUCCESS を撥ねる保険。**
     *
     * 打ち切られた agy は本文が空のまま `status:"SUCCESS"` を吐くので、そのまま写すと
     * 「正常に終わったのに何も言わない」ターンになる。`--print-timeout` は長く渡している
     * （antigravity-cli.mjs）が、値を変えれば同じ穴が開くので、文言でも気づけるようにする。
     */
    session.onPrintTimeout = () => {
      if (timedOut || failed || closed) return;
      timedOut = true;
      if (sawText) emit({ type: "text.end" });
      const message = t("antigravity.errors.printTimeout");
      failed = new Error(message);
      resultTrace = { source: "printTimeout", status: null, outcome: "error", error: message };
      clearBehind();
      emit({ type: "turnResult", outcome: "error", error: message });
      // **裏で走り続ける agy を残さない。** 放っておくと Pleiad の見ていない所でファイルを
      // 書き換え、Google の枠も食い続ける。会話は `--conversation <id>` で拾い直せる
      session.kill();
      release(conversationId, session);
      settle?.();
    };

    session.onExit = (err) => {
      release(conversationId, session);
      // result で畳んだターンは、直後に agy が終了してもその結果を変えない。
      if (closed) return;
      // ターンの途中で落ちた。中断（kill）なら abort 側が畳むので、ここでは失敗にしない
      if (signal?.signal?.aborted) return settle?.();
      failed = err;
      resultTrace = { source: "exit", status: null, outcome: "error", error: String(err?.message ?? err).slice(0, 1000) };
      clearBehind();
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      settle?.();
    };

    // 中断はプロセスを落とすしかない（プロトコルに中断が無い）。
    // **落としたことを自分で畳む。** kill() は先に proc を手放すので exit の通知は来ない
    // （来ないのが正しい。立て直しの die と取り違えないため）。ここで settle しないと
    // runTurn が返らず、server の実行中一覧から消えなくなる
    const abort = () => {
      resultTrace ??= { source: "abort", status: null, outcome: "aborted" };
      session.kill();
      release(conversationId, session);
      settle?.();
    };
    if (signal?.signal?.aborted) abort();
    else signal?.signal?.addEventListener?.("abort", abort, { once: true });

    const timer = setTimeout(() => {
      if (!conversationId) {
        failed = new Error(t("antigravity.errors.startTimeout", { ms: START_TIMEOUT_MS }));
        resultTrace = { source: "startTimeout", status: null, outcome: "error", error: failed.message };
        abort(); settle?.();
      }
    }, START_TIMEOUT_MS);
    timer.unref?.();

    /**
     * 札のバックエンドの欄（保持役に載せたターンだけ。core/server.mjs の takeCard が control.backendCard から読み、付け直す側の adoptTurn の card になる）。
     * 付け直しに要る、再生では作れないものだけ: 発言の時刻（控えの発言の uuid）・再開した会話か・発言のハッシュ（控えから本文を引く）・agent の置き場・
     * 次のターンの印の比べ（keys。トークンはダイジェスト）・hooks の発火の記録の読み位置。ツール・本文・会話の id は印からの再生と札の sessionId で戻る
     */
    const backendCard = () => ({ held: true, agy: { sentAt, resumed, sentHash: sent === null ? null : digest(sent), home: session.home ?? null, keys: session.keys ?? null,
      hookRuns: session.hookRuns ? { file: session.hookRuns.file, offset: session.hookRuns.offset,
        old: session.hookRuns.old ? { file: session.hookRuns.old.file, offset: session.hookRuns.old.offset } : null } : null } });
    // 札を保持役の子に置く口（server の touchCard が、札の中身が変わるたびに呼ぶ）
    const bindHolder = () => {
      const held = session.held;
      if (!control || !held) return;
      control.holder = { label: (card) => held.label(card) };
      control.backendCard = backendCard;
      control.touch?.();
    };

    try {
      if (adopt) {
        // 付け直した子は会話の次のターンも使う。印から ack までの再生と続きは、start が始める読みが handle へ流す（子が終わっていれば記録だけで締まる）
        live.set(conversationId, session);
        session.start();
      } else if (fresh) {
        await reaped;   // 前の孤児を掃除し終えてから起こす（自分のを巻き込まない）
        session.start();
        // 強制終了で取り残されたときに、次の起動が掃除できるように控える（保持役の子は pid を持たず、控えない）
        pids.remember(session.pid);
      }
      bindHolder();
      if (control) control.handle = { get conversationId() { return conversationId; } };
      control?.onReady?.();
      if (!adopt) {
        emit({ type: "activity", state: "thinking" });
        session.held?.markTurn();   // 印は最初の行の直前（再生はここから）
        // カスタムエージェントは作業場所の指示ファイル（AGENTS.md・GEMINI.md）を自分で読まない（antigravity-context.mjs 冒頭の実測）。
        // 指示の担当がエージェント任せのままなら、Pleiad がネイティブと同じ探索（nativeInstructionEntries）で拾い、発言の前に毎ターン足す。
        // 改訂が次のターンに効き、渡した分は nativeInjected で記録に残る
        // 探索が失敗してもターンは続けるが、黙って落とさない: 失敗・診断（読めなかったファイル・上限超過）は記録に残し、
        // コンソールにも出す（sessionContext の nativeInjected.error / diagnostics で見える）
        let injected = [], scanError = null, scanDiagnostics = null, scanLimited = false, injectedRan = false;
        if (session.keys?.custom && contextRuntime?.owners?.instruction !== 'ply') {
          injectedRan = true;
          const scan = await nativeInstructionEntries(cwd, 'antigravity', scanOptions).catch(e => ({ entries: null, error: String(e?.message ?? e) }));
          injected = scan?.entries ?? [];
          scanError = scan?.error ?? null;
          scanDiagnostics = scan?.diagnostics?.length ? scan.diagnostics.slice(0, 20) : null;
          scanLimited = Boolean(scan?.limited);
          if (scanError) console.error(`  ネイティブの指示ファイルを読めなかったので、このターンは注入しません（${conversationId}）:`, scanError);
        }
        // 探したが 0 件のターンも entries:[] で記録する（前のターンの分を残さない）。注入を試みなかったターンはフィールド自体を出さない
        nativeInjected = injectedRan
          ? { entries: injected.map(e => ({ id: e.id, name: e.name, path: e.path, scope: e.scope, appliesTo: e.appliesTo, hash: e.hash, tokens: e.tokens })),
              ...(scanError ? { error: scanError } : {}), ...(scanDiagnostics ? { diagnostics: scanDiagnostics } : {}), ...(scanLimited ? { limited: true } : {}) }
          : null;
        const injectedText = injected.map(e => agentT(locale, 'context.instructionsFrom', { path: e.path, scope: e.appliesTo ?? agentT(locale, 'context.allDirectories'), content: e.content })).join('\n\n') || null;
        // ply_agents の説明と Pleiad の指示も発言の本文の前に毎ターン足す（エージェント定義は最初の会話にしか効かないため）。
        // 控えに残すのは人が書いた分だけ（sent。Devin の mapper.beginTurn と同じ分け方）
        session.prompt([injectedText, agentRuntime?.instructions ?? addedInstructions, visualizeInstructions, sent].filter(Boolean).join("\n\n"));
        // 渡せた。再開した会話は id が分かっているので、ユーザー発言をここで書く（新しい会話は init で）
        delivered = true;
        save();
      }
      await finished;
      await reportHookRuns(session, hooksRuntime, emit);

      // 終わりの分を書く（時刻は発言ごとに変える: ユーザーは送信時、AI は完了時。提示はこの間に入る）。
      // 失敗・中断・打ち切りでも、そこまでのツールと本文を残す（中断の印は sidecar の interrupted が持つ）
      const aborted = Boolean(signal?.signal?.aborted);
      if (aborted) resultTrace ??= { source: "abort", status: null, outcome: "aborted" };
      await seal({ ok: !aborted && !failed });
      // 断られた会話のプロセスは次のターンに使い回さない（作り直す会話・送り直しは新しく起こす）
      if (retracted) { session.kill(); release(conversationId, session); }

      if (aborted) {
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: conversationId, nativeInjected };
      }
      if (failed) throw failed;
    } catch (err) {
      if (resultTrace?.outcome === "ok") resultTrace = { ...resultTrace, source: "postResultException", outcome: "error",
        error: String(err?.message ?? err).slice(0, 1000) };
      else resultTrace ??= { source: "exception", status: null, outcome: "error", error: String(err?.message ?? err).slice(0, 1000) };
      // 発言を渡した後に失敗しても、注入した分は記録に残す（server が err から拾う）
      if (nativeInjected && err && typeof err === 'object') err.nativeInjected = nativeInjected;
      throw err;
    } finally {
      clearTimeout(timer);
      clearBehind();
      if (session.behind === behind) session.behind = null;
      // 途中で投げた（seal まで来なかった）ときも、そこまでの分を書いてから返す。
      // 積んだ書き込みを待つ（server はターンの後に控えを読む。次のターンの書き込みとも重ねない）。手を離したターンは新しいサーバーが書く
      await seal({ ok: false });
      // 保持役の子はターンが終わっても会話のあいだ生きる（idle）。札と印を外し、付け直す対象から外す
      session.held?.endTurn();
      // 次の発言を待つ agy は IDLE_MS で止める（保持役の子も同じ）
      armIdle(conversationId, session);
      if (control) { control.handle = null; control.steer = null; control.holder = null; control.backendCard = null; }
    }

    return { sessionId: conversationId, nativeInjected };
  },

  /**
   * 付け直し（無停止の更新 段階 3。antigravity-held.mjs）: 保持役が持つ走っている agy の続きを受ける。card は runTurn が札に置いた分
   * （control.backendCard の { held, agy }）、source は保持役の子（core/adopt.mjs の holderSource）。印から ack までは記録を読み直して状態（本文・ツール・結果）を作り
   * （emit の replay）、続きは普通に流して行ごとに ack する。agy に握手は要らない（stage0-codex-agy.md §3）。sessionId は agy の会話の id
   */
  async adoptTurn(args) {
    if (!args.card?.held || !args.card.agy || typeof args.source?.write !== "function") throw new Error("antigravity: the turn was not on the holder");
    return backend.runTurn(args, { source: args.source, card: args.card });
  },

  // ---- セッション管理 -----------------------------------------------------
  //
  // `agy` に一覧も履歴も無い（サブコマンドを実機で確認）。Pleiad の控えが唯一の情報源。

  async listSessions({ limit = 100 } = {}) {
    return transcript.listRecords({ limit });
  },

  async getSession(sessionId) {
    const record = await transcript.getRecord(sessionId);
    return record ? transcript.toRow(record) : null;
  },

  async getMessages(sessionId, options) {
    return transcript.getMessages(sessionId, options ?? {});
  },

  // 生かしている agy のプロセスを止める。巻き戻して送り直す会話（core/conversations.mjs の rewind）は、新しい agy の会話を起こすので、古いプロセスは使わない
  releaseConversation(conversationId) {
    const session = conversationId ? live.get(conversationId) : null;
    if (!session) return;
    try { session.kill(); } catch {}
    release(conversationId, session);
  },

  /**
   * 裏へ回ったコマンドを 1 本止める（ターンは止めない）。その会話の agy の直下の子で、コマンドを走らせているシェルを木ごと落とし、
   * agy の DONE を待つ（一覧から外れるのは DONE。AI は出力を受けてターンを続ける）。見つからない・あいまいなら何も落とさずに断る
   */
  async stopBackground(sessionId, taskId) {
    const session = sessionId ? live.get(sessionId) : null;
    const entry = session?.behind?.tasks.get(taskId);
    if (!entry) throw new Error(t("antigravity.errors.backgroundGone"));
    entry.stopping ??= stopCommand(session, entry.command, taskId).catch((err) => { entry.stopping = null; throw err; });
    return entry.stopping;
  },

  // ---- 認証 ---------------------------------------------------------------
  //
  // `agy` は login サブコマンドを持たない。**ヘッドレスで走らせたときに、未ログインなら
  // stderr へ OAuth の URL を出し、stdin で認可コードを待つ**（実機で確認）。
  // つまりログイン専用の口は要らず、ターンを 1 本起こせばその経路に乗る。

  auth: {
    /**
     * ログインしているか。
     *
     * 資格情報は **OS の資格情報ストア**にある（macOS のキーチェーン: service `gemini` /
     * account `antigravity`）。ファイルとして読めないので、**`agy models` に聞く**。
     * 未ログインなら「Please sign in」で落ちる（実機で確認）。
     */
    async status({ probe = false } = {}) {
      // probe=false（起動時・定期の受動確認）は `agy` を起こさない。最後に分かった見通しだけを返す
      if (!probe) {
        if (authGuess === 'in') return { loggedIn: true, account: t("antigravity.auth.account"), detail: t("antigravity.auth.detail") };
        if (authGuess === 'out') return { loggedIn: false, account: null, detail: t("antigravity.auth.notLoggedIn") };
        return { loggedIn: false, account: null, unconfirmed: true, detail: t("antigravity.auth.unconfirmed") };
      }
      try {
        await fetchModels();
        authGuess = 'in';
        return { loggedIn: true, account: t("antigravity.auth.account"), detail: t("antigravity.auth.detail") };
      } catch (err) {
        const message = String(err?.message ?? err);
        if (AUTH_REQUIRED.test(message)) {
          authGuess = 'out';
          return { loggedIn: false, account: null, detail: t("antigravity.auth.notLoggedIn") };
        }
        // 落ちた理由が分からないときは「ログインしていない」と断定しない（見通しも変えない）。
        // 生の stderr（URL・パスを含みうる）は detail に出さず、確かめられなかった固定の文言だけ
        return { loggedIn: false, account: null, unconfirmed: true, detail: t("antigravity.auth.unconfirmed") };
      }
    },

    /**
     * ログイン。**Pleiad からは OAuth を回せない。** 端末でのサインインを案内し、終わるのを待つ。
     *
     * 実機（agy 1.2.4）で確かめたこと:
     *   - ヘッドレスで未ログインだと stderr に認可 URL を出し、
     *     「Or, paste the authorization code here and press Enter:」と促す
     *   - **その入力は端末からしか読まない。** パイプした stdin に認可コードを書いても
     *     完全に無視され、60 秒で `authentication failed or timed out` になる（実測）
     * 公式も同じことを書いている:
     *   > Headless mode uses your cached credentials. Authenticate once with an interactive
     *   > `agy` session first.
     *
     * そこで Pleiad は**自分で回そうとしない**。端末で叩くコマンドを案内し、
     * `agy models` が通るようになるまで見張る（利用者は「再確認」を押さなくてよい）。
     */
    async login({ emit }) {
      if (pendingAuth) throw new Error(t("antigravity.auth.loginRunning"));
      pendingAuth = {};
      const watch = loginWatch.begin();
      try {
        if (await signedIn()) {
          emit?.({ type: "auth", phase: "done", message: t("antigravity.auth.alreadyLoggedIn") });
          return;
        }

        const argv = cliCommand("antigravity");
        // PATH に載っていないこともある（インストーラが PATH を書いても、
        // 起動済みの端末や Pleiad には届かない）。そのまま貼れる形で出す
        const command = argv ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "agy";
        emit?.({
          type: "auth", phase: "url", url: command,
          message: t("antigravity.auth.runCommand"),
        });

        const until = Date.now() + LOGIN_TIMEOUT_MS;
        while (Date.now() < until) {
          await watch.pause(LOGIN_POLL_MS);
          const done = await signedIn();
          watch.check();
          if (done) {
            emit?.({ type: "auth", phase: "done", message: t("antigravity.auth.loggedIn") });
            return;
          }
        }
        const message = t("antigravity.auth.loginTimeout");
        emit?.({ type: "auth", phase: "error", code: "TIMEOUT", message });
        throw loginTimeoutError(message);
      } finally {
        pendingAuth = null;
        watch.end();
      }
    },

    /** 待っているログインをやめる（見張りを止める）。login は CANCELLED で返る */
    async cancel() {
      return loginWatch.cancel();
    },

    /**
     * ログアウト。`agy` に口が無く、資格情報は OS の資格情報ストアにある。
     * Pleiad からは消せないので、そのことを伝える。
     */
    async logout() {
      throw new Error(t("antigravity.auth.logoutInAgy"));
    },
  },
};

// ---------------------------------------------------------------- 小道具

/** `agy models` の上限。明示の probe（対人の再確認・ログイン待ち）でも、OAuth の入力待ちで無期限に残さない */
const AGY_MODELS_TIMEOUT_MS = 30_000;
/** 読む出力の上限（モデルの一覧は数 KB。OAuth の案内などで膨らませない） */
const AGY_MODELS_MAX_CHARS = 128 * 1024;

/** ログイン済みか。`agy models` が通れば通っている（資格情報は OS の資格情報ストアにあり読めない）。 */
async function signedIn() {
  try {
    await fetchModels();
    authGuess = 'in';
    return true;
  } catch {
    return false;
  }
}

/**
 * `agy models` の出力（`id<TAB>表示名` の行。antigravity-models.mjs の parseAgyModels）と、
 * そのとき agy が選んでいた既定のモデルの表示名。既定は設定ファイルに出ないので、
 * `--log-file` で置き場を決めたログから読む（defaultLabelFromLog。読めなければ null）。
 * @returns {Promise<{ rows: {id:string,label:string}[], defaultLabel: string|null }>}
 */
function listModels() {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    let proc;
    const log = path.join(os.tmpdir(), `ply-agy-models-${process.pid}-${crypto.randomUUID()}.log`);
    const readDefault = () => {
      try { return defaultLabelFromLog(fs.readFileSync(log, "utf8")); }
      catch { return null; }
      finally { fs.rm(log, { force: true }, () => {}); }
    };
    try {
      proc = spawnModels(log);
    } catch (e) {
      return reject(e);
    }
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // 認証の入力待ちで残った子は自分の proc だけ止める（ほかのセッションの agy には触れない）
    const timer = setTimeout(() => {
      killTree(proc.pid).catch(() => { try { proc.kill(); } catch {} });
      settle(reject, new Error("agy models timed out"));
    }, AGY_MODELS_TIMEOUT_MS);
    const cap = (buf, chunk) => (buf.length >= AGY_MODELS_MAX_CHARS ? buf : buf + chunk.slice(0, AGY_MODELS_MAX_CHARS - buf.length));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => { out = cap(out, c); });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => { err = cap(err, c); });
    proc.on("error", (e) => settle(reject, e));
    proc.on("exit", () => {
      const text = out + err;
      const defaultLabel = readDefault();
      if (/sign in/i.test(text)) return settle(reject, new Error(text.trim()));
      // 一覧は stdout から読む。stdout に何も無いときだけ stderr も見る（以前の読み方）
      const fromOut = parseAgyModels(out);
      const rows = fromOut.length ? fromOut : parseAgyModels(text);
      if (!rows.length) return settle(reject, new Error(text.trim() || t("antigravity.errors.noModels")));
      settle(resolve, { rows, defaultLabel });
    });
  });
}

function spawnModels(log) {
  // `--log-file` は agy 全体のフラグなのでサブコマンドより前。既定のモデルを読むためだけに使い、読んだら消す
  return spawnCli(cliCommand("antigravity"), ["--log-file", log, "models"], { stdio: ["ignore", "pipe", "pipe"] });
}

/** 裏のコマンドを止める（backend.stopBackground）。agy の直下の子だけから選び、落とした後は DONE（一覧から外れる）を待つ */
async function stopCommand(session, command, taskId) {
  const agyPid = await agyPidOf(session).catch(() => null);
  if (!agyPid) throw new Error(t("antigravity.errors.backgroundNoAgy"));
  const list = await listProcesses({ parent: agyPid });
  const hit = pickCommandProcess(list, { agyPid, command });
  if (hit.error === "ambiguous") throw new Error(t("antigravity.errors.backgroundAmbiguous", { count: hit.count }));
  if (hit.error) throw new Error(t("antigravity.errors.backgroundNotFound"));
  const gone = session.behind?.wait(taskId, STOP_WAIT_MS);
  try {
    await killTree(hit.pid);   // list は agy の直下の子だけ。POSIX は子孫を辿るので、killTree が全部の一覧を取り直す
  } catch (err) {
    throw new Error(t("antigravity.errors.backgroundStopFailed", { why: String(err?.message ?? err).trim().slice(0, 300) }));
  }
  await gone;
  return { stopped: true };
}

/**
 * 会話の agy の pid。直に起こした agy は session.pid。保持役が持つ agy は pid を持たないので、付け直した子は保持役の子の状態（attach の答え・
 * 起動時の一覧）から、このサーバーが起こさせた子は保持役の直下の子のうち、起動の引数（agent の置き場・--conversation）で決まる 1 つから引く
 */
async function agyPidOf(session) {
  if (Number.isInteger(session.pid)) return session.pid;
  const held = session.held;
  if (!held) return null;
  const known = held.source?.attachedState?.pid ?? held.source?.state?.pid;
  if (Number.isInteger(known)) return known;
  const holderPid = held.client?.pid;
  if (!Number.isInteger(holderPid)) return null;
  const markers = [session.home, session.conversationId ? `--conversation ${session.conversationId}` : null].filter(Boolean);
  if (!markers.length) return null;
  return pickHeldAgy(await listProcesses({ parent: holderPid }), { holderPid, markers });
}

/**
 * アプリの終了で、保持役の agy（idle の子も、走っている子も）を止める（server の stopHeldChildren）。更新・落ちたときは呼ばない
 * （保持役の子は残り、新しいサーバーが起動で拾う。idle の子は次の起動が止める。antigravity-held.mjs の sweepIdleAtStart）
 */
export async function stopHeldAgy() {
  for (const [id, session] of [...live]) {
    if (!session.held) continue;
    try { session.kill(); } catch {}
    release(id, session);
    session.cleanup();
  }
}

/** 引けた一覧だけを覚える（失敗は覚えない。前に引けた一覧を残す）。写しも置き換える */
async function rememberModels(list) {
  if (!list?.rows?.length) return;
  modelCache = buildAgyModels(list.rows, list.defaultLabel);   // lazy load の中の古い写しは、代入前の null 判定で上書きされない
  modelCacheAt = Date.now();
  await persistModelsCache(list);
}

// ---- 一覧の写し（AGENT_HOST_DATA/antigravity/models.json） ---------------------------
// 明示の probe・ログインで `agy models` が取れたときだけ書く補助の控え。再起動のあと `agy models` を
// 起こさずに models()（id・段の efforts）を戻し、保存済みの明示モデルとエフォートを失わないため。
// **ログインの証拠には使わない**（写しがあるのは「昔取れた」だけ。authGuess は動かさない）。
// 行数・各 id/label の長さ・ファイルの大きさに固定の上限を持つ 1 ファイル（表・形式番号は増やさない）
const MODELS_CACHE_MAX_ROWS = 64;
const MODELS_CACHE_MAX_ID = 128;
const MODELS_CACHE_MAX_LABEL = 256;
const MODELS_CACHE_MAX_BYTES = 64 * 1024;

function modelsCacheFile() { return path.join(transcript.dir(), 'models.json'); }

/** 写しの中身の検査。形・長さの合わないものは「写しが無い」と同じに扱う（破損で壊れないように） */
function cacheRowsOf(raw) {
  if (!raw || !Array.isArray(raw.rows)) return null;
  const rows = raw.rows.slice(0, MODELS_CACHE_MAX_ROWS)
    .filter((r) => r && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= MODELS_CACHE_MAX_ID
      && typeof r.label === 'string' && r.label.length > 0 && r.label.length <= MODELS_CACHE_MAX_LABEL)
    .map((r) => ({ id: r.id, label: r.label }));
  if (!rows.length) return null;
  // 写しが取れた時刻。古い形（時刻なし）は 0＝古い一覧にして、ログインが確かめられれば引き直す。未来の時刻は今に畳む
  const fetchedAt = Number.isFinite(raw.fetchedAt) ? Math.max(0, Math.min(raw.fetchedAt, Date.now())) : 0;
  return { rows, defaultLabel: typeof raw.defaultLabel === 'string' && raw.defaultLabel.length > 0 && raw.defaultLabel.length <= MODELS_CACHE_MAX_LABEL ? raw.defaultLabel : null, fetchedAt };
}

function loadModelsCache() {
  modelsCacheLoad ??= (async () => {
    try {
      const file = modelsCacheFile();
      if ((await fs.promises.stat(file)).size > MODELS_CACHE_MAX_BYTES) return;   // 上限超えは読まない
      const cached = cacheRowsOf(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      if (!cached) return;
      const built = buildAgyModels(cached.rows, cached.defaultLabel);
      // 読み込みの途中で明示の probe が新しい一覧を入れても、古い写しで上書きしない（代入前に null を確かめる）
      if (Object.keys(built).length > 1 && modelCache === null) {
        modelCache = built;   // '' だけなら写し無しと同じ
        modelCacheAt = cached.fetchedAt;
      }
    } catch { /* 無い・壊れている → 空のまま */ }
  })();
  return modelsCacheLoad;
}

async function persistModelsCache(list) {
  try {
    const rows = (list.rows ?? []).slice(0, MODELS_CACHE_MAX_ROWS)
      .map((r) => ({ id: String(r.id ?? '').slice(0, MODELS_CACHE_MAX_ID), label: String(r.label ?? '').slice(0, MODELS_CACHE_MAX_LABEL) }))
      .filter((r) => r.id && r.label);
    if (!rows.length) return;
    const defaultLabel = typeof list.defaultLabel === 'string' ? list.defaultLabel.slice(0, MODELS_CACHE_MAX_LABEL) : null;
    const data = JSON.stringify({ rows, defaultLabel, fetchedAt: Date.now() });
    if (Buffer.byteLength(data, 'utf8') > MODELS_CACHE_MAX_BYTES) return;
    await fs.promises.mkdir(transcript.dir(), { recursive: true });
    await writeAtomic(modelsCacheFile(), data);
  } catch { /* 写しが書けなくても動きは変わらない */ }
}

// `agy models` の自動の引き直しは、このプロセスでログイン済みと確かめられた所（'in'）だけ:
//   - 送信の関所（requireModelCatalog）は、一覧が無ければ /usage で見通しを確かめてから取りに行く（待つ）
//   - 使用量が読めて一覧が無ければ、裏で 1 回取る（usage()）
//   - 'in' の間、一覧が読まれて TTL を過ぎた一覧なら、裏で引き直す（models()）
// 未確認（'unknown'）・未ログイン（'out'）では、受動の照会も送信の関所も `agy models` を起こさない

/**
 * `agy models` を 1 本にまとめて起こし、取れた一覧（と写し）を覚える。
 * 並ぶ取得（明示の probe・ログインの見張り・送信の関所・裏の引き直し）は同じ 1 本を待つ（single-flight）。
 */
function fetchModels() {
  if (!modelsFetch) {
    modelsFetchTriedAt = Date.now();
    modelsFetch = listModels()
      .then((list) => rememberModels(list))
      .finally(() => { modelsFetch = null; });
  }
  return modelsFetch;
}

/**
 * 一覧を裏で引き直す口。`agy models` はこのプロセスでログイン済み（'in'）と確かめられた所でだけ起こす
 *（未確認・未ログインでは自動的に起こさない）。起こすのは一覧が無い・TTL を過ぎたときで、
 * 前の試みから TTL 未満では起こさない（使用量の定期の読みをきっかけに起こし続けたり、失敗を繰り返したりしない）。
 * 呼び出しは待たない。「sign in」で落ちたら見通しを out に、ほかの失敗は前の一覧を残して次の TTL まで試さない
 */
function refreshModelsSoon() {
  if (authGuess !== 'in' || modelsFetch) return;
  if (modelCache !== null && Date.now() - modelCacheAt < modelsTtlMs()) return;
  if (Date.now() - modelsFetchTriedAt < modelsTtlMs()) return;
  void fetchModels().catch((e) => { if (AUTH_REQUIRED.test(String(e?.message ?? e))) authGuess = 'out'; });
}

// サーバが終わったら、サーバーの子として起こした agy を道連れにする（保持役の子には触れない。新しいサーバーが起動で拾う。ADR 0270）。
// **SIGINT / SIGTERM のハンドラは足さない**（server はワーカースレッドでも動く。
// 既定の終了挙動を変えないため、`exit` の範囲に留める）。
process.once("exit", () => {
  const gone = [];
  for (const session of live.values()) {
    // 保持役の子は保持役が持つ（新しいサーバーが付け直す。アプリの終了は stopHeldChildren が止める）。agent の置き場も残す
    if (session.held) continue;
    try { session.kill(); } catch {}
    // Pleiad のコンテキストを渡したエージェント定義も消す（agy の exit はもう受け取れない）
    session.cleanup();
    if (session.pid) gone.push(session.pid);
  }
  live.clear();
  pids.forget(...gone);
});

export { MODES, TOOL_HINTS, botSessionKey, rejectedBeforeRun, turnResultFor, usageFor, usageTotal, usageDelta, usageBaseOf };
