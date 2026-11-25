// ply_shell の渡し方（ADR 0227 §1・§3）。LLM は呼ばない。
//   - OpenCode: ply_shell は聞かない。エージェントのシェルを切る会話は bash を全面拒否（一覧から外れる）。規則の印も変わる
//   - Claude: ply_shell を MCP に足し、聞かない。切る会話は Bash・PowerShell を disallowedTools に入れ、使い方の指示を足す
//   - サーバー（fake）: 設定 shellTool で切り替わる・run が走る・start のジョブが裏の一覧に出て人が止められる・終わりを会話へ知らせる・
//     長い start のジョブを会話へ知らせる
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions } from '../lib/data-store.mjs';
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
    let options, mcpConf = {};
    const restore = setClaudeSdkForTest({ executable: () => 'fake-claude', query: ({ options: received }) => {
      options = received;
      // HTTP の MCP は options.mcpServers に置かず、--mcp-config に渡す 0600 のファイルに載る（トークンを argv に出さない。ADR 0284）。
      // ファイルはターンの終わりに消すので、走っている最中に読む
      const conf = received?.extraArgs?.['mcp-config'];
      mcpConf = conf ? JSON.parse(fss.readFileSync(conf, 'utf8')).mcpServers ?? {} : {};
      return { close() {}, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', num_turns: 1 }; } };
    } });
    try {
      const shellRuntime = { url: 'http://127.0.0.1:1/mcp/shell', headers: { Authorization: 'Bearer x' }, nativeOff: true, instructions: 'use ply_shell' };
      await claude.runTurn({ prompt: 'hello', sessionId: null, cwd: scratch, mode: 'default', emit() {}, signal: new AbortController(), shellRuntime });
      const nativeOffConf = mcpConf;
      t.ok('Claude: ply_shell を MCP に足す（待ちの上限は run の最長の待ち・承認待ちより長い）', mcpConf.ply_shell?.url === shellRuntime.url && mcpConf.ply_shell.timeout > 600_000 && !options?.mcpServers?.ply_shell);
      t.ok('Claude: 切る会話は Bash・PowerShell を外し、使い方の指示を足す', ['Bash', 'PowerShell'].every((n) => options?.disallowedTools?.includes(n)) && options?.systemPrompt?.append?.includes('use ply_shell'));
      const decided = await options.canUseTool('mcp__ply_shell__run', { command: 'echo' }, { signal: new AbortController().signal, suggestions: [] });
      t.ok('Claude: ply_shell は聞かない（承認は橋）', decided?.behavior === 'allow', JSON.stringify(decided));
      await claude.runTurn({ prompt: 'hello', sessionId: null, cwd: scratch, mode: 'default', emit() {}, signal: new AbortController(), shellRuntime: { ...shellRuntime, nativeOff: false, instructions: null } });
      t.ok('Claude: 切らない会話は Bash を残す', !(options?.disallowedTools ?? []).includes('Bash'));
      // ply_shell が唯一のシェルになる会話は、ツール検索の後ろに回さず最初から読み込む（スキーマを読む前の呼び出しは 1 回失敗する）。切らない会話は今までどおり
      t.ok('Claude: 切る会話の ply_shell は alwaysLoad で最初から読み込む。切らない会話は付けない', nativeOffConf?.ply_shell?.alwaysLoad === true && mcpConf.ply_shell?.alwaysLoad === undefined, JSON.stringify({ nativeOffConf, mcpConf }));
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

  // ---- 「常に許可」（実サーバー・DB 往復・再起動・他会話・分岐・委譲の子・読むだけモード）
  const permScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-shell-always-'));
  const permData = path.join(permScratch, 'data');
  const startPermServer = () => startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: permData, timeoutMs: 60_000 });
  const bootClient = async (srv, resolve) => {
    const seen = [];
    const client = await open({
      port: srv.port, token: srv.token,
      onEvent: async (ev, api) => {
        if (ev.type !== 'permission') return;
        if (seen.some((x) => x.id === ev.id)) return;
        seen.push(ev);
        const a = resolve(ev);
        if (a) await api.cmd('resolvePermission', { id: ev.id, ...a }).catch(() => {});
      },
    });
    return { client, seen };
  };
  let srv1 = await startPermServer();
  let nextAnswer = () => ({ allow: true, always: false });
  let { client: c1, seen: cards1 } = await bootClient(srv1, (ev) => nextAnswer(ev));
  const askShell = async (client, sessionId, args, id) => {
    const from = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: id, prompt: shell(args) });
    await client.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 30_000 });
    return client.since(from).filter((e) => e.type === 'text.delta' && e.sessionId === sessionId).map((e) => e.text).join('');
  };
  try {
    const { sessionId: s1 } = await c1.cmd('newSession', { backend: 'fake', cwd: ROOT });
    // 1. 一度だけの許可（once）では印を残さない
    let out = await askShell(c1, s1, { name: 'run', arguments: { command: 'echo once-1' } }, 'sa-once-1');
    const cardOnce = cards1.filter((x) => x.toolName === 'ply_shell' && x.sessionId === s1);
    t.ok('サーバー越し: ply_shell の承認カードは canAlways: true で出て、once で通る',
      cardOnce.length === 1 && cardOnce[0].canAlways === true && out.includes('once-1') && !readSessions(permData)[s1]?.shellAlwaysAllow, out);

    // 2. 「常に許可」で許可すると DB に残り、以後はカードを出さない
    nextAnswer = () => ({ allow: true, always: true });
    out = await askShell(c1, s1, { name: 'run', arguments: { command: 'echo always-1' } }, 'sa-always-1');
    t.ok('サーバー越し: 「常に許可」を選んだら会話のデータ shellAlwaysAllow に残る',
      cards1.filter((x) => x.toolName === 'ply_shell' && x.sessionId === s1).length === 2 && out.includes('always-1') && readSessions(permData)[s1]?.shellAlwaysAllow === true);

    const beforeNoCard = cards1.length;
    out = await askShell(c1, s1, { name: 'run', arguments: { command: 'echo always-2' } }, 'sa-always-2');
    t.ok('サーバー越し: 常に許可の後の run はカードを出さずに通る', out.includes('always-2') && cards1.length === beforeNoCard);
    out = await askShell(c1, s1, { name: 'start', arguments: { command: 'echo always-start' } }, 'sa-always-start');
    const startJobId = /ジョブ (sh-[a-f0-9]+)/.exec(out)?.[1];
    t.ok('サーバー越し: 常に許可の後の start もカードを出さずに通る', Boolean(startJobId) && cards1.length === beforeNoCard);
    if (startJobId) await c1.cmd('stopBackground', { sessionId: s1, taskId: startJobId }).catch(() => {});

    // 3. ほかの会話・分岐・委譲の子には引き継がない
    nextAnswer = () => ({ allow: true, always: false });
    const { sessionId: s2 } = await c1.cmd('newSession', { backend: 'fake', cwd: ROOT });
    out = await askShell(c1, s2, { name: 'run', arguments: { command: 'echo other-conv' } }, 'sa-other-1');
    t.ok('サーバー越し: ほかの会話ではカードが出る', out.includes('other-conv') && cards1.some((x) => x.toolName === 'ply_shell' && x.sessionId === s2));

    const forked = await c1.cmd('fork', { sessionId: s1 });
    // fork 直後の最初のターンは引き継ぎ文が先頭に付くため、1 ターン済ませてから shell: 台本を走らせる
    {
      const fFrom = c1.mark();
      await c1.cmd('sendMessage', { sessionId: forked.sessionId, messageId: 'sa-fork-init', prompt: 'hello' });
      await c1.waitFor((e) => e.type === 'turnEnd' && e.sessionId === forked.sessionId, { from: fFrom, ms: 30_000 });
    }
    out = await askShell(c1, forked.sessionId, { name: 'run', arguments: { command: 'echo forked-conv' } }, 'sa-fork-1');
    t.ok('サーバー越し: 分岐（fork）した会話には引き継がず、カードが出る',
      out.includes('forked-conv') && cards1.some((x) => x.toolName === 'ply_shell' && x.sessionId === forked.sessionId) && !readSessions(permData)[forked.sessionId]?.shellAlwaysAllow, out);

    // 4. 読むだけのモードに変わったら、印があっても断る
    await c1.cmd('setMode', { sessionId: s1, mode: 'plan' });
    const beforePlan = cards1.length;
    out = await askShell(c1, s1, { name: 'run', arguments: { command: 'echo plan-blocked' } }, 'sa-plan-1');
    t.ok('サーバー越し: 承認モードが読むだけに変わったら、印があってもカードを出さず断る',
      out.includes('読み取りだけ') && cards1.length === beforePlan, out);
    await c1.cmd('setMode', { sessionId: s1, mode: 'default' });

    // 5. サーバーを再起動しても会話のデータの印が残り、カードを出さない
    c1.close();
    await srv1.stop();
    srv1 = null;
    srv1 = await startPermServer();
    const restarted = await bootClient(srv1, () => ({ allow: true, always: false }));
    c1 = restarted.client;
    cards1 = restarted.seen;
    out = await askShell(c1, s1, { name: 'run', arguments: { command: 'echo after-server-restart' } }, 'sa-restart-1');
    t.ok('サーバー越し: 再起動後も shellAlwaysAllow が残り、カードを出さずに通る',
      out.includes('after-server-restart') && cards1.length === 0, `${out} cards=${cards1.length}`);

    // 6. 委譲の子にも引き継がない（子の承認カードは canAlways: true、親への中継カードは canAlways: false）
    const childPrompt = 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', task: shell({ name: 'run', arguments: { command: 'echo child-run' } }) } });
    const delFrom = c1.mark();
    await c1.cmd('sendMessage', { sessionId: s1, messageId: 'sa-del-1', prompt: childPrompt });
    await c1.waitFor((e) => e.type === 'turnEnd' && e.sessionId === s1, { from: delFrom, ms: 30_000 });
    const task = await until(async () => {
      const rows = (await c1.cmd('agentTasks')).filter((r) => r.parentSessionId === s1);
      return rows[0]?.status === 'completed' ? rows[0] : null;
    });
    const childCard = cards1.find((x) => x.toolName === 'ply_shell' && x.sessionId === task?.sessionId);
    const relayCard = cards1.find((x) => x.toolName === 'ply_shell' && x.sessionId === s1 && x.targetSessionId === task?.sessionId);
    t.ok('サーバー越し: 委譲の子には引き継がず子の会話でカード（canAlways: true）が出、親への中継は canAlways: false',
      Boolean(task) && Boolean(childCard) && childCard.canAlways === true && Boolean(relayCard) && relayCard.canAlways === false && !readSessions(permData)[task.sessionId]?.shellAlwaysAllow);
    // 親へのタスク完了通知のターンが走り切るのを待ってからサーバーを止める
    await until(async () => (await c1.cmd('running')).turns.length === 0, 10_000);
  } finally {
    c1?.close();
    if (srv1) await srv1.stop();
    await fs.rm(permScratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
