import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { open } from '../lib/ws-client.mjs';
import { anchored, sameRows } from '../lib/acp-history.mjs';

// 実行中の設定の変化の拒否・中断・途中送信・上限は server-devin-config、サーバーを使わない backend の試験は server-devin-backend へ分けた
// （1 本では、重い PC で suite の時間の上限 180 秒を超えたため。判定はそのまま移した）
export const name = 'server-devin';
export const title = 'Devin: fake ACP でターン・再開・履歴・承認・圧縮・文脈・cwd と native 設定の保持・再起動後の復元';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-server-devin-'));
  const cwd = path.join(root, 'project'), other = path.join(root, 'other'), nativeConfig = path.join(root, 'native-config');
  await Promise.all([cwd, other, nativeConfig].map(p => fs.mkdir(p)));
  let server, c;
  const permissions = [];
  try {
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_ROUTING_USAGE: 'on', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open({ port: server.port, token: server.token, onEvent: async (e, self) => { if (e.type === 'permission') { permissions.push(e); await self.cmd('resolvePermission', { id: e.id, allow: false }); } } });
    const models = await c.cmd('models', { backend: 'devin', cwd });
    t.ok('ACP の model の選択肢（既定と他の候補）を返す',models[''].resolvesTo === 'swe-2-high' && models['paid-exact']);
    const backends = await c.cmd('backends');
    t.ok('思考はモデル名ではなく強さの軸で選ぶ（性質 effortInModelId は能力の表に出さない）', !('effortInModelId' in backends[0].capabilities));
    const first = await c.runTurn({ backend: 'devin', cwd, prompt: '[permission] alpha', model: 'swe-2-high', effort: 'medium', mode: 'accept-edits' });
    const sid = first.sessionId, loaded = await c.cmd('loadSession', { sessionId: sid });
    t.ok('承認を Pleiad に渡し、本文・思考・ツールの結果を保存する', first.outcome === 'ok' && permissions.length === 1 && loaded.messages.some(m => m.role === 'assistant' && m.thinking && m.toolCalls?.length));
    const sessionAt = first.events.findIndex(e => e.type === 'session'), thinkAt = first.events.findIndex(e => e.type === 'activity' && e.state === 'thinking'), textAt = first.events.findIndex(e => e.type === 'text.delta');
    t.ok('送ってから最初の応答まで稼働表示が出る（送信準備中→考えている）',
      first.events.find(e => e.type === 'activity')?.state === 'preparing' && sessionAt > -1 && thinkAt > sessionAt && thinkAt < textAt);
    const before = structuredClone(loaded.messages);
    const next = await c.runTurn({ sessionId: sid, prompt: 'beta', model: 'swe-2-high', effort: 'max', mode: 'ask' });
    const nextStates = next.events.filter(e => e.type === 'activity').map(e => e.state);
    t.ok('再開の送信でも同じ順で出す', nextStates[0] === 'preparing' && nextStates.includes('thinking'));
    const after = await c.cmd('loadSession', { sessionId: sid });
    t.ok('再開時の replay を重複させず前の UUID を保つ', next.outcome === 'ok' && after.messages.filter(m => m.role === 'user').length === 2 && before.every((m, i) => after.messages[i].uuid === m.uuid));
    t.ok('ホスト記録の無い会話の text.end の発言の id は、読み直した履歴の行に当たり、記録用の印を出さない',
      anchored(first, loaded.messages) && anchored(next, after.messages) && after.messages.every(m => !('sent' in m) && !('positional' in m) && !('liveUuid' in m)));
    const compactFrom = c.mark();
    const compactResult = await c.cmd('compactConversation', { sessionId: sid });
    const compactDone = await c.waitFor(e => e.type === 'compaction' && e.sessionId === sid && e.phase === 'complete', { from: compactFrom, ms: 20_000 });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from: compactFrom, ms: 20_000 });
    const afterCompact = await c.cmd('loadSession', { sessionId: sid });
    t.ok('/compact を送って手動圧縮が完了し、前後の文脈量と要約を持つ',
      compactResult.status === 'started' && compactDone.trigger === 'manual'
      && compactDone.beforeTokens > compactDone.afterTokens && compactDone.summary === 'fixture summary'
      && afterCompact.compactions?.some(x => x.phase === 'complete')
      && afterCompact.messages.filter(m => m.role === 'user').length === 2, JSON.stringify(compactDone));
    const lastUuid = after.messages.at(-1).uuid;
    t.ok('区切りは圧縮の直前の発言の uuid を持つ（Devin の発言は時刻を持たないので、画面はこのアンカーで区切りを置く）',
      compactDone.afterMessageId === lastUuid
      && afterCompact.compactions.find(x => x.phase === 'complete')?.afterMessageId === lastUuid,
      JSON.stringify({ lastUuid, compactDone, saved: afterCompact.compactions }));
    // transcript（sessions.db の継続ノード）の区切りも読み直しで載り、保存済みの区切りと時刻で突き合わされて手動の印が残る
    t.ok('transcript の継続ノードを区切りとして読む（自動圧縮の形）',
      afterCompact.compactions?.some(x => x.nativeId?.startsWith('node-') && x.trigger === 'manual' && x.summary === 'fixture summary'),
      JSON.stringify(afterCompact.compactions));
    // ---- 圧縮するものが無い（通知も使用量の減少も継続ノードも無い）ときは、完了にせず実態の理由を出す（#104）
    const emptyId = (await c.cmd('newSession', { backend: 'devin', cwd })).sessionId;
    await c.runTurn({ sessionId: emptyId, prompt: '[disable-compact] hi', model: 'swe-2-high' });
    const noopFrom = c.mark();
    await c.cmd('compactConversation', { sessionId: emptyId });
    const noop = await c.waitFor(e => e.type === 'compaction' && e.sessionId === emptyId && e.phase === 'failed', { from: noopFrom, ms: 20_000 });
    t.ok('圧縮するものが無いときは完了にせず実態の理由を出す', noop.reason === '圧縮するものがありませんでした', JSON.stringify(noop));
    // ---- Devin 内部の自動圧縮は _cognition.ai/compaction 通知で区切りに載り、transcript の継続ノードとも突き合わされる（#104）
    const autoId = (await c.cmd('newSession', { backend: 'devin', cwd })).sessionId;
    const autoTurn = await c.runTurn({ sessionId: autoId, prompt: '[auto-compact] work', model: 'swe-2-high' });
    const autoBoundary = autoTurn.events.find(e => e.type === 'compaction' && e.phase === 'complete');
    const autoLoaded = await c.cmd('loadSession', { sessionId: autoId });
    t.ok('自動圧縮の通知が区切りとして届き、継続ノードと突き合わされて要約を持つ',
      autoTurn.outcome === 'ok' && autoBoundary?.trigger === 'auto' && autoBoundary?.summary === 'fixture auto summary'
      && autoLoaded.compactions?.some(x => x.nativeId?.startsWith('node-') && x.summary === 'fixture auto summary'), JSON.stringify({ autoBoundary, compactions: autoLoaded.compactions }));
    const editId = (await c.cmd('newSession', { backend: 'devin', cwd })).sessionId;
    const edit = await c.runTurn({ sessionId: editId, prompt: '[large-edit]', model: 'swe-2-high' });
    const edited = await c.cmd('loadSession', { sessionId: editId });
    const editCall = edited.messages.flatMap(m => m.toolCalls ?? []).find(call => call.name === 'Edit file');
    assert.equal(edit.outcome, 'ok');
    assert.equal(editCall.input.file_path, 'large.mjs');
    assert.ok(editCall.input.oldText.includes('before'));
    assert.ok(JSON.stringify(edited.messages).length < 80000);
    const resumedEdit = await c.runTurn({ sessionId: editId, prompt: 'after large edit', model: 'swe-2-high' });
    assert.equal(resumedEdit.outcome, 'ok');
    t.ok('巨大 Edit を保存し、その再生を通って次のプロンプトを送信できる', true);
    const env = await c.runTurn({ backend: 'devin', cwd: other, prompt: '[env]', model: 'swe-2-high' });
    const text = env.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const observed = JSON.parse(text);
    // 子の process.cwd() は実体のパスを返す（macOS の一時フォルダーは /var → /private/var のリンクを通る）ので、実体のパスで比べる
    t.ok('別 cwd は別プロセスで起動し native 設定の場所を保つ', await fs.realpath(observed.cwd) === await fs.realpath(other) && observed.configHome === nativeConfig,
      JSON.stringify({ cwd: observed.cwd, configHome: observed.configHome, other, nativeConfig }));

    // ---- Devin 自身の MCP を名前で止める（名前ごとのモデルの off。ADR 0336）: 止める名前があるターンだけ、設定の置き場を写しに替える
    {
      const mcpCwd = path.join(root, 'mcp-off-project');
      await fs.mkdir(path.join(mcpCwd, '.git'), { recursive: true });
      await fs.mkdir(path.join(nativeConfig, 'devin'), { recursive: true });
      const nativeMcp = JSON.stringify({ mcpServers: { zz: { command: 'zz' }, keep: { command: 'keep' } } });
      await fs.writeFile(path.join(nativeConfig, 'devin', 'mcp_config.json'), nativeMcp);
      const scanNone = { sources: [], excludePaths: [] };
      const setOff = off => c.cmd('setContextSettings', { cwd: mcpCwd, place: mcpCwd, kind: 'mcp', value: { owner: 'native', user: scanNone, directory: scanNone, agents: { off, spread: {} } } });
      const envOf = async () => JSON.parse((await c.runTurn({ backend: 'devin', cwd: mcpCwd, prompt: '[env]', model: 'swe-2-high' })).events.filter(e => e.type === 'text.delta').map(e => e.text).join(''));
      await setOff({ zz: ['devin'] });
      const offEnv = await envOf();
      const offMcp = JSON.parse(await fs.readFile(path.join(offEnv.configHome, 'devin', 'mcp_config.json'), 'utf8'));
      t.ok('止める名前があるターンは、写しの設定の置き場で起動し、写しの mcp_config.json だけ止める名前に disabled を付ける（本物は書き換えない）',
        offEnv.configHome !== nativeConfig && path.relative(path.join(root, 'data', 'devin', 'mcp-off'), offEnv.configHome).split(path.sep).length === 1
        && offMcp.mcpServers.zz.disabled === true && !offMcp.mcpServers.keep.disabled && await fs.readFile(path.join(nativeConfig, 'devin', 'mcp_config.json'), 'utf8') === nativeMcp,
        JSON.stringify({ configHome: offEnv.configHome, offMcp }));
      await setOff({});
      const onEnv = await envOf();
      t.ok('止める名前が無くなった次のターンは、本物の設定の置き場に戻る（今までと同じ起動）', onEnv.configHome === nativeConfig, onEnv.configHome);
      // Devin の設定に無い名前（Pleiad にだけある名前）を Devin の列で off にしても、写しでは起動しない（ADR 0336 の再レビュー B）
      await setOff({ 'pleiad-only': ['devin'] });
      const otherEnv = await envOf();
      t.ok('Devin の設定に無い名前の off は、本物の設定の置き場のまま起動する（写しを作らない）', otherEnv.configHome === nativeConfig, otherEnv.configHome);
      await setOff({});
      await fs.rm(path.join(nativeConfig, 'devin'), { recursive: true, force: true });
    }
    // ply_control は ACP の mcpServers（type: 'http'）と会話束縛の CLI の env で届く（印 plyControl。ブラウザーは Chrome の層が無い試験では渡らない）
    t.ok('ply_control を mcpServers で渡し、会話束縛の CLI の環境変数が届く', observed.mcpServers?.includes('ply_control') && observed.seenEnv?.includes('PLEIAD_CONTROL_URL') && observed.seenEnv?.includes('PLEIAD_CONTROL_TOKEN'), JSON.stringify({ mcpServers: observed.mcpServers, seenEnv: observed.seenEnv }));

    // ---- Pleiad 担当のコンテキスト（指示・Skills・外部 MCP。issue #102）。ACP には指示の欄が無いので、
    // 指示と Skills の一覧は発言の前に注入文として足し、本文の読み出し（load_skill）と外部 MCP は ply_context の MCP 越しに届く
    const contextCwd = path.join(root, 'context-project');
    await fs.mkdir(path.join(contextCwd, '.git'), { recursive: true });
    await fs.mkdir(path.join(contextCwd, '.claude', 'skills', 'demo'), { recursive: true });
    await fs.writeFile(path.join(contextCwd, 'AGENTS.md'), 'PROJECT-RULE-DEVIN');
    await fs.writeFile(path.join(contextCwd, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill for the devin test\n---\n\nDEMO-SKILL-BODY\n');
    const fixtureMcp = path.join(root, 'fixture-mcp.mjs');
    await fs.writeFile(fixtureMcp, `import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{content:[{type:'text',text:'echo:devin-fixture'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
    await fs.writeFile(path.join(contextCwd, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixtureMcp] } } }));
    const noScan = { sources: [], excludePaths: [] };
    for (const kind of ['instruction', 'skill', 'mcp']) await c.cmd('setContextSettings', { cwd: contextCwd, place: contextCwd, kind, value: { owner: 'ply', user: noScan, directory: { sources: ['common', 'claude'], excludePaths: [] } } });
    const ctxFirst = await c.runTurn({ backend: 'devin', cwd: contextCwd, prompt: 'ctx-check', model: 'swe-2-high' });
    const ctxSent = ctxFirst.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('Pleiad 担当の指示と Skills の一覧を注入文として発言の前に足して送る', ctxFirst.outcome === 'ok' && ctxSent.includes('PROJECT-RULE-DEVIN') && /demo: Demo skill/.test(ctxSent), ctxSent.slice(-400));
    const ctxSession = ctxFirst.sessionId;
    const ctxRecord = await c.cmd('sessionContext', { sessionId: ctxSession });
    t.ok('会話の記録に Pleiad 担当として残る（外部 MCP は接続済み）', ctxRecord?.report?.status === 'ready' && !ctxRecord.report.guardedBackend
      && ctxRecord.report.entries.find(e => e.kind === 'instruction')?.status === 'supplied'
      && ctxRecord.report.entries.find(e => e.kind === 'skill')?.status === 'available'
      && ctxRecord.report.entries.find(e => e.name === 'fixture')?.status === 'connected', JSON.stringify(ctxRecord?.report?.entries?.map(e => [e.name, e.status])));
    // 再開（session/load）でもその回の ply_context を渡し直す。身代わりが口へ実際に問い合わせる
    const toolsTurn = await c.runTurn({ sessionId: ctxSession, prompt: '[context-tools]', model: 'swe-2-high' });
    const toolsText = toolsTurn.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    let toolsListed = []; try { toolsListed = JSON.parse(toolsText); } catch {}
    t.ok('ply_context の口から load_skill・instructions_for_path・外部 MCP のツールが見える', toolsTurn.outcome === 'ok' && Array.isArray(toolsListed)
      && ['load_skill', 'instructions_for_path'].every(n => toolsListed.some(x => x.name === n))
      && toolsListed.some(x => (x.description ?? '').includes('[fixture / echo]')), toolsText.slice(0, 400));
    const mcpTool = toolsListed.find(x => (x.description ?? '').includes('[fixture / echo]'))?.name;
    const echoTurn = await c.runTurn({ sessionId: ctxSession, prompt: `context:{"name":${JSON.stringify(mcpTool)},"arguments":{}}`, model: 'swe-2-high' });
    const echoText = echoTurn.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('外部 MCP のツールを ply_context 越しに呼べる', echoTurn.outcome === 'ok' && echoText === '"echo:devin-fixture"', echoText.slice(0, 200));
    const skillId = ctxRecord.report.entries.find(e => e.kind === 'skill')?.id;
    const skillTurn = await c.runTurn({ sessionId: ctxSession, prompt: `context:{"name":"load_skill","arguments":{"id":${JSON.stringify(skillId)}}}`, model: 'swe-2-high' });
    const skillText = skillTurn.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('Skill の本文を load_skill で読める', skillTurn.outcome === 'ok' && skillText.includes('DEMO-SKILL-BODY'), skillText.slice(0, 200));

    // ---- 圧縮でネイティブが履歴を書き換えた、ホスト記録の会話（指示は発言の前に足して送る）。発言は原文のまま、前の行を上書きも重複もしない
    const compactId = (await c.cmd('newSession', { backend: 'devin', cwd })).sessionId;
    const compactPrompts = ['one', 'two', '[compact-rewrite] three', 'four'], compactTurns = [];
    for (const prompt of compactPrompts.slice(0, 3)) compactTurns.push(await c.runTurn({ sessionId: compactId, prompt, model: 'swe-2-high' }));
    const rewritten = await c.cmd('loadSession', { sessionId: compactId });
    compactTurns.push(await c.runTurn({ sessionId: compactId, prompt: compactPrompts[3], model: 'swe-2-high' }));
    const compacted = await c.cmd('loadSession', { sessionId: compactId });
    const sentFirst = compactTurns[0].events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('指示は発言の前に足してエージェントに送る', sentFirst.startsWith('fixture: ') && sentFirst.endsWith('\n\none') && sentFirst.length > 'fixture: \n\none'.length, sentFirst.slice(0, 120));
    t.ok('圧縮で書き換わった履歴の再生でも、記録の発言は原文のまま 1 回ずつ並び、前の行の uuid と本文を保つ',
      compactTurns.every(turn => turn.outcome === 'ok') && sameRows(compacted.messages, compactPrompts)
      && rewritten.messages.every((m, i) => compacted.messages[i].uuid === m.uuid && compacted.messages[i].text === m.text),
      JSON.stringify(compacted.messages.map(m => [m.uuid, m.role, m.text.slice(0, 40)])));
    t.ok('ホスト記録の会話の text.end の発言の id は、記録の行の uuid に当たる', compactTurns.every(turn => anchored(turn, compacted.messages)));
    // ---- ホスト記録のある会話の圧縮の区切りは、記録の行（接頭辞付き）の uuid を持つ（issue #105）
    const compact2From = c.mark();
    await c.cmd('compactConversation', { sessionId: compactId });
    const compact2Done = await c.waitFor(e => e.type === 'compaction' && e.sessionId === compactId && e.phase === 'complete', { from: compact2From, ms: 20_000 });
    const compact2Last = compacted.messages.at(-1).uuid;
    t.ok('ホスト記録の会話でも区切りのアンカーは描いた発言の uuid に当たる',
      compact2Done.afterMessageId === compact2Last && compact2Last.startsWith('devin:'),
      JSON.stringify({ compact2Last, afterMessageId: compact2Done.afterMessageId }));
    c.close(); c = null;
    await server.stop(); server = null;
    const conversationDir = path.join(root, 'data', 'conversations');
    const saved = await Promise.all((await fs.readdir(conversationDir)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await fs.readFile(path.join(conversationDir, name), 'utf8'))));
    const storedEdit = saved.find(record => record.messages.some(m => m.toolCalls?.some(call => call.id === editCall.id)));
    assert.ok(storedEdit);
    const storedCall = storedEdit.messages.flatMap(m => m.toolCalls ?? []).find(call => call.name === 'Edit file');
    assert.ok(JSON.stringify(storedEdit).length < 80000);
    assert.ok(storedCall.input.oldText.includes('before') && storedCall.input.newText.includes('after'));
    t.ok('保存された会話ファイルにも巨大 diff の全文を残さない', true);
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'devin,fake', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open(server);
    const restored = await c.cmd('loadSession', { sessionId: sid });
    t.ok('サーバー再起動後も共通 DB の cwd でネイティブ履歴を復元する', restored.messages.filter(m => m.role === 'user').length === 2 && after.messages.every((m, i) => restored.messages[i].uuid === m.uuid), JSON.stringify({ before: after.messages.map(m => [m.uuid, m.role]), restored: restored.messages.map(m => [m.uuid, m.role]) }));

    const compactRestored = await c.cmd('loadSession', { sessionId: compactId });
    t.ok('サーバー再起動後も、圧縮で書き換わった会話の発言を原文のまま、同じ uuid で重複なく復元する',
      sameRows(compactRestored.messages, compactPrompts) && compacted.messages.every((m, i) => compactRestored.messages[i].uuid === m.uuid && compactRestored.messages[i].text === m.text),
      JSON.stringify(compactRestored.messages.map(m => [m.uuid, m.role, m.text.slice(0, 40)])));
    const restoredEdit = await c.cmd('loadSession', { sessionId: editId });
    assert.ok(JSON.stringify(restoredEdit.messages).length < 80000);
    assert.ok(restoredEdit.messages.flatMap(m => m.toolCalls ?? []).find(call => call.name === 'Edit file').input.newText.includes('after'));
    t.ok('再起動後も復元するツールの入力は縮小済み', true);
  } finally { c?.close(); await server?.stop(); await cleanupTestHolder(path.join(root, 'data')); await fs.rm(root, { recursive: true, force: true }); }
}
