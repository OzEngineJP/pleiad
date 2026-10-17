// OpenCode のバックエンドの部品: 出来事の写し替え（実機の記録 tests/lib/opencode-events.json）・発言の写し替え・
// 中継の口（core/opencode-relay.mjs。合言葉・会話への振り分け・子の会話・知らない会話は断る・環境変数）・
// OpenCode に読ませるプラグイン（core/backends/opencode-plugin.mjs。ply_* の引数に会話の id を足す・shell.env）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTurnMapper, messagesToNormalized, toolName, sessionRow } from '../../core/backends/opencode-normalize.mjs';
import { createOpencodeRelay, SESSION_ARG } from '../../core/opencode-relay.mjs';
import { PLUGIN_SOURCE, writePlugin } from '../../core/backends/opencode-plugin.mjs';
import { checkBackendEvent } from '../../core/backends/contract.mjs';

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
  const call = async (p, body, auth = 'Bearer s3cret', method = 'POST') => { const res = fakeRes(); await relay.handle(fakeReq({ method, headers: { authorization: auth }, body }), res, url(p)); return res; };
  t.ok('中継: 合言葉が違えば 401', (await call('ply_agents', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')).status === 401);
  t.ok('中継: まだ会話が無ければツールの一覧は空', (await call('ply_agents', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools.length === 0);
  relay.bind('ses_A', { runtimes: { agentRuntime: { url: 'http://pleiad/mcp/agents', headers: { Authorization: 'Bearer A' } } }, env: { PLEIAD_CONTROL_URL: 'http://x' } });
  relay.bind('ses_B', { runtimes: { agentRuntime: { url: 'http://pleiad/mcp/agents', headers: { Authorization: 'Bearer B' } } } });
  relay.alias('ses_child', 'ses_A');
  const listed = (await call('ply_agents', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  t.ok('中継: 一覧は結び付けた口に聞く', listed.result.tools[0].name === 'ply_delegate');
  forwarded.length = 0;
  await call('ply_agents', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ply_task_list', arguments: { [SESSION_ARG]: 'ses_A', x: 1 } } });
  await call('ply_agents', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ply_task_list', arguments: { [SESSION_ARG]: 'ses_B' } } });
  await call('ply_agents', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ply_task_list', arguments: { [SESSION_ARG]: 'ses_child' } } });
  t.ok('中継: 会話の id でその会話の口（トークン）へ振り分け、会話の id の引数は外す', forwarded.map((f) => f.headers.Authorization).join() === 'Bearer A,Bearer B,Bearer A'
    && forwarded[0].body.params.arguments.x === 1 && !(SESSION_ARG in forwarded[0].body.params.arguments), JSON.stringify(forwarded.map((f) => [f.headers.Authorization, f.body.params])));
  const stray = (await call('ply_agents', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ply_task_list', arguments: { [SESSION_ARG]: 'ses_unknown' } } })).json();
  t.ok('中継: 結び付いていない会話は断る（ほかの会話の口を使わせない）', stray.result.isError === true && forwarded.length === 3);
  const noBrowser = (await call('ply_browser', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'open', arguments: { [SESSION_ARG]: 'ses_A' } } })).json();
  t.ok('中継: その会話に無い口（ブラウザー）は断る', noBrowser.result.isError === true);
  const envRes = await call('env?session=ses_A', null, 'Bearer s3cret', 'GET');
  const res = fakeRes();
  await relay.handle(fakeReq({ method: 'GET', headers: { authorization: 'Bearer s3cret' } }), res, new URL('http://127.0.0.1:9/mcp/opencode/env?session=ses_child'));
  t.ok('中継: 会話のシェルの環境変数（子の会話は親の分）', envRes.status !== 0 && JSON.parse(res.body).PLEIAD_CONTROL_URL === 'http://x');
  t.ok('中継: 知らないサーバー名は 404', (await call('nope', { jsonrpc: '2.0', id: 8, method: 'tools/list' })).status === 404);

  // ---- プラグイン（OpenCode の中で動く本文を、そのまま読み込んで呼ぶ）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-oc-plugin-'));
  try {
    const href = writePlugin(dir);
    t.ok('プラグインはデータ置き場の opencode/ に書き出し、file URL で渡す', href === pathToFileURL(path.join(dir, 'opencode', 'pleiad-plugin.mjs')).href
      && fs.readFileSync(path.join(dir, 'opencode', 'pleiad-plugin.mjs'), 'utf8') === PLUGIN_SOURCE);
    const seen = [];
    const envServer = http.createServer((req, res2) => { seen.push({ url: req.url, auth: req.headers.authorization }); res2.writeHead(200, { 'content-type': 'application/json' }); res2.end(JSON.stringify({ A: '1', N: 2 })); });
    await new Promise((r) => envServer.listen(0, '127.0.0.1', r));
    process.env.PLEIAD_OPENCODE_ENV_URL = `http://127.0.0.1:${envServer.address().port}/mcp/opencode/env`;
    process.env.PLEIAD_OPENCODE_SECRET = 'plug';
    try {
      const mod = await import(`${href}?t=${Date.now()}`);
      const hooks = await mod.PleiadPlugin({});
      const ply = { args: { a: 1 } };
      await hooks['tool.execute.before']({ tool: 'ply_agents_ply_delegate', sessionID: 'ses_X' }, ply);
      const other = { args: { a: 1 } };
      await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_X' }, other);
      t.ok('プラグイン: ply_* のツールの引数にだけ会話の id を足す（その場で書き足す）', ply.args._pleiadSession === 'ses_X' && ply.args.a === 1 && !('_pleiadSession' in other.args));
      const env = { env: { KEEP: 'k' } };
      await hooks['shell.env']({ sessionID: 'ses_X', cwd: '.' }, env);
      t.ok('プラグイン: shell.env は会話の環境変数（文字列だけ）を足す', env.env.A === '1' && env.env.KEEP === 'k' && !('N' in env.env)
        && seen[0]?.url === '/mcp/opencode/env?session=ses_X' && seen[0]?.auth === 'Bearer plug', JSON.stringify({ env, seen }));
    } finally {
      delete process.env.PLEIAD_OPENCODE_ENV_URL; delete process.env.PLEIAD_OPENCODE_SECRET;
      envServer.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
