// `agy` の身代わり。ACP（`agy acp`）と、`agy models`・`--version`・`--print /usage`、候補づくりの 1 回呼び出し（`--print=`）を話す。
//
// 本物の `agy` は 190MB の単一バイナリで、Google のサブスクへのログインが要る。
// テストで測りたいのは **core/backends/antigravity.mjs の写し替え**（ACP の通知 -> 正規化イベント、ツールの開始・終了、
// 出力の打ち切り、stopReason、認証の受け渡し、会話の保持と再開）なので、プロトコルの形だけを真似た台本を返す。
//
// ACP の口は、実機（agy 1.5.17 / windows-x64）で測った形から取っている。**推測で足していない**（測っていない名前は仮と書く）。
//
// 使い方: AGENT_HOST_AGY_BIN="node tests/lib/fake-agy.mjs" で core/backends/agents.mjs の起動の口から呼ばれる（agy の実行ファイルの代わり）。
//
// `agy acp`（argv[0] が acp）は ACP（stdio の 1 行 1 JSON の JSON-RPC 2.0）の口になる。台本（slow / fail / gated: / partial など）と
// 環境変数（FAKE_AGY_*）を ACP のフレームに写す。実装は下の「ACP モード」（runAcp）。受け取った依頼は FAKE_AGY_ACP_LOG に 1 行 1 JSON で控える。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const NL = String.fromCharCode(10);

// 控えのファイルは、一時のファイルに書いてから置き換える。試験は agy が書いている間にも読むので、そのまま上書きすると空の中身を読むことがある
function writeList(file, list) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list));
  try { fs.renameSync(tmp, file); }
  catch { fs.rmSync(tmp, { force: true }); fs.writeFileSync(file, JSON.stringify(list)); }
}

const argv = process.argv.slice(2);
// 次の発言の候補を作る 1 回（core/backends/antigravity-suggest.mjs）は、使い捨てのホーム（pleiad-agy-suggest）で起きる。会話の agy ではないので、
// 起こした数・引数の控え（FAKE_AGY_PID_FILE・FAKE_AGY_ARGS_FILE）には入れない（会話の agy の起こし直しを数える試験のため）
const forSuggestion = path.basename(process.env.USERPROFILE ?? "") === "pleiad-agy-suggest";
// 起こされた pid を控える。**呼び出し側が落としたかどうか**をテストから見るため
if (process.env.FAKE_AGY_PID_FILE && !forSuggestion) {
  try {
    const file = process.env.FAKE_AGY_PID_FILE;
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    list.push(process.pid);
    writeList(file, list);
  } catch {}
}
if (process.env.FAKE_AGY_ARGS_FILE && !forSuggestion) {
  try {
    const file = process.env.FAKE_AGY_ARGS_FILE;
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    list.push(argv);
    writeList(file, list);
  } catch {}
}
// 起こされたときのホーム（USERPROFILE・HOME）と作業場所を控える。候補づくりの使い捨てのホームの検査用（tests/unit/prompt-suggestions.mjs）。
// 配達物の試験は、会話のシェルへ渡す環境変数と、--add-dir の置き場に書かれたカスタムエージェント（agent.md）・hooks.json もここで読む
if (process.env.FAKE_AGY_ENV_FILE) {
  try {
    const file = process.env.FAKE_AGY_ENV_FILE;
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const home = (() => { const at = argv.indexOf("--add-dir"); for (let i = at + 1; at >= 0 && i < argv.length; i++) { const p = argv[i]; if (fs.existsSync(path.join(p, ".agents", "agents", "ply-context", "agent.md"))) return p; } return null; })();
    const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
    list.push({
      USERPROFILE: process.env.USERPROFILE ?? null, HOME: process.env.HOME ?? null, cwd: process.cwd(),
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(AGENT_BROWSER_|PLEIAD_|PLY_|DELIVERY_)/.test(k))),
      agent: argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : null,
      agentMd: home ? read(path.join(home, ".agents", "agents", "ply-context", "agent.md")) : null,
      hooksJson: home ? read(path.join(home, ".agents", "hooks.json")) : null,
    });
    writeList(file, list);
  } catch {}
}
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : null;
};
const has = (name) => argv.includes(name);

if (has('--version')) {
  // FAKE_AGY_VERSION で版を差し替える（古い CLI は /usage の print を持たない再現に使う）
  console.log(process.env.FAKE_AGY_VERSION || '1.5.15');
  process.exit(0);
}
// 未ログインの再現（前半）: 本物の資格情報は OS の資格情報ストアに残り、**プロセスをまたいで効く**。
// 身代わりは印のファイルで同じことをする（`agy models` や `--print` は別プロセスで走るので、
// ここが無いと「ログインしたのに次の確認で未ログイン」になってしまう）。残りの宣言は下の「未ログインの再現」
const authFile = process.env.FAKE_AGY_AUTH_FILE || null;
// 複数アカウント（Ph3）: `--app-data-dir <相対>` は USERPROFILE/.gemini から数える（本物は ~/.gemini から。絶対パスは断る）。
// env AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 のとき、資格情報は鍵束（authFile）ではなく <appData>/antigravity-oauth-token に置く。
// FAKE_AGY_NO_FILE_MARKER=1 は「この env を知らない古い版」のふり（印のログを書かず、資格情報も鍵束のまま）
const homeDir = () => process.env.USERPROFILE ?? process.env.HOME ?? '.';
const appDataFlag = (() => { const at = argv.indexOf('--app-data-dir'); return at >= 0 ? argv[at + 1] : null; })();
if (appDataFlag && path.isAbsolute(appDataFlag)) { process.stderr.write('Error: app data dir must not be absolute' + NL); process.exit(1); }
const appDataDir = appDataFlag ? path.resolve(homeDir(), '.gemini', appDataFlag) : null;
const fileStorage = process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE === '1' && process.env.FAKE_AGY_NO_FILE_MARKER !== '1';
const tokenFile = fileStorage ? path.join(appDataDir ?? path.join(homeDir(), '.gemini', 'antigravity-cli'), 'antigravity-oauth-token') : null;
const signedIn = () => Boolean(tokenFile ? fs.existsSync(tokenFile) : authFile && fs.existsSync(authFile));
const authRequired = () => (process.env.FAKE_AGY_NEEDS_AUTH === '1' || Boolean(tokenFile)) && !signedIn();
/** token のファイルの `remaining`（0〜1）。アカウントごとに使用量を変える試験用（無ければ既定の .9） */
const tokenRemaining = () => { try { const v = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).remaining; return typeof v === 'number' ? v : .9; } catch { return .9; } };
let markerWritten = false;
/** 本物が ログへ書く印（composite_token_storage.go）。env があり、古い版のふり（FAKE_AGY_NO_FILE_MARKER）でないときだけ書く */
function writeFileMarker() {
  if (markerWritten || !fileStorage) return;
  markerWritten = true;
  const logFile = flag('--log-file');
  if (!logFile) return;
  try { fs.appendFileSync(logFile, 'I0923 03:02:52.462073       1 composite_token_storage.go:42] Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set' + NL); } catch {}
}

if (flag('--print') === '/usage') {
  writeFileMarker();
  if (authRequired()) {
    // 公式の headless 保証の形: 端末の無い環境で未認証なら「authentication required」で落ちる（OAuth を始めない）
    process.stderr.write("Error: authentication required. Run agy to sign in." + NL);
    process.exit(1);
  }
  if (process.env.FAKE_AGY_USAGE_DELAY_MS) await new Promise(r => setTimeout(r, Number(process.env.FAKE_AGY_USAGE_DELAY_MS)));
  console.log(JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { window: 'weekly', remaining_fraction: tokenFile ? tokenRemaining() : .9, reset_time: '2030-09-23T06:31:30Z' },
      { window: '5h', remaining_fraction: 1, reset_time: '2030-09-17T19:59:24Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: 0 }] },
  ] } } }));
  process.exit(0);
}

// 未ログインの再現（後半: authFile・signedIn は上の `/usage` 分岐より前に宣言してある）
const needsAuth = authRequired();
let authorized = !needsAuth;

// 身代わりのモデル（id と表示名）。`agy models` の一覧と、ACP の session/new が返す選択肢の元。
// FAKE_AGY_EXTRA_MODELS（カンマ区切りの id）で足す。委譲の振り分けのテストが、本物の名前（gemini-…）の候補を選ばせるのに使う
const MODEL_ROWS = () => [
  ["fake-antigravity-1", "Fake Antigravity 1"],
  ["fake-antigravity-2", "Fake Antigravity 2 (Thinking)"],
  ["fake-flash-high", "Fake Flash (High)"],
  ["fake-flash-low", "Fake Flash (Low)"],
  ...String(process.env.FAKE_AGY_EXTRA_MODELS ?? "").split(",").filter(Boolean).map((id) => [id, id]),
];
// 既定のモデルの表示名。FAKE_AGY_DEFAULT_LABEL_FILE があれば、その中身を既定にする（起動後に agy 側の既定が変わった場合の再現。tests/unit/server-agy-default-model.mjs）。
// FAKE_AGY_DEFAULT_LABEL が空なら空（既定が分からない場合の再現）
function defaultLabel() {
  const labelFile = process.env.FAKE_AGY_DEFAULT_LABEL_FILE;
  return (labelFile && fs.existsSync(labelFile) ? fs.readFileSync(labelFile, "utf8").trim() : null) ?? process.env.FAKE_AGY_DEFAULT_LABEL ?? "Fake Flash (High)";
}
// 本物は起動のたびにログへ選ばれているモデルの表示名を書く（Pleiad はここから既定を読む）。表示名が空なら書かない
function writeDefaultLabelLog() {
  const logFile = flag("--log-file");
  const label = defaultLabel();
  if (logFile && label) fs.writeFileSync(logFile, `I0923 03:02:52.462073       1 model_config_manager.go:327] Propagating selected model override to backend: label="${label}"` + NL);
}

// `agy models` は別のサブコマンド（ヘッドレスではない）。ログイン判定がここを通る。
// 本物は未ログインだと「Please sign in …」で落ち、ログイン済みなら 1 行 1 モデルを出す
if (argv.includes("models")) {
  // 未認証以外の失敗の再現（タイムアウト・内部エラーなど、「Please sign in」でない落ち方）
  if (process.env.FAKE_AGY_MODELS_FAIL === "1") {
    process.stderr.write("Error: agy internal failure while listing models https://accounts.example.invalid/" + NL);
    process.exit(1);
  }
  if (authRequired()) {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in." + NL);
    process.exit(1);
  }
  // 本物（1.2.8）は `id<TAB>表示名`。段違いは別の id で並ぶ（core/backends/antigravity-models.mjs）
  const TAB = String.fromCharCode(9);
  process.stdout.write(["Fetching available models...", ...MODEL_ROWS().map(([id, name]) => id + TAB + name)].join(NL) + NL);
  writeDefaultLabelLog();
  writeFileMarker();
  process.exit(0);
}

// 本物は `--print=`（空値）を要る。`--print` 単体だと次のフラグを prompt として飲み込む。
// 身代わりでも同じ約束を守らせて、呼び出し側の組み立てが崩れたら気づけるようにする（`agy acp` は --print を使わない）
if (argv[0] !== "acp" && !argv.includes("--print=")) {
  process.stderr.write(`Error: --print took "${argv[0] ?? ""}" as its prompt.` + NL);
  process.exit(2);
}

// 組織の管理ポリシー（Gemini Enterprise の「ターミナル自動実行モード」が要審査）は skip より勝つ（実機 1.5 系で確認）。FAKE_AGY_ADMIN_REVIEW=1 で真似る。
// FAKE_AGY_PERMISSION_MODE は任意の値（「サンドボックスで続行」など、確認が要るか分からない値）を返す。ACP の現在のモードがこの値を使う
const permissionMode = () => process.env.FAKE_AGY_ADMIN_REVIEW === "1" ? "request-review" : process.env.FAKE_AGY_PERMISSION_MODE ? process.env.FAKE_AGY_PERMISSION_MODE : has("--dangerously-skip-permissions") ? "skip" : (flag("--mode") ?? "default");

// usage は agy の会話ごとの累計で、本物は --conversation で起こし直した別のプロセスでも続きから数える（1.5.2 で実測）。
// ここでも会話 id ごとにファイルでターンの数を持つ。会話の agy のホーム（HOME）は試験でも利用者の本物なので、置き場は試験のデータ置き場の下
const usageFile = (id) => path.join(process.env.AGENT_HOST_DATA || os.tmpdir(), "fake-agy-usage", `${id}.json`);
function usageTurns(id) {
  try { return JSON.parse(fs.readFileSync(usageFile(id), "utf8")).turns ?? 0; } catch { return 0; }
}
function setUsageTurns(turns, id) {
  try { fs.mkdirSync(path.dirname(usageFile(id)), { recursive: true }); fs.writeFileSync(usageFile(id), JSON.stringify({ turns })); } catch {}
}

// ---- カスタムエージェント（`--agent`）--------------------------------------
//
// 本物（agy 1.2.7）で観測したとおりに真似る（報告書 temporary/reports/mcp-auth-agents.md）:
//   - `--agent <名前>` はワークスペース（cwd と `--add-dir`）の `.agents/agents/<名前>/agent.md` を探す。
//     無ければ stderr に「not found, falling back to default」を出して既定のエージェントで動く
//   - frontmatter の `mcpServers`（リスト）の stdio MCP は、最初のプロンプトで起動する。agy の env を引き継ぐ
//   - 最初に `server/discover` を送る（知らない MCP は断る）。続けて initialize / initialized / tools/list
// frontmatter は Pleiad が書く形（1 行 1 キー、値は JSON か素の文字列）だけを読む。
const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
const agentName = flag("--agent");
const customAgent = (() => {
  if (!agentName) return null;
  for (const root of [process.cwd(), ...addDirs]) {
    const file = path.join(root, ".agents", "agents", agentName, "agent.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, NL);
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) return null;
    const front = {};
    for (const line of match[1].split(NL)) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const raw = line.slice(at + 1).trim();
      try { front[line.slice(0, at).trim()] = JSON.parse(raw); } catch { front[line.slice(0, at).trim()] = raw; }
    }
    return { file, front, body: match[2].trim() };
  }
  process.stderr.write(`Agent "${agentName}" not found, falling back to default` + NL);
  return null;
})();
// 会話の agy（acp）だけが控える。--version・models など会話でない起動が上書きしない
if (process.env.FAKE_AGY_AGENT_FILE && argv[0] === "acp") {
  try {
    fs.writeFileSync(process.env.FAKE_AGY_AGENT_FILE, JSON.stringify({
      agent: agentName, found: Boolean(customAgent), file: customAgent?.file ?? null, front: customAgent?.front ?? null, body: customAgent?.body ?? null,
      authorization: process.env.PLY_CONTEXT_AUTHORIZATION ?? null, url: process.env.PLY_CONTEXT_URL ?? null,
      computerAuthorization: process.env.PLY_COMPUTER_AUTHORIZATION ?? null, computerUrl: process.env.PLY_COMPUTER_URL ?? null,
    }));
  } catch {}
}

/** 渡された MCP（{ serverName, command, args, env }）を起こして握手する。ACP は session/new の mcpServers の分、カスタムエージェントは frontmatter の mcpServers の分 */
async function connectMcp(specs) {
  const mcpServers = [];
  for (const spec of specs) {
    const child = spawn(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
    children.push(child);
    const waiting = new Map();
    let buffer = "", next = 1;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf(NL)) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch {}
      }
    });
    const call = (method, params) => new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + NL);
    });
    await call("server/discover");
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NL);
    const listed = await call("tools/list", {});
    mcpServers.push({ name: spec.serverName, call, tools: listed.result?.tools ?? [], child });
  }
  return mcpServers;
}
// 返事の前に止まった MCP も落とす（起こした順に控える）
const children = [];
process.on("exit", () => { for (const child of children) { try { child.kill(); } catch {} } });

/**
 * hooks の確認用（agy-hooks）: run_command の前の PreToolUse を本物（agy 1.2.12）の読み方で動かし、走った名前と答えを返す。
 * 読むのはユーザー（HOME の .gemini/config/hooks.json）・作業場所（cwd）と --add-dir の .agents/hooks.json。
 * どこかで { enabled: false } の名前はスコープをまたいで止まる。hook は <その場所>/.agents で動く（実機で確認。2026-09-27・28）
 */
function agyHooksScript(id) {
  const files = [path.join(process.env.HOME || process.env.USERPROFILE || '', '.gemini', 'config', 'hooks.json'),
    ...[process.cwd(), ...addDirs].map((d) => path.join(d, '.agents', 'hooks.json'))];
  const defs = [];
  for (const file of files) {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const [name, spec] of Object.entries(map)) defs.push({ name, spec, dir: path.dirname(file) });
  }
  const off = new Set(defs.filter((d) => d.spec?.enabled === false).map((d) => d.name));
  const ran = [];
  for (const d of defs) {
    if (off.has(d.name)) continue;
    for (const g of d.spec?.PreToolUse ?? []) for (const h of g.hooks ?? []) {
      const input = JSON.stringify({ conversationId: id, workspacePaths: [process.cwd().replace(/\\/g, '/')], stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } });
      const r = spawnSync(h.command, { cwd: d.dir, shell: true, input, encoding: 'utf8', timeout: 20_000 });
      let decision = 'deny';
      try { decision = JSON.parse(r.stdout || '{}').decision ?? 'deny'; } catch {}
      ran.push(`${d.name}:${r.status === 0 ? decision : 'deny'}`);
    }
  }
  return `hooks:${ran.join(',') || 'none'}`;
}

/** mcp-tools の答え（起こした MCP のツールの一覧） */
const mcpToolList = (servers) => JSON.stringify(servers.flatMap((s) => s.tools.map((t) => ({ server: s.name, name: t.name, description: t.description ?? "" }))));
/** mcp-call:<ツール名または説明の一部> [JSON の引数] を読んで、呼ぶ MCP とツールを選ぶ */
function pickMcpTool(servers, text) {
  const [, key, json] = /^mcp-call:(\S+(?: \/ \S+)?)(?: (\{.*\}))?$/.exec(text) ?? [];
  const server = servers.find((s) => s.tools.some((t) => t.name === key || (t.description ?? "").includes(`[${key}]`)));
  const tool = server?.tools.find((t) => t.name === key || (t.description ?? "").includes(`[${key}]`));
  return { key, server, tool, args: json ? JSON.parse(json) : {} };
}
/** 本物（agy 1.2.14）は ServerName を空のまま出し、引数は Arguments に入る（ACP の rawInput の形） */
const mcpCallParameters = (tool, args) => ({ ServerName: "", ToolName: tool.name, Arguments: args });
/** ツールの出力。画像はファイルに退避して、出力の末尾に退避先の行を足す（2026-10-01 実測） */
function mcpCallOutput(reply, id, index) {
  const content = reply.result?.content ?? [];
  const offloaded = content.filter((c) => c.type === "image").map((c, i) => `${NL}[Resource offloaded to file:///C:/fake-agy/brain/${id}/.system_generated/steps/${index}/media_${i}.jpg]`).join("");
  return reply.error ? `error:${reply.error.message}` : content.map((c) => c.text ?? "").join("") + offloaded;
}

/**
 * 前置き（ply_agents の説明・Pleiad の指示・注入したネイティブの指示）が付いた発言だけ末尾の段落へ切る。
 * 前置きの無い複数段落のプロンプト（候補作りなどの別経路）はそのまま
 */
function lastParagraph(wire) {
  const hasPreamble = /Pleiad が追加した指示|Pleiad の委譲ツール|の指示（適用範囲[:：]|instructions \(|Pleiad instructions/.test(wire.slice(0, wire.lastIndexOf("\n\n")));
  return hasPreamble && wire.includes("\n\n") ? wire.slice(wire.lastIndexOf("\n\n") + 2) : wire;
}

// ---- 1 回呼び出し（`agy --print=`）------------------------------------------------
//
// 本体の会話は ACP（agy acp）に移った。ここに残すのは core/backends/antigravity-suggest.mjs（次の発言の候補づくり）が使う 1 回呼び出しだけ。
// stdin の 1 行（{ event: "user", message: { content } }）に stream-json で 1 回答えて、stdin が閉じたら落ちる。
function runPrintOnce() {
  if (!authorized) {
    process.stderr.write("Error: authentication required. Run agy to sign in." + NL);
    process.exit(1);
  }
  const conversationId = flag("--conversation") ?? randomUUID();
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + NL);
  const step = (body) => send({ event: "step_update", step_update: { conversation_id: conversationId, ...body } });
  const answer = (text) => {
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: text });
    step({ step_index: 1, state: "DONE", step_type: "agent_response" });
    send({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: text, duration_seconds: 0.1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } });
  };
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let msg = null;
      try { msg = JSON.parse(line); } catch {}
      if (msg?.event !== "user") continue;
      const content = msg.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
      // 次の発言の候補の指示（core/prompt-suggestions.mjs）には JSON で答え、本物と同じく会話の置き場をホームの下に作る
      if (text.includes("Return only JSON matching this schema")) {
        const base = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".gemini", "antigravity-cli");
        try {
          fs.mkdirSync(path.join(base, "conversations"), { recursive: true });
          fs.mkdirSync(path.join(base, "brain", conversationId), { recursive: true });
          fs.writeFileSync(path.join(base, "conversations", `${conversationId}.db`), "");
        } catch {}
        answer(JSON.stringify({ suggestion: "テストを流して" }));
      } else {
        answer(`了解: ${text}`);
      }
    }
  });
  // 親が消えたら道連れになる。stdin が閉じたことを終了の合図にする
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}


// ---- ACP モード（`agy acp`）---------------------------------------------------
//
// 本物（agy 1.5.17）で測った ACP の口を、台本（環境変数 FAKE_AGY_*）で動かす。測ったのは次のとおり:
//   - initialize: protocolVersion 1・agentCapabilities（loadSession・promptCapabilities・sessionCapabilities・auth.logout・_meta.antigravity）・authMethods が 4 つ
//   - session/new: UUID の sessionId・models・modes（4 つ）・configOptions（model / thought_level / mode）、続けて available_commands_update と usage_update の通知
//   - session/prompt: agent_message_chunk・tool_call・tool_call_update・usage_update、stopReason は end_turn / cancelled
// **モードの id と認証方式の id は数（4 つずつ）しか測っていない**ので、名前は仮（Pleiad の側はこの名前に頼らない）。
// 会話（session）はデータ置き場（AGENT_HOST_DATA）のファイルに残す。session/load は別のプロセスでも、残した会話を読み直して再生する。
const ACP_MODES = [
  { id: "default", name: "Default", description: "Ask before running tools" },
  { id: "accept-edits", name: "Accept Edits", description: "Apply edits without asking" },
  { id: "plan", name: "Plan", description: "Plan before acting" },
  { id: "skip", name: "Skip Permissions", description: "Never ask for permission" },
];
const ACP_THOUGHT_LEVELS = ["low", "medium", "high"];
const ACP_AUTH_METHODS = [
  { id: "oauth-personal", name: "Log in with Google", description: "Sign in with a Google account" },
  { id: "oauth-business", name: "Log in with Google (Workspace)", description: "Sign in with a Google Workspace account" },
  { id: "gemini-api-key", name: "Gemini API key", description: "Use a Gemini API key" },
  { id: "agent-platform", name: "Agent platform", description: "Use agent platform credentials" },
];
const ACP_WINDOW = 1_000_000;
const SIGNATURE_ERROR = "INVALID_ARGUMENT (code 400): Invalid thought signature.";
const acpError = (code, message, data) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

async function runAcp() {
  const out = (frame, onFlushed) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + NL, onFlushed);
  const update = (sessionId, value) => out({ method: "session/update", params: { sessionId, update: value } });
  const acpLog = (frame) => {
    if (process.env.FAKE_AGY_ACP_LOG) { try { fs.appendFileSync(process.env.FAKE_AGY_ACP_LOG, JSON.stringify(frame) + NL); } catch {} }
  };

  // クライアントへの依頼（session/request_permission）。答えが来るまで待つ
  const asks = new Map();
  let askSeq = 0;
  const ask = (method, params) => new Promise((resolve) => {
    const id = `fake-agy-ask-${++askSeq}`;
    asks.set(id, resolve);
    out({ id, method, params });
  });

  // ---- 会話の置き場 ----
  const dir = path.join(process.env.AGENT_HOST_DATA || os.tmpdir(), "fake-agy-acp");
  const sessions = new Map();
  const save = (data) => {
    data.updatedAt = new Date().toISOString();
    try { fs.mkdirSync(dir, { recursive: true }); writeList(path.join(dir, `${data.sessionId}.json`), data); } catch {}
  };
  const read = (sessionId) => {
    try {
      if (!/^[\w-]+$/.test(String(sessionId))) throw new Error("bad id");
      return JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), "utf8"));
    } catch { throw acpError(-32002, `Session not found: ${sessionId}`); }
  };
  const need = (params) => {
    const session = sessions.get(params?.sessionId);
    if (!session || session.closed) throw acpError(-32602, `Unknown session: ${params?.sessionId}`);
    return session;
  };
  // ACP の mcpServers（stdio は { name, command, args, env: [{ name, value }] }）を、connectMcp の形へ直す
  const mcpSpecs = (mcpServers) => (Array.isArray(mcpServers) ? mcpServers : []).filter((s) => s && typeof s.command === "string").map((s) => ({
    serverName: s.name, command: s.command, args: s.args ?? [],
    env: Array.isArray(s.env) ? Object.fromEntries(s.env.filter((e) => e?.name).map((e) => [e.name, e.value ?? ""])) : (s.env ?? {}),
  }));
  // 会話を預かる。mcpServers が渡されたら、返事を待たずに裏で起こして握手する（最初のプロンプトで待つ）
  const attach = (data, mcpServers) => {
    let session = sessions.get(data.sessionId);
    if (!session) {
      session = { data, tail: Promise.resolve(), epoch: 0, token: null, closed: false, toolSeq: 0, mcpStart: null };
      sessions.set(data.sessionId, session);
    }
    // --agent のカスタムエージェント（Skills・MCP を止める会話）は、その frontmatter の mcpServers を使う（session/new の mcpServers は空）
    const given = mcpSpecs(mcpServers);
    const specs = given.length ? given : (Array.isArray(customAgent?.front?.mcpServers) ? customAgent.front.mcpServers : []);
    // --agent の無い会話（Skills・MCP を Pleiad が持たない）は、中継が session/new の mcpServers で、指示が systemPrompt.append で届く。同じ形で控える
    if (process.env.FAKE_AGY_AGENT_FILE && !customAgent) {
      const envOf = (key) => given.map((spec) => spec.env?.[key]).find((value) => value !== undefined) ?? null;
      try {
        fs.writeFileSync(process.env.FAKE_AGY_AGENT_FILE, JSON.stringify({
          agent: null, found: false, file: null, front: { mcpServers: given.map(({ env: _env, ...rest }) => rest) }, body: data.systemPrompt ?? null,
          authorization: envOf("PLY_CONTEXT_AUTHORIZATION"), url: envOf("PLY_CONTEXT_URL"),
          computerAuthorization: envOf("PLY_COMPUTER_AUTHORIZATION"), computerUrl: envOf("PLY_COMPUTER_URL"),
        }));
      } catch {}
    }
    if (specs.length && !session.mcpStart && process.env.FAKE_AGY_MCP_DISABLED !== "1") session.mcpStart = connectMcp(specs).catch(() => []);
    return session;
  };

  // ---- session の見せ方 ----
  const initialModel = () => {
    const rows = MODEL_ROWS();
    const asked = rows.find(([id]) => id === flag("--model"));
    const label = defaultLabel();
    const byLabel = label ? (rows.find(([, name]) => name === label) ?? rows[0]) : null;
    return (asked ?? byLabel)?.[0] ?? null;
  };
  const configOptions = (data) => [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: data.model ?? "", options: MODEL_ROWS().map(([value, name]) => ({ value, name })) },
    { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: data.thought, options: ACP_THOUGHT_LEVELS.map((value) => ({ value, name: value })) },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: data.mode, options: ACP_MODES.map((m) => ({ value: m.id, name: m.name })) },
  ];
  const sessionSetup = (data) => ({
    models: { ...(data.model ? { currentModelId: data.model } : {}), availableModels: MODEL_ROWS().map(([modelId, name]) => ({ modelId, name })) },
    modes: { currentModeId: data.mode, availableModes: ACP_MODES },
    configOptions: configOptions(data),
    _meta: { antigravity: { tier: { name: "Fake Tier" } } },
  });
  const usage = (sessionId, n) => update(sessionId, {
    sessionUpdate: "usage_update", used: 21 * n, size: ACP_WINDOW,
    // 本物の usage の中身は入力・出力・思考・キャッシュ読み。ACP の側の形は測っていないので、身代わりの置き場として _meta に置く
    _meta: { antigravity: { usage: { input_tokens: 11 * n, output_tokens: 7 * n, thinking_tokens: 3 * n, cache_read_tokens: 2 * n, total_tokens: 21 * n } } },
  });
  // session/new・load・resume の返事の後に、コマンドの一覧と usage を通知する（usage は FAKE_AGY_USAGE_DELAY_MS だけ遅れる）
  const announce = (session, ctx) => ctx.afterFlush.push(() => {
    const id = session.data.sessionId;
    update(id, { sessionUpdate: "available_commands_update", availableCommands: [
      { name: "usage", description: "Show usage" }, { name: "compact", description: "Compact the conversation" },
    ] });
    setTimeout(() => { if (!session.closed) usage(id, usageTurns(id)); }, Number(process.env.FAKE_AGY_USAGE_DELAY_MS ?? 0));
  });
  const requireAuth = () => {
    if (!authorized && !signedIn()) throw acpError(-32000, "Authentication required");
  };
  const appendedPrompt = (meta) => meta?.antigravity?.systemPrompt?.append ?? meta?.systemPrompt?.append ?? null;

  // ---- 中断 ----
  // 走っているターンの札（cancelled・wake）。待ちは hold（中断まで）と pause（時間か中断まで）で、どちらも session/cancel で起きる
  const hold = (token) => new Promise((resolve) => { if (token.cancelled) return resolve(); token.wake = resolve; });
  const pause = (token, ms) => new Promise((resolve) => {
    if (token.cancelled) return resolve();
    const timer = setTimeout(resolve, ms);
    token.wake = () => { clearTimeout(timer); resolve(); };
  });
  const cancel = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.epoch++;   // 順番待ちの prompt（まだ始まっていないもの）は、始まる前に cancelled で答える
    if (session.token) { session.token.cancelled = true; session.token.wake?.(); }
  };

  // ---- 1 ターン ----
  async function turn(session, wire, ctx) {
    const { data } = session;
    const id = data.sessionId;
    const token = { cancelled: false, wake: null };
    session.token = token;
    let reply = "";
    const say = (text) => { reply += text; update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); };
    const startTool = (title, rawInput) => {
      const toolCallId = `fake-agy-tool-${++session.toolSeq}`;
      update(id, { sessionUpdate: "tool_call", toolCallId, title, kind: "execute", status: "in_progress", rawInput });
      return toolCallId;
    };
    const endTool = (toolCallId, status, output) => update(id, {
      sessionUpdate: "tool_call_update", toolCallId, status,
      ...(output === undefined ? {} : { content: [{ type: "content", content: { type: "text", text: output } }], rawOutput: { output } }),
    });
    const finish = (extra = {}) => ({ stopReason: token.cancelled ? "cancelled" : "end_turn", ...extra });
    const text = lastParagraph(wire);
    data.messages.push({ role: "user", text });
    data.title ??= text.slice(0, 40);

    const script = async () => {
      // 届いた本文を確かめる台本（前置きを含めて）
      if (wire.endsWith("wire-dump")) { say(JSON.stringify({ paragraphs: wire.split("\n\n").length, head: wire.slice(0, 800), tail: wire.slice(-800) })); return finish(); }
      if (wire.endsWith("wire-all")) { say(JSON.stringify({ wire })); return finish(); }
      // session/new の _meta で足したシステムプロンプトが届いたかを返す
      if (text === "system-prompt") { say(data.systemPrompt ?? "(none)"); return finish(); }

      // 思考の署名が通らなくなった会話（FAKE_AGY_SIGNATURE_DIR の印のファイル）。step を 1 つも出さずに断る
      const signatureDir = process.env.FAKE_AGY_SIGNATURE_DIR;
      if (signatureDir && (fs.existsSync(path.join(signatureDir, id)) || fs.existsSync(path.join(signatureDir, "all")))) throw acpError(-32000, SIGNATURE_ERROR);
      if (signatureDir && (text === "poison-signature" || text === "poison-signature-all")) {
        fs.mkdirSync(signatureDir, { recursive: true });
        fs.writeFileSync(path.join(signatureDir, text === "poison-signature" ? id : "all"), "");
        say(`署名を壊した: ${text}`);
        return finish();
      }
      if (text === "signature-after-step") { startTool("read_file", { path: "x" }); throw acpError(-32000, SIGNATURE_ERROR); }
      if (text.startsWith("wire-has:")) { say(wire.includes(text.slice("wire-has:".length)) ? "wire-has:yes" : "wire-has:no"); return finish(); }

      // 返事を返した直後にプロセスが終わる agy（応答を書き切ってから終える）
      if (text === "result-then-exit") {
        say("完了した返事");
        ctx.afterFlush.push(() => process.exit(0));
        return finish();
      }

      // カスタムエージェント・hooks・MCP の確認（agent-body / agy-hooks / mcp-tools / mcp-call:…）。本文だけ返して終える
      if (text === "agent-body" || text === "agy-hooks" || /^mcp-(tools|call:)/.test(text)) {
        let body;
        if (text === "agent-body") body = customAgent?.body ?? "(no agent)";
        else if (text === "agy-hooks") body = agyHooksScript(id);
        else {
          const servers = session.mcpStart ? await session.mcpStart : [];
          if (text === "mcp-tools") body = mcpToolList(servers);
          else {
            const { key, server, tool, args } = pickMcpTool(servers, text);
            if (!tool) body = `no-tool:${key}`;
            else {
              const parameters = mcpCallParameters(tool, args);
              const toolCallId = startTool("call_mcp_tool", parameters);
              const result = await server.call("tools/call", { name: tool.name, arguments: args });
              const output = mcpCallOutput(result, id, session.toolSeq);
              endTool(toolCallId, "completed", output);
              body = `mcp:${output}`;
            }
          }
        }
        say(body);
        return finish();
      }

      // ゲートで止める台本（gated:<名前>）: 前置き → ツールの実行中でゲート（FAKE_AGY_GATE_DIR/<名前>）が開くまで待つ → 完了 → 本文。
      // 応答を書き出した後に <ゲート>.done の印を置く（読む側が居ない間に agy が終わったことを、テストが見るのに使う）
      const gated = /^gated:(\S+)/.exec(text);
      if (gated) {
        say("前置き。");
        const toolCallId = startTool("run_command", { CommandLine: `echo ${gated[1]}` });
        const gate = path.join(process.env.FAKE_AGY_GATE_DIR ?? "", gated[1]);
        while (!fs.existsSync(gate) && !token.cancelled) await pause(token, 20);
        if (token.cancelled) return finish();
        endTool(toolCallId, "completed", `out-${gated[1]}`);
        say(`終わり: ${gated[1]}`);
        ctx.afterFlush.push(() => fs.writeFileSync(`${gate}.done`, ""));
        return finish();
      }

      // ターンの途中の控えを測る台本（partial は中断まで待つ。-fail は ERROR、-exit はプロセスごと落ち、-ok は続きを足して終わる）
      const partial = /^partial(?:-(fail|exit|ok))?/.exec(text);
      if (partial) {
        say("途中まで");
        endTool(startTool("run_command", { CommandLine: "echo partial" }), "completed", "partial-out");
        if (!partial[1]) { await hold(token); return finish(); }
        await pause(token, Number(process.env.FAKE_AGY_PARTIAL_HOLD_MS ?? 400));
        if (token.cancelled) return finish();
        if (partial[1] === "exit") process.exit(3);
        if (partial[1] === "ok") { say("。続き"); return finish(); }
        throw acpError(-32000, "agy が途中で失敗した");
      }

      // 終わらないコマンド（hang-command）。コマンドはシェルの子（agy の直下）で走る。中断は応答を cancelled で返すが、コマンドは止めない（裏のコマンドを止める試験）
      if (text.startsWith("hang-command")) {
        const command = 'node -e "setInterval(()=>{},1000)"';
        const toolCallId = startTool("run_command", { CommandLine: command, Cwd: data.cwd, WaitMsBeforeAsync: 20000 });
        const child = spawn(command, { shell: true, stdio: "ignore", windowsHide: true });
        if (process.env.FAKE_AGY_COMMAND_PID_FILE) fs.writeFileSync(process.env.FAKE_AGY_COMMAND_PID_FILE, String(child.pid));
        const ended = await new Promise((resolve) => {
          child.once("exit", (code, signal) => resolve(signal ?? code));
          token.wake = () => resolve(null);
          if (token.cancelled) resolve(null);
        });
        if (token.cancelled) return finish();
        endTool(toolCallId, "completed", `exited: ${ended}`);
        say("コマンドが終わった");
        return finish();
      }

      // 何も出さずに中断まで待つターン（quiet）と、本文を 1 つ出して中断まで待つターン（slow）
      if (text.startsWith("quiet")) { await hold(token); return finish(); }
      if (text.startsWith("slow") || text.includes("[slow]")) { say("待つ"); await hold(token); return finish(); }

      // 送信と完了で時刻が変わることを測るための、少しかかるターン（delay / delay500）
      const slowly = /^delay(\d+)?/.exec(text);
      if (slowly) { await pause(token, Number(slowly[1] ?? 300)); if (token.cancelled) return finish(); }

      if (text === "error-body") { say("本文は届いた"); throw acpError(-32000, "結果は失敗"); }
      // 委譲の isolate では依頼の後に worktree の段落が付き、末尾の段落が依頼でなくなる。届いた本文全体の行で見る
      const noReplyLimit = wire.split("\n").some(line => line === "limit-no-reply");
      if (text === "error-after-reply" || text === "limit-after-reply" || noReplyLimit || text === "error-after-tool") {
        if (!noReplyLimit) say("完成した返事");
        if (text === "error-after-tool") startTool("read_file", { path: "x" });
        throw acpError(-32000, text === "error-after-reply" || text === "error-after-tool" ? "後続処理が失敗" : "Individual quota reached. Resets in 3h.");
      }

      // 組織の管理ポリシーで確認の要るコマンドを、ヘッドレスの agy が黙って拒否したターン（ツールは失敗で終わり、拒否は _meta に載る）
      if (text === "admin-denied" || text === "admin-denied-reply") {
        const toolCallId = startTool("run_command", { CommandLine: "echo hi" });
        endTool(toolCallId, "failed", `permission check failed for command "echo hi": user denied permission to run command:${NL}echo hi`);
        if (text === "admin-denied-reply") say("コマンドを実行できませんでした");
        return finish({ _meta: { antigravity: { deniedActions: [{ action: "command", display_name: "RunCommand" }] } } });
      }

      // クライアントに許可を求める台本（[permission]）。選ばれた選択肢を返事に書く
      if (text.includes("[permission]")) {
        const rawInput = { CommandLine: "echo permission" };
        const toolCallId = startTool("run_command", rawInput);
        const answer = await Promise.race([
          ask("session/request_permission", { sessionId: id, toolCall: { toolCallId, title: "run_command", rawInput }, options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "reject_once", kind: "reject_once", name: "Reject once" },
          ] }),
          hold(token).then(() => null),
        ]);
        if (!answer) return finish();
        const outcome = answer.error ? "error" : answer.result?.outcome?.outcome === "selected" ? answer.result.outcome.optionId : (answer.result?.outcome?.outcome ?? "none");
        endTool(toolCallId, outcome === "allow_once" ? "completed" : "failed", outcome === "allow_once" ? "permitted" : "not permitted");
        say(`permission:${outcome}`);
        return finish();
      }

      if (text.startsWith("fail") || text.includes("[fail]")) {
        // fail-400 は思考の署名ではない INVALID_ARGUMENT（作り直さない側の確かめ）
        throw acpError(-32603, text === "fail-400" ? "INVALID_ARGUMENT (code 400): Request contains an invalid argument." : "agy が失敗した");
      }

      // 次の発言の候補の指示（core/prompt-suggestions.mjs）には JSON で答え、本物と同じく会話の置き場をホームの下に作る
      if (text.includes("Return only JSON matching this schema")) {
        const base = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".gemini", "antigravity-cli");
        try {
          fs.mkdirSync(path.join(base, "conversations"), { recursive: true });
          fs.mkdirSync(path.join(base, "brain", id), { recursive: true });
          fs.writeFileSync(path.join(base, "conversations", `${id}.db`), "");
        } catch {}
        say(JSON.stringify({ suggestion: "テストを流して" }));
        return finish();
      }

      // 本文は 4 文字ずつのデルタで流れ、ツールは tool_call（実行中）→ tool_call_update（完了と出力）の 2 回で来る
      for (const chunk of `了解: ${text}`.match(/[\s\S]{1,4}/g) ?? []) {
        if (token.cancelled) return finish();
        say(chunk);
        await pause(token, 1);
      }
      const toolCallId = startTool("run_command", { CommandLine: "echo hello" });
      await pause(token, 1);
      endTool(toolCallId, "completed", "hello\r\n");
      // 本物と同じく、usage は会話の累計（usage-reset は数え直す）
      const n = text.startsWith("usage-reset") ? 1 : usageTurns(id) + 1;
      setUsageTurns(n, id);
      usage(id, n);
      return finish();
    };

    try {
      // 本物は MCP を最初のプロンプトで待つ。返事を待たない MCP で止まらないよう上限を置く
      if (session.mcpStart) await Promise.race([session.mcpStart, new Promise((r) => setTimeout(r, 10_000).unref())]);
      return await script();
    } finally {
      // 返す前に会話を残す（session/load が、止まった後でも途中までの本文を再生できる）
      if (reply) data.messages.push({ role: "assistant", text: reply });
      save(data);
      if (session.token === token) session.token = null;
    }
  }

  // ---- 依頼の表 ----
  const methods = {
    initialize: async () => ({
      protocolVersion: 1,
      agentInfo: { name: "agy", title: "Antigravity CLI", version: process.env.FAKE_AGY_VERSION || "1.5.15" },
      agentCapabilities: {
        loadSession: true, load_session: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
        // ログアウトの口。FAKE_AGY_NO_LOGOUT=1 で返さない古い版を再現する（画面は［ログアウト］を出さない）
        ...(process.env.FAKE_AGY_NO_LOGOUT === "1" ? {} : { auth: { logout: {} } }),
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      },
      authMethods: ACP_AUTH_METHODS,
    }),
    authenticate: async (params) => {
      if (!ACP_AUTH_METHODS.some((m) => m.id === params.methodId)) throw acpError(-32602, `Unknown auth method: ${params.methodId}`);
      // ブラウザーでのログインを待つ再現（本物は開けなかったとき stderr に URL を出す）。FAKE_AGY_AUTH_HOLD_MS ミリ秒止まる。
      // FAKE_AGY_AUTH_RELEASE_FILE は、時間でなく「そのファイルができるまで」止まる（ブラウザーでのログインを済ませた、の合図。
      // ［やめる］が先に届くかを時間の競争にしない試験向け）
      const releaseFile = process.env.FAKE_AGY_AUTH_RELEASE_FILE;
      if (process.env.FAKE_AGY_AUTH_HOLD_MS || releaseFile) {
        process.stderr.write('Could not open the browser. Please visit https://accounts.example.invalid/o/oauth2/auth?state=fake to sign in' + NL);
        if (releaseFile) { while (!fs.existsSync(releaseFile)) await new Promise((r) => setTimeout(r, 50)); }
        else await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGY_AUTH_HOLD_MS)));
      }
      // agy がログインを断る再現（実機 1.5.17: 会社のアカウントを oauth-business で入れると -32603 で Enterprise の契約が無いと返す）
      if (process.env.FAKE_AGY_AUTH_REFUSE) throw acpError(-32603, process.env.FAKE_AGY_AUTH_REFUSE);
      authorized = true;
      writeFileMarker();
      // ファイル保存の資格情報（本物は暗号化されない JSON）。複数アカウントのログインはここへ残る
      if (tokenFile) { try { fs.mkdirSync(path.dirname(tokenFile), { recursive: true }); fs.writeFileSync(tokenFile, JSON.stringify({ fake: true, method: params.methodId })); } catch {} }
      // 資格情報が残った、の印。次に起きるプロセス（`agy models` など）から見える
      else if (authFile) { try { fs.mkdirSync(path.dirname(authFile), { recursive: true }); fs.writeFileSync(authFile, "ok"); } catch {} }
      return {};
    },
    logout: async () => {
      if (process.env.FAKE_AGY_NO_LOGOUT === "1") throw acpError(-32601, "Method not found: logout");
      // agy がログアウトに失敗する再現（資格情報ストアに触れない、など）。FAKE_AGY_LOGOUT_FAIL の文で -32603 を返す。
      // FAKE_AGY_LOGOUT_FAIL_FILE はそのファイルがある間だけ失敗する（サーバーを立てたまま失敗と成功を続けて試すブラウザーの試験向け）
      const failFile = process.env.FAKE_AGY_LOGOUT_FAIL_FILE;
      const failText = process.env.FAKE_AGY_LOGOUT_FAIL || (failFile && fs.existsSync(failFile) ? fs.readFileSync(failFile, 'utf8') || 'logout failed' : '');
      if (failText) throw acpError(-32603, failText);
      if (tokenFile) fs.rmSync(tokenFile, { force: true });
      if (authFile) fs.rmSync(authFile, { force: true });
      authorized = false;
      return {};
    },
    "session/new": async (params, ctx) => {
      writeFileMarker();   // 本物は session/new を受けたところで印を書く（未ログインの -32000 でも書く）
      requireAuth();
      // 一覧が取れない agy の再現（本物は session/new の返事にモデルの一覧を載せる）
      if (process.env.FAKE_AGY_MODELS_FAIL === "1") throw acpError(-32603, "agy internal failure while listing models");
      const data = {
        sessionId: randomUUID(), cwd: params.cwd ?? process.cwd(), model: initialModel(), thought: "medium", mode: permissionMode(),
        messages: [], systemPrompt: appendedPrompt(params._meta),
        additionalDirectories: Array.isArray(params.additionalDirectories) ? params.additionalDirectories : [], title: null,
      };
      save(data);
      const session = attach(data, params.mcpServers);
      announce(session, ctx);
      return { sessionId: data.sessionId, ...sessionSetup(data) };
    },
    "session/load": async (params, ctx) => {
      requireAuth();
      const data = read(params.sessionId);
      if (params.cwd) data.cwd = params.cwd;
      { const appended = appendedPrompt(params._meta); if (appended != null) data.systemPrompt = appended; }   // 付け直しの systemPrompt が最新の指示
      const session = attach(data, params.mcpServers);
      // load は残した会話を返事の前に再生する（resume は再生しない）
      for (const message of session.data.messages) {
        update(data.sessionId, { sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: message.text } });
      }
      announce(session, ctx);
      return sessionSetup(session.data);
    },
    "session/resume": async (params, ctx) => {
      requireAuth();
      const data = read(params.sessionId);
      if (params.cwd) data.cwd = params.cwd;
      { const appended = appendedPrompt(params._meta); if (appended != null) data.systemPrompt = appended; }   // 付け直しの systemPrompt が最新の指示
      const session = attach(data, params.mcpServers);
      announce(session, ctx);
      return sessionSetup(session.data);
    },
    "session/list": async (params) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      const found = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        try { found.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); } catch {}
      }
      return {
        sessions: found.filter((d) => !params.cwd || d.cwd === params.cwd)
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .map((d) => ({ sessionId: d.sessionId, cwd: d.cwd, title: d.title, updatedAt: d.updatedAt })),
      };
    },
    "session/close": async (params) => {
      const session = need(params);
      cancel(params.sessionId);
      session.closed = true;
      sessions.delete(params.sessionId);
      session.mcpStart?.then((servers) => { for (const s of servers) { try { s.child.kill(); } catch {} } });
      return {};
    },
    "session/prompt": async (params, ctx) => {
      requireAuth();
      const session = need(params);
      const wire = (Array.isArray(params.prompt) ? params.prompt : []).filter((b) => b?.type === "text").map((b) => b.text).join("");
      // 受け取ったプロンプトを 1 行ずつ控える（再送で二重に届かないことを数える試験用）
      if (process.env.FAKE_AGY_PROMPT_LOG) { try { fs.appendFileSync(process.env.FAKE_AGY_PROMPT_LOG, `${wire.replaceAll("\n", " ")}\n`); } catch {} }
      // 1 つの会話の prompt は 1 つずつ。走っている間に来たものは順番を待ち、中断されたら始まる前に cancelled で答える
      const epoch = session.epoch;
      const run = session.tail.then(() => (session.epoch !== epoch || session.closed ? { stopReason: "cancelled" } : turn(session, wire, ctx)));
      session.tail = run.catch(() => {});
      return run;
    },
    "session/set_config_option": async (params) => {
      const session = need(params);
      const option = configOptions(session.data).find((o) => o.id === params.configId);
      if (!option) throw acpError(-32602, `Unknown config option: ${params.configId}`);
      if (!option.options.some((o) => o.value === params.value)) throw acpError(-32602, `Invalid value '${params.value}' for config option '${params.configId}'`);
      session.data[{ model: "model", thought_level: "thought", mode: "mode" }[option.id]] = params.value;
      save(session.data);
      const options = configOptions(session.data);
      update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: options });
      return { configOptions: options };
    },
    "session/set_mode": async (params) => {
      const session = need(params);
      if (!ACP_MODES.some((m) => m.id === params.modeId)) throw acpError(-32602, `Invalid mode: ${params.modeId}`);
      session.data.mode = params.modeId;
      save(session.data);
      update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
      return {};
    },
  };

  // 1 行ごとに非同期で処理する（止まっている prompt が、ほかの依頼や session/cancel を止めない）
  const handle = async (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (!frame || typeof frame !== "object") return;
    if (typeof frame.method === "string") acpLog(frame);
    // クライアントへの依頼への答え
    if (frame.method === undefined && frame.id !== undefined) {
      const waiting = asks.get(frame.id);
      if (waiting) { asks.delete(frame.id); waiting(frame); }
      return;
    }
    if (typeof frame.method !== "string") return;
    // session/cancel は通知。id 確認の前に処理する（id 付きで来たら空の答えを返す）
    if (frame.method === "session/cancel") {
      cancel(frame.params?.sessionId);
      if (frame.id !== undefined) out({ id: frame.id, result: {} });
      return;
    }
    if (frame.id === undefined) return;   // 知らない通知は捨てる
    const ctx = { afterFlush: [] };
    try {
      if (!Object.hasOwn(methods, frame.method)) throw acpError(-32601, `Method not found: ${frame.method}`);
      const result = await methods[frame.method](frame.params ?? {}, ctx);
      out({ id: frame.id, result: result ?? {} }, () => { for (const fn of ctx.afterFlush) { try { fn(); } catch {} } });
    } catch (error) {
      out({ id: frame.id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: String(error.message), ...(error.data ? { data: error.data } : {}) } });
    }
  };

  writeDefaultLabelLog();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => { if (line.trim()) handle(line).catch(() => {}); });
  // 親が消えたら道連れになる。stdin が閉じたことを終了の合図にする
  await new Promise((resolve) => rl.on("close", resolve));
}

if (argv[0] === "acp") {
  await runAcp();
  process.exit(0);
}
runPrintOnce();
