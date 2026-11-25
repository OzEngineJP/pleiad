// 実物の CLI で 1 ターン流し、Pleiad の渡し物が届いたかを確かめる（issue #146。CI では回さない。使用量は 1 エージェント 1 ターン）。
//
//   npm run test:delivery                 6 エージェントを順に
//   npm run test:delivery -- claude devin 指定だけ
//
// 確かめること（1 ターンで 5 つ。偽のプロセスで確かめる tests/unit/backend-common.mjs の実物版）:
//   instructions  設定 › 指示に足した合言葉が返答に入る（plyInstructions・plyAgents の届け方）
//   plyControl    ply_control の list_ops を呼び、操作の一覧（sessions.list など）が返る
//   secrets       秘密情報の変数が会話のシェルにある（値は読まず、あるかないかを答えさせる）
//   models        モデルの一覧（models）が 1 件以上返る
//   model         モデルを指定しない会話が、一覧の既定（models の '' の resolvesTo）で走る。
//                 REAL_OVERRIDES でモデルを指定するエージェントは、そのモデルが一覧にあり、そのモデルで走る
//
// 利用者のデータ置き場・認証ファイルは触らない（データ置き場は一時ディレクトリ、作業場所も一時ディレクトリ）。
// CLI が入っていない・ログインしていないエージェントは SKIP と理由を出す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from './lib/server.mjs';
import { open } from './lib/ws-client.mjs';
import { scrubInheritedEnv } from './lib/inherited-env.mjs';
import { AGENTS, DEFAULT_AGENT_IDS, definePerAgentMap } from '../core/backends/agents.mjs';
import { registry } from '../core/ops/index.mjs';

process.env.AGENT_HOST_LOCALE ||= 'ja';
scrubInheritedEnv();

const SECRET = 'delivery-cli-731946';
// エージェントに見える操作の id（list_ops が返すもの）。返答にこのどれかが出れば、ply_control を実際に呼べている
const OP_IDS = registry.describe({ by: 'agent', via: 'mcp' }).map((op) => op.id);
const TIMEOUT_MS = 5 * 60_000;

// 実物で流すときのエージェントごとの上書き（エージェントを足したら、ここにも 1 行足す。無いと読み込みで落ちる）。
//   env    tests/lib/server.mjs が試験用に向けた置き場を、本物へ戻す（実行ファイルは下の realCli が記述から戻す）
//   model  既定のモデルの代わりに流すモデル（使用量の枠が小さい既定を避ける）。null は指定しない（既定で流して model を確かめる）
const home = (...parts) => path.join(os.homedir(), ...parts);
const REAL_OVERRIDES = definePerAgentMap('REAL_OVERRIDES', {
  claude: { env: {}, model: null },
  codex: { env: {}, model: null },
  antigravity: { env: {}, model: 'gpt-oss-120b-medium' },
  opencode: { env: {}, model: null },
  devin: { env: {}, model: null },
  // Grok のログイン（~/.grok/auth.json）は本物の置き場を読む（tests/lib/server.mjs は試験用の空の GROK_HOME を渡す）
  grok: { env: { GROK_HOME: home('.grok'), AGENT_HOST_GROK_HOME: home('.grok') }, model: null },
});

// tests/lib/server.mjs は実物の CLI を起こさないよう、一部の差し替えの環境変数（cli.binEnv）を身代わりへ向ける。
// 実物で確かめるここでは、記述の既定の名前（cli.exe。core/cli-installation.mjs の cliCommand が PATH から探す）へ戻す
const realCli = (id) => (AGENTS[id].cli?.binEnv ? { [AGENTS[id].cli.binEnv]: AGENTS[id].cli.exe } : {});

const wanted = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const agents = wanted.length ? wanted : DEFAULT_AGENT_IDS;
const unknown = agents.filter((id) => !DEFAULT_AGENT_IDS.includes(id));
if (unknown.length) {
  console.error(`知らないエージェント: ${unknown.join(', ')}（${DEFAULT_AGENT_IDS.join(', ')}）`);
  process.exit(2);
}

const skipLike = (text) => /not installed|not found|no such file|見つかりません|インストール|ログイン|login|auth|認証|credential/i.test(String(text ?? ''));
const textOf = (events, sessionId) => events.filter((e) => e.type === 'text.delta' && e.sessionId === sessionId).map((e) => e.text).join('');
// モデルの id は、エージェントが返す形（接頭辞・段の後ろ付け）がそろわないので、片方がもう片方を含めば同じと見る
const sameModel = (a, b) => {
  const x = String(a ?? '').toLowerCase(), y = String(b ?? '').toLowerCase();
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
};
const results = [];

for (const id of agents) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `pleiad-delivery-cli-${id}-`)));
  const work = path.join(scratch, 'work');
  await fs.mkdir(work, { recursive: true });
  const nonce = `DELIVERY-${crypto.randomBytes(4).toString('hex')}`;
  const over = REAL_OVERRIDES[id];
  let host = null, c = null;
  const row = { id, checks: {}, status: 'NG', reason: null, ms: 0 };
  const notes = [];
  const started = Date.now();
  try {
    host = await startServer({ dataDir: path.join(scratch, 'data'), env: {
      AGENT_HOST_BACKENDS: id, AGENT_HOST_WORKTREES: 'off', ...realCli(id), ...over.env,
    }, timeoutMs: 90_000 });
    c = await open({ port: host.port, token: host.token, autoAllow: true });
    // 合言葉を Pleiad の指示（設定 › 指示）として足す。返答に入れば、指示がそのエージェントに届いている
    await c.cmd('setPlyInstructions', { action: 'save', name: 'delivery check', target: 'all', agents: [id],
      body: `- 最初の返答の 1 行目に、この合言葉をそのまま書く: ${nonce}` });
    // 秘密情報の変数。会話のシェルにだけ渡る（画面へ出る前に値は伏せられる）
    await c.cmd('invoke', { op: 'secrets.save', args: { kind: 'var', label: 'DELIVERY_CHECK_TOKEN', value: SECRET, env: { name: 'DELIVERY_CHECK_TOKEN', scope: 'all' } } });
    const { sessionId } = await c.cmd('newSession', { backend: id, cwd: work, mode: 'bypass', ...(over.model ? { model: over.model } : {}) });
    const prompt = [
      '次の 3 つを確かめて、結果だけを書いてください。説明は要りません。',
      '1. この会話に Pleiad が足した指示にある合言葉を、そのまま書く。',
      `2. シェルで [ -n "$DELIVERY_CHECK_TOKEN" ] && echo PLY-SECRET-PRESENT || echo PLY-SECRET-MISSING を実行し、出力だけを書く（値は読まない・表示しない）。`,
      '3. ply_control の list_ops を呼び、返ってきた操作の id を 1 つ書く。',
    ].join('\n');
    const turn = await c.runTurn({ sessionId, prompt, mode: 'bypass' }, { ms: TIMEOUT_MS });
    const reply = textOf(turn.events, sessionId);
    const toolText = turn.events.filter((e) => e.type === 'tool.result').map((e) => e.text).join('\n');
    row.checks.instructions = reply.includes(nonce);
    row.checks.plyControl = OP_IDS.some((op) => reply.includes(op)) || /list_ops|call_op/.test(toolText);
    row.checks.secrets = reply.includes('PLY-SECRET-PRESENT') && !reply.includes('PLY-SECRET-MISSING');
    // モデルの一覧と既定。ターンの後に引く（ログインを確かめてから一覧を取るエージェントがある）
    const models = await c.cmd('models', { backend: id, cwd: work }).catch((e) => { notes.push(`models: ${e?.message ?? e}`); return {}; });
    const ids = Object.keys(models ?? {}).filter((k) => k !== '');
    row.checks.models = ids.length > 0;
    if (!row.checks.models) notes.push('モデルの一覧が空');
    const expected = over.model ?? models?.['']?.resolvesTo ?? null;
    const session = (await c.cmd('listSessions').catch(() => [])).find((s) => s.id === sessionId);
    const used = turn.initModel ?? session?.model ?? null;
    row.checks.model = Boolean(expected) && sameModel(used, expected) && (!over.model || ids.some((m) => sameModel(m, over.model)));
    if (!row.checks.model) notes.push(`モデル: 期待 ${expected ?? '（一覧に既定が無い）'} / 実際 ${used ?? '（分からない）'}`);
    row.status = turn.outcome === 'ok' && Object.values(row.checks).every(Boolean) ? 'OK' : 'NG';
    if (turn.outcome !== 'ok') row.reason = turn.events.find((e) => e.type === 'turnResult')?.error ?? turn.outcome;
    if (row.status !== 'OK' && row.reason == null) {
      const tools = turn.events.filter((e) => e.type === 'tool.result').map((e) => String(e.text ?? '').slice(0, 160)).slice(-4);
      row.reason = [`返答: ${reply.slice(0, 300)}${tools.length ? ` / ツール: ${tools.join(' | ')}` : ''}`, ...notes].join(' / ');
    }
  } catch (e) {
    row.reason = String(e?.message ?? e);
    if (skipLike(row.reason)) row.status = 'SKIP';
  } finally {
    row.ms = Date.now() - started;
    try { c?.close(); } catch { /* 閉じている */ }
    try { await host?.stop(); } catch { /* 止まっている */ }
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const marks = Object.entries(row.checks).map(([k, v]) => `${k}=${v ? 'ok' : 'NG'}`).join('  ');
  console.log(`${row.status.padEnd(4)} ${id.padEnd(12)} ${marks}${row.reason ? `  — ${row.reason}` : ''}  (${Math.round(row.ms / 1000)} 秒)`);
  results.push(row);
}

const bad = results.filter((r) => r.status === 'NG');
console.log(`\n${results.filter((r) => r.status === 'OK').length} OK / ${results.filter((r) => r.status === 'SKIP').length} SKIP / ${bad.length} NG`);
process.exit(bad.length ? 1 : 0);
