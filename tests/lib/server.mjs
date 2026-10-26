// テスト用に core/server.mjs を別プロセスで起動する。
//
// ポートは 0 を渡して OS に空きを選ばせる。だから 7420 が塞がっていても、
// 普段使いのサーバが動いたままでも衝突しない。実際のポートは起動メッセージから読む。
// sidecar（AGENT_HOST_DATA）も使い捨ての場所へ逃がし、普段の ~/.agent-host を汚さない。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotGuarded } from "../../core/test-guard.mjs";
import { serverBaseEnv } from "./inherited-env.mjs";
import { restartMode } from "./restart.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");


const LAUNCHED = /http:\/\/(localhost|[\d.]+|\[[\da-f:]+\]):(\d+)\/\?token=(\S+)/i;

/**
 * サーバを起動し、ready になるまで待つ。
 * @param env サーバプロセスに足す環境変数（AGENT_HOST_GRACE_MS など）
 * @param dataDir sidecar の置き場。使い捨ての場所を渡すこと
 * @param entry 起動するスクリプト（既定は core/server.mjs。parentPort の身代わりを置く tests/lib/parent-port-server.mjs など）
 * @param args entry の後ろに付ける引数（無停止の更新の新サーバーは `--handover`）
 * @param lazy 待ち受けるのを待たず、起こしてすぐ返す（`--handover` の新サーバーは、旧サーバーがデータ置き場を放すまで待ち受けない）。
 *   返り値の ready() が待ち受けるまで待ち、port を決める。起動前に終われば ready() が投げる
 */
export async function startServer({ env = {}, dataDir, timeoutMs = 90_000, entry = path.join(ROOT, "core", "server.mjs"), args = [], lazy = false } = {}) {
  // 呼び出し側がトークンを渡したらそれを使う（起こし直すときに、前のサーバーと同じトークンで起こす。tests/lib/restart.mjs）
  const token = env.AGENT_HOST_TOKEN || crypto.randomBytes(12).toString("hex");
  // 夜の記憶整理（core/memory/learn.mjs）は、起動のときに一度「追いつく」実行をし、そのときの会話・投稿を読んで隠れた learner 会話を作る。
  // 負荷で起動直後の読み取りが遅れると、テストが投稿した直後や runTurn の最中にその会話が走り、その session イベントを
  // ws-client.runTurn が自分の会話と取り違える（会話が control-info の返事でなく {"memories":[]} になる）。テストの server は止めておく。
  // 確かめるテストは prefs.json に memoryLearnPaused: false を置いてから起動する。
  // 次の発言の候補（core/prompt-suggestions.mjs）も止めておく（ターンのたびに候補を作る裏の 1 回が、ターンや保持役の数え方の試験に混ざる）。
  // 確かめるテスト（server-prompt-suggestions）は起動後に設定でオンにする
  // 本物のデータ置き場（PLEIAD_TEST_GUARD_HOME。tests/lib/test-env.mjs）には、prefs.json を置くことも、サーバーを立てることもしない
  if (dataDir) assertNotGuarded(dataDir, "start a test server on", { ...process.env, ...env });
  if (dataDir) {
    const file = path.join(dataDir, "prefs.json");
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 無ければ空から */ }
    if (prefs.memoryLearnPaused === undefined || prefs.composerSuggestions === undefined) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ memoryLearnPaused: true, composerSuggestions: false, ...prefs }));
    }
  }
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: ROOT,
    env: {
      // main がサーバーを起こすときにだけ渡す変数（AGENT_HOST_HANDOVER・SERVER_LOG・RUNTIME_KEY など。core/boot-env.mjs）と、Pleiad が会話のシェルへ渡す
      // PLEIAD_CLI_*・PLEIAD_CONTROL_* などは、実行元から継がない（tests/lib/inherited-env.mjs の serverBaseEnv）。test-env を読まずに startServer を使う入口
      // （tests/browser/*）でも、インストール版の実行場所・server.log・Ply.exe へ向かない。確かめるテストは env で渡す
      ...Object.fromEntries(Object.entries(serverBaseEnv(process.env)).filter(([key]) => !key.toUpperCase().startsWith('DEVIN_') && !key.toUpperCase().startsWith('GROK_') && !key.toUpperCase().startsWith('XAI_') && key.toUpperCase() !== 'WINDSURF_API_KEY')),
      // test-env を読まない入口でも、実 Devin・Grok の起動と継承した資格情報の利用を防ぐ。
      // Devin・Grok の試験だけが env で身代わりを指定する。
      AGENT_HOST_DEVIN_BIN: 'missing-pleiad-test-devin-cli',
      AGENT_HOST_GROK_BIN: 'missing-pleiad-test-grok-cli',
      GROK_HOME: path.join(dataDir ?? process.env.AGENT_HOST_DATA ?? os.tmpdir(), 'grok-home'),
      DEVIN_CONFIG_HOME: path.join(dataDir ?? process.env.AGENT_HOST_DATA ?? os.tmpdir(), 'devin-config'),
      DEVIN_SESSIONS_DIR: path.join(dataDir ?? process.env.AGENT_HOST_DATA ?? os.tmpdir(), 'devin-sessions'),
      AGENT_HOST_PORT: "0",
      AGENT_HOST_TOKEN: token,
      // Claude のトークンの持ち主の確認（api.anthropic.com）へは送らない。確かめるテストは偽の送り先を渡す
      AGENT_HOST_ANTHROPIC_API: "off",
      // 委譲の振り分け用の使用量を定期的に取らない（agy などの子プロセスを勝手に起こさない）。確かめるテストは "on" を渡す
      AGENT_HOST_ROUTING_USAGE: "off",
      // 自動選択（OpenRouter の Jev・Qwen）へは送らない。キーを登録するテストは偽の自動選択を渡す
      AGENT_HOST_OPENROUTER_API: "http://127.0.0.1:9",
      // 通話モード（core/voice/）の OpenRouter へは送らない。通話を確かめるテストは偽の送り先（tests/lib/fake-openrouter.mjs）を渡す
      AGENT_HOST_VOICE_API: "http://127.0.0.1:9",
      // ターンの始まりと終わりの git の撮影（refs/pleiad/）はしない。作業場所が開発中のリポジトリのテストが .git に ref を残さないため。
      // 確かめるテスト（server-git）は "on" を渡す
      AGENT_HOST_GIT_SNAPSHOTS: "off",
      // worktree（git worktree。ADR 0089）は作らない。cwd がこのリポジトリのテストが <リポジトリ>.pleiad に作業場所を残すため。
      // 確かめるテスト（server-worktree）は一時のリポジトリを cwd にして "on" を渡す
      AGENT_HOST_WORKTREES: "off",
      // 言語は日本語に固定する。テストは日本語の文言に依存している（CI の OS の言語で変わらないように）
      AGENT_HOST_LOCALE: process.env.AGENT_HOST_LOCALE || "ja",
      // Antigravity の次の発言の候補を作る agy の使い捨てのホーム（core/backends/antigravity-suggest.mjs）は、利用者の一時フォルダーでなくデータ置き場の下に
      AGENT_HOST_AGY_SUGGEST_HOME: path.join(dataDir ?? process.env.AGENT_HOST_DATA ?? os.tmpdir(), "pleiad-agy-suggest"),
      // バックエンドが出したイベントを契約（core/backends/contract.mjs）に照らし、外れたら [backend-contract] の行を出させる。
      // 下の stop() がその行を見つけたら落とす（どの試験のサーバーでも、契約に外れたイベントを見逃さない）
      PLEIAD_BACKEND_CONTRACT: "strict",
      // OpenCode の会話の DB・資格情報の置き場（core/backends/opencode.mjs）。利用者の本物（~/.local/share/opencode）を読まない
      AGENT_HOST_OPENCODE_DATA: path.join(dataDir ?? process.env.AGENT_HOST_DATA ?? os.tmpdir(), "opencode-data"),
      // コンテキスト探索の home（agy が発言の前に足すネイティブの指示ファイルなど）。利用者の本物（~/.gemini など）を読まない
      PLEIAD_SCAN_HOME: path.join(dataDir ?? process.env.AGENT_HOST_DATA ?? os.tmpdir(), "scan-home"),
      ...(dataDir ? { AGENT_HOST_DATA: dataDir } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 落ちたときに何が起きていたか言えるよう、直近の出力だけ手元に残す
  const log = [];
  // 契約に外れたイベント（[backend-contract] の行）。直近の出力と違い、捨てずに全部持つ
  const contract = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.includes("[backend-contract]")) contract.push(line.trim());
      log.push(line);
      if (log.length > 200) log.shift();
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  const tail = (n = 20) => log.slice(-n).join("\n").replaceAll(token, "[redacted]");

  const waiting = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`サーバが ${timeoutMs}ms で起動しなかった\n${tail()}`)), timeoutMs);
    const look = (chunk) => {
      const m = LAUNCHED.exec(String(chunk));
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off("data", look);
      res(Number(m[2]));
    };
    child.stdout.on("data", look);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`サーバが起動前に終了した (exit ${code})\n${tail()}`));
    });
  });
  waiting.catch(() => {});
  const port = lazy ? null : await waiting;

  const server = {
    port,
    /** 起こした子（lazy で、待ち受けの前に pid・終了を見るため） */
    child,
    /** lazy で起こしたとき、待ち受けるまで待つ。port が決まる */
    async ready() { this.port = await waiting; return this; },
    token,
    root: ROOT,
    dataDir,
    tail,
    /** 強制終了（後片付けも保持役への手を離す口も通らない。無停止の更新の「サーバーが落ちた」を作る）。落ちるまで待つ */
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await done;
    },
    /** 契約に外れたイベントの行（core/backends/contract.mjs）。契約の違反を確かめる試験が読む */
    contractViolations: () => [...contract],
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise((r) => child.once("exit", r));
        child.kill();
        // 行儀よく終わらないなら諦めて落とす（SDK が子を抱えたままのことがある）
        const hard = setTimeout(() => child.kill("SIGKILL"), 5000);
        await done;
        clearTimeout(hard);
      }
      if (contract.length && env.PLEIAD_BACKEND_CONTRACT !== "off") {
        const lines = [...new Set(contract)];
        contract.length = 0;
        throw new Error(`バックエンドのイベントが契約（core/backends/contract.mjs）に外れた:\n${lines.join("\n")}`);
      }
    },
  };
  // 「途中でサーバーを止めて起こし直す」モード（tests/lib/restart.mjs）。入っていなければ何もしない。
  // 起こし直す側は、この startServer をもう一度呼ぶ（同じデータ置き場・同じトークン・同じポート・保持役はそのまま）
  restartMode()?.registerServer(server, { env, dataDir, timeoutMs, entry, args, lazy }, options => startServer(options));
  return server;
}
