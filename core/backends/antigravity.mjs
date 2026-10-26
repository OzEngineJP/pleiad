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
import { antigravityLimit } from "./antigravity-limit.mjs";
import { agyComputerName, computerFailed, computerPrompt, computerResult, computerToolInput } from "./computer-delivery.mjs";
import { createHeldAgy, heldPlan, sweepIdle } from "./antigravity-held.mjs";
import { runAgySuggestion, suggestModel } from "./antigravity-suggest.mjs";
import { commandLabel, killTree, listProcesses, pickCommandProcess, pickHeldAgy } from "./antigravity-background.mjs";
import { t, agentT } from "../i18n.mjs";
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
  if (conversationId && live.get(conversationId) === session) live.delete(conversationId);
  if (session?.pid) pids.forget(session.pid);
}

/** 直近に引けたモデル一覧。`agy models` は認証が要るので、引けたときだけ覚える。 */
let modelCache = null;

/** ログインを 2 本同時に走らせないための印。 */
let pendingAuth = null;

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
 * `result.usage` -> Pleiad の usage イベント。
 * agy の usage は分けて数える（total_tokens = input + output + thinking + cache_read）。Claude・Codex と同じく
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

const toolName = (name) => (name && Object.hasOwn(TOOL_HINTS, name) ? name : name || "tool");

// ---------------------------------------------------------------- backend

const digest = (value) => (value == null ? null : crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32));

/**
 * 起動時にしか渡せないもの（Pleiad のコンテキスト・ブラウザー・Hooks・ply_computer・ply_control・bot の人格）の印。起動時と違う渡し方になる次のターンは agy を起こし直す。
 * トークンを含むものは頭の文字列ではなくダイジェストで持つ: 保持役に載せた agy の札（server の takeCard）にそのまま置いても秘密が出ず、付け直した先が同じ印で比べられる
 */
function keysOf({ contextKey, contextShape, browserEnv, hooksShape, computerKey, agentsKey = null, browserKey, controlKey, botKey, secretsKey = null, useAgent = false }) {
  return { context: digest(contextKey), shape: contextShape ?? null, browser: browserEnv?.AGENT_BROWSER_CONFIG ?? null, hooks: hooksShape ?? null,
    computer: digest(computerKey), agents: digest(agentsKey), browserTool: digest(browserKey), control: digest(controlKey), bot: botKey ?? null,
    // custom: カスタムエージェント（agent.md）で動いているか。ターンが注入で読み替える口の判定にも使う（agent.md の本文は再開で持ち越されるため印に入れない）
    custom: useAgent ? 1 : 0,
    // 秘密情報と変数（ADR 0217）。値はハッシュだけ（札に残る）。無い会話は今までと同じ印
    ...(secretsKey ? { secrets: digest(secretsKey) } : {}) };
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

  async usage() { return (await import('./antigravity-usage.mjs')).readAntigravityUsage(); },

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
    return modelCache ?? buildAgyModels([], null);
  },

  /**
   * 次の発言の候補（core/prompt-suggestions.mjs、ADR 0211）。prompt は指示と要約。返すのは生の返り（読むのは server 側）。
   * agy は 1 回ごとに会話を履歴に残すので、使い捨てのホームで起こす（antigravity-suggest.mjs）
   */
  async suggestNext({ prompt, signal }) {
    return runAgySuggestion({ prompt, model: suggestModel(await backend.models()), signal });
  },

  // ---- 実行 ---------------------------------------------------------------

  // adopt は付け直し（{ source, card }。adoptTurn だけが渡す）。無ければ普通のターン（保持役に載せるかは antigravity-held.mjs の heldPlan が決める）
  async runTurn({ prompt, sessionId, cwd, mode, model, effort, emit, signal, control, contextRuntime, browserEnv, browserInstructions, browserRuntime = null, agentRuntime = null, addedInstructions, computerRuntime = null, controlRuntime = null, hooksRuntime = null, secretsRuntime = null, locale, notes = [], botInstructions = null, botFolders = null, account = null, scanOptions = {} }, adopt = null) {
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
    const sent = k ? await adoptedSent(sessionId, sentAt, k.sentHash) : [...notes, String(prompt ?? "")].join("");

    let conversationId = sessionId ?? null;
    // 再開した会話の途中の書き込みでは控えを作らない（--conversation が撥ねられて forget した控えを作り直さない）
    const resumed = k ? Boolean(k.resumed) : Boolean(sessionId);
    let sawText = false;
    let text = "";                 // 控えに残す本文
    let finishedReply = false;     // agent_response の DONE。途中までの文とは分ける
    let replyTextSinceTool = "";
    const toolCalls = [];          // 控えに残すツール呼び出し
    let settle = null;
    let failed = null;
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
    let handedOff = false;         // 旧サーバーが新しいサーバーへ手を離した（以後、このサーバーは控えに書かない・締めない）
    let handingOff = false;        // 手を離している最中（札を子に置いて detach する）
    let writes = Promise.resolve();
    let queued = false;            // 積んだまま、まだ始まっていない書き込みがある（次のを積まない。始まるときに最新を読む）
    let final = null;              // 終わりに書く分（畳んだ後に遅れて届いた出来事を混ぜない）
    let textTimer = null;
    const snapshot = (at) => [
      ...(sent === null ? [] : [{ role: "user", text: sent, uuid: `${conversationId}:u${sentAt}`, at: new Date(sentAt).toISOString() }]),
      // uuid はターンの間変えない（送信の時刻から作る）。変えると控えにも写しの会話（core/conversations.mjs の mergeMessages）にも二重に並ぶ
      ...(text || toolCalls.length ? [{
        role: "assistant", text, uuid: `${conversationId}:a${sentAt}`, at: new Date(at).toISOString(),
        ...(toolCalls.length ? { tools: toolCalls.map((c) => c.name), toolCalls: [...toolCalls] } : {}),
      }] : []),
    ];
    const save = ({ last = false } = {}) => {
      // 畳んだ後は終わりの分（seal）だけを書く。遅れて届いた出来事で書き直さない
      if (!delivered || !conversationId || queued || handedOff || (final && !last)) return writes;
      queued = true;
      writes = writes.then(() => {
        queued = false;
        const messages = final?.messages ?? snapshot(Date.now());
        return transcript.appendMessages(conversationId, { cwd, messages, create: final?.create ?? !resumed,
          ...(final?.turnResult ? { turnResult: final.turnResult } : {}) });
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
      if (final || !delivered || handedOff) return writes;
      final = { messages: snapshot(Date.now()), create: ok || !resumed,
        turnResult: resultTrace ? { sentAt, at: new Date().toISOString(), ...resultTrace } : null };
      return save({ last: true });
    };

    // 生きているプロセスを使い回す。落ちていれば立て直す（会話は --conversation で拾える）
    let session = !adopt && conversationId ? live.get(conversationId) : null;
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
    const keys = keysOf({ contextKey, contextShape, browserEnv, hooksShape, computerKey, agentsKey, browserKey, controlKey, botKey, secretsKey, useAgent });
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
        // --model と --effort は同時に渡さない。段は同じ系統の段違いの id に解決する（antigravity-models.mjs）
        ...agyTarget(model, effortFor(effort), modelCache ?? {}),
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
    }

    // opts は feedLine から来る（付け直しの再生の行は { replay: true }。server の makeEmit が画面へ流さず、実行中のスナップショットとメモリの状態だけを作る）
    const handle = (ev, opts) => {
      const out = (event) => emit(event, opts?.replay ? { replay: true } : undefined);
      // Step updates without a history entry still show that the child is active.
      out({ type: 'task.activity', output: true });
      switch (ev?.event) {
        case "init": {
          const id = ev.conversation_id ?? ev.init?.conversation_id ?? null;
          if (!id) return;
          const isNew = !conversationId;
          conversationId = id;
          live.set(id, session);
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
            // 知らない state・state 無しでも取りこぼさない: output があれば完了、無ければ開始
            const done = state === "ACTIVE" ? false
              : state === "DONE" ? true
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
            const raw = typeof output === "string" ? output : JSON.stringify(output ?? "");
            // ply_computer: 画像を退避した行を除き、印の行から images と computer を作る。控えにもその形で残す（読み直しで印を読み直さない）
            const r = computer ? computerResult(raw, cut) : cut(raw);
            const isError = computer ? computerFailed(r.computer) : false;
            out({ type: "tool.result", id, ...r, isError });
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
          // 本文の無い SUCCESS は、打ち切り（onPrintTimeout）と見分けがつかない。印が遅れて
          // 届く分だけ待ってから確定する。その間に印が来れば onPrintTimeout が失敗として畳む
          if (!ev[LATE] && !opts?.replay && !sawText && !r.response && String(r.status ?? "").toUpperCase() === "SUCCESS") {
            // 保持役の読みは、確定するまで ack しない（待つ間に手を離しても、新しいサーバーが同じ result を読み直す）
            return new Promise((resolve) => setTimeout(() => resolve(handle({ ...ev, [LATE]: true }, opts)), EMPTY_SUCCESS_GRACE_MS));
          }
          conversationId ||= r.conversation_id || null;
          if (sawText) out({ type: "text.end" });
          const usage = usageFor(r.usage);
          if (usage) out(usage);
          const outcome = turnResultFor(r, { finishedReply });
          resultTrace = { source: "result", status: String(r.status ?? "").slice(0, 100), outcome: outcome.outcome,
            ...(r.error ? { error: String(r.error).slice(0, 1000) } : {}) };
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
    // 札を保持役の子に置く口（server の touchCard が、札の中身が変わるたびに呼ぶ）と、旧サーバーの手を離す口（core/handover.mjs の detach）
    const bindHolder = () => {
      const held = session.held;
      if (!control || !held) return;
      control.holder = {
        label: (card) => held.label(card),
        handOff: async (card) => {
          // 手を離す最中に結果が届いてターンが終わっても、札と印は外さない（終わった直後のターンを付け直す側が、記録の結果から締める）
          handingOff = true;
          await save();   // 控え（会話の記録）を最新にしてから手を離す。新しいサーバーは同じ uuid で書き直す
          await held.handOff(card);
          handedOff = true;
          clearTimeout(textTimer);
          settle?.();
        },
      };
      session.holder = control.holder;   // テストの入口（handOffAgy）が引く
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
        session.prompt([injectedText, agentRuntime?.instructions ?? addedInstructions, sent].filter(Boolean).join("\n\n"));
        // 渡せた。再開した会話は id が分かっているので、ユーザー発言をここで書く（新しい会話は init で）
        delivered = true;
        save();
      }
      await finished;
      // 旧サーバーが手を離した。このターンはここで終わる（出来事は server が捨てる。締めるのは付け直したサーバー）
      if (handedOff) { emit({ type: "turnResult", outcome: "aborted" }); return { sessionId: conversationId, handedOff: true }; }
      await reportHookRuns(session, hooksRuntime, emit);

      // 終わりの分を書く（時刻は発言ごとに変える: ユーザーは送信時、AI は完了時。提示はこの間に入る）。
      // 失敗・中断・打ち切りでも、そこまでのツールと本文を残す（中断の印は sidecar の interrupted が持つ）
      const aborted = Boolean(signal?.signal?.aborted);
      if (aborted) resultTrace ??= { source: "abort", status: null, outcome: "aborted" };
      await seal({ ok: !aborted && !failed });

      if (aborted) {
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: conversationId, nativeInjected };
      }
      if (failed) throw failed;
    } catch (err) {
      if (handedOff) { emit({ type: "turnResult", outcome: "aborted" }); return { sessionId: conversationId, handedOff: true }; }
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
      // 保持役の子はターンが終わっても会話のあいだ生きる（idle）。札と印を外し、付け直す対象から外す。手を離した子には触れない
      if (!handedOff && !handingOff) session.held?.endTurn();
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

  /**
   * 引き継ぎ（core/server.mjs の handoverRun。旧サーバーが手を離した後、預かり物を置く前）: ターンの無い（idle の）保持役の agy を止める。
   * 走っているターンは手を離して新しいサーバーが付け直すが、idle の子は新しいサーバーが知らない（札が無い）ので、残すと止める人が居なくなる。
   * 次のターンは agy を起こし直す（会話は --conversation で続く）。止めた数を返す
   */
  releaseIdle() {
    let stopped = 0;
    for (const [id, session] of [...live]) {
      if (!session.held || session.held.handedOff) continue;
      try { session.kill(); } catch {}
      release(id, session);
      session.cleanup();
      stopped++;
    }
    return stopped;
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
    async status() {
      try {
        rememberModels(await listModels());
        return { loggedIn: true, account: t("antigravity.auth.account"), detail: t("antigravity.auth.detail") };
      } catch (err) {
        const message = String(err?.message ?? err);
        if (/sign in/i.test(message)) {
          return { loggedIn: false, account: null, detail: t("antigravity.auth.notLoggedIn") };
        }
        // 落ちた理由が分からないときは「ログインしていない」と断定しない
        return { loggedIn: false, account: null, detail: message.slice(0, 200) };
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

/** ログイン済みか。`agy models` が通れば通っている（資格情報は OS の資格情報ストアにあり読めない）。 */
async function signedIn() {
  try {
    rememberModels(await listModels());
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
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => { out += c; });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => { err += c; });
    proc.on("error", reject);
    proc.on("exit", () => {
      const text = out + err;
      const defaultLabel = readDefault();
      if (/sign in/i.test(text)) return reject(new Error(text.trim()));
      // 一覧は stdout から読む。stdout に何も無いときだけ stderr も見る（以前の読み方）
      const fromOut = parseAgyModels(out);
      const rows = fromOut.length ? fromOut : parseAgyModels(text);
      if (!rows.length) return reject(new Error(text.trim() || t("antigravity.errors.noModels")));
      resolve({ rows, defaultLabel });
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
  if (!held || held.handedOff) return null;
  const known = held.source?.attachedState?.pid ?? held.source?.state?.pid;
  if (Number.isInteger(known)) return known;
  const holderPid = held.client?.pid;
  if (!Number.isInteger(holderPid)) return null;
  const markers = [session.home, session.conversationId ? `--conversation ${session.conversationId}` : null].filter(Boolean);
  if (!markers.length) return null;
  return pickHeldAgy(await listProcesses({ parent: holderPid }), { holderPid, markers });
}

/** 引けた一覧だけを覚える（失敗は覚えない。前に引けた一覧を残す） */
function rememberModels(list) {
  if (!list?.rows?.length) return;
  modelCache = buildAgyModels(list.rows, list.defaultLabel);
}

// サーバが終わったら、生かしている agy を道連れにする。
// **SIGINT / SIGTERM のハンドラは足さない**（server はワーカースレッドでも動く。
// 既定の終了挙動を変えないため、`exit` の範囲に留める）。
process.once("exit", () => {
  const gone = [];
  const frames = new Map();   // 保持役の子を止める依頼を、保持役への接続ごとに 1 回の書き込みにまとめる（続けて write すると、終わる前に最初の 1 つしか出ない）
  for (const session of live.values()) {
    // 保持役に手を離した子は保持役が持つ（新しいサーバーが付け直す）。agent の置き場も残す
    if (session.held?.handedOff) continue;
    if (session.held) {
      const client = session.held.client;
      if (client) frames.set(client, [...(frames.get(client) ?? []), ...session.held.exitFrames()]);
      session.proc = null;
    } else try { session.kill(); } catch {}
    // Pleiad のコンテキストを渡したエージェント定義も消す（agy の exit はもう受け取れない）
    session.cleanup();
    if (session.pid) gone.push(session.pid);
  }
  live.clear();
  pids.forget(...gone);
  for (const [client, list] of frames) { try { client.sendBatch(list); } catch {} }
});

/**
 * 旧サーバーの手を離す口（テストの入口 tests/lib/adopt-server.mjs が呼ぶ。本番は core/handover.mjs が control.holder.handOff を呼ぶ）: 札（server の handOffTurn の card）を
 * 保持役の子に置いて detach する。sessionId は agy の会話の id
 */
export async function handOffAgy(sessionId, card) {
  const session = live.get(sessionId);
  if (!session?.holder) throw new Error(`antigravity: no held turn to hand off (${sessionId})`);
  await session.holder.handOff(card);
  return { childId: session.held.id };
}

/** テスト用: 保持役の子への書き込みを止める／戻す。止めている間の書き込みは捨てる */
export function muteAgyHeld(sessionId, muted) {
  const session = live.get(sessionId);
  if (!session?.held) throw new Error(`antigravity: no held session (${sessionId})`);
  session.held.mute(muted);
  return true;
}

/** テスト用: 読みを止める（agy の出力は保持役に溜まり、このサーバーは処理も ack もしない）／再開する */
export function pauseAgyHeld(sessionId, paused) {
  const session = live.get(sessionId);
  if (!session?.held) throw new Error(`antigravity: no held session (${sessionId})`);
  session.held.pause(paused);
  return true;
}

export { MODES, TOOL_HINTS, botSessionKey, turnResultFor, usageFor };
