// Google Antigravity CLI（`agy`）のバックエンド。
//
// これが Pleiad で **Google のサブスク枠（AI Pro / Ultra）を正規の手段で使える唯一の道**。
// gemini-cli の個人向けログインは 2026-06-18 に終了し、Gemini API キーは別建ての従量課金、
// Antigravity SDK は API キーか Vertex しか受けない（docs/multi-backend.md §2.8）。
//
// **口は ACP（`agy acp`。1.5.15 以降）。** JSON-RPC を stdio で話す共通の口（acp-client.mjs）に、agy 固有の差（antigravity-acp.mjs）を載せる。
// 会話ごとに 1 プロセス（live）を持ち、次の発言まで IDLE_MS だけ生かす。承認は session/request_permission を Pleiad の承認カードへ繋ぎ、
// モード・モデル・段はターンの途中でも session/set_config_option（configId: mode・model・thought_level）で替えられる。古い agy（1.5.15 未満）は
// 古い口へ落とさず、更新を促す（antigravity.errors.acpTooOld）。
//
// **組織の管理ポリシーは承認の省略（yolo）より強い。** 確認を求める設定のとき、確認の要るツールは拒否される。黙らせずに知らせる（adminNotice）。
// **思考は流れない**（thought chunk は捨てる。thinking_tokens は usage_update の集計にだけ出る）。
import { cliCommand, spawnCli } from "../cli-installation.mjs";
import { AgyAcp, MIN_ACP_VERSION, agyLaunchProfile, assertFileStorage, prepareAgyLogs, tooOldAcp } from "./antigravity-acp.mjs";
import { LOGIN_TIMEOUT_MS, accountHome, hasAgyToken, loginAgyAccount } from "./antigravity-accounts.mjs";
import { adoptHome, agyRestricted, antigravityAgentOwners, antigravitySkipsNativeInstructions, prepareAgent, sweep, sweepHeldHomes, systemPromptAppend } from "./antigravity-context.mjs";
import { nativeInstructionEntries } from "../context-session.mjs";
import * as transcript from "./antigravity-store.mjs";
import { AGY_LEVELS, agyTarget, buildAgyModels, defaultLabelFromLog, parseAgyModels } from "./antigravity-models.mjs";
import { MAX_RESULT_CHARS, cutText } from "./shared.mjs";
import { writeAtomic } from "../atomic-file.mjs";
import { undelivered } from "./undelivered.mjs";
import { agyComputerName, computerFailed, computerPrompt, computerResult, computerToolInput } from "./computer-delivery.mjs";
import { createHeldAcp, heldAcpPlan, sweepIdleAcp } from "./acp-held.mjs";
import { createAcpSteer } from "./acp-steer.mjs";
import { holderLink } from "../holder/link.mjs";
import { bootEnv } from "../boot-env.mjs";
// antigravity-suggest.mjs（使い捨てホームで候補を作る）は、内部呼出しを分離して呼べる保証が無いため使わない（Issue #180）
import { commandLabel, pickCommandProcess, pickHeldAgy } from "./antigravity-background.mjs";
import { killTree, listProcesses } from "../process-tree.mjs";
import { t, agentT } from "../i18n.mjs";
import { mcpContacted, mcpContactsWatched } from "../mcp-contact.mjs";
import { createLoginWatch, loginTimeoutError } from "../auth/login-watch.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from '../store.mjs';
import { readAgyRuns, rotateAgyRuns } from '../hooks-unify.mjs';
import { CAPABILITY_STATES, AGENT_TRAITS } from './agent-marks.mjs';

/** `agy acp` の起動と握手を待つ上限（ms） */
const START_TIMEOUT_MS = Number(process.env.AGENT_HOST_AGY_START_MS ?? 120_000);

/** 中断（session/cancel）に agy が応じるのを待つ上限。過ぎたらその agy を落とす（会話は残るので次のターンで起こし直す） */
const CANCEL_GRACE_MS = Number(process.env.AGENT_HOST_AGY_CANCEL_MS ?? 5_000);

/** 保持役の子の id の頭。保持役は Claude・fake の子とも共有するので、agy の子だけを見分ける */
const ACP_CHILD_PREFIX = 'acp-agy-';

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
 * 承認モード。ACP の mode（session/set_config_option の configId: 'mode'）に対応する。`acp` が agy 側の id。
 *
 * - `default`（都度確認）・`accept-edits`・`auto`・`plan` は、ツールの承認を session/request_permission で受けて Pleiad の承認カードへ繋ぐ。
 * - `yolo` は起動の旗（`--dangerously-skip-permissions`）。**起動の時にしか決まらない**ので、yolo と それ以外の行き来は agy の起こし直し（keysOf・setModeLive が false）。
 *   新しい会話の既定は今までどおり `yolo`。
 *
 * **組織の管理ポリシーは skip より強い。** Gemini Enterprise の管理者が確認を求める設定にしていると、
 * `--dangerously-skip-permissions` を付けても `permission_mode` は `request-review` になり、確認の要るツールは拒否される。
 * 黙らせずに知らせる（下の adminNotice。docs/multi-backend.md §2.8「組織の管理ポリシー」）
 */
const MODES = {
  default: {
    // label / note はゲッター（サーバーの言語は実行中に変わる。core/i18n.mjs）
    get label() { return t("modes.ask"); },
    get short() { return t("modesShort.ask"); },
    get note() { return t("antigravity.modes.default"); },
    acp: "default",
    scope: "full",
    autonomy: "ask",
    enforced: false,
  },
  "accept-edits": {
    get label() { return t("modes.acceptEdits"); },
    get short() { return t("modesShort.acceptEdits"); },
    get note() { return t("antigravity.modes.accept-edits"); },
    acp: "accept-edits",
    scope: "full",
    autonomy: "ask",
    enforced: false,
  },
  auto: {
    get label() { return t("modes.auto"); },
    get short() { return t("modesShort.auto"); },
    get note() { return t("antigravity.modes.auto"); },
    acp: "auto",
    scope: "full",
    autonomy: "judge",
    enforced: false,
  },
  plan: {
    get label() { return t("modes.plan"); },
    get short() { return t("modesShort.plan"); },
    get note() { return t("antigravity.modes.plan"); },
    acp: "plan",
    scope: "readonly",
    autonomy: "ask",
    enforced: false,
  },
  yolo: {
    get label() { return t("modes.full"); },
    get short() { return t("modesShort.full"); },
    get note() { return t("antigravity.modes.yolo"); },
    skip: true,
    // 軸（core/modes.mjs）。確認しないので never。範囲は絞らない
    scope: "full",
    autonomy: "never",
    enforced: false,
  },
};

/**
 * 段の値（`agy --help` の `--effort` で確認）。画面に出す段の候補はモデル一覧の efforts から取る（core/effort.mjs）。
 * agy の段は「段違いの id を選ぶ」ことなので、段そのものは設定せず id に解決する（antigravity-models.mjs の agyTarget）
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

/** 会話ごとの生きたプロセス。**1 プロセス = 1 会話**（entry は newEntry）。 */
const live = new Map();   // conversationId -> entry

// 前の起動が残した、Pleiad のコンテキストを渡すためのエージェント定義も消す（antigravity-context.mjs）
sweep();

/** account の指定の検査。無ければ null（1 つ目＝今ログインしているアカウント）。指定があるのに id が無い（空のオブジェクトなど）ものは、1 つ目へ黙って落とさず断る */
function profileFor(account) {
  if (account != null && !account?.id) throw Object.assign(new Error('A valid Antigravity account is required'), { code: 'AGY_ACCOUNT_INVALID' });
  return agyLaunchProfile({ account: account ?? null });
}

/** 登録したアカウントの agy を止めている・ログインしている・消している最中（会話の起動と消す操作が重ならないための印） */
const accountLogins = new Set();
const accountRemoving = new Set();
/** アカウントの会話の生きた agy（keys.profile がアカウントの id） */
const entriesOf = account => [...new Set(live.values())].filter(entry => entry.keys?.profile === account?.id || entry.profile?.key === account?.id);

/** 会話の生きた agy 1 本の状態。client は AgyAcp。turn は走っているターンの受け口（無いときは出来事を捨てる） */
function newEntry(conversationId, fields = {}) {
  return { conversationId, client: null, held: null, keys: null, home: null, hookRuns: null, cleanup: () => {}, mcpTokens: [], mcpServers: [],
    permissionMode: "", reviewNoticed: false, mcpChecked: false, behind: null, idleTimer: null, turn: null, sessionId: null,
    caps: null, modeId: null, modelId: null, config: [], commands: [],
    get pid() { return this.client?.pid ?? null; },
    kill() { closeEntry(this); },
    ...fields };
}

function processGone(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e?.code === 'ESRCH'; }
}

/** agy を止める（ACP の close → プロセスの木）。保持役の子も同じ口で止まる（AcpClient が held を通す） */
function closeEntry(entry) {
  if (!entry?.client) return;
  const client = entry.client;
  void (async () => {
    try {
      if (entry.sessionId && entry.caps?.sessionCapabilities?.close && client.alive) {
        await client.call("session/close", { sessionId: entry.sessionId }, { timeoutMs: 2_000 }).catch(() => {});
      }
    } finally { await client.close().catch(() => {}); }
  })();
}

/** 会話から手を引く。live の印を落とし、止めるタイマーも外す */
function release(conversationId, entry) {
  disarmIdle(entry);
  if (conversationId && live.get(conversationId) === entry) live.delete(conversationId);
  if (entry?.conversationId && live.get(entry.conversationId) === entry) live.delete(entry.conversationId);
}

/** 次のターンを待ち始めた agy に、IDLE_MS で止めるタイマーを付ける。止めた後の次のターンは session/resume で起こし直す（会話は agy が持つ） */
function armIdle(conversationId, entry) {
  disarmIdle(entry);
  if (IDLE_MS === null || !conversationId || !entry?.client?.alive || live.get(conversationId) !== entry) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (live.get(conversationId) !== entry) return;
    closeEntry(entry);
    release(conversationId, entry);
    entry.cleanup?.();
  }, IDLE_MS);
  entry.idleTimer.unref?.();
}

function disarmIdle(entry) {
  if (!entry?.idleTimer) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

/** ターンの途中の切り替えの対象（runTurn が control.handle に置く { sessionId }）。生きていて走っているターンの会話だけ */
function liveEntry(handle) {
  const entry = live.get(handle?.sessionId ?? handle?.conversationId);
  return entry?.client?.alive && entry.sessionId ? entry : null;
}

/** モデル・段（agyTarget の結果）を agy の設定に反映して確かめる。断られたら configRejected の印つきで投げる */
async function applyTarget(on, target) {
  const options = [];
  if (target.model && target.model !== on.modelId) options.push(["model", target.model]);
  if (!target.model && target.effort) options.push(["thought_level", target.effort]);
  for (const [configId, value] of options) {
    const applied = await on.client.call("session/set_config_option", { sessionId: on.sessionId, configId, value });
    if (Array.isArray(applied?.configOptions)) on.config = applied.configOptions;
    const current = applied?.configOptions?.find((o) => o.id === configId)?.currentValue;
    if (current !== value) throw Object.assign(new Error(t("antigravity.errors.modelRejected")), { configRejected: { option: configId } });
    if (configId === "model") on.modelId = value;
  }
}

/** session/new が返したモデルの一覧から、まだ一覧が無いときだけ控えを作る（`agy models` を起こさずに済む）。形が違えば何もしない */
function learnModels(catalog, state) {
  const list = state?.models?.availableModels;
  if (catalog.modelCache !== null || !Array.isArray(list) || !list.length) return;
  const rows = list.map((m) => ({ id: String(m?.modelId ?? m?.id ?? ""), label: String(m?.name ?? m?.label ?? m?.modelId ?? m?.id ?? "") })).filter((r) => r.id);
  if (!rows.length) return;
  void rememberModels(catalog, buildAgyModels(rows, null)).catch(() => {});
}

let sweptIdle = false;
/**
 * このプロセスで 1 回だけ（起動の sweepIdleAtStart か、そこでつなげなければ最初の保持役の使用）、前のサーバーが残した agy の子を片付ける: **札か印の欠けた**（idle の）子は止める。
 * agent の置き場（held-*）も、生きている子が指していないものを消す。この呼び出しの前に保持役へつないでいた自分の子（ids）は止めない
 */
async function sweepIdleOnce(client, { ids = new Set() } = {}) {
  if (sweptIdle) return [];
  sweptIdle = true;
  return sweepIdleAcp(client, {
    prefix: ACP_CHILD_PREFIX,
    ids,
    onHomes: (kept) => sweepHeldHomes(new Set(kept.map((child) => child.label?.backendCard?.agy?.home).filter(Boolean))),
  });
}

/**
 * サーバーの起動で、前のサーバーが保持役に残した idle の agy を止める（sweepIdleOnce）。server が起動の付け直し（restoreAdoptedTurns）の後に呼ぶ。
 * 居る保持役にだけつなぐ（起こさない）。保持役が居ない・つなげないときは何もせず、次の保持役の使用に任せる
 */
export async function sweepIdleAtStart({ dataDir, log = console.error } = {}) {
  const root = bootEnv("AGENT_HOST_RUNTIME_ROOT");
  if (sweptIdle || !dataDir || !root) return [];
  let client;
  try { client = await holderLink({ dataDir, root, key: bootEnv("AGENT_HOST_RUNTIME_KEY") ?? "", launch: false }); }
  catch (error) {
    // i18n-ignore: サーバーのログ（log は console.error）
    if (error?.code !== "HOLDER_NONE") log("  保持役につなげないので、前のサーバーが残した agy は次の使用で片付ける:", String(error?.code ?? error?.message ?? error));
    return [];
  }
  return sweepIdleOnce(client);
}

/** テスト用: sweepIdleOnce の「1 回だけ」を戻す */
export function resetSweep() { sweptIdle = false; }
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


/**
 * 起動の型（agyLaunchProfile の key）ごとの、モデル一覧・認証の見通し・ログインの進行。
 * 複数アカウント（Ph3）で環境や資格情報が分かれても、一覧と single-flight が混ざらないようにする。
 */
const profileStates = new Map();
function profileState(key = "default") {
  const id = String(key || "default");
  if (!profileStates.has(id)) profileStates.set(id, {
    key: id,
    /** 直近に引けたモデル一覧。`agy models` は認証が要るので、引けたときだけ覚える */
    modelCache: null,
    /** 一覧を引いた（写しから戻した）時刻。古い形の写しには時刻が無いので 0（＝古い） */
    modelCacheAt: 0,
    /** 一覧の写しの読み込み。同じプロファイルの全員が同じ 1 本を待つ */
    modelsCacheLoad: null,
    /** 進行中の `agy models`。並ぶ取得は同じ 1 本を待つ（single-flight） */
    modelsFetch: null,
    /** 最後に一覧の取得を試みた時刻（成否を問わない）。裏の引き直し（TTL）の間隔に使う */
    modelsFetchTriedAt: 0,
    /** 最後に一覧の取得が失敗した時刻。送信の関所が失敗を連発しないための間隔に使う */
    modelsFetchFailedAt: 0,
    /** 送信の関所（見通しの確認 → 取得）の進行中の 1 本。並ぶ呼び出しは同じ結果を受け取る */
    modelsGate: null,
    /** ログインを 2 本同時に走らせないための印 */
    pendingAuth: null,
    /** 最後に分かったログインの見通し（'unknown'|'in'|'out'。プロセス内だけ） */
    authGuess: "unknown",
    /** 待っているログインの見張りをやめる口（authCancel） */
    loginWatch: createLoginWatch("Antigravity"),
  });
  return profileStates.get(id);
}
/**
 * 覚えた一覧を古いとみなすまでの ms（`AGENT_HOST_AGY_MODELS_TTL_MS`。既定 5 分）。
 * agy の既定（/model の選択）は Pleiad の外で変わり得るので、過ぎた一覧は読み取りをきっかけに裏で引き直す（issue #161）。
 * 読み取りごとに評価する（試験が途中で変えられるように）
 */
const modelsTtlMs = () => Number(process.env.AGENT_HOST_AGY_MODELS_TTL_MS ?? 5 * 60_000);
/**
 * 送信の関所が一覧の取得を試す間の、直前の失敗から試行を控える ms（`AGENT_HOST_AGY_MODELS_GATE_RETRY_MS`。既定 30 秒）。
 * 裏の取得（usage の温め・TTL の引き直し）が一時的な理由で 1 回落ちただけで、人の送信や bot の送信が
 * TTL いっぱい「一覧を確認して」で断られるのを防ぐため、裏の間隔（TTL）より短い間隔にする。
 * 読み取りごとに評価する（試験が途中で縮められるように）
 */
const modelsGateRetryMs = () => Number(process.env.AGENT_HOST_AGY_MODELS_GATE_RETRY_MS ?? 30_000);

/**
 * 最後に分かったログインの見通し（'unknown'|'in'|'out'。プロセス内だけ）。
 * 受動の照会が `agy` を起こさないための状態表示用。`agy models`（未ログインだと「Please sign in」で落ちるか、
 * 環境によっては認証待ちになるサブコマンド）は、このプロセスでログイン済みと確かめられた所
 * （人の明示の確認・ログイン・使用量の読み・認証を通ったターン）でだけ起こす。
 * `--print` 系（公式の headless 保証）は受動でも起こせる
 */
/** 未認証の印（`agy models` の「Please sign in」と `--print` 系の authentication required） */
const AUTH_REQUIRED = /sign in|authentication required/i;


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

/** 確認を出せずに拒否されたツールの文面（実機の失敗したツールの文面。stream-json の `tool_info.error.message` で見たもの。組織の管理ポリシーの「要審査」など） */
const DENIED_RE = /permission check failed|denied permission/i;

/**
 * 確認なしで渡したのに session/new の応答（`_meta.antigravity.permissionMode`）が返したら、管理側の設定（「ターミナル自動実行モード」が「要審査」）が勝っていると分かる値（実機 1.5 系で確認）。
 * 知らない値（「サンドボックスで続行」のときなど）は確認が要るとは限らないので知らせない
 */
const REVIEW_MODES = new Set(["request-review"]);

/** 中継に渡したトークン（mcpServers の env。antigravity-context.mjs の prepareAgent）。1 本でも口へ来れば、agy は Pleiad の MCP を起こしている */
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
 * 使用量の累計（`usage_update` の `_meta.antigravity.usage`）またはその差 -> Pleiad の usage イベント。
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
/** 使用量の累計の数（agy の会話の始まりからの累計。stream-json の `result.usage` を 1.5.2 で実測。ACP の `usage_update` で同じかは実機で未確認）。無ければ null */
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
function keysOf({ contextKey, contextShape, browserEnv, hooksShape, computerKey, agentsKey = null, browserKey, controlKey, botKey, secretsKey = null, useAgent = false, profileKey = "default", yolo = false }) {
  return { context: digest(contextKey), shape: contextShape ?? null, browser: browserEnv?.AGENT_BROWSER_CONFIG ?? null, hooks: hooksShape ?? null,
    computer: digest(computerKey), agents: digest(agentsKey), browserTool: digest(browserKey), control: digest(controlKey), bot: botKey ?? null,
    // custom: Skills・MCP を止める会話（agent 定義 ply-context）で動いているか。ターンが注入で読み替える口の判定にも使う（agent.md の本文は再開で持ち越されるため印に入れない）
    custom: useAgent ? 1 : 0,
    // 起動の旗（--dangerously-skip-permissions）。yolo とそれ以外の行き来は起こし直し（それ以外の承認モードの行き来は session の mode で替える）
    yolo: yolo ? 1 : 0,
    // 起動の型（agyLaunchProfile）。アカウントごとに環境・引数が変わる将来のための区別（今は 'default' だけ）
    profile: profileKey,
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

  // `--print /usage` は公式の headless 保証（未認証なら authentication required で落ち、OAuth を始めない。対応版 1.1.11+）で
  // 受動の照会から呼べる。未ログインと分かっている間は起こさない。
  // 'in' は `--print /usage` が実際に読めた（attempted）ときだけ（古い CLI の needsUpdate は認証を試していない）。
  // 'out' は未認証の確定（AUTH_REQUIRED コード）だけ。理由は quota store の構造化の行（no-login）で伝える
  async usage() {
    const catalog = profileState();
    if (catalog.authGuess === 'out') return { windows: [], reason: 'no-login', message: t("antigravity.auth.notLoggedIn") };
    try {
      const result = await (await import('./antigravity-usage.mjs')).readAntigravityUsage();
      if (result?.attempted === true) {
        catalog.authGuess = 'in';
        // 使用量が読めた＝このプロセスでログイン済みが確かめられた。一覧（メモリにも写しにも）が無ければ裏で 1 回取る
        //（この呼び出しは待たない。間隔の制限は refreshModelsSoon。一覧があるのに定期の読みで起こし続ける形にはしない）
        if (catalog.modelCache === null) {
          await loadModelsCache(catalog);
          if (catalog.modelCache === null) refreshModelsSoon(catalog);
        }
      }
      return result;
    } catch (e) {
      if (e?.code === 'AUTH_REQUIRED' || AUTH_REQUIRED.test(String(e?.message ?? e))) {
        catalog.authGuess = 'out';
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
  async models(cwd, { refresh = false } = {}) {
    // `agy models` は headless の保証が無いので、未確認（'unknown'）・未ログイン（'out'）では起こさない。
    // 'in' の間だけ、一覧が無い・TTL を過ぎた一覧を、この読み取りをきっかけに裏で引き直す
    //（この呼び出しは待たない。今の一覧（無ければ空）を返す。issue #161）。
    // 写し（認証の証拠ではない）があれば、再起動直後も保存済みの明示モデル・エフォート（models[id].efforts）を戻す
    // { refresh }（選ぶときに「一覧に無い」を確かめ直す、server の validModel）は 'in' のときだけ
    // 待って取り直す（TTL・受動の間隔を無視するが、`agy models` を起こしてよい条件は変えない）
    const catalog = profileState();
    if (catalog.modelCache === null) await loadModelsCache(catalog);
    if (refresh && catalog.authGuess === 'in') await fetchModels(catalog).catch(() => null);
    else refreshModelsSoon(catalog);
    return catalog.modelCache ?? buildAgyModels([], null);
  },

  // 一覧を引けていない間（受動では `agy models` を起こさない）は、保存済みの明示モデルを
  // 「一覧に無い」で断らない（不実な id は CLI が断る。docs/adr/0304・0308）。
  // 一覧（メモリか写し）があるあとは一覧どおりに見る。
  // server の validModel は一覧の確認・取り直しのあと、それでも無いときの最後の判断としてこれを呼ぶ
  async validModel(model) {
    if (typeof model !== "string" || model.length > 200 || /[\r\n\x00]/.test(model)) return false;
    if (!model) return true;
    const catalog = profileState();
    if (catalog.modelCache === null) await loadModelsCache(catalog);
    if (catalog.modelCache !== null) return Object.hasOwn(catalog.modelCache, model);
    return /^[\w.\-\[\]]+$/.test(model);
  },

  // 一覧が無い（このプロセスで未取得・写しも無い）ときは、このプロセスでログイン済みと確かめてから自分で取りに行く。
  // 段はモデル id に入るので、一覧が無いまま検査を省いて別の強さで黙って走らせない。
  // 「確かめる→取る」の全体を catalog.modelsGate で 1 本に束ねる（再起動直後に並ぶ送信・bot・委譲は同じ結果を受け取り、
  // /usage も agy models も 1 本だけ起こす）。終わり方は:
  //   - 一覧を取れた（呼ぶ側は取れた一覧でもう一度候補を引く）
  //   - 未ログイン確定（'out'。一覧の取得が「sign in」で落ちた場合も）: ログインの案内を投げる。agy は起こさない
  //   - 未確認（'unknown'）: まず /usage で見通しを確かめる（公式の headless 保証。未認証なら OAuth を始めず即落ちる）。
  //     'in' なら一覧を取り、'out' ならログインの案内、確かめられなければ checkNeeded（`agy models` は起こさない）
  //   - 取得のほかの失敗・直前の失敗から間隔（modelsGateRetryMs）が浅い再試行: checkNeeded（失敗を連発しない）
  async requireModelCatalog(cwd, model, { account = null } = {}) {
    const catalog = profileState(profileFor(account).key);
    await loadModelsCache(catalog);
    if (catalog.modelCache !== null) return;
    const old = await tooOldAcp();
    if (old) throw new Error(t('antigravity.errors.acpTooOld', { version: old, min: MIN_ACP_VERSION }));
    // 本体の掃除は外側の .finally に付ける: IIFE が await せずに終わる経路（失敗の連発止め・out の案内）では、
    // finally が ??= の代入より先に走り、決まったはずの拒否 promise が catalog.modelsGate に残ってしまう
    catalog.modelsGate ??= (async () => {
      if (catalog.authGuess === 'out') throw new Error(t('antigravity.auth.notLoggedIn'));
      if (catalog.authGuess === 'unknown') {
        await backend.usage().catch(() => null);   // 受動でも起こせる /usage（起こしてよいのはこの読み取り専用だけ）
        if (catalog.authGuess === 'out') throw new Error(t('antigravity.auth.notLoggedIn'));
        if (catalog.authGuess !== 'in') throw new Error(t('antigravity.models.checkNeeded'));   // 古い CLI・分からない失敗
      }
      // 取れたのか取れないのか分からないまま、短い間に何度も `agy models` を起こさない。
      // 裏の取得が最近落ちていても、この間隔を過ぎていれば自分で 1 回試す（裏の失敗で送信が長く断られない）。
      // 進行中の取得には相乗りする（並ぶ呼び出しは fetchModels が 1 本に束ねる）
      if (!catalog.modelsFetch && Date.now() - catalog.modelsFetchFailedAt < modelsGateRetryMs()) throw new Error(t('antigravity.models.checkNeeded'));
      try {
        await fetchModels(catalog);
      } catch (e) {
        if (AUTH_REQUIRED.test(String(e?.message ?? e))) {
          catalog.authGuess = 'out';
          throw new Error(t('antigravity.auth.notLoggedIn'));
        }
        throw new Error(t('antigravity.models.checkNeeded'));
      }
    })().finally(() => { catalog.modelsGate = null; });
    return catalog.modelsGate;
  },

  // ---- 実行 ---------------------------------------------------------------

  // adopt は付け直し（{ source, card }。adoptTurn だけが渡す）。無ければ普通のターン（保持役に載せるかは acp-held.mjs の heldAcpPlan が決める）
  async runTurn({ prompt, sessionId, cwd, mode, model, effort, emit, signal, control, contextRuntime, browserEnv, browserInstructions, browserRuntime = null, agentRuntime = null, addedInstructions, visualizeInstructions = null, shellAppends = [], computerRuntime = null, controlRuntime = null, hooksRuntime = null, secretsRuntime = null, locale, notes = [], botInstructions = null, botFolders = null, account = null, scanOptions = {}, askPermission = null, onPromptDelivered = null }, adopt = null) {
    if (account != null && (accountRemoving.has(account?.id) || accountLogins.has(account?.id))) {
      throw undelivered(new Error(t(accountRemoving.has(account.id) ? 'accounts.backend.removing' : 'accounts.backend.loginRunning', { agent: 'Antigravity' })));
    }
    const modeId = modeFor(mode);
    const m = MODES[modeId];
    const yolo = modeId === 'yolo';
    const k = adopt?.card?.agy ?? null;   // 付け直しの札のバックエンドの欄（backendCard）
    const profile = profileFor(account);
    // 2 つ目以降のアカウントは、置き場の検査（id の書式・親・リンク）を通してから起こす
    if (profile.guard) await accountHome(account, store.dataDir).catch(e => { throw undelivered(e); });
    const catalog = profileState(k?.keys?.profile ?? profile.key);

    // **控えはターンの途中から書き足すが、ユーザー発言の時刻は送信の時刻で打つ。**（AI の発言は書くたびにその時刻、終わりで完了の時刻に打ち直す）
    const sentAt = k ? Number(k.sentAt) || Date.now() : Date.now();
    // 付け直しは、旧サーバーが控えに書いた発言（同じ uuid）から引く。引けなければ null（控えの発言を書き換えない）
    const sent = k ? await adoptedSent(k.sessionId ?? sessionId, sentAt, k.sentHash) : [...shellAppends, [...notes, String(prompt ?? '')].join('')].filter(Boolean).join('\n\n');

    let conversationId = k?.sessionId ?? sessionId ?? null;
    const originalId = sessionId ?? null;
    // 再開した会話の途中の書き込みでは控えを作らない
    const resumed = k ? Boolean(k.resumed) : Boolean(sessionId);
    // agy の usage は会話の累計なので、前のターンの累計（控えのターンの記録）との差を使用量にする
    const usageBase = resumed ? usageBaseOf(await transcript.getRecord(sessionId ?? conversationId).catch(() => null), sentAt) : null;
    let sawText = false;
    let text = '';
    let replyTextSinceTool = '';
    const toolCalls = [];
    let failed = null;
    let retracted = false;         // agy が何も実行せずに断った（thought signature）。発言を控えから外す
    let resultTrace = null;
    const started = new Map();     // tool id -> { name, input, computer }
    let closed = false;            // このターンを畳み終えた
    let lastUsage = null;          // usage_update の累計（_meta.antigravity.usage）
    // 裏へ回ったコマンド（run_command が BACKGROUND_AFTER_MS を超えて実行中のまま）
    const behind = {
      timers: new Map(),
      tasks: new Map(),
      gone: new Map(),
      wait(id, ms) {
        return new Promise((resolve) => {
          if (!behind.tasks.has(id)) return resolve();
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
          behind.gone.set(id, [...(behind.gone.get(id) ?? []), () => { clearTimeout(timer); resolve(); }]);
        });
      },
    };
    const sendBehind = (out = emit) => out({ type: 'background', tasks: [...behind.tasks.values()].map((b) => b.task) });
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

    // ---- 控え。**ターンの途中から書き足す**（agy に履歴の取り出し口が無い。antigravity-store.mjs 冒頭）
    let delivered = Boolean(adopt);   // プロンプトを渡した（渡せなかったターンは控えに残さない）
    let nativeInjected = null;
    let writes = Promise.resolve();
    let queued = false;
    let final = null;
    let textTimer = null;
    const userUuid = () => `${conversationId}:u${sentAt}`;
    const snapshot = (at) => [
      ...(sent === null || retracted ? [] : [{ role: 'user', text: sent, uuid: userUuid(), at: new Date(sentAt).toISOString() }]),
      ...(text || toolCalls.length ? [{
        role: 'assistant', text, uuid: `${conversationId}:a${sentAt}`, at: new Date(at).toISOString(),
        ...(toolCalls.length ? { tools: toolCalls.map((c) => c.name), toolCalls: [...toolCalls] } : {}),
      }] : []),
    ];
    const save = ({ last = false } = {}) => {
      if (!delivered || !conversationId || queued || (final && !last)) return writes;
      queued = true;
      writes = writes.then(() => {
        queued = false;
        const messages = final?.messages ?? snapshot(Date.now());
        return transcript.appendMessages(conversationId, { cwd, messages, create: final?.create ?? !resumed,
          ...(final?.turnResult ? { turnResult: final.turnResult } : {}), ...(final?.drop ? { drop: final.drop } : {}) });
      }).catch((err) => console.error('  agy の控えを書けなかった:', String(err?.message ?? err)));
      return writes;
    };
    const saveSoon = () => {
      if (textTimer || final) return;
      textTimer = setTimeout(() => { textTimer = null; if (!final) save(); }, TEXT_SAVE_MS);
      textTimer.unref?.();
    };
    const seal = ({ ok }) => {
      clearTimeout(textTimer);
      if (final || !delivered) return writes;
      final = { messages: snapshot(Date.now()), create: ok || !resumed,
        turnResult: resultTrace ? { sentAt, at: new Date().toISOString(), ...resultTrace } : null,
        ...(retracted ? { drop: [userUuid()] } : {}) };
      return save({ last: true });
    };

    // ---- 起動時にしか渡せないものの印（変われば会話の agy を起こし直す）
    const contextKey = contextRuntime?.headers?.Authorization ?? null, contextShape = contextRuntime?.shape ?? null;
    const hooksShape = hooksRuntime?.shape ?? null;
    const computerKey = computerRuntime ? `${computerRuntime.url} ${computerRuntime.headers?.Authorization ?? ''}` : null;
    const agentsKey = agentRuntime ? `${agentRuntime.url} ${agentRuntime.headers?.Authorization ?? ''}` : null;
    const browserKey = browserRuntime ? `${browserRuntime.url} ${browserRuntime.headers?.Authorization ?? ''}` : null;
    const controlKey = controlRuntime ? `${controlRuntime.url} ${controlRuntime.headers?.Authorization ?? ''}` : null;
    const botKey = botSessionKey(botInstructions, botFolders);
    const secretsEnv = agySecretsEnv(secretsRuntime?.env);
    const secretsKey = Object.keys(secretsEnv).length || secretsRuntime?.instructions ? JSON.stringify([secretsEnv, secretsRuntime?.instructions ?? '']) : null;
    const computerInstructions = computerPrompt(computerRuntime, { locale: contextRuntime?.locale ?? locale, agent: 'antigravity' });
    const agentPrompt = [contextRuntime?.prompt, browserInstructions, computerInstructions, controlRuntime?.instructions, secretsRuntime?.instructions, botInstructions].filter(Boolean).join('\n\n');
    const useAgent = Boolean(contextRuntime || browserInstructions || agentRuntime || computerRuntime || controlRuntime || secretsRuntime?.instructions || botInstructions);
    const owners = antigravityAgentOwners(contextRuntime);
    // Skills・MCP を止める会話だけ agent 定義（--agent ply-context）で動かす。それ以外は session/new の MCP と systemPrompt で渡す
    const restricted = useAgent && agyRestricted(owners);
    const keys = keysOf({ contextKey, contextShape, browserEnv, hooksShape, computerKey, agentsKey, browserKey, controlKey, botKey, secretsKey, useAgent: restricted, profileKey: profile.key, yolo });

    // ---- 会話の agy（1 会話 = 1 プロセス）。生きていて印が合えば使い回す
    let entry = !adopt && conversationId ? live.get(conversationId) : null;
    if (entry) disarmIdle(entry);
    // 終了の知らせが届く前でも、プロセスが無ければ使い回さない（書き込みの失敗にしない）
    if (entry && (!entry.client?.alive || processGone(entry.client.pid))) { release(conversationId, entry); entry = null; }
    if (entry && !sameKeys(entry.keys, keys)) { closeEntry(entry); release(conversationId, entry); entry = null; }
    const reused = Boolean(entry);

    let client = entry?.client ?? null, sessionKnown = Boolean(entry?.sessionId && entry.sessionId === conversationId);
    let prompting = false, sent2 = false, fatal = null, closing = false, watchdog = null, steered = null, promptId = null, replaying = false;
    const local = new AbortController();
    let forceReject;
    const stopped = new Promise((_, reject) => { forceReject = reject; }); stopped.catch(() => {});
    let finish;

    const hostSignal = signal?.signal ?? signal;
    const abortError = () => Object.assign(new Error(t('turn.aborted')), { aborted: true });
    const check = () => { if (fatal) throw fatal; if (local.signal.aborted) throw abortError(); };
    const stop = (error) => {
      if (error && !fatal) fatal = error;
      local.abort();
      try { if (entry?.client && entry.sessionId) entry.client.notify('session/cancel', { sessionId: entry.sessionId }); } catch {}
      if (prompting && !watchdog) watchdog = setTimeout(() => { forceReject(fatal ?? abortError()); if (entry) closeEntry(entry); }, CANCEL_GRACE_MS);
      else if (!prompting && entry) closeEntry(entry);
    };
    const onAbort = () => stop();
    hostSignal?.addEventListener?.('abort', onAbort, { once: true });
    if (hostSignal?.aborted) local.abort();

    const out = (event) => emit(event, replaying ? { replay: true } : undefined);

    const finishTool = (id, update, prev) => {
      dropBehind(id, out);
      const name = prev.name, input = prev.input, computer = prev.computer;
      const failedStep = update.status === 'failed';
      const outputText = (() => {
        const raw = update.rawOutput;
        if (raw && typeof raw === 'object' && raw.output != null) return typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output);
        if (typeof raw === 'string') return raw;
        return (Array.isArray(update.content) ? update.content : []).map((c) => c?.content?.text ?? c?.text ?? '').filter(Boolean).join('\n');
      })();
      const errorText = failedStep ? outputText : '';
      const cutResult = computer ? computerResult(outputText, cut) : cut(outputText);
      const denied = failedStep && DENIED_RE.test(errorText);
      const r = denied ? { ...cutResult, text: `${cutResult.text}\n\n${t('antigravity.admin.toolDenied', { ask: t('antigravity.admin.askTools') })}` } : cutResult;
      const isError = failedStep || (computer ? computerFailed(r.computer) : false);
      const rejection = denied ? { tool: name, kind: 'policy', via: 'antigravity',
        command: String(input?.CommandLine ?? input?.AbsolutePath ?? input?.TargetFile ?? input?.Path ?? '') || null,
        reason: t('antigravity.admin.reason'), raw: errorText.slice(0, 1000) } : null;
      out({ type: 'tool.result', id, ...r, isError, ...(rejection ? { rejection } : {}) });
      toolCalls.push({ id, name, input, result: { ...r, isError } });
      save();
    };

    const onUpdate = (params, opts) => {
      if (!entry || (entry.sessionId && params.sessionId !== entry.sessionId)) return;
      const update = params.update ?? {};
      switch (update.sessionUpdate) {
        case 'current_mode_update': entry.modeId = update.currentModeId ?? entry.modeId; return;
        case 'config_option_update': if (Array.isArray(update.configOptions)) entry.config = update.configOptions; return;
        case 'available_commands_update': entry.commands = Array.isArray(update.availableCommands) ? update.availableCommands : entry.commands; return;
        default: break;
      }
      // 履歴の再生（session/load）や、プロンプトの前の出来事は会話に出さない
      if (!prompting || fatal) return;
      replaying = Boolean(opts?.replay);
      try {
        switch (update.sessionUpdate) {
          case 'usage_update': {
            const used = Number(update.used), size = Number(update.size);
            if (Number.isFinite(used) && Number.isFinite(size) && size > 0) out({ type: 'contextWindow', usedTokens: used, windowTokens: size });
            const total = usageTotal(update._meta?.antigravity?.usage);
            if (total) lastUsage = total;
            return;
          }
          case 'agent_message_chunk': {
            out({ type: 'task.activity', output: true });
            const delta = update.content?.type === 'text' ? update.content.text : null;
            if (!delta) return;
            if (!sawText) { sawText = true; out({ type: 'activity', state: 'writing' }); }
            text += delta;
            replyTextSinceTool += delta;
            saveSoon();
            return out({ type: 'text.delta', text: String(delta) });
          }
          case 'tool_call':
          case 'tool_call_update': {
            out({ type: 'task.activity', output: true });
            replyTextSinceTool = '';
            const id = `${conversationId ?? 'agy'}:${update.toolCallId ?? started.size}`;
            let prev = started.get(id);
            const params2 = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : null;
            if (!prev) {
              const toolRaw = String(update.title ?? update.kind ?? 'tool');
              const computer = toolRaw === 'call_mcp_tool' ? agyComputerName(params2) : null;
              const name = computer ?? toolName(toolRaw);
              const input = computer ? computerToolInput(computer, params2?.Arguments && typeof params2.Arguments === 'object' ? params2.Arguments : {}) : params2 ?? {};
              prev = { name, input, computer };
              started.set(id, prev);
              out({ type: 'activity', state: 'running', label: t('activity.tool', { label: TOOL_HINTS[name]?.label ?? name }) });
              out({ type: 'tool.start', id, name, input });
              const done = update.status === 'completed' || update.status === 'failed';
              // 終わらないコマンドは agy が裏へ回す。しばらく実行中のままなら裏のコマンドとして出す
              if (!done && name === 'run_command' && !closed) {
                const command = String(input?.CommandLine ?? '');
                const timer = setTimeout(() => {
                  behind.timers.delete(id);
                  if (closed) return;
                  behind.tasks.set(id, { task: { id, kind: 'shell', label: commandLabel(command) || name }, command });
                  sendBehind();
                }, BACKGROUND_AFTER_MS);
                timer.unref?.();
                behind.timers.set(id, timer);
              }
            } else if (params2 && update.sessionUpdate === 'tool_call_update' && !prev.computer) {
              prev.input = params2;
            }
            if (update.status === 'completed' || update.status === 'failed') {
              if (!prev.finished) { prev.finished = true; finishTool(id, update, prev); }
            }
            return;
          }
          default: return;
        }
      } finally { replaying = false; }
    };

    const onGone = (error) => {
      if (entry) { release(conversationId, entry); entry.cleanup?.(); }
      if (!closing) { fatal ??= error; local.abort(); forceReject(error); }
    };

    const onRequest = async (method, params) => {
      if (method !== 'session/request_permission') throw Object.assign(new Error('Unsupported ACP client request'), { code: -32601 });
      if (!prompting || params.sessionId !== entry?.sessionId || local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const allow = params.options?.find((o) => o.kind === 'allow_once'), deny = params.options?.find((o) => o.kind === 'reject_once');
      const always = params.options?.find((o) => o.kind === 'allow_always');
      const title = String(params.toolCall?.title ?? params.toolCall?.kind ?? '');
      if (!title.trim() || typeof askPermission !== 'function') return { outcome: typeof deny?.optionId === 'string' ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
      emit({ type: 'activity', state: 'waiting', sessionId: entry.sessionId });
      const answer = await Promise.resolve(askPermission({ toolName: title, input: params.toolCall?.rawInput ?? {}, sessionId: entry.sessionId,
        toolUseID: params.toolCall?.toolCallId ?? null, signal: local.signal, canAlways: typeof always?.optionId === 'string', kind: 'tool', locale })).catch(() => ({ allow: false }));
      if (local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const selected = answer?.allow ? (answer.always && typeof always?.optionId === 'string' ? always : allow) : deny;
      return { outcome: typeof selected?.optionId === 'string' ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
    };

    const onResponse = ({ method, result }) => {
      if (!entry) return;
      if (Array.isArray(result?.configOptions)) entry.config = result.configOptions;
      if (method === 'session/new') learnModels(catalog, result);
    };

    const bindHandlers = () => { entry.turn = { onUpdate, onGone, onRequest, onResponse }; entry.behind = behind; };

    const backendCard = () => ({ held: true, agy: { promptId, sessionId: entry?.sessionId ?? conversationId, sentAt, resumed, sentHash: sent === null ? null : digest(sent),
      prompts: client?.pendingPromptIds?.() ?? [], home: entry?.home ?? null, keys: entry?.keys ?? null,
      hookRuns: entry?.hookRuns ? { file: entry.hookRuns.file, offset: entry.hookRuns.offset,
        old: entry.hookRuns.old ? { file: entry.hookRuns.old.file, offset: entry.hookRuns.old.offset } : null } : null } });
    const bindHolder = () => {
      const held = entry?.held;
      if (!control || !held) return;
      control.holder = { label: (card) => held.label(card) };
      control.backendCard = backendCard;
      control.touch?.();
    };

    let outcome = 'ok', error = null, response = null, result = null;
    try {
      check();
      if (adopt) {
        // 付け直す子（保持役が持つ agy）。起動も握手も session の準備も済んでいる。走っている session/prompt の応答を拾い直し、印から ack までを再生する
        if (!k?.promptId || typeof adopt.source?.write !== 'function') throw new Error('antigravity: the card has no prompt id');
        const held = createHeldAcp({ source: adopt.source, lifetime: 'conversation', childPrefix: ACP_CHILD_PREFIX });
        entry = newEntry(conversationId, { keys: k.keys ?? null, home: k.home ?? null, hookRuns: k.hookRuns ?? null, cleanup: adoptHome(k.home), held, catalog });
        entry.sessionId = conversationId;
        entry.client = client = new AgyAcp({ cwd, held, adopt: { promptId: k.promptId }, ...entryHandlers(entry) });
        promptId = k.promptId;
        live.set(conversationId, entry);
        bindHandlers();
        await client.start();
        await client.open(1);
        client.adoptTrailing((Array.isArray(k.prompts) ? k.prompts : []).filter((id) => id !== promptId));
        steered = createAcpSteer({ client, sessionId: conversationId, emit, ready: () => prompting && !closing && !fatal && !local.signal.aborted,
          onSent: () => {}, confirmOnAccept: true, onCall: () => control?.persistSteer?.() ?? control?.touch?.() });
        if (control) { control.handle = { sessionId: conversationId, get conversationId() { return conversationId; } }; control.steer = (item) => steered.steer(item); control.steerConfirms = true; }
        bindHolder();
        sent2 = true; prompting = true;
        client.begin();
        response = client.running;
        control?.onReady?.();
      } else {
        // ---- 起動（生きていなければ）
        if (!entry) {
          const old = await tooOldAcp();
          if (old) throw undelivered(new Error(t('antigravity.errors.acpTooOld', { version: old, min: MIN_ACP_VERSION })));
          if (profile.guard) {
            // トークンが無いアカウントは起こさない（起こしても -32000 で落ちるだけ）。ログの置き場を作り、古いログを片付ける
            if (!(await hasAgyToken(account, store.dataDir).catch(() => false))) throw undelivered(Object.assign(new Error(t('accounts.backend.notLoggedIn', { agent: 'Antigravity' })), { code: 'AGY_NOT_LOGGED_IN' }));
            prepareAgyLogs(profile);
          }
          const plan = await heldAcpPlan({ dataDir: store.dataDir, argv: cliCommand('antigravity'), envName: 'AGENT_HOST_AGY_HOLDER' });
          if (plan) await sweepIdleOnce(plan.client);
          const botDirs = botFolders?.additionalDirectories ?? [];
          const agent = useAgent || hooksRuntime ? await prepareAgent({ owners,
            prompt: agentPrompt, cwd, url: contextRuntime?.url, authorization: contextKey, locale: contextRuntime?.locale ?? locale,
            context: useAgent, restricted, hooks: hooksRuntime, computer: computerRuntime ? { url: computerRuntime.url, authorization: computerRuntime.headers?.Authorization } : null,
            agents: agentRuntime ? { url: agentRuntime.url, authorization: agentRuntime.headers?.Authorization } : null,
            browser: browserRuntime ? { url: browserRuntime.url, authorization: browserRuntime.headers?.Authorization } : null,
            control: controlRuntime ? { url: controlRuntime.url, authorization: controlRuntime.headers?.Authorization, env: controlRuntime.env } : null, held: Boolean(plan) }) : null;
          const held = plan ? createHeldAcp({ client: plan.client, lifetime: 'conversation', childPrefix: ACP_CHILD_PREFIX }) : null;
          entry = newEntry(conversationId, { keys, profile, home: plan && agent ? agent.home : null, hookRuns: agent?.runs ? { file: agent.runs, offset: 0 } : null,
            cleanup: agent?.cleanup ?? (() => {}), held, catalog, mcpServers: restricted ? [] : agent?.mcpServers ?? [],
            mcpTokens: useAgent && agent ? relayTokens(agent.env) : [], cwd });
          entry.client = client = new AgyAcp({ cwd, home: agent?.home, extraDirs: botDirs, restricted, skipPermissions: yolo, profile,
            env: { ...process.env, ...secretsEnv, ...(agent?.env ?? {}), ...(browserEnv ?? {}) }, held, timeoutMs: START_TIMEOUT_MS, ...entryHandlers(entry) });
          bindHandlers();
          if (conversationId) live.set(conversationId, entry);
          emit({ type: 'activity', state: 'preparing' });
          const init = await client.start();
          entry.caps = init?.agentCapabilities ?? null;
          check();
        } else {
          client = entry.client;
          bindHandlers();
        }
        // ---- 会話（session/new・resume・load）
        if (!sessionKnown) {
          const base = { cwd, mcpServers: entry.mcpServers ?? [] };
          const meta = !restricted && useAgent ? { _meta: { antigravity: { systemPrompt: { append: systemPromptAppend({ prompt: agentPrompt, cwd, home: entry.home, locale: contextRuntime?.locale ?? locale }) } } } } : {};
          let state = null, missing = false, lastError = null;
          if (conversationId) {
            for (const method of ['session/resume', 'session/load']) {
              try { state = await client.call(method, { sessionId: conversationId, ...base, ...meta }); break; }
              catch (e) { if (e?.notFound) { missing = true; break; } lastError = e; }
            }
            if (!state && !missing) throw lastError ?? new Error(t('antigravity.errors.notConnected'));
          }
          if (!state) {
            state = await client.call('session/new', { ...base, ...meta });
            const id = state?.sessionId;
            if (typeof id !== 'string' || !id) throw new Error(t('antigravity.errors.notConnected'));
            conversationId = id;
            live.set(id, entry);
            emit({ type: 'session', sessionId: id, ...(originalId ? {} : { first: true }), ...(state?.models?.currentModelId ? { model: state.models.currentModelId } : {}) });
          }
          entry.sessionId = conversationId;
          entry.conversationId = conversationId;
          entry.permissionMode = String(state?._meta?.antigravity?.permissionMode ?? state?.modes?.currentModeId ?? entry.permissionMode ?? '').slice(0, 100);
          if (Array.isArray(state?.configOptions)) entry.config = state.configOptions;
          if (state?.modes?.currentModeId) entry.modeId = state.modes.currentModeId;
          if (state?.models?.currentModelId) entry.modelId = state.models.currentModelId;
          learnModels(catalog, state);
        }
        check();
        // ---- 2 つ目以降のアカウント: ファイル保存の印がログに出たことを確かめるまで prompt を送らない（鍵束へ黙って戻さない。プロセス 1 つにつき 1 度）
        if (entry.profile?.guard && !entry.fileStorage) {
          await assertFileStorage(entry.profile);
          entry.fileStorage = true;
        }
        // ---- 承認モードとモデルの適用（yolo は起動の旗。それ以外は ACP の mode）
        if (!yolo && (entry.modeId ?? '') !== m.acp) {
          const applied = await client.call('session/set_config_option', { sessionId: conversationId, configId: 'mode', value: m.acp }).catch(() => null);
          const current = applied?.configOptions?.find((o) => o.id === 'mode')?.currentValue;
          if (current !== m.acp && entry.modeId !== m.acp) throw new Error(t('antigravity.errors.modeUnavailable'));
          entry.modeId = m.acp;
        }
        const target = agyTarget(model, effortFor(effort), catalog.modelCache ?? {});
        await applyTarget(entry, target);
        entry.baseModel = model ?? "";
        entry.effort = effortFor(effort);
        check();
        // ---- 指示ファイルの補填（Skills・MCP を止める会話だけ。ほかは systemPrompt で渡している）
        let injected = [], scanError = null, scanDiagnostics = null, scanLimited = false, injectedRan = false;
        if (restricted && !antigravitySkipsNativeInstructions(contextRuntime)) {
          injectedRan = true;
          const scan = await nativeInstructionEntries(cwd, 'antigravity', scanOptions).catch((e) => ({ entries: null, error: String(e?.message ?? e) }));
          injected = scan?.entries ?? [];
          scanError = scan?.error ?? null;
          scanDiagnostics = scan?.diagnostics?.length ? scan.diagnostics.slice(0, 20) : null;
          scanLimited = Boolean(scan?.limited);
          if (scanError) console.error(`  ネイティブの指示ファイルを読めなかったので、このターンは注入しません（${conversationId}）:`, scanError);
        }
        nativeInjected = injectedRan
          ? { entries: injected.map((e) => ({ id: e.id, name: e.name, path: e.path, scope: e.scope, appliesTo: e.appliesTo, hash: e.hash, tokens: e.tokens })),
              ...(scanError ? { error: scanError } : {}), ...(scanDiagnostics ? { diagnostics: scanDiagnostics } : {}), ...(scanLimited ? { limited: true } : {}) }
          : null;
        const injectedText = injected.map((e) => agentT(locale, 'context.instructionsFrom', { path: e.path, scope: e.appliesTo ?? agentT(locale, 'context.allDirectories'), content: e.content })).join('\n\n') || null;
        // ply_agents の説明と Pleiad の指示は発言の本文の前に毎ターン足す。控えに残すのは人が書いた分だけ（sent）
        const promptText = [injectedText, agentRuntime?.instructions ?? addedInstructions, visualizeInstructions, sent].filter(Boolean).join('\n\n');
        steered = createAcpSteer({ client, sessionId: conversationId, emit, ready: () => prompting && !closing && !fatal && !local.signal.aborted,
          onSent: () => {}, confirmOnAccept: true, onCall: () => control?.persistSteer?.() ?? control?.touch?.() });
        if (control) { control.handle = { sessionId: conversationId, get conversationId() { return conversationId; } }; control.steer = (item) => steered.steer(item); control.steerConfirms = true; }
        check();
        prompting = true;
        promptId = client.newId();
        bindHolder();
        await new Promise((resolve) => setImmediate(resolve));
        entry.held?.markTurn();
        emit({ type: 'activity', state: 'thinking' });
        response = client.call('session/prompt', { sessionId: conversationId, prompt: [{ type: 'text', text: promptText }] }, { timeoutMs: 0, id: promptId });
        sent2 = true;
        delivered = true;
        save();
        onPromptDelivered?.(userUuid());
        control?.onReady?.();
      }

      result = await Promise.race([response, stopped]);
      if (fatal) throw fatal;
      const stopReason = result?.stopReason;
      // ---- 返答の締め
      const denials = Array.isArray(result?._meta?.antigravity?.deniedActions) ? result._meta.antigravity.deniedActions : [];
      const deniedTurn = denials.length > 0 && !sawText && stopReason === 'end_turn';
      const notice = replaying || stopReason !== 'end_turn' ? '' : adminNotice(entry, { askedSkip: yolo, deniedTurn });
      if (notice) {
        const add = `${text ? '\n\n' : ''}${notice}`;
        if (!sawText) { sawText = true; out({ type: 'activity', state: 'writing' }); }
        text += add;
        out({ type: 'text.delta', text: add });
      }
      if (sawText) out({ type: 'text.end' });
      if (stopReason === 'end_turn' && sawText && !adopt) catalog.authGuess = 'in';   // 付け直しの再生は、このプロセスが確かめた訳ではない
      // 新しい会話（再開でない・別の会話になった）は 0 から数える。基準の無い再開は出さない
      const total = lastUsage;
      const usageFresh = !resumed || conversationId !== originalId;
      const counted = total && USAGE_KEYS.some((key) => total[key]);
      const usage = counted ? usageFor(usageDelta(total, usageFresh ? usageTotal({}) : usageBase)) : null;
      if (usage) out(usage);
      const actions = denials.map((a) => String(a?.display_name ?? a?.action ?? '').slice(0, 100)).filter(Boolean);
      if (deniedTurn) {
        outcome = 'error';
        failed = new Error(t('antigravity.admin.deniedTurn', { actions: [...new Set(actions)].join(', '), ask: t('antigravity.admin.askTools') }));
      } else if (local.signal.aborted || stopReason === 'cancelled') outcome = 'aborted';
      else if (['max_tokens', 'max_turn_requests'].includes(stopReason)) outcome = 'limited';
      else if (stopReason !== 'end_turn') { outcome = 'error'; failed = new Error(t('antigravity.errors.endedWith', { status: stopReason ?? t('antigravity.errors.unknownStatus') })); }
      resultTrace = { source: 'result', status: String(stopReason ?? '').slice(0, 100), outcome, ...(failed ? { error: String(failed.message).slice(0, 1000) } : {}),
        ...(denials.length ? { denied: denials.length } : {}), ...(total && (counted || usageFresh) ? { usage: total } : {}) };
    } catch (e) {
      error = fatal ?? e;
      if (!fatal && (hostSignal?.aborted || error?.aborted)) outcome = 'aborted';
      else if (!fatal && sent2 && error?.acpLimit) outcome = 'limited';
      else outcome = 'error';
      if (outcome === 'error' && AUTH_REQUIRED.test(String(error?.message ?? ''))) {
        catalog.authGuess = 'out';   // agy が自ら認証を求めた＝未ログインが確定
        if (profile.guard) {
          // 2 つ目以降のアカウントは端末のコマンドで入れない。「このアカウントのログインが要る」（画面のログインの導線）にまとめる
          error = Object.assign(new Error(t('accounts.backend.notLoggedIn', { agent: 'Antigravity' })), { code: 'AGY_NOT_LOGGED_IN' });
        } else {
          const argv = cliCommand('antigravity');
          emit({ type: 'auth', backend: 'antigravity', phase: 'url', url: argv ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') : 'agy', message: t('antigravity.auth.notLoggedInTurn') });
        }
      }
      // 何も実行せずに thought signature で断られた: 発言を控えから外し、再開した会話はネイティブの会話を使えない印を付ける
      if (outcome === 'error' && error?.thoughtSignature && started.size === 0 && !sawText) {
        retracted = true;
        error = Object.assign(sent2 ? undelivered(error) : error, { retracted: [userUuid()] }, resumed ? { nativeUnusable: true } : {});
      }
      failed = outcome === 'error' ? error : null;
      resultTrace = { source: 'exception', status: null, outcome, ...(outcome === 'error' ? { error: String(error?.message ?? error).slice(0, 1000) } : {}) };
    } finally {
      clearTimeout(watchdog);
      hostSignal?.removeEventListener?.('abort', onAbort);
      closing = true;
      if (outcome === 'ok') await steered?.drain?.({ alive: () => !local.signal.aborted && !fatal }).catch(() => {});
      if (adopt) await client?.settleTrailing?.(1500).catch(() => {});
      prompting = false;
      closed = true;
      clearBehind();
      if (entry) {
        if (entry.behind === behind) entry.behind = null;
        entry.turn = null;
      }
      void finish;
    }

    try {
      if (entry) await reportHookRuns(entry, hooksRuntime, emit).catch(() => {});
      if (outcome === 'aborted') resultTrace ??= { source: 'abort', status: null, outcome: 'aborted' };
      await seal({ ok: outcome === 'ok' });
    } finally {
      // ターンが終わった子は付け直す対象から外す。生きていれば次の発言を待つ（IDLE_MS で止める）。断られた・落ちた・中断を畳めなかった会話は使い回さない
      entry?.held?.endTurn();
      const dead = !entry?.client?.alive || retracted || (outcome === 'aborted' && Boolean(fatal)) || outcome === 'error' && ['AGY_GONE', 'AGY_FILE_STORAGE_UNSUPPORTED'].includes(error?.code);
      if (entry) {
        if (dead || retracted) { closeEntry(entry); release(conversationId, entry); }
        else { live.set(conversationId, entry); armIdle(conversationId, entry); }
      }
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; control.holder = null; control.backendCard = null; }
    }

    // 選んだモデル・段を agy が断った: kind: 'model' で知らせ、委譲の自動の振り分けでは次の候補へ回す
    const modelRejected = outcome === 'error' && Boolean(error?.configRejected);
    if (retracted && resumed) { /* 作り直しは server が行う（nativeUnusable）。ここでは turnResult を出さない */ }
    else emit({ type: 'turnResult', outcome, turns: 1, ...(conversationId ? { sessionId: conversationId } : {}),
      ...(outcome === 'error' ? { error: String(failed?.message ?? error?.message ?? t('antigravity.errors.unknownStatus')) } : {}),
      ...(modelRejected ? { kind: 'model', pristine: !sent2 } : {}),
      ...(outcome === 'limited' && error?.acpLimit ? { error: String(error.message), resetsAt: error.acpLimit.resetsAt, window: null } : {}) });
    if (outcome === 'error') {
      const thrown = failed ?? error;
      if (nativeInjected && thrown && typeof thrown === 'object') thrown.nativeInjected = nativeInjected;
      throw sent2 || thrown?.retracted ? thrown : undelivered(thrown);
    }
    return { sessionId: conversationId, nativeInjected };

    // ---- このターンの中の小道具（関数の宣言は巻き上げられる）
    function entryHandlers(target) {
      return {
        onUpdate: (params, opts) => target.turn?.onUpdate(params, opts),
        onResponse: (info) => target.turn?.onResponse(info),
        onRequest: (method, params, opts) => target.turn ? target.turn.onRequest(method, params, opts) : Promise.reject(Object.assign(new Error('Unsupported ACP client request'), { code: -32601 })),
        onGone: (e) => { if (target.turn) target.turn.onGone(e); else { release(target.conversationId, target); target.cleanup?.(); } },
      };
    }
  },

  /**
   * 付け直し（無停止の更新 段階 3。acp-held.mjs）: 保持役が持つ走っている `agy acp` の続きを受ける。card は runTurn が札に置いた分
   * （control.backendCard の { held, agy }）、source は保持役の子（core/adopt.mjs の holderSource）。印から ack までは記録を読み直して状態（本文・ツール・結果）を作り
   * （emit の replay）、続きは普通に流して行ごとに ack する。握手も session の準備も要らない。sessionId は agy の会話の id
   */
  async adoptTurn(args) {
    if (!args.card?.held || !args.card.agy || typeof args.source?.write !== 'function') throw new Error('antigravity: the turn was not on the holder');
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
    const entry = conversationId ? live.get(conversationId) : null;
    if (!entry) return;
    closeEntry(entry);
    release(conversationId, entry);
    entry.cleanup?.();
  },

  /**
   * 裏へ回ったコマンドを 1 本止める（ターンは止めない）。その会話の agy の直下の子で、コマンドを走らせているシェルを木ごと落とし、
   * agy の完了の通知を待つ（一覧から外れるのは完了。AI は出力を受けてターンを続ける）。見つからない・あいまいなら何も落とさずに断る
   */
  async stopBackground(sessionId, taskId) {
    const entry = sessionId ? live.get(sessionId) : null;
    const task = entry?.behind?.tasks.get(taskId);
    if (!task) throw new Error(t("antigravity.errors.backgroundGone"));
    task.stopping ??= stopCommand(entry, task.command, taskId).catch((err) => { task.stopping = null; throw err; });
    return task.stopping;
  },

  // ---- ターンの途中の切り替え ------------------------------------------------
  // handle は runTurn が control.handle に置く { sessionId }。止めずに替えられないときは false（server が止める道へ落とす）

  async setModelLive(handle, model) {
    const entry = liveEntry(handle);
    if (!entry || typeof model !== "string" || !model) return false;
    try { await applyTarget(entry, agyTarget(model, entry.effort ?? "", (entry.catalog ?? profileState(entry.keys?.profile)).modelCache ?? {})); entry.baseModel = model; return true; }
    catch { return false; }
  },

  async setEffortLive(handle, effort) {
    const entry = liveEntry(handle);
    if (!entry) return false;
    try { await applyTarget(entry, agyTarget(entry.baseModel ?? "", effortFor(effort), (entry.catalog ?? profileState(entry.keys?.profile)).modelCache ?? {})); entry.effort = effortFor(effort); return true; }
    catch { return false; }
  },

  async setModeLive(handle, mode) {
    const entry = liveEntry(handle);
    if (!entry) return false;
    const next = MODES[modeFor(mode)];
    // yolo は起動の旗。yolo とそれ以外の行き来は起こし直しが要る
    if (Boolean(next.skip) !== Boolean(entry.keys?.yolo)) return false;
    if (next.skip) return true;
    try {
      const applied = await entry.client.call("session/set_config_option", { sessionId: entry.sessionId, configId: "mode", value: next.acp });
      const current = applied?.configOptions?.find((o) => o.id === "mode")?.currentValue;
      if (current !== next.acp && entry.modeId !== next.acp) return false;
      entry.modeId = next.acp;
      return true;
    } catch { return false; }
  },

  /**
   * 会話の圧縮（/compact）。ACP のスラッシュコマンドは、host が prompt の本文として送る（agy が available_commands_update に compact を出しているときだけ）。
   * 走っているターンでは呼ばれない。前後の文脈量は usage_update（文脈の占有）から取る
   */
  async compact({ sessionId, emit, cwd, trigger = "manual", signal, hostSessionId, hostBackend, account = null }) {
    const profile = profileFor(account);
    const dir = path.resolve(cwd ?? process.cwd());
    const hostSignal = signal?.signal ?? signal;
    let client, fatal = null, usage = null, before = null, commands = [];
    const onAbort = () => { try { client?.notify("session/cancel", { sessionId }); } catch {} };
    hostSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const last = (hostBackend && hostSessionId ? await hostBackend.getMessages(hostSessionId).catch(() => []) : []).filter((m) => m?.uuid).at(-1);
      const boundary = last?.uuid ? { afterMessageId: last.uuid } : {};
      const old = await tooOldAcp();
      if (old) { emit({ type: "compaction", phase: "failed", trigger, ...boundary, reason: t("antigravity.errors.acpTooOld", { version: old, min: MIN_ACP_VERSION }) }); return { sessionId }; }
      const existing = live.get(sessionId);
      if (existing?.turn) throw new Error(t("antigravity.errors.notConnected"));
      if (existing) { closeEntry(existing); release(sessionId, existing); existing.cleanup?.(); }
      if (profile.guard) {
        await accountHome(account, store.dataDir);
        if (!(await hasAgyToken(account, store.dataDir).catch(() => false))) throw Object.assign(new Error(t('accounts.backend.notLoggedIn', { agent: 'Antigravity' })), { code: 'AGY_NOT_LOGGED_IN' });
        prepareAgyLogs(profile);
      }
      client = new AgyAcp({ cwd: dir, timeoutMs: START_TIMEOUT_MS, skipPermissions: true, profile,
        onGone: (error) => { fatal = error; },
        onUpdate: (params) => {
          if (params.sessionId !== sessionId) return;
          const u = params.update;
          if (u?.sessionUpdate === "available_commands_update") commands = Array.isArray(u.availableCommands) ? u.availableCommands : commands;
          if (u?.sessionUpdate === "usage_update") {
            const used = Number(u.used), size = Number(u.size);
            if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
            usage = { usedTokens: used, windowTokens: size };
            emit({ type: "contextWindow", usedTokens: used, windowTokens: size });
          }
        } });
      await client.start();
      let state = null, lastError = null;
      for (const method of ["session/resume", "session/load"]) {
        try { state = await client.call(method, { sessionId, cwd: dir, mcpServers: [] }); break; } catch (e) { lastError = e; if (e?.notFound) break; }
      }
      if (!state) throw lastError ?? new Error(t("antigravity.errors.notConnected"));
      await assertFileStorage(profile);   // 2 つ目以降のアカウントは印を確かめてから prompt（/compact）を送る
      await new Promise((resolve) => setImmediate(resolve));
      if (fatal) throw fatal;
      if (!commands.some((c) => String(c?.name ?? "").replace(/^\//, "") === "compact")) {
        emit({ type: "compaction", phase: "failed", trigger, ...boundary, reason: t("compaction.nothingToCompact") });
        return { sessionId };
      }
      before = usage?.usedTokens;
      emit({ type: "compaction", phase: "start", trigger, ...boundary });
      emit({ type: "activity", state: "compacting" });
      const result = await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] }, { timeoutMs: 0 });
      if (fatal) throw fatal;
      if (result?.stopReason !== "end_turn") {
        emit({ type: "compaction", phase: "failed", trigger, ...boundary, reason: result?.stopReason === "cancelled" ? t("turn.aborted") : t("compaction.noCompletion") });
        return { sessionId };
      }
      const after = usage?.usedTokens;
      const dropped = Number.isFinite(before) && Number.isFinite(after) && after < before;
      emit({ type: "compaction", phase: "complete", trigger, ...boundary, ...(dropped ? { beforeTokens: before, afterTokens: after } : {}) });
      return { sessionId };
    } finally {
      hostSignal?.removeEventListener("abort", onAbort);
      if (client) await client.close().catch(() => {});
    }
  },

  // ---- 認証 ---------------------------------------------------------------
  //
  // `agy` は login サブコマンドを持たない。**ヘッドレスで走らせたときに、未ログインなら
  // stderr へ OAuth の URL を出し、stdin で認可コードを待つ**（実機で確認）。
  // つまりログイン専用の口は要らず、ターンを 1 本起こせばその経路に乗る。

  // ---- 2 つ目以降のアカウント（ADR 0222。トークンをファイルに保存させて別の置き場に分ける。antigravity-accounts.mjs） -------------------
  //
  // 1 つ目（account 無し）は今の OS の鍵束のまま。agy のバックエンドはモジュールに 1 つで、アカウントごとの状態は profile（key = アカウントの id）に持つ。

  /** アカウントを束縛した写し。各メソッドの引数にアカウントを入れる（OpenCode と同じ形。履歴は Pleiad の控えなのでアカウントを問わない） */
  async forAccount(account) {
    if (!account?.id) throw Object.assign(new Error('A valid Antigravity account is required'), { code: 'AGY_ACCOUNT_INVALID' });
    await accountHome(account, store.dataDir);
    const bound = Object.defineProperties({}, Object.getOwnPropertyDescriptors(backend));
    const inject = (name, index) => {
      const fn = backend[name];
      bound[name] = (...args) => {
        const next = [...args];
        next[index] = { ...(typeof next[index] === 'object' && next[index] !== null ? next[index] : {}), account };
        return fn(...next);
      };
    };
    for (const [name, index] of [['runTurn', 0], ['adoptTurn', 0], ['compact', 0], ['models', 1], ['validModel', 1], ['requireModelCatalog', 2]]) inject(name, index);
    bound.usage = (options = {}) => backend.usage({ ...options, account, accounts: [] });
    bound.forAccount = next => backend.forAccount(next);
    for (const name of ['accountLogin', 'accountStatus', 'accountRemove', 'accountDispose']) bound[name] = (options = {}) => backend[name]({ ...options, account });
    bound.auth = {
      status: async () => { const status = await backend.accountStatus({ account }); return { loggedIn: status.hasCredential, account: status.label ?? null }; },
      login: (options = {}) => backend.accountLogin({ ...options, account }),
      cancel: () => backend.auth.cancel({ account }),
      logout: (options = {}) => backend.auth.logout({ ...options, account }),
    };
    return bound;
  },

  /** トークンのファイルが安全に在るか（中身は読まない）。置き場が安全でないときは「無い」 */
  async accountStatus({ account }) {
    const has = await hasAgyToken(account, store.dataDir).catch(() => false);
    return { hasCredential: has, ...(has ? { label: account.name || t('antigravity.auth.account') } : {}) };
  },

  /** ブラウザーでのログイン（method は oauth-personal・oauth-business。既定は個人用） */
  async accountLogin({ account, emit, signal, method }) {
    if (!account?.id) throw new Error('A dedicated Antigravity account is required');
    if (accountRemoving.has(account.id)) throw new Error(t('accounts.backend.removing', { agent: 'Antigravity' }));
    if (accountLogins.has(account.id)) throw new Error(t('accounts.backend.loginRunning', { agent: 'Antigravity' }));
    // 生きている agy があると、ログインで書かれるトークンと食い違う。止めてから進める
    for (const entry of entriesOf(account)) { if (entry.turn) throw new Error(t('accounts.backend.inUseByTurn', { agent: 'Antigravity' })); }
    for (const entry of entriesOf(account)) { closeEntry(entry); release(entry.conversationId, entry); entry.cleanup?.(); }
    accountLogins.add(account.id);
    try {
      const result = await loginAgyAccount({ account, dataDir: store.dataDir, emit, signal, ...(method ? { method } : {}) });
      profileState(account.id).authGuess = 'in';
      return result;
    } finally { accountLogins.delete(account.id); }
  },

  /** アカウントの agy を止める（使用中のターン・バックグラウンドのコマンドがあれば断る）。置き場は accounts.remove が消す */
  async accountRemove({ account }) {
    if (!account?.id) throw new Error('A dedicated Antigravity account is required');
    if (accountRemoving.has(account.id) || accountLogins.has(account.id)) throw new Error(t('accounts.backend.inUse', { agent: 'Antigravity' }));
    accountRemoving.add(account.id);
    try {
      if (entriesOf(account).some(entry => entry.turn || entry.behind)) throw new Error(t('accounts.backend.inUseByTurn', { agent: 'Antigravity' }));
      await backend.accountDispose({ account });
      profileStates.delete(account.id);
    } finally { accountRemoving.delete(account.id); }
  },

  /** アカウントの生きた agy を止める（接続先の一覧から外すとき・作り直すとき） */
  async accountDispose({ account }) {
    for (const entry of entriesOf(account)) { closeEntry(entry); release(entry.conversationId, entry); entry.cleanup?.(); }
  },

  auth: {
    /**
     * ログインしているか。
     *
     * 資格情報は **OS の資格情報ストア**にある（macOS のキーチェーン: service `gemini` /
     * account `antigravity`）。ファイルとして読めないので、**`agy models` に聞く**。
     * 未ログインなら「Please sign in」で落ちる（実機で確認）。
     */
    async status({ probe = false, account = null } = {}) {
      const catalog = profileState(profileFor(account).key);
      // probe=false（起動時・定期の受動確認）は `agy` を起こさない。最後に分かった見通しだけを返す
      if (!probe) {
        if (catalog.authGuess === 'in') return { loggedIn: true, account: t("antigravity.auth.account"), detail: t("antigravity.auth.detail") };
        if (catalog.authGuess === 'out') return { loggedIn: false, account: null, detail: t("antigravity.auth.notLoggedIn") };
        return { loggedIn: false, account: null, unconfirmed: true, detail: t("antigravity.auth.unconfirmed") };
      }
      const old = await tooOldAcp();
      if (old) return { loggedIn: false, account: null, unconfirmed: true, detail: t('antigravity.errors.acpTooOld', { version: old, min: MIN_ACP_VERSION }) };
      try {
        await fetchModels(catalog);
        catalog.authGuess = 'in';
        return { loggedIn: true, account: t("antigravity.auth.account"), detail: t("antigravity.auth.detail") };
      } catch (err) {
        const message = String(err?.message ?? err);
        if (AUTH_REQUIRED.test(message)) {
          catalog.authGuess = 'out';
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
    async login({ emit, account = null } = {}) {
      const catalog = profileState(profileFor(account).key);
      if (catalog.pendingAuth) throw new Error(t("antigravity.auth.loginRunning"));
      catalog.pendingAuth = {};
      const watch = catalog.loginWatch.begin();
      try {
        if (await signedIn(catalog)) {
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
          const done = await signedIn(catalog);
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
        catalog.pendingAuth = null;
        watch.end();
      }
    },

    /** 待っているログインをやめる（見張りを止める）。login は CANCELLED で返る */
    async cancel({ account = null } = {}) {
      return profileState(profileFor(account).key).loginWatch.cancel();
    },

    /**
     * ログアウト。`agy` に口が無く、資格情報は OS の資格情報ストアにある。
     * Pleiad からは消せないので、そのことを伝える。
     */
    async logout({ account = null } = {}) {
      const catalog = profileState(profileFor(account).key);
      // ACP に logout があるときだけ agy に頼む（無ければ端末での操作を案内する）
      const client = new AgyAcp({ timeoutMs: START_TIMEOUT_MS, profile: profileFor(account) });
      try {
        const init = await client.start();
        if (init?.agentCapabilities?.auth?.logout) {
          await client.call("logout", {});
          catalog.authGuess = "out";
          return;
        }
      } catch { /* 案内に落とす */ } finally { await client.close().catch(() => {}); }
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
async function signedIn(catalog) {
  try {
    await fetchModels(catalog);
    catalog.authGuess = 'in';
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

/** 裏のコマンドを止める（backend.stopBackground）。agy の直下の子だけから選び、落とした後は完了の通知（一覧から外れる）を待つ */
async function stopCommand(entry, command, taskId) {
  const agyPid = await agyPidOf(entry).catch(() => null);
  if (!agyPid) throw new Error(t("antigravity.errors.backgroundNoAgy"));
  const list = await listProcesses({ parent: agyPid });
  const hit = pickCommandProcess(list, { agyPid, command });
  if (hit.error === "ambiguous") throw new Error(t("antigravity.errors.backgroundAmbiguous", { count: hit.count }));
  if (hit.error) throw new Error(t("antigravity.errors.backgroundNotFound"));
  const gone = entry.behind?.wait(taskId, STOP_WAIT_MS);
  try {
    await killTree(hit.pid);   // list は agy の直下の子だけ。POSIX は子孫を辿るので、killTree が全部の一覧を取り直す
  } catch (err) {
    throw new Error(t("antigravity.errors.backgroundStopFailed", { why: String(err?.message ?? err).trim().slice(0, 300) }));
  }
  await gone;
  return { stopped: true };
}

/**
 * 会話の agy の pid。直に起こした agy は client.pid。保持役が持つ agy は pid を持たないので、付け直した子は保持役の子の状態（attach の答え・
 * 起動時の一覧）から、このサーバーが起こさせた子は保持役の直下の子のうち、起動の引数（agent の置き場）で決まる 1 つから引く
 */
async function agyPidOf(entry) {
  if (Number.isInteger(entry.pid)) return entry.pid;
  const held = entry.held;
  if (!held) return null;
  const known = held.source?.attachedState?.pid ?? held.source?.state?.pid;
  if (Number.isInteger(known)) return known;
  const holderPid = held.client?.pid;
  if (!Number.isInteger(holderPid)) return null;
  const markers = [entry.home].filter(Boolean);
  if (!markers.length) return null;
  return pickHeldAgy(await listProcesses({ parent: holderPid }), { holderPid, markers });
}

/**
 * アプリの終了で、保持役の agy（idle の子も、走っている子も）を止める（server の stopHeldChildren）。更新・落ちたときは呼ばない
 * （保持役の子は残り、新しいサーバーが起動で拾う。idle の子は次の起動が止める。sweepIdleAtStart）
 */
export async function stopHeldAgy() {
  for (const [id, entry] of [...live]) {
    if (!entry.held) continue;
    closeEntry(entry);
    release(id, entry);
    entry.cleanup?.();
  }
}

/** 引けた一覧だけを覚える（失敗は覚えない。前に引けた一覧を残す）。写しも置き換える */
async function rememberModels(catalog, list) {
  if (!list?.rows?.length) return;
  catalog.modelCache = buildAgyModels(list.rows, list.defaultLabel);   // lazy load の中の古い写しは、代入前の null 判定で上書きされない
  catalog.modelCacheAt = Date.now();
  await persistModelsCache(catalog, list);
}

// ---- 一覧の写し（AGENT_HOST_DATA/antigravity/models.json） ---------------------------
// 明示の probe・ログインで `agy models` が取れたときだけ書く補助の控え。再起動のあと `agy models` を
// 起こさずに models()（id・段の efforts）を戻し、保存済みの明示モデルとエフォートを失わないため。
// **ログインの証拠には使わない**（写しがあるのは「昔取れた」だけ。catalog.authGuess は動かさない）。
// 行数・各 id/label の長さ・ファイルの大きさに固定の上限を持つ 1 ファイル（表・形式番号は増やさない）
const MODELS_CACHE_MAX_ROWS = 64;
const MODELS_CACHE_MAX_ID = 128;
const MODELS_CACHE_MAX_LABEL = 256;
const MODELS_CACHE_MAX_BYTES = 64 * 1024;

function modelsCacheFile(profileKey = 'default') {
  // default は今までの置き場を使う。将来のプロファイルは key をファイル名に写し、一覧を混ぜない
  const safe = String(profileKey || 'default').replace(/[^\w.-]/g, '_').slice(0, 80) || 'default';
  return path.join(transcript.dir(), safe === 'default' ? 'models.json' : `models-${safe}.json`);
}

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

function loadModelsCache(catalog) {
  catalog.modelsCacheLoad ??= (async () => {
    try {
      const file = modelsCacheFile(catalog.key);
      if ((await fs.promises.stat(file)).size > MODELS_CACHE_MAX_BYTES) return;   // 上限超えは読まない
      const cached = cacheRowsOf(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      if (!cached) return;
      const built = buildAgyModels(cached.rows, cached.defaultLabel);
      // 読み込みの途中で明示の probe が新しい一覧を入れても、古い写しで上書きしない（代入前に null を確かめる）
      if (Object.keys(built).length > 1 && catalog.modelCache === null) {
        catalog.modelCache = built;   // '' だけなら写し無しと同じ
        catalog.modelCacheAt = cached.fetchedAt;
      }
    } catch { /* 無い・壊れている → 空のまま */ }
  })();
  return catalog.modelsCacheLoad;
}

async function persistModelsCache(catalog, list) {
  try {
    const rows = (list.rows ?? []).slice(0, MODELS_CACHE_MAX_ROWS)
      .map((r) => ({ id: String(r.id ?? '').slice(0, MODELS_CACHE_MAX_ID), label: String(r.label ?? '').slice(0, MODELS_CACHE_MAX_LABEL) }))
      .filter((r) => r.id && r.label);
    if (!rows.length) return;
    const defaultLabel = typeof list.defaultLabel === 'string' ? list.defaultLabel.slice(0, MODELS_CACHE_MAX_LABEL) : null;
    const data = JSON.stringify({ rows, defaultLabel, fetchedAt: Date.now() });
    if (Buffer.byteLength(data, 'utf8') > MODELS_CACHE_MAX_BYTES) return;
    await fs.promises.mkdir(transcript.dir(), { recursive: true });
    await writeAtomic(modelsCacheFile(catalog.key), data);
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
function fetchModels(catalog) {
  if (!catalog.modelsFetch) {
    catalog.modelsFetchTriedAt = Date.now();
    catalog.modelsFetch = listModels()
      .then((list) => rememberModels(catalog, list))
      .catch((e) => { catalog.modelsFetchFailedAt = Date.now(); throw e; })
      .finally(() => { catalog.modelsFetch = null; });
  }
  return catalog.modelsFetch;
}

/**
 * 一覧を裏で引き直す口。`agy models` はこのプロセスでログイン済み（'in'）と確かめられた所でだけ起こす
 *（未確認・未ログインでは自動的に起こさない）。起こすのは一覧が無い・TTL を過ぎたときで、
 * 前の試みから TTL 未満では起こさない（使用量の定期の読みをきっかけに起こし続けたり、失敗を繰り返したりしない）。
 * 呼び出しは待たない。「sign in」で落ちたら見通しを out に、ほかの失敗は前の一覧を残して次の TTL まで試さない
 */
function refreshModelsSoon(catalog) {
  if (catalog.authGuess !== 'in' || catalog.modelsFetch) return;
  if (catalog.modelCache !== null && Date.now() - catalog.modelCacheAt < modelsTtlMs()) return;
  if (Date.now() - catalog.modelsFetchTriedAt < modelsTtlMs()) return;
  void fetchModels(catalog).catch((e) => { if (AUTH_REQUIRED.test(String(e?.message ?? e))) catalog.authGuess = 'out'; });
}

// サーバが終わったら、サーバーの子として起こした agy を道連れにする（保持役の子には触れない。新しいサーバーが起動で拾う。ADR 0270）。
// **SIGINT / SIGTERM のハンドラは足さない**（server はワーカースレッドでも動く。
// 既定の終了挙動を変えないため、`exit` の範囲に留める）。
process.once("exit", () => {
  for (const entry of live.values()) {
    // 保持役の子は保持役が持つ（新しいサーバーが付け直す。アプリの終了は stopHeldChildren が止める）。agent の置き場も残す
    if (entry.held) continue;
    // exit の中では非同期が走らない。プロセスの木は同期で落とせないので、直下の agy だけ止める（残りの子は stdin が閉じて終わる）
    try { entry.client?.proc?.kill?.(); } catch {}
    // Pleiad のコンテキストを渡したエージェント定義も消す
    try { entry.cleanup?.(); } catch {}
  }
  live.clear();
});

export { MODES, TOOL_HINTS, botSessionKey, usageFor, usageTotal, usageDelta, usageBaseOf };
