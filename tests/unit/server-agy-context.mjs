// antigravity（agy）に Pleiad が担当するコンテキスト（指示・Skills・外部 MCP の中継）を渡す。
// 本物の agy は使わない（tests/lib/fake-agy.mjs。カスタムエージェントの探し方・MCP の起こし方は実機の観測に合わせてある）。
//   - Pleiad の置き場に作ったカスタムエージェント（--add-dir + --agent）で、指示と Skills の一覧がシステムプロンプトに入る
//   - 中継（core/agy-context-relay.mjs）を通して、ply_context のツール（load_skill・外部 MCP）が使える
//   - トークンは会話ごと。agy は 1 本のまま、ターンをまたいで同じトークンで使える。ターンの外では 401
//   - エージェント定義にトークンを書かない。前の起動が残した置き場は次の起動で消す
//   - 指示がエージェント任せのまま Skills・MCP を Pleiad にする組み合わせも受ける（読めない分の指示は Pleiad が発言の前に足す）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agentDefinition, contextRefusal } from '../../core/backends/antigravity-context.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-agy-context';
export const title = 'antigravity に Pleiad のコンテキスト（指示・Skills・外部 MCP）をカスタムエージェント経由で渡す';

/** 中継を env なしで起こし、JSON-RPC を流して返事を集める */
async function relayAlone(messages) {
  const env = { ...process.env };
  delete env.PLY_CONTEXT_URL; delete env.PLY_CONTEXT_AUTHORIZATION;
  const child = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; });
  for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  const expected = messages.filter(m => m.id !== undefined).length;
  for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < expected; i++) await new Promise(r => setTimeout(r, 50));
  child.kill();
  return out.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export default async function (t) {
  // ---- 担当の組み合わせと、エージェント定義の形（純粋な関数）
  // かつては指示がエージェント任せのまま他を Pleiad にする組み合わせを断っていたが、読めない分の指示ファイルを
  // Pleiad が発言の前に足す（issue #107）ので、どの組み合わせも受ける
  t.ok('指示の担当がエージェントのまま Skills・MCP を Pleiad にする組み合わせも受ける（読めない指示は Pleiad が注入する）',
    contextRefusal({ instruction: 'native', skill: 'native', mcp: 'ply' }) === null && contextRefusal({ instruction: 'native', skill: 'ply', mcp: 'native' }) === null
    && contextRefusal({ instruction: 'ply', skill: 'native', mcp: 'native' }) === null && contextRefusal({ instruction: 'native', skill: 'native', mcp: 'native' }) === null);
  const partial = agentDefinition({ owners: { instruction: 'ply', skill: 'native', mcp: 'ply' }, prompt: 'P', cwd: 'C:/w', home: 'C:/h' });
  t.ok('Skills がエージェント担当ならネイティブの読み込みを残し、MCP は切る', /\ninheritCustomizations: true\n/.test(partial) && /\ninheritMcp: false\n/.test(partial));
  const full = agentDefinition({ owners: { instruction: 'ply', skill: 'ply', mcp: 'native' }, prompt: 'P', cwd: 'C:/w', home: 'C:/h', electron: true });
  t.ok('Skills が Pleiad ならネイティブを切り、MCP がエージェント担当なら残す。Electron では Node として動かす印を付ける', /\ninheritCustomizations: false\n/.test(full) && /\ninheritMcp: true\n/.test(full) && full.includes('"ELECTRON_RUN_AS_NODE":"1"'));
  // tools を書かないと agy は書き込み系ツールを 1 つも渡さない（antigravity-context.mjs の TOOLS）
  const tools = JSON.parse(/\ntools: (\[[^\n]*\])\n/.exec(partial)?.[1] ?? 'null');
  t.ok('書き込みとコマンド実行のツールを明示する', Array.isArray(tools) && ['write_to_file', 'replace_file_content', 'run_command', 'view_file'].every(name => tools.includes(name)), JSON.stringify(tools));
  // 起動ごと失敗する名前・応答に JSON が混ざる名前を入れない（同上）
  t.ok('レジストリに無い名前と finish を入れない', Array.isArray(tools) && !['*', 'call_mcp_tool', 'list_resources', 'read_resource', 'command_status', 'send_command_input', 'sed_file', 'finish'].some(name => tools.includes(name)), JSON.stringify(tools));

  const alone = await relayAlone([
    { jsonrpc: '2.0', id: 1, method: 'server/discover' },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  ]);
  t.ok('中継は Pleiad の接続先が無ければツールを持たない MCP として答え、知らない要求は断る',
    alone.find(m => m.id === 1)?.error?.code === -32601 && alone.find(m => m.id === 2)?.result?.serverInfo?.name === 'Pleiad Context' && Array.isArray(alone.find(m => m.id === 3)?.result?.tools) && alone.find(m => m.id === 3).result.tools.length === 0, JSON.stringify(alone));

  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-context-')));
  const cwd = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data'), launches = path.join(tmp, 'launches.txt');
  const agentFile = path.join(tmp, 'agent.json'), argsFile = path.join(tmp, 'args.json'), pidFile = path.join(tmp, 'pids.json');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  let host, client;
  try {
    // 外部 MCP の身代わり。echo は env の API_KEY（Pleiad の登録に入れた秘密）を返す
    const script = path.join(tmp, 'fixture.mjs');
    await write(script, `import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launches)},(process.env.MARK||'?')+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{content:[{type:'text',text:'echo:'+(process.env.API_KEY||'none')}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(cwd, 'CLAUDE.md'), '# Rules\n\nThe project codeword is PROJECT-RULE-AGY.\n');
    await write(path.join(cwd, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill for the agy test\n---\n\nDEMO-SKILL-BODY\n');

    host = await startServer({ dataDir, timeoutMs: 30_000, env: {
      AGENT_HOST_BACKENDS: 'fake,antigravity',
      AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"`,
      FAKE_AGY_AGENT_FILE: agentFile, FAKE_AGY_ARGS_FILE: argsFile, FAKE_AGY_PID_FILE: pidFile,
    } });
    client = await open({ ...host, autoAllow: true });
    await client.cmd('savePlyMcp', { name: 'fixture', mode: 'add', value: { transport: 'stdio', command: process.execPath, args: [script], env: { MARK: 'ply', API_KEY: 'AGY_ENV_SECRET' } } });
    // 担当はすべて Pleiad（この場所の上書き）。探すのは Claude 形式、MCP は home 側も（Pleiad の登録を含む）
    for (const kind of ['instruction', 'skill', 'mcp']) await client.cmd('setContextSettings', { cwd, place: cwd, kind,
      value: { owner: 'ply', user: kind === 'mcp' ? { sources: [], excludePaths: [] } : null, directory: { sources: ['claude'], excludePaths: [] } } });

    const first = await client.runTurn({ prompt: 'agent-body', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    const body = first.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('指示と Skills の一覧が agy のシステムプロンプト（エージェントの本文）に入る', first.outcome === 'ok' && body.includes('PROJECT-RULE-AGY') && /demo: Demo skill/.test(body), body.slice(0, 400));
    const agent = JSON.parse(await fs.readFile(agentFile, 'utf8'));
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8'))[0];
    const home = args[args.lastIndexOf('--add-dir') + 1];
    t.ok('Pleiad の置き場に作ったエージェントを --add-dir と --agent で渡す', agent.found && args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'ply-context'
      && path.relative(path.join(dataDir, 'antigravity', 'context'), home).split(path.sep).length === 1 && args.includes(cwd), JSON.stringify(args));
    t.ok('ネイティブの Skills と MCP を切り、中継を MCP として持つ', agent.front.inheritCustomizations === false && agent.front.inheritMcp === false && agent.front.mcpServers?.[0]?.serverName === 'ply_context');
    const definition = await fs.readFile(agent.file, 'utf8');
    t.ok('トークンはエージェント定義に書かず、agy の env でだけ渡す', /^Bearer [a-f0-9]{64}$/.test(agent.authorization ?? '') && !definition.includes(agent.authorization.slice(7)) && !definition.includes('AGY_ENV_SECRET'));

    const sessionId = first.sessionId;
    const tools = await client.runTurn({ prompt: 'mcp-tools', sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    const listed = JSON.parse(tools.events.filter(e => e.type === 'text.delta').map(e => e.text).join('') || '[]');
    t.ok('中継から ply_context のツールが見える（load_skill・instructions_for_path・外部 MCP）', ['load_skill', 'instructions_for_path'].every(n => listed.some(x => x.name === n)) && listed.some(x => x.description.includes('[fixture / echo]')), JSON.stringify(listed).slice(0, 400));

    const echo = await client.runTurn({ prompt: 'mcp-call:fixture / echo', sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('2 ターン目以降も同じ agy のまま、外部 MCP を Pleiad の登録（秘密の env）で呼べる', echo.outcome === 'ok' && echo.events.some(e => e.type === 'tool.result' && e.text.includes('echo:AGY_ENV_SECRET')),
      JSON.stringify(echo.events.filter(e => e.type === 'tool.result' || e.type === 'turnResult')));
    // 会話の言語は日本語（テストは AGENT_HOST_LOCALE=ja）なので、Skills の一覧も日本語の書式（core/context-runtime.mjs の context.prompt.skillLine）
    const skillId = /demo: Demo skill for the agy test（id: ([^、]+)、/.exec(body)?.[1];
    const skill = await client.runTurn({ prompt: `mcp-call:load_skill ${JSON.stringify({ id: skillId })}`, sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('Skill の本文を ply_context から読める', skill.events.some(e => e.type === 'tool.result' && e.text.includes('DEMO-SKILL-BODY')), JSON.stringify(skill.events.filter(e => e.type === 'tool.result')).slice(0, 300));
    const pids = JSON.parse(await fs.readFile(pidFile, 'utf8'));
    t.ok('agy は会話のあいだ 1 本（トークンは会話ごと）', pids.length === 1, JSON.stringify(pids));

    const record = await client.cmd('sessionContext', { sessionId });
    const row = record?.report?.entries?.find(e => e.name === 'fixture');
    t.ok('会話の記録に Pleiad 担当として残る（外部 MCP は接続済み）', record?.report?.status === 'ready' && !record.report.guardedBackend && row?.status === 'connected', JSON.stringify({ status: record?.report?.status, guarded: record?.report?.guardedBackend, row }));
    const outside = await fetch(agent.url, { method: 'POST', headers: { authorization: agent.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    t.ok('ターンの外ではそのトークンでも ply_context に入れない', outside.status === 401);

    t.ok('通常の agy 会話には子のコマンド実行指示を入れない', !body.includes('Start-Process -Wait'));
    const delegated = await client.runTurn({ backend: 'fake', cwd,
      prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'antigravity', task: 'wire-has:Start-Process -Wait' } }) }, { ms: 30000 });
    const task = JSON.parse(delegated.events.find(e => e.type === 'tool.result' && e.text.includes('"taskId"')).text);
    let child;
    for (let i = 0; i < 600; i++) {
      child = (await client.cmd('agentTasks')).find(x => x.taskId === task.taskId);
      if (child?.status === 'completed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    // wire-has は、前置きの指示を含む agy が実際に受け取った本文にその文字列があるかを返す
    t.ok('agy の委譲された子には時間上限・PID管理・無期限待機禁止が実際に届く', child?.status === 'completed' && child.result === 'wire-has:yes', JSON.stringify(child?.result ?? child?.status).slice(0, 300));

    // ---- 指示がエージェント任せの会話: カスタムエージェントが読めない AGENTS.md・GEMINI.md を Pleiad が発言の前に足す（issue #107）
    // 探索は scan-home（PLEIAD_SCAN_HOME。利用者の home ではない）と作業場所。`@import` の行は agy 側で解決されないため生のまま渡す
    const scanHome = path.join(dataDir, 'scan-home');
    await write(path.join(cwd, 'AGENTS.md'), 'AGENTS-RULE-MARKER\n\n@./IMPORTED-NOT-RESOLVED.md\n');
    await write(path.join(scanHome, '.gemini', 'GEMINI.md'), 'HOME-GEMINI-MARKER\n');
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'instruction', value: { owner: 'native', user: null, directory: null } });
    const nat = await client.runTurn({ prompt: 'wire-has:AGENTS-RULE-MARKER', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    const natText = nat.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('エージェント任せの指示ファイルは発言の前に足して渡る', nat.outcome === 'ok' && natText.includes('wire-has:yes'), natText.slice(0, 200));
    const nat2 = await client.runTurn({ prompt: 'wire-has:HOME-GEMINI-MARKER', sessionId: nat.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('ユーザー範囲（探索の home の .gemini）も同じ探索で拾う', nat2.events.filter(e => e.type === 'text.delta').map(e => e.text).join('').includes('wire-has:yes'));
    const nat3 = await client.runTurn({ prompt: 'wire-has:IMPORTED-NOT-RESOLVED.md', sessionId: nat.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('@ の参照行は解決せず生のまま渡す（agy が解決しないため）', nat3.events.filter(e => e.type === 'text.delta').map(e => e.text).join('').includes('wire-has:yes'));
    // 続きの会話でも毎ターン再探索される（改訂が次のターンに効く）
    await write(path.join(cwd, 'AGENTS.md'), 'AGENTS-RULE-REVISED\n');
    const nat4 = await client.runTurn({ prompt: 'wire-has:AGENTS-RULE-REVISED', sessionId: nat.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('改訂は起こし直し無しで次のターンに効く', nat4.events.filter(e => e.type === 'text.delta').map(e => e.text).join('').includes('wire-has:yes'));
    const natRec = await client.cmd('sessionContext', { sessionId: nat.sessionId });
    t.ok('渡した分は記録に残る（ファイル・ハッシュ・量）', natRec?.nativeInjected?.entries?.some(e => e.path?.endsWith('AGENTS.md') && e.hash) && natRec.nativeInjected.entries.some(e => e.path?.endsWith('GEMINI.md')),
      JSON.stringify(natRec?.nativeInjected).slice(0, 400));
    // 注入した後に失敗したターンでも記録は残る
    const natFail = await client.runTurn({ prompt: 'fail-inject', sessionId: nat.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 }).catch(() => null);
    const natRecAfterFail = await client.cmd('sessionContext', { sessionId: nat.sessionId });
    t.ok('注入の後に失敗したターンでも記録に残る', Boolean(natRecAfterFail?.nativeInjected?.entries?.length), JSON.stringify(natRecAfterFail?.nativeInjected).slice(0, 200));

    // ---- 前の起動が残した置き場は、次の起動で消す（強制終了では agy の終了を待てないため）
    client.close(); client = null;
    await host.stop(); host = null;
    const stale = path.join(dataDir, 'antigravity', 'context', '999999-deadbeef0000');
    await fs.mkdir(path.join(stale, '.agents'), { recursive: true });
    host = await startServer({ dataDir, timeoutMs: 30_000, env: { AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"` } });
    client = await open({ ...host, autoAllow: true });
    const left = await fs.readdir(path.join(dataDir, 'antigravity', 'context')).catch(() => []);
    t.ok('持ち主の居ない置き場は次の起動で消える', !left.includes('999999-deadbeef0000') && !left.includes(path.basename(home)), JSON.stringify(left));
  } finally {
    client?.close(); await host?.stop();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
