// ply_shell の渡し方（ADR 0227 §1・§3）。LLM は呼ばない。
//   - OpenCode: ply_shell は聞かない。エージェントのシェルを切る会話は bash を全面拒否（一覧から外れる）。規則の印も変わる
//   - Claude: ply_shell を MCP に足し、聞かない。切る会話は Bash・PowerShell を disallowedTools に入れ、使い方の指示を足す
//   - サーバー（fake）: 設定 shellTool で切り替わる・run が走る・start のジョブが裏の一覧に出て人が止められる・終わりを会話へ知らせる・
//     長い start のジョブを会話へ知らせる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { sessionPermission } from '../../core/backends/opencode.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';

export const name = 'shell-delivery';
export const title = 'ply_shell の渡し方: OpenCode の bash の拒否・Claude の disallowedTools・設定での切り替え・裏のジョブ・終わりと長さの知らせ';

const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
const shell = (params) => 'shell:' + JSON.stringify(params);

export default async function (t) {
  // ---- OpenCode の規則
  {
    const plain = sessionPermission('ask');
    const offered = sessionPermission('ask', { shellRuntime: { url: 'u', nativeOff: false } });
    const off = sessionPermission('ask', { shellRuntime: { url: 'u', nativeOff: true } });
    const has = (p, perm, action) => p.permission.some((r) => r.permission === perm && r.action === action && r.pattern === '*');
    t.ok('OpenCode: ply_shell を渡す会話では ply_shell を聞かない（承認は橋）', has(offered, 'ply_shell_*', 'allow') && !has(plain, 'ply_shell_*', 'allow'));
    t.ok('OpenCode: 切る会話は bash を全面拒否にする（mode の規則より後ろ）', has(off, 'bash', 'deny') && !has(offered, 'bash', 'deny')
      && off.permission.findIndex((r) => r.permission === 'bash') > off.permission.findIndex((r) => r.permission === '*'));
    t.ok('OpenCode: 規則の印が変わる（入れ直す）', new Set([plain.permissionKey, offered.permissionKey, off.permissionKey]).size === 3);
  }

  // ---- Claude の渡し方
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-shell-claude-'));
    let options;
    const restore = setClaudeSdkForTest({ executable: () => 'fake-claude', query: ({ options: received }) => {
      options = received;
      return { close() {}, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', num_turns: 1 }; } };
    } });
    try {
      const shellRuntime = { url: 'http://127.0.0.1:1/mcp/shell', headers: { Authorization: 'Bearer x' }, nativeOff: true, instructions: 'use ply_shell' };
      await claude.runTurn({ prompt: 'hello', sessionId: null, cwd: scratch, mode: 'default', emit() {}, signal: new AbortController(), shellRuntime });
      t.ok('Claude: ply_shell を MCP に足す（待ちの上限は run より長い）', options?.mcpServers?.ply_shell?.url === shellRuntime.url && options.mcpServers.ply_shell.timeout > 600_000);
      t.ok('Claude: 切る会話は Bash・PowerShell を外し、使い方の指示を足す', ['Bash', 'PowerShell'].every((n) => options?.disallowedTools?.includes(n)) && options?.systemPrompt?.append?.includes('use ply_shell'));
      const decided = await options.canUseTool('mcp__ply_shell__run', { command: 'echo' }, { signal: new AbortController().signal, suggestions: [] });
      t.ok('Claude: ply_shell は聞かない（承認は橋）', decided?.behavior === 'allow', JSON.stringify(decided));
      await claude.runTurn({ prompt: 'hello', sessionId: null, cwd: scratch, mode: 'default', emit() {}, signal: new AbortController(), shellRuntime: { ...shellRuntime, nativeOff: false, instructions: null } });
      t.ok('Claude: 切らない会話は Bash を残す', !(options?.disallowedTools ?? []).includes('Bash'));
    } finally { restore(); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }); }
  }

  // ---- サーバー（fake）
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-shell-delivery-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_SESSION_COMMAND_MINUTES: '0.02' }, dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
  const c = await open({ ...server, autoAllow: true });
  const reply = async (sessionId, prompt, messageId) => {
    const from = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId, prompt });
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 30_000 });
    return c.since(from).filter((e) => e.type === 'text.delta' && e.sessionId === sessionId).map((e) => e.text).join('');
  };
  const transcript = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages.map((m) => m.text ?? '').join('\n');
  const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    let info = JSON.parse(await reply(sessionId, 'shell-info', 'sd-info-0001'));
    t.ok('fake: 既定ではエージェントのシェルを切らない（記述の shellDefault）', info.nativeOff === false && info.instructions === null && /\/mcp\/shell$/.test(info.url), JSON.stringify(info));
    await c.cmd('setPref', { key: 'shellTool', value: { fake: 'ply' } });
    info = JSON.parse(await reply(sessionId, 'shell-info', 'sd-info-0002'));
    t.ok('設定 shellTool を ply にすると、次のターンから切り、使い方の指示を足す', info.nativeOff === true && /ply_shell/.test(info.instructions ?? ''), JSON.stringify(info));

    const ran = await reply(sessionId, shell({ name: 'run', arguments: { command: 'echo from-ply-shell' } }), 'sd-run-0001');
    t.ok('run: 会話の作業場所で走り、出力と終了コードを返す', ran.includes('from-ply-shell') && /終了コード 0/.test(ran), ran);

    const started = await reply(sessionId, shell({ name: 'start', arguments: { command: `${node} -e "console.log('server up'); setInterval(() => {}, 1000)"` } }), 'sd-start-0001');
    const jobId = /ジョブ (sh-[a-f0-9]+)/.exec(started)?.[1];
    t.ok('start: すぐ戻り、ジョブの id を返す', Boolean(jobId), started);
    const jobsOf = async () => (await c.cmd('running')).background.filter((x) => x.sessionId === sessionId).flatMap((x) => x.tasks);
    const listed = await until(async () => (await jobsOf()).find((x) => x.id === jobId));
    t.ok('start のジョブは会話の裏の一覧に kind: shell で出る', listed?.kind === 'shell', JSON.stringify(listed));
    const entry = (await c.cmd('running')).background.find(x => x.sessionId === sessionId && x.tasks.some(y => y.id === jobId));
    t.ok('ply_shell advertises output and stop capabilities to the UI', entry?.capabilities?.backgroundDetails === true && entry.capabilities.stopBackground === true);
    const detail = await until(async () => {
      const r = await c.cmd('loadBackground', { sessionId, taskId: jobId });
      return r.task?.output?.includes('server up') ? r.task : null;
    });
    t.ok('Background details return real output, command, cwd and start time', detail?.output.includes('server up') && detail.command.includes('server up') && detail.cwd === ROOT && Number.isFinite(detail.startedAtMs));
    const notice = await until(async () => (await transcript(sessionId)).includes('Pleiad コマンド長時間通知'));
    t.ok('長い start のジョブは、止めずに会話へ知らせる（空いていれば新しいターン）', Boolean(notice));
    await c.cmd('stopBackground', { sessionId, taskId: jobId });
    const done = await until(async () => (await transcript(sessionId)).includes(`Pleiad シェルのジョブの終わり / ${jobId}`));
    t.ok('人が止めたジョブの終わりを会話へ知らせる', Boolean(done));
    const final = await c.cmd('loadBackground', { sessionId, taskId: jobId });
    t.ok('Completed background details keep final output and exit status', final.task?.status === 'completed' && final.task.output.includes('server up') && final.task.stopped === true && final.task.exitCode === null);
    const { sessionId: naturalSession } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const natural = await reply(naturalSession, shell({ name: 'start', arguments: { command: 'echo final-output' } }), 'sd-start-0002');
    const naturalId = /ジョブ (sh-[a-f0-9]+)/.exec(natural)?.[1];
    const finished = await until(async () => {
      const r = await c.cmd('loadBackground', { sessionId: naturalSession, taskId: naturalId });
      return r.task?.status === 'completed' ? r.task : null;
    });
    t.ok('Naturally completed commands retain final output and exit 0', finished?.exitCode === 0 && finished.output.includes('final-output'));
    const after = await jobsOf();
    t.ok('止めたジョブは裏の一覧から消える', !after.some((x) => x.id === jobId), JSON.stringify(after));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
