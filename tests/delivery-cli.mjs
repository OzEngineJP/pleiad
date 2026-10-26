// 実物の CLI で 1 ターン流し、Pleiad の渡し物が届いたかを確かめる（issue #146。CI では回さない。使用量は 1 エージェント 1 ターン）。
//
//   npm run test:delivery                 6 エージェントを順に
//   npm run test:delivery -- claude devin 指定だけ
//
// 確かめること（1 ターンで 3 つ。偽のプロセスで確かめる tests/unit/backend-delivery.mjs の実物版）:
//   instructions  設定 › 指示に足した合言葉が返答に入る（plyInstructions・plyAgents の届け方）
//   plyControl    ply_control の list_ops を呼び、操作の一覧（sessions.list など）が返る
//   secrets       秘密情報の変数が会話のシェルにある（値は読まず、あるかないかを答えさせる）
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
import { DEFAULT_AGENT_IDS } from '../core/backends/agents.mjs';
import { registry } from '../core/ops/index.mjs';

process.env.AGENT_HOST_LOCALE ||= 'ja';
scrubInheritedEnv();

const SECRET = 'delivery-cli-731946';
// エージェントに見える操作の id（list_ops が返すもの）。返答にこのどれかが出れば、ply_control を実際に呼べている
const OP_IDS = registry.describe({ by: 'agent', via: 'mcp' }).map((op) => op.id);
const TIMEOUT_MS = 5 * 60_000;

const wanted = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const agents = wanted.length ? wanted : DEFAULT_AGENT_IDS;
const unknown = agents.filter((id) => !DEFAULT_AGENT_IDS.includes(id));
if (unknown.length) {
  console.error(`知らないエージェント: ${unknown.join(', ')}（${DEFAULT_AGENT_IDS.join(', ')}）`);
  process.exit(2);
}

const skipLike = (text) => /not installed|not found|no such file|見つかりません|インストール|ログイン|login|auth|認証|credential/i.test(String(text ?? ''));
const textOf = (events, sessionId) => events.filter((e) => e.type === 'text.delta' && e.sessionId === sessionId).map((e) => e.text).join('');
const results = [];

for (const id of agents) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `pleiad-delivery-cli-${id}-`)));
  const work = path.join(scratch, 'work');
  await fs.mkdir(work, { recursive: true });
  const nonce = `DELIVERY-${crypto.randomBytes(4).toString('hex')}`;
  let host = null, c = null;
  const row = { id, checks: {}, status: 'NG', reason: null, ms: 0 };
  const started = Date.now();
  try {
    host = await startServer({ dataDir: path.join(scratch, 'data'), env: {
      AGENT_HOST_BACKENDS: id, AGENT_HOST_WORKTREES: 'off',
      // tests/lib/server.mjs は実 Devin・Grok を起こさないよう身代わりを指す。実物で確かめるここでは、PATH の本物を使う。
      // Grok のログイン（~/.grok/auth.json）は本物の置き場を読む（tests/lib/server.mjs は試験用の空の GROK_HOME を渡す）
      ...(id === 'devin' ? { AGENT_HOST_DEVIN_BIN: 'devin' } : {}),
      ...(id === 'grok' ? { AGENT_HOST_GROK_BIN: 'grok', GROK_HOME: path.join(os.homedir(), '.grok'), AGENT_HOST_GROK_HOME: path.join(os.homedir(), '.grok') } : {}),
    }, timeoutMs: 90_000 });
    c = await open({ port: host.port, token: host.token, autoAllow: true });
    // 合言葉を Pleiad の指示（設定 › 指示）として足す。返答に入れば、指示がそのエージェントに届いている
    await c.cmd('setPlyInstructions', { action: 'save', name: 'delivery check', target: 'all', agents: [id],
      body: `- 最初の返答の 1 行目に、この合言葉をそのまま書く: ${nonce}` });
    // 秘密情報の変数。会話のシェルにだけ渡る（画面へ出る前に値は伏せられる）
    await c.cmd('invoke', { op: 'secrets.save', args: { kind: 'var', label: 'DELIVERY_CHECK_TOKEN', value: SECRET, env: { name: 'DELIVERY_CHECK_TOKEN', scope: 'all' } } });
    const { sessionId } = await c.cmd('newSession', { backend: id, cwd: work, mode: 'bypass',
      ...(id === 'antigravity' ? { model: 'gpt-oss-120b-medium' } : {}) });
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
    row.status = turn.outcome === 'ok' && Object.values(row.checks).every(Boolean) ? 'OK' : 'NG';
    if (turn.outcome !== 'ok') row.reason = turn.events.find((e) => e.type === 'turnResult')?.error ?? turn.outcome;
    if (row.status !== 'OK' && row.reason == null) {
      const tools = turn.events.filter((e) => e.type === 'tool.result').map((e) => String(e.text ?? '').slice(0, 160)).slice(-4);
      row.reason = `返答: ${reply.slice(0, 300)}${tools.length ? ` / ツール: ${tools.join(' | ')}` : ''}`;
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
