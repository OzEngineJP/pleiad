import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { createDevinBackend } from '../../core/backends/devin.mjs';
import { anchored, sameRows } from '../lib/acp-history.mjs';

export const name = 'server-devin';
export const title = 'Devin: fake ACP でターン・再開・履歴・承認・中断・設定変更の拒否・cwd と native 設定の保持';
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
    t.ok('ライブカタログの無料既定と有料候補を返す', models[''].resolvesTo === 'swe-2-high' && models['paid-exact']);
    const backends = await c.cmd('backends');
    t.ok('未実装機能を表示せず、思考は variant ID で選ぶ', backends[0].capabilities.plyContext === 'turn' && !backends[0].capabilities.accounts && backends[0].capabilities.effortInModelId && backends[0].capabilities.approvals === 'interactive');
    const first = await c.runTurn({ backend: 'devin', cwd, prompt: '[permission] alpha', model: 'swe-2-medium', mode: 'accept-edits' });
    const sid = first.sessionId, loaded = await c.cmd('loadSession', { sessionId: sid });
    t.ok('承認を Pleiad に渡し、本文・思考・ツールの結果を保存する', first.outcome === 'ok' && permissions.length === 1 && loaded.messages.some(m => m.role === 'assistant' && m.thinking && m.toolCalls?.length));
    const sessionAt = first.events.findIndex(e => e.type === 'session'), thinkAt = first.events.findIndex(e => e.type === 'activity' && e.state === 'thinking'), textAt = first.events.findIndex(e => e.type === 'text.delta');
    t.ok('送ってから最初の応答まで稼働表示が出る（送信準備中→考えている）',
      first.events.find(e => e.type === 'activity')?.state === 'preparing' && sessionAt > -1 && thinkAt > sessionAt && thinkAt < textAt);
    const before = structuredClone(loaded.messages);
    const next = await c.runTurn({ sessionId: sid, prompt: 'beta', model: 'swe-2-max', mode: 'ask' });
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

    for (const marker of ['model', 'thought_level', 'speed', 'mode']) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}-drift]`, model: 'swe-2-high' });
      t.ok(`実行中の確認済み設定の変更を拒否する（${marker}）`, turn.outcome === 'error');
    }
    const valid = await c.runTurn({ backend: 'devin', cwd, prompt: '[config-valid]', model: 'swe-2-high' });
    t.ok('完全な同一設定の通知は受け入れる', valid.outcome === 'ok');
    for (const marker of ['config-empty', 'config-invalid', ...['mode', 'model', 'thought_level', 'speed'].flatMap(kind => ['missing', 'duplicate', 'renamed'].map(fault => `${kind}-${fault}`))]) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}]`, model: 'swe-2-high' });
      t.ok(`必須設定の不完全な通知を拒否する（${marker}）`, turn.outcome === 'error' && turn.events.filter(e => e.type === 'turnResult').length === 1);
    }
    const dead = await c.runTurn({ backend: 'devin', cwd, prompt: '[kill]', model: 'swe-2-high' });
    t.ok('CLI の終了を失敗として一度だけ確定する', dead.outcome === 'error' && dead.events.filter(e => e.type === 'turnResult').length === 1);
    const from = c.mark();
    const running = c.runTurn({ backend: 'devin', cwd, prompt: '[slow]', model: 'swe-2-high' });
    const active = await c.waitFor(e => e.type === 'session' && e.first === true, { ms: 10000, from });
    await c.cmd('abort', { sessionId: active.sessionId });
    const stopped = await running;
    t.ok('中断は cancel 通知で完了し turnResult は一度だけ', stopped.outcome === 'aborted' && stopped.events.filter(e => e.type === 'turnResult').length === 1);
    // ---- 途中送信（走っている回へ session/prompt を重ねると、同じ回に折り込まれて届く）
    const sm = c.mark();
    const holding = c.runTurn({ backend: 'devin', cwd, prompt: '[slow] first', model: 'swe-2-high' });
    const steerSession = await c.waitFor(e => e.type === 'session' && e.first === true, { ms: 10000, from: sm });
    await c.cmd('sendMessage', { sessionId: steerSession.sessionId, messageId: 'devin-steer-0001', prompt: 'steer-note' });
    const held = await holding;
    const heldText = held.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const umEvents = c.since(sm);
    t.ok('途中送信が同じ回に折り込まれて答えられ、発言の行が出て turnResult は一度だけ',
      heldText.includes('fixture: steer-note')
      && umEvents.some(e => e.type === 'userMessage' && e.messageId === 'devin-steer-0001')
      && held.events.filter(e => e.type === 'turnResult').length === 1 && held.outcome === 'ok', heldText);
    t.ok('受理した発言は pending で出し、呼び出しの決着で userMessage.delivered が届く',
      umEvents.find(e => e.type === 'userMessage' && e.messageId === 'devin-steer-0001')?.pending === true
      && umEvents.some(e => e.type === 'userMessage.delivered' && e.messageId === 'devin-steer-0001'), JSON.stringify(umEvents.filter(e => e.messageId === 'devin-steer-0001')));
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

    const catalogue = async () => ({ families: [{ family_uid: 'swe-2', variants: [{ model_uid: 'swe-2-high', cost_tier: 'Free' }] }] });
    const command = () => [process.execPath, path.join(ROOT, 'tests/lib/fake-devin.mjs')];
    const deliveryCalls = [];
    class DeliveryClient extends DevinAcp {
      async call(method, params, options) { deliveryCalls.push({ method, params }); return super.call(method, params, options); }
    }
    const deliveryBackend = createDevinBackend({ Acp: DeliveryClient, catalogue, command, dataDir: path.join(root, 'delivery') });
    const shellRuntime = { url: 'http://127.0.0.1:1/shell', headers: { Authorization: 'Bearer fixture-shell' }, instructions: 'fixture-shell-instructions' };
    const deliveredShell = await deliveryBackend.runTurn({ cwd, prompt: 'shell first', model: 'swe-2-high', mode: 'ask', shellRuntime, emit: () => {} });
    await deliveryBackend.runTurn({ cwd, sessionId: deliveredShell.sessionId, prompt: 'shell next', model: 'swe-2-high', mode: 'ask', shellRuntime, emit: () => {} });
    t.ok('新規・再開の両方に認証付きply_shellとその指示を渡す',
      deliveryCalls.filter(c => ['session/new', 'session/load'].includes(c.method)).every(c => c.params.mcpServers.some(s => s.name === 'ply_shell' && s.type === 'http' && s.headers[0].value === 'Bearer fixture-shell'))
      && deliveryCalls.filter(c => c.method === 'session/prompt').every(c => c.params.prompt[0].text.includes('fixture-shell-instructions')));
    t.ok('Devinでも入力欄の!とPleiadシェルが使える', deliveryBackend.capabilities.shell === 'host' && deliveryBackend.capabilities.plyShell);
    const deliveryMark = deliveryCalls.length;
    await deliveryBackend.runTurn({ cwd, prompt: 'no shell', model: 'swe-2-high', mode: 'ask', emit: () => {} });
    t.ok('別のターンにply_shellを持ち越さない', deliveryCalls.slice(deliveryMark).find(c => c.method === 'session/new').params.mcpServers.length === 0);

    let alwaysAnswer, canAlways;
    class AlwaysClient extends DevinAcp {
      constructor(options) { super({ ...options, onRequest: async (method, params, context) => {
        if (method === 'session/request_permission') params.options.push({ kind: 'allow_always', optionId: 'persistent', name: 'For this session' });
        const answer = await options.onRequest(method, params, context);
        if (method === 'session/request_permission') alwaysAnswer = answer;
        return answer;
      } }); }
    }
    const alwaysBackend = createDevinBackend({ Acp: AlwaysClient, catalogue, command, dataDir: path.join(root, 'always') });
    await alwaysBackend.runTurn({ cwd, prompt: '[permission]', model: 'swe-2-high', mode: 'ask', emit: () => {},
      askPermission: async request => { canAlways = request.canAlways; return { allow: true, always: true }; } });
    t.ok('Devin: CLIが提示した恒常許可を画面の回答へ対応させる', canAlways && alwaysAnswer.outcome.optionId === 'persistent');

    class CloseFailure extends DevinAcp { async close() { await super.close(); throw new Error('fixture close failed'); } }
    const events = [];
    const backend = createDevinBackend({ Acp: CloseFailure, catalogue, command, dataDir: path.join(root, 'close-data') });
    await assert.rejects(backend.runTurn({ cwd, prompt: 'done', model: 'swe-2-high', emit: e => events.push(e) }), /fixture close failed/);
    t.ok('close の失敗を成功にせず、一度だけ失敗として返す', events.filter(e => e.type === 'turnResult').length === 1 && events.find(e => e.type === 'turnResult').outcome === 'error' && events.find(e => e.type === 'turnResult').error.includes('fixture close failed'));
    t.ok('使用量の取得日時は不明を明示する', (await backend.usage()).checkedAt === null);

    const bounded = createDevinBackend({ catalogue, command, dataDir: path.join(root, 'bounded-data'), cancelGraceMs: 100 });
    const signal = new AbortController(), cancelled = [], started = Date.now();
    await bounded.runTurn({ cwd, prompt: '[stubborn]', model: 'swe-2-high', signal, emit: e => cancelled.push(e), onPromptDelivered: () => setTimeout(() => signal.abort(), 50) });
    t.ok('cancel に応じない CLI も期限内に終了する', Date.now() - started < 5000 && cancelled.filter(e => e.type === 'turnResult').length === 1 && cancelled.find(e => e.type === 'turnResult').outcome === 'aborted');

    for (const drift of ['after-mode', 'after-config-mode', 'after-model', 'before-mode', 'after-empty', 'after-duplicate', 'before-recovered', 'after-recovered']) {
      class SetupDrift extends DevinAcp { constructor(options) { super({ ...options, env: { ...options.env, FAKE_DEVIN_SETUP_DRIFT: drift } }); } }
      const dataDir = path.join(root, drift), updates = [];
      const guarded = createDevinBackend({ Acp: SetupDrift, catalogue, command, dataDir });
      let delivered = false;
      const turn = guarded.runTurn({ cwd, prompt: 'must use ask and SWE-2 High', model: 'swe-2-high', mode: 'ask', emit: event => updates.push(event), onPromptDelivered: () => { delivered = true; } });
      const recovered = drift.endsWith('recovered');
      if (recovered) await turn; else await assert.rejects(turn);
      const nativeDir = path.join(dataDir, 'devin', 'sessions');
      const [file] = (await fs.readdir(nativeDir)).filter(name => name.endsWith('.json'));
      const saved = JSON.parse(await fs.readFile(path.join(nativeDir, file), 'utf8'));
      t.ok(`最終 ACK 前後の同一 batch の最新設定で prompt の送信を判断する（${drift}）`,
        delivered === recovered && updates.find(event => event.type === 'turnResult').outcome === (recovered ? 'ok' : 'error') && saved.messages.filter(message => message.role === 'user').length === (recovered ? 1 : 0));
    }
    for (const kind of ['permission-id-only', 'permission-partial', 'permission-null', 'permission-unknown']) {
      const requests = [], decisions = [];
      class PermissionClient extends DevinAcp {
        constructor(options) {
          super({ ...options, onResponse: response => { options.onResponse(response); if (response.method === 'session/prompt') decisions.push(response.result.permissionResult); } });
        }
      }
      const permissionBackend = createDevinBackend({ Acp: PermissionClient, catalogue, command, dataDir: path.join(root, kind) });
      await permissionBackend.runTurn({ cwd, prompt: `[${kind}]`, model: 'swe-2-high', emit() {}, askPermission: request => { requests.push(request); return { allow: false }; } });
      assert.deepEqual(decisions, [{ outcome: { outcome: 'selected', optionId: 'reject_once' } }]);
      if (kind === 'permission-unknown') assert.equal(requests.length, 0);
      else {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].toolName, kind === 'permission-partial' ? 'Updated permission' : 'Fixture permission');
        assert.deepEqual(requests[0].input, { command: 'echo fixture' });
      }
      t.ok(`承認要求は既知の詳細を非 null patch と統合し、不明操作は拒否する（${kind}）`, true);
    }

    for (const stop of ['max-tokens', 'max-turn-requests']) {
      const stopped = await c.runTurn({ backend: 'devin', cwd, prompt: `[${stop}]`, model: 'swe-2-high' });
      const result = stopped.events.find(e => e.type === 'turnResult');
      t.ok(`${stop} の上限はエラーや解除時刻を足さず limited のまま`, stopped.outcome === 'limited' && !result.error && result.resetsAt === null);
    }
    class BeforePromptLimit extends DevinAcp {
      call(method, ...args) {
        if (method === 'session/new') return Promise.reject(Object.assign(new Error('fixture rate limit'), { acpLimit: { resetsAt: Date.now() + 5000 } }));
        return super.call(method, ...args);
      }
    }
    let deliveredBeforeLimit = false;
    const beforeEvents = [];
    const beforeBackend = createDevinBackend({ Acp: BeforePromptLimit, catalogue, command, dataDir: path.join(root, 'before-limit') });
    await assert.rejects(beforeBackend.runTurn({ cwd, prompt: 'not delivered', model: 'swe-2-high', emit: e => beforeEvents.push(e), onPromptDelivered: () => { deliveredBeforeLimit = true; } }), e => e.undelivered === true);
    t.ok('送信前の上限は未配送の失敗であり、送信済みや limited に変えない', !deliveredBeforeLimit && beforeEvents.find(e => e.type === 'turnResult')?.outcome === 'error');

    await c.cmd('setDelegationRouting', { settings: { tiers: { t3: ['devin:swe-2-high'] } } });
    await c.cmd('delegationRouting', { refresh: true });
    const limitBefore = Date.now();
    const limitTurn = await c.runTurn({ backend: 'devin', cwd, prompt: '[rate-limit] pause', model: 'swe-2-high' });
    const limitResult = limitTurn.events.find(e => e.type === 'turnResult');
    t.ok('provider の一時的な rate limit は有限の解除時刻つき limited になる',
      limitTurn.outcome === 'limited' && Number.isFinite(limitResult?.resetsAt) && limitResult.resetsAt >= limitBefore + 5000 && limitResult.resetsAt <= Date.now() + 5000,
      JSON.stringify(limitResult));
    const routeState = await c.cmd('delegationRouting');
    const heldCandidate = routeState.candidates.find(x => x.candidate === 'devin:swe-2-high');
    // 戻す時刻は告げられた見込み以上で、短い見込み（5 秒）でも最低 1 分は外す（core/slot-limits.mjs）
    const heldUntil = Date.parse(heldCandidate?.until);
    t.ok('制限中の同じモデルを自動選択の候補から外し、戻す時刻を示す（短い見込みでも最低 1 分）', heldCandidate?.reason === 'recently_limited' && heldUntil >= limitResult.resetsAt && heldUntil >= limitBefore + 60_000, JSON.stringify(heldCandidate));
    const followFrom = c.mark(), followId = 'devin-limit-followup';
    await c.cmd('sendMessage', { sessionId: limitTurn.sessionId, messageId: followId, prompt: 'after cooldown' });
    const queued = (await c.cmd('listMessages', { sessionId: limitTurn.sessionId })).find(x => x.id === followId);
    t.ok('解除前の次の指示を API に渡さず送信待ちへ保持する', queued?.waiting?.reason === 'limit', JSON.stringify(queued));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === limitTurn.sessionId && e.outcome === 'ok', { from: followFrom, ms: 15000 });
    const recovered = await c.cmd('loadSession', { sessionId: limitTurn.sessionId });
    const userTexts = recovered.messages.filter(x => x.role === 'user').map(x => x.text);
    t.ok('解除後に次の指示だけを一度送り、失敗した最初の指示は送り直さない', userTexts.filter(x => x === 'after cooldown').length === 1 && userTexts.filter(x => x.endsWith('[rate-limit] pause')).length === 1 && userTexts.length === 2, JSON.stringify(userTexts.map(x => x.slice(-40))));
    const recoveredRouting = await c.cmd('delegationRouting');
    t.ok('解除後は同じモデルの制限による除外を外す', recoveredRouting.candidates.find(x => x.candidate === 'devin:swe-2-high')?.reason !== 'recently_limited');

    // ---- 委譲の子が「N minutes」の上限で止まった（Issue #111）。日次・週次は 0% のままでも、通知・使用量・自動の振り分けに止まった枠が出る
    const pc = await open({ port: server.port, token: server.token, autoAllow: true });
    try {
      const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
      // 依頼元の会話（fake）から Pleiad の MCP ツールを 1 回呼び、その会話に届いた tool.result を返す
      const callTool = async (name, args) => {
        const from = pc.mark();
        const turn = await pc.runTurn({ backend: 'fake', cwd, prompt: ply(name, args) });
        return pc.waitFor(e => e.type === 'tool.result' && e.sessionId === turn.sessionId, { from, ms: 60000 });
      };
      const childFrom = Date.now();
      const pinned = await callTool('ply_delegate', { kind: 'implement', backend: 'devin', model: 'swe-2-high', task: '[rate-limit-minutes] child' });
      const taskId = JSON.parse(pinned.text).taskId;
      let row;
      for (let i = 0; i < 1200 && !(row?.status === 'failed' && row.notification === 'sent'); i++) { row = (await pc.cmd('agentTasks')).find(x => x.taskId === taskId); await sleep(50); }
      const childReset = typeof row?.limit?.resetsAt === 'number' ? row.limit.resetsAt : Date.parse(row?.limit?.resetsAt);
      t.ok('分の形（reset in 3 minutes）の上限も limited になり、委譲の記録に解除の見込みと止まった枠を残す',
        row?.status === 'failed' && childReset >= childFrom + 170_000 && childReset <= Date.now() + 190_000
          && row.limit.backend === 'devin' && row.limit.model === 'swe-2-high', JSON.stringify(row?.limit ?? row));
      const parent = await pc.cmd('loadSession', { sessionId: pinned.sessionId });
      const notice = parent.messages.filter(m => m.internalTaskNotice).map(m => m.text).join('\n');
      t.ok('上限で止まった子の完了通知に、自動の振り分けがいつまでその枠を選ばないかを添える',
        /backend を省いた ply_delegate は、.+まで|ply_delegate without backend will not pick .+ until/.test(notice), notice.slice(0, 600));

      const usage = await pc.cmd('providerUsage', { backend: 'devin' });
      const heldSlot = usage.held?.find(x => x.model === 'swe-2-high');
      t.ok('使用量（providerUsage の held）に止まった枠と戻す時刻を出す',
        heldSlot?.reason === 'recently_limited' && Date.parse(heldSlot.until) >= childReset, JSON.stringify(usage.held));

      await pc.cmd('setDelegationRouting', { settings: { tiers: { t1: ['devin:swe-2-high'], t2: ['devin:swe-2-high'], t3: ['devin:swe-2-high'], t4: ['devin:swe-2-high'] } } });
      await pc.cmd('delegationRouting', { refresh: true });
      const auto = await callTool('ply_delegate', { kind: 'implement', task: 'after the limit' });
      const skipLine = /^- devin:swe-2-high \(t\d\): recently_limited until (\S+)$/m.exec(auto.text ?? '');
      t.ok('backend を省いた ply_delegate は止まった枠を選ばず、飛ばした理由と戻す時刻を返す',
        auto.isError === true && skipLine?.[1] === heldSlot?.until && (await pc.cmd('agentTasks')).filter(x => x.backend === 'devin').length === 1, auto.text?.slice(0, 600));
    } finally { pc.close(); }
  } finally { c?.close(); await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
