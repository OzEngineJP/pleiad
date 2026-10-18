// OpenCode のバックエンドの部品: 出来事の写し替え（実機の記録 tests/lib/opencode-events.json）・発言の写し替え・
// 中継の口（core/opencode-relay.mjs。合言葉・会話への振り分け・子の会話・知らない会話は断る・環境変数）・
// OpenCode に読ませるプラグイン（core/backends/opencode-plugin.mjs。v2 の登録 API・会話の環境・指示）
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createTurnMapper, messagesToNormalized, toolName, sessionRow } from '../../core/backends/opencode-normalize.mjs';
import { createOpencodeRelay, SESSION_ARG } from '../../core/opencode-relay.mjs';
import { PLUGIN_SOURCE, writePlugin } from '../../core/backends/opencode-plugin.mjs';
import { checkBackendEvent } from '../../core/backends/contract.mjs';
import { scanContext, opencodeServers } from '../../core/context-scan.mjs';

export const name = 'opencode-parts';
export const title = 'OpenCode の部品: 実機の出来事の写し替え・発言の写し替え・中継の口・プラグイン';

function fakeReq({ method = 'POST', headers = {}, body = null }) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return { method, headers, async *[Symbol.asyncIterator]() { yield* chunks; } };
}
function fakeRes() {
  const r = { status: 0, body: '' };
  r.writeHead = (status) => { r.status = status; return r; };
  r.end = (text) => { r.body = text ?? ''; };
  r.json = () => (r.body ? JSON.parse(r.body) : null);
  return r;
}

export default async function (t) {
  // ---- 実機の出来事の列を写す
  const { events } = JSON.parse(fs.readFileSync(new URL('../lib/opencode-events.json', import.meta.url), 'utf8'));
  const sid = events[0].properties.sessionID;
  const out = [];
  const users = [];
  const mapper = createTurnMapper({ sessionId: sid, emit: (e) => out.push(e), onUserMessage: (u) => users.push(u), windowTokens: () => 200_000 });
  let ended = false;
  for (const ev of events) ended = mapper.handle(ev) || ended;
  const text = out.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
  const start = out.find((e) => e.type === 'tool.start');
  const result = out.find((e) => e.type === 'tool.result');
  t.ok('実機: session.idle でターンの終わり', ended && mapper.idle);
  t.ok('実機: 本文は差分のつなぎで、返答の本文になる', text === 'hello-probe', JSON.stringify(text));
  t.ok('実機: 考え・ツールの始まり（入力つき）・結果・使用量・文脈の量', out.some((e) => e.type === 'thinking.delta')
    && start?.name === 'bash' && start.input?.command === 'echo hello-probe' && result?.text === 'hello-probe\n' && result.isError === false
    && out.some((e) => e.type === 'usage' && e.inputTokens > 0) && out.some((e) => e.type === 'contextWindow' && e.windowTokens === 200_000), JSON.stringify(out.map((e) => e.type)));
  t.ok('実機: ツールの始まりと結果は 1 回ずつ（running の更新が何度来ても）', out.filter((e) => e.type === 'tool.start').length === 1 && out.filter((e) => e.type === 'tool.result').length === 1);
  t.ok('実機: 自分の発言が会話に入った合図を拾う', users.some((u) => u.text.startsWith('Use the bash tool')));
  t.ok('実機: 出したイベントはどれも契約どおり', out.every((e) => checkBackendEvent(e) === null), out.map((e) => checkBackendEvent(e)).filter(Boolean).join(' / '));
  t.ok('実機: text.end は発言の id を持つ', out.some((e) => e.type === 'text.end' && typeof e.uuid === 'string' && e.uuid.startsWith('msg_')));

  const errOut = [];
  const failing = createTurnMapper({ sessionId: 's', emit: (e) => errOut.push(e) });
  failing.handle({ type: 'session.error', properties: { sessionID: 's', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } });
  t.ok('中断のエラーは aborted として覚える', failing.error?.aborted === true && failing.error.message === 'Aborted');
  failing.handle({ type: 'session.error', properties: { sessionID: 's', error: { name: 'ProviderAuthError', data: { message: 'no key' } } } });
  t.ok('ログインのエラーは auth として覚える', failing.error?.auth === true);

  // ---- 名前と発言の写し替え
  t.ok('Pleiad の MCP のツールの名前は mcp__<サーバー>__<ツール> にそろえ、ほかはそのまま', toolName('ply_computer_screenshot') === 'mcp__ply_computer__screenshot'
    && toolName('ply_agents_ply_delegate') === 'mcp__ply_agents__ply_delegate' && toolName('bash') === 'bash' && toolName('pencil_draw') === 'pencil_draw');
  const msgs = messagesToNormalized([
    { info: { id: 'msg_u1', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'hi' }] },
    { info: { id: 'msg_a1', role: 'assistant', time: { created: 2000 } }, parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'x'.repeat(5000) } }, { type: 'text', text: 'done' }] },
    { info: { id: 'msg_u2', role: 'user', time: { created: 3000 } }, parts: [{ type: 'compaction', auto: false }] },
    { info: { id: 'msg_a2', role: 'assistant', summary: true, time: { created: 4000 } }, parts: [{ type: 'text', text: '## Summary' }] },
    { info: { id: 'msg_u3', role: 'user', time: { created: 5000 } }, parts: [{ type: 'text', text: 'The following tool was executed by the user', synthetic: true }] },
  ]);
  t.ok('履歴: 発言・考え・ツール（2000 字で切る）・圧縮の区切り。圧縮の印と本文の無い発言は落とす', msgs.length === 3
    && msgs[0].text === 'hi' && msgs[0].uuid === 'msg_u1' && msgs[0].at === new Date(1000).toISOString()
    && msgs[1].thinking === 'hmm' && msgs[1].toolCalls[0].name === 'bash' && msgs[1].toolCalls[0].result.truncated === true && msgs[1].toolCalls[0].result.text.length < 2100
    && msgs[2].kind === 'compactSummary' && msgs[2].summary === '## Summary', JSON.stringify(msgs));
  t.ok('履歴: fullResults なら切らない', messagesToNormalized([{ info: { id: 'm', role: 'assistant', time: {} }, parts: [{ type: 'tool', tool: 'bash', callID: 'c', state: { status: 'completed', input: {}, output: 'y'.repeat(5000) } }] }], { fullResults: true })[0].toolCalls[0].result.text.length === 5000);
  const r = sessionRow({ id: 'ses_1', title: 't', directory: 'C:\\w', time: { created: 1000, updated: 2000 } });
  t.ok('会話の行: 作成は ISO、更新はミリ秒、状態タグは無い', r.createdAt === new Date(1000).toISOString() && r.lastModified === 2000 && r.cwd === 'C:\\w' && r.tag === null);

  // ---- 中継の口
  const forwarded = [];
  const relay = createOpencodeRelay({ secret: 's3cret', fetchImpl: async (url, init) => {
    forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const body = JSON.parse(init.body);
    return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [{ name: 'ply_delegate' }] } : { content: [{ type: 'text', text: `from ${url}` }] } }) };
  } });
  relay.setOrigin('http://127.0.0.1:9');
  const url = (p) => new URL(`http://127.0.0.1:9/mcp/opencode/${p}`);
  const call = async (p, body, auth = 'Bearer '+relay.token(), method = 'POST') => { const res = fakeRes(); await relay.handle(fakeReq({ method, headers: { authorization: auth }, body }), res, url(p)); return res; };
  t.ok('中継: 合言葉が違えば 401', (await call('ply_agents', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')).status === 401);
  t.ok('中継: まだ会話が無ければツールの一覧は空', (await call('ply_agents', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools.length === 0);
  relay.bind('ses_A', { runtimes: { agentRuntime: { url: 'http://pleiad/mcp/agents', headers: { Authorization: 'Bearer A' } } }, env: { PLEIAD_CONTROL_URL: 'http://x' } });
  relay.bind('ses_B', { runtimes: { agentRuntime: { url: 'http://pleiad/mcp/agents', headers: { Authorization: 'Bearer B' } } } });
  relay.alias('ses_child', 'ses_A');
  const listed = (await call('ply_agents', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  t.ok('中継: 一覧は結び付けた口に聞く', listed.result.tools[0].name === 'ply_delegate');
  forwarded.length = 0;
  await call('ply_agents', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ply_task_list', _meta: { 'ai.opencode/sessionID': 'ses_A' }, arguments: { x: 1 } } });
  await call('ply_agents', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ply_task_list', _meta: { 'ai.opencode/sessionID': 'ses_B' }, arguments: {  } } });
  await call('ply_agents', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ply_task_list', _meta: { 'ai.opencode/sessionID': 'ses_child' }, arguments: {  } } });
  t.ok('中継: 会話の id でその会話の口（トークン）へ振り分け、会話の id の引数は外す', forwarded.map((f) => f.headers.Authorization).join() === 'Bearer A,Bearer B,Bearer A'
    && forwarded[0].body.params.arguments.x === 1 && !(SESSION_ARG in forwarded[0].body.params.arguments), JSON.stringify(forwarded.map((f) => [f.headers.Authorization, f.body.params])));
  const stray = (await call('ply_agents', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ply_task_list', _meta: { 'ai.opencode/sessionID': 'ses_unknown' }, arguments: {  } } })).json();
  t.ok('中継: 結び付いていない会話は断る（ほかの会話の口を使わせない）', stray.result.isError === true && forwarded.length === 3);
  const noBrowser = (await call('ply_browser', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'open', _meta: { 'ai.opencode/sessionID': 'ses_A' }, arguments: {  } } })).json();
  t.ok('中継: その会話に無い口（ブラウザー）は断る', noBrowser.result.isError === true);
  const envRes = await call('env?session=ses_A', null, 'Bearer s3cret', 'GET');
  const res = fakeRes();
  await relay.handle(fakeReq({ method: 'GET', headers: { authorization: 'Bearer '+relay.token() } }), res, new URL('http://127.0.0.1:9/mcp/opencode/env?session=ses_child'));
  t.ok('中継: 会話のシェルの環境変数（子の会話は親の分）', envRes.status !== 0 && JSON.parse(res.body).PLEIAD_CONTROL_URL === 'http://x');
  t.ok('中継: 知らないサーバー名は 404', (await call('nope', { jsonrpc: '2.0', id: 8, method: 'tools/list' })).status === 404);
  let refreshed=false;
  relay.bind('ses_refresh',{context:async(id,options)=>{refreshed=id==='ses_refresh'&&options.fresh;return{omitTexts:['new native instruction']};}});
  const freshContext=(await call('env?session=ses_refresh&kind=context&fresh=1',null,'Bearer '+relay.token(),'GET')).json();
  t.ok('送信直前の context は履歴のキャッシュを更新する',refreshed&&freshContext.omitTexts[0]==='new native instruction');
  const environments=[];
  relay.bind('ses_A',{env:{value:'new'},prepareChild:async id=>environments.push(id)});
  await Promise.all([call('env?session=ses_child',null,'Bearer '+relay.token(),'GET'),call('env?session=ses_child',null,'Bearer '+relay.token(),'GET')]);
  relay.bind('ses_A',{env:{value:'revoked'},prepareChild:async id=>environments.push(id)});
  await call('env?session=ses_child',null,'Bearer '+relay.token(),'GET');
  t.ok('中継: 前のターンの子も bind ごとに環境を設定し直し、並行する呼び出しは一度にまとめる',environments.join() === 'ses_child,ses_child');

  // ---- 無停止の更新: 前のサーバーの合言葉を引き継ぐ・付け直す会話は結び付けるまで呼び出しを待たせる
  const previous = 'p'.repeat(48);
  relay.adoptSecret('short');
  t.ok('中継: 短すぎる合言葉は引き継がない', (await call('ply_agents', { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status === 200);
  relay.adoptSecret(previous);
  t.ok('中継: 引き継いだ合言葉で通り、前の値は 401', (await call('ply_agents', { jsonrpc: '2.0', id: 10, method: 'tools/list' }, `Bearer ${relay.token()}`)).status === 200
    && (await call('ply_agents', { jsonrpc: '2.0', id: 11, method: 'tools/list' },'Bearer stale')).status === 401 && relay.secret === previous);
  relay.expect(['ses_W', 'ses_X'], { ses_Wc: 'ses_W' });
  forwarded.length = 0;
  const waiting = call('ply_agents', { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'ply_task_list', _meta: { 'ai.opencode/sessionID': 'ses_Wc' }, arguments: {  } } }, `Bearer ${relay.token()}`);
  await new Promise((r) => setTimeout(r, 30));
  t.ok('中継: 付け直す会話（の子）の呼び出しは、結び付けるまで待つ', forwarded.length === 0);
  relay.bind('ses_W', { runtimes: { agentRuntime: { url: 'http://pleiad/mcp/agents', headers: { Authorization: 'Bearer W' } } } });
  await waiting;
  t.ok('中継: 結び付けたら、その会話の口へ届く', forwarded.map((f) => f.headers.Authorization).join() === 'Bearer W');
  const dropped = call('ply_agents', { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'ply_task_list', _meta: { 'ai.opencode/sessionID': 'ses_X' }, arguments: {  } } }, `Bearer ${relay.token()}`);
  relay.unexpect('ses_X');
  t.ok('中継: 付け直さなかった会話の待ちは外れて断る', (await dropped).json().result.isError === true);

  // ---- 無停止の更新: 取り直した発言の後、途中の本文は次の部品の更新まで差分を読まない（溜めた差分と重ならない）
  {
    const got = [];
    const m = createTurnMapper({ sessionId: 'ses_R', emit: (e) => got.push(e) });
    const part = (extra) => ({ type: 'message.part.updated', properties: { part: { id: 'prt_t', messageID: 'msg_a', sessionID: 'ses_R', type: 'text', ...extra } } });
    const delta = (id, d) => ({ type: 'message.part.delta', properties: { sessionID: 'ses_R', messageID: 'msg_a', partID: id, field: 'text', delta: d } });
    m.handle({ type: 'message.updated', properties: { info: { id: 'msg_a', role: 'assistant', sessionID: 'ses_R' } } });
    m.handle(part({ text: 'hello wor', time: { start: 1 } }));   // 取り直した今の本文
    m.resync();
    m.handle(delta('prt_t', 'wor'));                              // 取り直しの前に溜まっていた差分（本文に入っている）
    m.handle(part({ text: 'hello', time: { start: 1 } }));        // 溜まっていた古い更新
    m.handle(delta('prt_t', 'ld'));                               // 取り直しの後の差分（終わりの更新が全文で埋める）
    m.handle(part({ text: 'hello world', time: { start: 1, end: 2 } }));
    m.handle({ type: 'message.part.updated', properties: { part: { id: 'prt_n', messageID: 'msg_a', sessionID: 'ses_R', type: 'text', text: '', time: { start: 3 } } } });
    m.handle(delta('prt_n', '!'));
    const streamed = got.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
    t.ok('付け直し: 途中の本文は欠けも重なりもなく、後から始まった部品の差分は普通に流れる', streamed === 'hello world!' && got.filter((e) => e.type === 'text.end').length === 1, JSON.stringify(got));
  }

  // ---- コンテキストの読み込み元（OpenCode が自分で読む指示・Skills・MCP）
  const cx = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-oc-context-'));
  try {
    const home = path.join(cx, 'home'), opencodeHome = path.join(home, '.config', 'opencode'), repo = path.join(cx, 'repo');
    const skill = (dir, name) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---
name: ${name}
description: about ${name}
---
body`); };
    fs.mkdirSync(opencodeHome, { recursive: true });
    fs.writeFileSync(path.join(opencodeHome, 'AGENTS.md'), '# global rules');
    skill(path.join(opencodeHome, 'skills'), 'global-skill');
    fs.writeFileSync(path.join(opencodeHome, 'opencode.json'), JSON.stringify({ mcp: { local1: { type: 'local', command: ['node', 'x.js'], environment: { A: '1' } }, remote1: { type: 'remote', url: 'https://example.com/mcp', enabled: false } } }));
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# project rules');
    skill(path.join(repo, '.opencode', 'skills'), 'project-skill');
    fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ mcp: { proj: { type: 'local', command: ['npx', 'y'] } } }));
    const oc = { sources: ['common', 'opencode'], kinds: ['instruction', 'skill', 'mcp'], excludePaths: [] };
    const scan = await scanContext({ cwd: repo, user: oc, directory: oc }, { home, opencodeHome });
    const of = (kind) => scan.entries.filter((e) => e.kind === kind);
    t.ok('読み込み元 opencode: 設定の置き場と作業場所の AGENTS.md', of('instruction').filter((e) => e.name === 'AGENTS.md').map((e) => e.scope).sort().join() === 'directory,user', JSON.stringify(of('instruction').map((e) => [e.name, e.scope, e.path])));
    t.ok('読み込み元 opencode: 設定の置き場と .opencode の skills', ['global-skill', 'project-skill'].every((n) => of('skill').some((e) => e.name === n)), JSON.stringify(of('skill').map((e) => e.name)));
    const mcp = Object.fromEntries(of('mcp').map((e) => [e.name, e]));
    t.ok('読み込み元 opencode: opencode.json の mcp を Claude の形に写して並べる（切ったものは disabled）', mcp.local1?.transport === 'stdio' && mcp.local1.command === 'node' && mcp.local1.args?.join() === 'x.js'
      && mcp.local1.envKeys?.join() === 'A' && mcp.remote1?.transport === 'http' && mcp.remote1.status === 'disabled' && mcp.proj?.command === 'npx', JSON.stringify(of('mcp')));
    t.ok('形の写し: remote は http、local は command と args、置き換えられないものはそのまま', JSON.stringify(opencodeServers({ r: { type: 'remote', url: 'u', headers: { h: '1' } } })) === JSON.stringify({ r: { type: 'http', url: 'u', headers: { h: '1' } } })
      && opencodeServers(null) === null && opencodeServers([]).length === 0);
  } finally { fs.rmSync(cx, { recursive: true, force: true }); }

  // The package and callbacks below use the v2 plugin registration contract.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-oc-plugin-'));
  try {
    const href=writePlugin(dir),entry=path.join(dir,'opencode','pleiad-plugin-v2','index.js');
    t.ok('v2 plugin package has a module entry',fs.readFileSync(entry,'utf8')===PLUGIN_SOURCE && JSON.parse(fs.readFileSync(path.join(path.dirname(entry),'package.json'),'utf8')).type==='module');
    const seen=[];let unavailable=false;
    const endpoint=http.createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=raw?JSON.parse(raw):null;seen.push({url:req.url,body,auth:req.headers.authorization});
      if(unavailable){res.writeHead(403);res.end('{}');return;}
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(body?.phase==='before'?{args:{command:'rewritten'}}:body?.phase==='after'?{append:'checked'}:{system:'Pleiad instructions',omitMessageIDs:['native_instruction'],omitTexts:['AGENTS_ONLY']}));
    });
    await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
    process.env.PLEIAD_OPENCODE_ENV_URL='http://127.0.0.1:'+endpoint.address().port+'/env';
    process.env.PLEIAD_OPENCODE_HOOK_URL='http://127.0.0.1:'+endpoint.address().port+'/hook';
    process.env.PLEIAD_OPENCODE_SECRET='plug';
    process.env.PLEIAD_OPENCODE_INSTRUCTION_OWNER='ply';
    try {
      const callbacks=new Map();
      const domain={hook:async(name,fn)=>{callbacks.set(name,fn);return{dispose:async()=>{}};}};
      const mod=await import(pathToFileURL(entry).href+'?v2');
      await mod.default.setup({tool:domain,session:domain,shell:domain});
      const before={sessionID:'ses_X',tool:'shell',input:{command:'original'}};
      await callbacks.get('execute.before')(before);
      t.ok('v2 tool hook replaces input without an identity argument',before.input.command==='rewritten'&&!('_pleiadSession' in before.input));
      const after={...before,status:'completed',result:{content:[{type:'text',text:'out'}]}};
      await callbacks.get('execute.after')(after);
      t.ok('v2 completed result receives post-tool context',after.result.content[1]?.text==='checked');
      for(const kind of ['context','compaction','title','generate']){
        const event={sessionID:'ses_X',system:[],messages:[{id:'native_instruction',content:[{type:'text',text:'AGENTS_ONLY'}]},{id:'checkpoint',content:[{type:'text',text:'<conversation-checkpoint>\n[Synthetic context]: AGENTS_ONLY\nKeep user text\n</conversation-checkpoint>'}]}]};await callbacks.get(kind)(event);
        t.ok('v2 '+kind+' receives conversation instructions',event.system[0]?.text==='Pleiad instructions');
        t.ok('v2 '+kind+' omits native instructions from live and compacted context',event.messages.length===1 && !event.messages[0].content[0].text.includes('AGENTS_ONLY') && event.messages[0].content[0].text.includes('Keep user text'));
      }
      const request={sessionID:'ses_X',request:new Request('http://127.0.0.1/provider',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{content:'[Synthetic context]: AGENTS_ONLY\nKeep user text'}]})})};
      await callbacks.get('http.request')(request);
      const sanitized=await request.request.json();
      const frame={sessionID:'ses_X',frame:JSON.stringify({input:[{text:'[Synthetic context]: AGENTS_ONLY\nKeep user text'}]})};
      await callbacks.get('experimental.ws.send')(frame);
      t.ok('v2 provider requests omit instructions reinserted by compaction fallback, over HTTP and WebSocket',!JSON.stringify(sanitized).includes('AGENTS_ONLY') && !frame.frame.includes('AGENTS_ONLY') && frame.frame.includes('Keep user text'));
      assert(seen.slice(-2).every(call=>new URL('http://127.0.0.1'+call.url).searchParams.get('fresh')==='1'));
      for(const [encoding,encode,decode] of [['gzip',zlib.gzipSync,zlib.gunzipSync],['br',zlib.brotliCompressSync,zlib.brotliDecompressSync],['deflate',zlib.deflateSync,zlib.inflateSync],...(zlib.zstdCompressSync?[['zstd',zlib.zstdCompressSync,zlib.zstdDecompressSync]]:[])]) {
        const compressed={sessionID:'ses_X',request:new Request('http://127.0.0.1/provider',{method:'POST',headers:{'content-type':'application/json','content-encoding':encoding},body:encode(Buffer.from(JSON.stringify({input:'[Synthetic context]: AGENTS_ONLY\nKeep user text'})))})};
        await callbacks.get('http.request')(compressed);
        const text=decode(Buffer.from(await compressed.request.arrayBuffer())).toString();
        t.ok('v2 '+encoding+' body preserves encoding while excluding instructions',!text.includes('AGENTS_ONLY')&&text.includes('Keep user text')&&compressed.request.headers.get('content-encoding')===encoding);
      }
      const signed={sessionID:'ses_X',request:new Request('http://127.0.0.1/provider',{method:'POST',headers:{'content-type':'application/json',authorization:'AWS4-HMAC-SHA256 fixture'},body:JSON.stringify({input:'[Synthetic context]: AGENTS_ONLY'})})};
      await callbacks.get('http.request')(signed);
      t.ok('v2 signed requests needing exclusion return a local error without forwarding credentials or original body',signed.request.url.endsWith('/blocked?account=login&session=ses_X') && signed.request.headers.get('authorization')==='Bearer plug' && !await signed.request.text());
      t.ok('v2 plugin authenticates and scopes the conversation',seen.every(x=>x.auth==='Bearer plug'&&x.url.includes('account=login')&&x.url.includes('session=ses_X')));
      unavailable=true;
      const guarded={sessionID:'ses_X',request:new Request('http://127.0.0.1/provider',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer provider-key'},body:'{"input":"private context"}'})};
      await callbacks.get('http.request')(guarded);
      assert(guarded.request.url.includes('/blocked?'));
      assert(!await guarded.request.text());
      await assert.rejects(callbacks.get('experimental.ws.send')({sessionID:'ses_X',frame:'{"input":"private context"}'}),/instruction context is unavailable/);
      t.ok('A missing relay context stops HTTP and WebSocket requests before provider credentials or content are sent',true);
    }finally{delete process.env.PLEIAD_OPENCODE_ENV_URL;delete process.env.PLEIAD_OPENCODE_HOOK_URL;delete process.env.PLEIAD_OPENCODE_SECRET;delete process.env.PLEIAD_OPENCODE_INSTRUCTION_OWNER;await new Promise(r=>endpoint.close(r));}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
