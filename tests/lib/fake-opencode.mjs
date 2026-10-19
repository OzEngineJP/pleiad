// OpenCode v2.0.32 の HTTP/SSE を模した、モデルを呼ばない試験サーバー。
// 外側は /api/* と native event envelope、内部は既存の会話の台本を使う。
// 台本は tool / ask / question / mcp:<JSON> / env / task / slow / hold / fail /
// retry-* / gate:<名前> / stream:<名前> / show-system。共有ファイルでプロセス間の
// 会話を維持し、モデル推論と本物の v2 plugin の検証は別途行う。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const CONFIG = (() => { try { return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'); } catch { return {}; } })();
const relayEndpoint=kind=>{
  try {if(process.env.PLEIAD_OPENCODE_RELAY_FILE)return JSON.parse(fs.readFileSync(process.env.PLEIAD_OPENCODE_RELAY_FILE,'utf8'))[kind];}catch{}
  return process.env[`PLEIAD_OPENCODE_${kind.toUpperCase()}_URL`];
};
const PROVIDERS = {
  providers: [{ id: 'fake', name: 'Fake', models: { echo: { name: 'Echo', limit: { context: 100_000, output: 8_000 }, variants: { low: {}, high: {} } }, tiny: { name: 'Tiny', limit: { context: 8_000, output: 1_000 }, variants: {} } } }],
  default: { fake: 'echo' },
};

let seq = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(16)}${(++seq).toString(36).padStart(4, '0')}${crypto.randomBytes(4).toString('hex')}`;
const sessions = new Map();       // id -> { id, directory, title, parentID, time, permission, messages: [{ info, parts }], run }
const mcp = new Map();            // directory -> { name: { status, config } }
const waits = new Map();          // permission / question の id -> resolve
const pending = new Map();        // 答えていない permission / question の id -> { kind, properties }
const clients = new Set();

const ACCOUNT_DATA = process.env.PLEIAD_OPENCODE_ACCOUNT_ID ? path.join(process.env.XDG_DATA_HOME, 'opencode') : null;
const STATE_FILE = ACCOUNT_DATA ? path.join(ACCOUNT_DATA, 'fake-sessions.json') : process.env.FAKE_OPENCODE_STATE_DIR ? path.join(process.env.FAKE_OPENCODE_STATE_DIR, 'sessions.json') : null;
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
/** 変えた会話だけをファイルに書く（ほかのプロセスが変えた会話は上書きしない） */
function persist(id) {
  const s = id && STATE_FILE ? sessions.get(id) : null;
  if (!s) return;
  const all = readState();
  const { run, compacting, ...rest } = s;
  all[id] = rest;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(all));
}
/** 会話を引く。走っていなければファイルの最新で置き換える（別のプロセスが続けたかもしれない） */
function lookup(id) {
  const now = sessions.get(id);
  if (!STATE_FILE || now?.run || now?.compacting) return now;
  const saved = readState()[id];
  if(saved) {if(now)Object.assign(now,saved,{run:null});else sessions.set(id,{...saved,run:null});}
  return sessions.get(id);
}
if (STATE_FILE) for (const saved of Object.values(readState())) sessions.set(saved.id, { ...saved, run: null });

function broadcast(directory, type, properties) {
  persist(properties?.sessionID);
  const p=properties,s=sessions.get(p.sessionID),m=s?.messages.find(m=>m.info.id===(p.messageID??p.part?.messageID??p.info?.id));
  const output=(event,data)=>{const line=`data: ${JSON.stringify({id:id('evt'),created:now(),type:event,data,location:{directory}})}\n\n`;for(const res of clients)res.write(line);};
  if(type==='session.created')return output(type,{sessionID:p.sessionID,parentID:p.info.parentID,location:{directory}});
  if(type==='message.updated'&&p.info.role==='user')return output('session.inbox.delivered',{sessionID:s.id,inboxID:p.info.id});
  if(type==='message.updated')return;
  if(type==='session.status') {
    const status=p.status,mid=s?.messages.findLast(m=>m.info.role==='assistant')?.info.id;
    if(status.type==='retry')return output('session.retry.scheduled',{sessionID:s.id,assistantMessageID:mid,attempt:status.attempt,at:status.next,error:{type:status.action?'provider.quota':'provider.rate-limit',message:status.message,response:{body:JSON.stringify({error:{type:status.action?.reason==='free_tier_limit'?'FreeUsageLimitError':status.action?.reason==='account_rate_limit'?'GoUsageLimitError':undefined}})}}});
    if(status.type==='busy')return output('session.step.started',{sessionID:s.id,assistantMessageID:mid});
    return;
  }
  if(type==='message.part.delta') {
    const part=m.parts.find(x=>x.id===p.partID);
    return output(`session.${part.type}.delta`,{sessionID:s.id,assistantMessageID:m.info.id,ordinal:m.parts.filter(x=>x.type===part.type).findIndex(x=>x.id===part.id),delta:p.delta});
  }
  if(type==='message.part.updated') {
    const part=p.part;
    if(m.info.role==='user')return;
    const base={sessionID:s.id,assistantMessageID:m.info.id};
    if(['text','reasoning'].includes(part.type))return output(`session.${part.type}.${part.time?.end?'ended':'started'}`,{...base,ordinal:m.parts.filter(x=>x.type===part.type).findIndex(x=>x.id===part.id),text:part.text});
    if(part.type==='step-finish')return output('session.step.ended',{...base,tokens:part.tokens,cost:part.cost});
    if(part.type==='tool') {
      const state=part.state,tool={...base,id:part.callID};
      if(state.status==='pending')return output('session.tool.input.started',{...tool,name:part.tool});
      if(state.status==='running'){output('session.tool.called',{...tool,input:state.input,executed:true});if(state.metadata)output('session.tool.progress',{...tool,metadata:state.metadata});return;}
      return output(state.status==='completed'?'session.tool.success':'session.tool.failed',{...tool,metadata:state.metadata,executed:true,...(state.status==='completed'?{content:[{type:'text',text:state.output}]}:{error:{type:'ToolError',message:state.error}})});
    }
    return;
  }
  if(type==='permission.asked')return output(type,{id:p.id,sessionID:p.sessionID,action:p.permission,resources:p.patterns,save:p.always,metadata:p.metadata,source:{type:'tool',messageID:p.tool.messageID,id:p.tool.callID}});
  if(type==='question.asked')return output('form.created',{form:formOf(p)});
  if(type==='session.step.failed')return output('session.step.failed',{sessionID:s.id,assistantMessageID:p.assistantMessageID??s?.messages.findLast(m=>m.info.role==='assistant')?.info.id,error:p.error});
  if(type==='session.error'){s.error=p.error;return;}
  if(type==='session.idle')return output(s.error?'session.execution.failed':'session.execution.succeeded',{sessionID:s.id,...(s.error?{error:s.error}:{})});
  output(type,p);
}
function formOf(p){return {id:p.id,sessionID:p.sessionID,title:'Question',fields:p.questions.map((q,i)=>({key:String(i),type:q.multiple?'multiselect':'string',title:q.question,options:q.options.map(o=>({value:o.label,label:o.label,...(o.description?{description:o.description}:{})}))}))};}
function nativeRow(s){
  const totals={cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}}};
  for(const info of [...s.messages.map(m=>m.info),...Object.values(s.compactionUsage??{})]) {
    totals.cost+=info.cost??0;
    for(const key of ['input','output','reasoning'])totals.tokens[key]+=info.tokens?.[key]??0;
    for(const key of ['read','write'])totals.tokens.cache[key]+=info.tokens?.cache?.[key]??0;
  }
  return {...row(s),...totals,location:{directory:s.directory},permissions:s.permission.map(r=>({action:r.permission,resource:r.pattern,effect:r.action})),time:Object.fromEntries(Object.entries(s.time).map(([k,v])=>[k,new Date(v).toISOString()]))};
}
function nativeMessage(m){
  const {info,parts}=m;
  const base={id:info.id,time:Object.fromEntries(Object.entries(info.time).map(([k,v])=>[k,new Date(v).toISOString()]))};
  if(info.role==='idle')return {...base,type:'idle',outcome:info.outcome??'failed',...(info.error?{error:info.error}:{})};
  if(info.summary)return {...base,type:'compaction',status:info.status??'completed',reason:'manual',summary:parts.filter(p=>p.type==='text').map(p=>p.text).join(''),recent:'',tokens:info.tokens,cost:info.cost,...(info.error?{error:info.error}:{})};
  if(info.role==='user')return {...base,type:info.synthetic?'synthetic':'user',text:parts.filter(p=>p.type==='text').map(p=>p.text).join(''),files:[],agents:[],skills:[]};
  return {...base,type:'assistant',agent:'build',model:{providerID:'fake',id:'echo'},tokens:info.tokens,cost:info.cost,...(info.finish?{finish:info.finish}:{}) ,...(info.error?{error:info.error}:{}) ,content:parts.filter(p=>['text','reasoning','tool'].includes(p.type)).map(p=>p.type==='tool'?{type:'tool',id:p.callID,name:p.tool,time:{created:base.time.created},state:{...p.state,...(p.state.output?{content:[{type:'text',text:p.state.output}]}:{}),...(p.state.error?{error:{type:'ToolError',message:p.state.error}}:{})}}:{type:p.type,text:p.text})};
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const row = (s) => ({ id: s.id, slug: 'fake', projectID: 'fake-project', directory: s.directory, title: s.title, ...(s.parentID ? { parentID: s.parentID } : {}), version: 'fake', time: s.time, permission: s.permission });

function session(directory, { title = null, parentID = null, permission = [] } = {}) {
  const s = { id: id('ses'), directory, title: title ?? 'New session', parentID, time: { created: now(), updated: now() }, permission: [...permission], messages: [], run: null };
  sessions.set(s.id, s);
  broadcast(directory, 'session.created', { sessionID: s.id, info: row(s) });
  return s;
}

function addUser(s, text, { system = null, messageID = null, synthetic = false } = {}) {
  const info = { id: messageID ?? id('msg'), sessionID: s.id, role: 'user', time: { created: now() }, ...(system ? { system } : {}),...(synthetic?{synthetic:true}:{}) };
  const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'text', text };
  s.messages.push({ info, parts: [part] });
  broadcast(s.directory, 'message.updated', { sessionID: s.id, info });
  broadcast(s.directory, 'message.part.updated', { sessionID: s.id, part, time: now() });
  return info;
}

function assistant(s, parentID) {
  const info = { id: id('msg'), sessionID: s.id, role: 'assistant', parentID, time: { created: now() }, modelID: 'echo', providerID: 'fake', mode: 'build', agent: 'build', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  const m = { info, parts: [] };
  s.messages.push(m);
  broadcast(s.directory, 'message.updated', { sessionID: s.id, info });
  const put = (part) => { const at = m.parts.findIndex((p) => p.id === part.id); if (at >= 0) m.parts[at] = part; else m.parts.push(part); broadcast(s.directory, 'message.part.updated', { sessionID: s.id, part, time: now() }); };
  return {
    info,
    async text(body, { pause = null } = {}) {
      const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'text', text: '', time: { start: now() } };
      put(part);
      const stream = async (chunk) => {
        for (const piece of String(chunk).match(/[\s\S]{1,6}/g) ?? []) {
          part.text += piece;
          // 実機と同じく、部品の本文は差分で伸び、部品の更新は始まりと終わりにだけ来る（GET の発言には今の本文が入る）
          m.parts[m.parts.findIndex((x) => x.id === part.id)] = { ...part };
          broadcast(s.directory, 'message.part.delta', { sessionID: s.id, messageID: info.id, partID: part.id, field: 'text', delta: piece });
          await wait(1);
        }
      };
      if (pause) { await stream(pause.before); await pause.wait(); await stream(pause.after); } else await stream(body);
      put({ ...part, time: { start: part.time.start, end: now() } });
    },
    reasoning(body) {
      const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'reasoning', text: '', time: { start: now() } };
      put(part);
      broadcast(s.directory, 'message.part.delta', { sessionID: s.id, messageID: info.id, partID: part.id, field: 'text', delta: body });
      put({ ...part, text: body, time: { start: part.time.start, end: now() } });
    },
    tool(tool, input) {
      const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'tool', tool, callID: id('call'), state: { status: 'pending', input: {}, raw: '' } };
      put(part);
      const start = now();
      put({ ...part, state: { status: 'running', input, time: { start } } });
      return {
        callID: part.callID,
        metadata: (metadata) => put({ ...part, state: { status: 'running', input, metadata, time: { start } } }),
        done: (output, metadata = {}) => put({ ...part, state: { status: 'completed', input, output, title: tool, metadata, time: { start, end: now() } } }),
        fail: (error) => put({ ...part, state: { status: 'error', input, error, time: { start, end: now() } } }),
      };
    },
    finish() {
      const tokens = { total: 1200, input: 1000, output: 150, reasoning: 50, cache: { read: 400, write: 0 } };
      put({ id: id('prt'), messageID: info.id, sessionID: s.id, type: 'step-finish', reason: 'stop', cost: 0.001, tokens });
      Object.assign(info, { tokens, cost: 0.001, time: { ...info.time, completed: now() } });
      broadcast(s.directory, 'message.updated', { sessionID: s.id, info });
    },
  };
}

function ask(s, type, properties) {
  const requestID = id(type === 'permission.asked' ? 'per' : 'que');
  return new Promise((resolve) => {
    const props = { id: requestID, sessionID: s.id, ...properties };
    waits.set(requestID, (answer) => { pending.delete(requestID); resolve(answer); });
    pending.set(requestID, { kind: type === 'permission.asked' ? 'permission' : 'question', directory: s.directory, properties: props });
    broadcast(s.directory, type, props);
  });
}

/** ゲート（tests/lib/fake-gate.mjs）が開くまで待つ */
async function gate(name, ctl) {
  const file = `${process.env.AGENT_HOST_FAKE_GATE_DIR ?? ''}/${name}`;
  const fs = await import('node:fs');
  while (!ctl.aborted && !fs.existsSync(file)) await wait(25);
}

async function mcpCall(s, server, tool, args) {
  const entry = mcp.get(s.directory)?.[server];
  if (!entry) return `no mcp server ${server}`;
  const res = await fetch(entry.config.url, { method: 'POST', headers: { ...entry.config.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args, _meta:{'ai.opencode/sessionID':s.id} } }) });
  const body = await res.json();
  return (body.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || JSON.stringify(body.error ?? body.result ?? null);
}

// Pleiad のプラグインの tool.execute.before / after と同じく、Pleiad の口（PLEIAD_OPENCODE_HOOK_URL）にツールの前後を聞く
async function pluginHook(s, phase, tool, args, output = '') {
  if (!relayEndpoint('hook')) return {};
  const res = await fetch(relayEndpoint('hook')+'?account='+encodeURIComponent(process.env.PLEIAD_OPENCODE_ACCOUNT??'login'), { method: 'POST', headers: { authorization: `Bearer ${process.env.PLEIAD_OPENCODE_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: s.id, phase, tool, args, output }) }).catch(() => null);
  return res?.ok ? res.json() : {};
}

/** 再試行の待ち（GET /session/status もこれを返す）・待ちが明けた busy */
function retryStatus(s, status) {
  if (s.run) s.run.status = { type: 'retry', ...status };
  broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'retry', ...status } });
}
function busyStatus(s) {
  if (s.run) s.run.status = { type: 'busy' };
  broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'busy' } });
}

async function run(s, user, text, { system = null } = {}) {
  const ctl = { aborted: false, steers: [], abort: null, status: { type: 'busy' } };
  ctl.aborted$ = new Promise((resolve) => { ctl.abort = () => { ctl.stopped = true; resolve(); }; });
  s.run = ctl;
  s.error=null;
  broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'busy' } });
  const a = assistant(s, user.id);
  try {
    if (text.startsWith('slow')) {
      const t = a.tool('bash', { command: 'sleep 600' });
      await ctl.aborted$;
      t.fail('Tool execution aborted');
      broadcast(s.directory, 'session.error', { sessionID: s.id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
      return;
    }
    if (text.startsWith('fail')) {
      broadcast(s.directory, 'session.error', { sessionID: s.id, error: { name: 'UnknownError', data: { message: 'fake failure' } } });
      return;
    }
    if (text.startsWith('provider-fail')) {
      // 実機 2.0.32: プロバイダーの 4xx は step.failed → execution.failed（どちらも data.error）。
      // 履歴の assistant メッセージには finish:'error' と error が残り、type:'idle'（outcome:'failed'）の記録も残る
      const error = { type: 'provider.invalid-request', message: 'region not allowed for this workspace', status: 400,
        response: { body: JSON.stringify({ error: { message: 'region not allowed for this workspace', type: 'invalid_request_error', code: 'region_denied' } }) } };
      Object.assign(a.info, { finish: 'error', error, time: { ...a.info.time, completed: now() } });
      s.messages.push({ info: { id: id('msg'), sessionID: s.id, role: 'idle', outcome: 'failed', error, time: { created: now() } }, parts: [] });
      broadcast(s.directory, 'session.step.failed', { sessionID: s.id, assistantMessageID: a.info.id, error });
      s.error = error;
      return;
    }
    if (text.startsWith('limited') || text.startsWith('partial-limited') || text.startsWith('tool-limited')) {
      if (text.startsWith('partial-')) await a.text('partial answer');
      if (text.startsWith('tool-')) { const tool = a.tool('bash', { command: 'write-file' }); tool.done('written'); }
      broadcast(s.directory, 'session.error', { sessionID: s.id, error: { name: 'APIError', data: { message: 'Usage limit reached', statusCode: 429,
        responseBody: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 2000000000 } }) } } });
      return;
    }
    // 再試行の待ち（実機 1.19.3 に 429 を返す provider を当てて確かめた形。ADR 0229）
    if (text.startsWith('retry-free') || text.startsWith('retry-go')) {
      // 待っても通らない上限（Zen の無料枠・Go の枠）。本物は 5 回まで待ち直す。ここでは中断されるまで待ち、中断で session.error なしに idle
      retryStatus(s, text.startsWith('retry-free')
        ? { attempt: 1, message: 'Free usage exceeded, subscribe to Go', action: { reason: 'free_tier_limit', provider: 'fake', title: 'Free limit reached', message: 'Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.', label: 'subscribe', link: 'https://opencode.ai/go' }, next: now() + 3_000 }
        : { attempt: 1, message: 'Weekly usage limit reached. It will reset in 1 minute. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_x/go', action: { reason: 'account_rate_limit', provider: 'fake', title: 'Go limit reached', message: 'Weekly usage limit reached. It will reset in 1 minute. To continue using this model now, enable usage from your available balance', label: 'open settings', link: 'https://opencode.ai/workspace/wrk_x/go' }, next: now() + 60_000 });
      await ctl.aborted$;
      return;
    }
    if (text.startsWith('retry-rate')) {
      // 込み具合の 429（"Rate limit exceeded"、action なし）。5 回待ち直して、なお 429 なら session.error
      for (let attempt = 1; attempt <= 5 && !ctl.stopped; attempt++) {
        retryStatus(s, { attempt, message: 'Rate limit exceeded', next: now() + 40 });
        await Promise.race([wait(40), ctl.aborted$]);
        if (ctl.stopped) return;
        busyStatus(s);
      }
      broadcast(s.directory, 'session.error', { sessionID: s.id, error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429, isRetryable: true,
        responseHeaders: { 'content-type': 'application/json', 'retry-after': '120' }, responseBody: JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit' } }) } } });
      return;
    }
    if (text.startsWith('retry-recover') || text.startsWith('retry-nonext') || text.startsWith('retry-gate:')) {
      // 待った後に通る。retry-gate はゲートが開くまで待ち（next は 1 分後）、retry-nonext は next の無い待ち（実機では見ていない。古い版・別の provider の備え）
      const name = text.startsWith('retry-gate:') ? text.slice('retry-gate:'.length).trim() : null;
      retryStatus(s, { attempt: 1, message: text.startsWith('retry-nonext') ? 'Provider is overloaded' : 'Rate limit exceeded', ...(text.startsWith('retry-nonext') ? {} : { next: now() + (name ? 60_000 : 200) }) });
      await Promise.race([name ? gate(name, ctl) : wait(200), ctl.aborted$]);
      if (ctl.stopped) return;
      busyStatus(s);
    }
    if (text === 'account-env') {
      await a.text(JSON.stringify({ accountId: process.env.PLEIAD_OPENCODE_ACCOUNT_ID ?? null,
        data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME,
        inheritedOpenAI: Boolean(process.env.OPENAI_API_KEY),
        inheritedGemini: Boolean(process.env.GEMINI_API_KEY), inheritedConfig: Boolean(process.env.OPENCODE_CONFIG),
        providers: ACCOUNT_DATA ? Object.keys(JSON.parse(fs.readFileSync(path.join(ACCOUNT_DATA, 'auth.json'), 'utf8'))) : [] }));
      a.finish();
      return;
    }
    let reply = `echo: ${text}`;
    if (text.startsWith('show-system')) {
      await a.text(`system: ${system ?? ''}`);
      a.finish();
      return;
    }
    if (text.startsWith('stream:')) {
      const name = text.slice('stream:'.length).trim();
      await a.text('', { pause: { before: `first half ${name} / `, after: `second half ${name}`, wait: () => gate(name, ctl) } });
      a.finish();
      return;
    }
    a.reasoning('thinking about it');
    if (text.startsWith('tool')) {
      const args = { command: text.includes('forbidden') ? 'echo forbidden' : 'echo hello' };
      const verdict = await pluginHook(s, 'before', 'bash', args);
      if (verdict.args) Object.assign(args, verdict.args);
      const t = a.tool('bash', args);
      await wait(5);
      if (verdict.block) { t.fail(verdict.block); reply = `blocked: ${verdict.block}`; }
      else {
        let out = `${args.command === 'echo hello' ? 'hello' : args.command}\n`;
        const after = await pluginHook(s, 'after', 'bash', args, out);
        if (after.append) out += `\n${after.append}`;
        t.done(out, { exit: 0, truncated: false });
        reply = after.append ? `ran the tool (${after.append})` : 'ran the tool';
      }
    } else if (text.startsWith('ask')) {
      const t = a.tool('bash', { command: 'echo asked' });
      const answer = await Promise.race([ask(s, 'permission.asked', { permission: 'bash', patterns: ['echo asked'], metadata: { command: 'echo asked' }, always: ['echo *'], tool: { messageID: a.info.id, callID: t.callID } }), ctl.aborted$.then(() => ({ reply: 'reject' }))]);
      if (answer.reply === 'reject') { t.fail(`The user rejected permission to use this specific tool call${answer.message ? ` with the following feedback: ${answer.message}` : ''}`); reply = `rejected${answer.message ? `: ${answer.message}` : ''}`; }
      else { t.done('asked\n', { exit: 0 }); reply = `allowed (${answer.reply})`; }
    } else if (text.startsWith('question')) {
      const answer = await ask(s, 'question.asked', { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }] });
      reply = answer.rejected ? 'question rejected' : `answers: ${JSON.stringify(answer.answers)}`;
    } else if (text.startsWith('mcp:')) {
      const { server, tool, arguments: args = {} } = JSON.parse(text.slice(4));
      const t = a.tool(`${server}_${tool}`, args);
      const out = await mcpCall(s, server, tool, args);
      t.done(out);
      reply = out;
    } else if (text.startsWith('env')) {
      const t = a.tool('bash', { command: 'env' });
      const res = await fetch(`${relayEndpoint('env')}?session=${encodeURIComponent(s.id)}&account=${encodeURIComponent(process.env.PLEIAD_OPENCODE_ACCOUNT??'login')}`, { headers: { authorization: `Bearer ${process.env.PLEIAD_OPENCODE_SECRET}` } });
      const env = res.ok ? await res.json() : { status: res.status };
      t.done(JSON.stringify(env));
      reply = `env: ${JSON.stringify(env)}`;
    } else if (text.startsWith('gate:')) {
      const name = text.slice('gate:'.length).trim();
      const t = a.tool('bash', { command: `wait ${name}` });
      await gate(name, ctl);
      t.done(`${name} opened\n`, { exit: 0 });
      reply = `gate ${name} done`;
    } else if (text.startsWith('hold')) {
      for (let i = 0; i < 400 && !ctl.steers.length; i++) await wait(50);
    } else if (text.startsWith('task')) {
      const child = session(s.directory, { title: 'fake subagent (@general subagent)', parentID: s.id });
      const t = a.tool('task', { description: 'fake subagent', prompt: 'say hi', subagent_type: 'general' });
      t.metadata({ sessionId: child.id, parentSessionId: s.id });
      const cu = addUser(child, 'say hi');
      const ca = assistant(child, cu.id);
      await ca.text('hi from the child');
      ca.finish();
      broadcast(child.directory, 'session.idle', { sessionID: child.id });
      t.done('hi from the child', { sessionId: child.id, parentSessionId: s.id });
      reply = 'the child said hi';
    }
    // 途中送信: 走っている最中に届いた発言は、ここ（区切り）で読む
    await wait(30);
    for (const steer of ctl.steers.splice(0)) { const text=typeof steer==='string'?steer:steer.text;addUser(s,text,{messageID:steer.id}); reply += `\n受け取った: ${text}`; }
    await a.text(system ? `[system] ${reply}` : reply);
    a.finish();
  } finally {
    s.run = null;
    s.time.updated = now();
    broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'idle' } });
    broadcast(s.directory, 'session.idle', { sessionID: s.id });
  }
}

async function body(req) {
  if(req.fakeBody)return req.fakeBody;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return req.fakeBody=raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const wire=url.pathname;
  const direct = (status,value) => {res.writeHead(status,{'content-type':'application/json'});res.end(value===undefined?'':JSON.stringify(value));};
  const send = (status, value) => {
    if(status===204)return direct(status);
    if(status>=400)return direct(status,value);
    if(value?.id&&sessions.has(value.id))value=nativeRow(sessions.get(value.id));
    if(Array.isArray(value)&&wire.endsWith('/message'))return direct(status,{data:value.map(nativeMessage),cursor:{}});
    return direct(status,{data:value});
  };
  if (req.headers.authorization !== AUTH) return direct(401, { error: 'unauthorized' });
  if(!wire.startsWith('/api/')&&wire!=='/openapi.json')return direct(404,{error:'v2 only'});
  let dir=req.headers['x-opencode-directory']?decodeURIComponent(req.headers['x-opencode-directory']):null;
  if(wire==='/api/info')return direct(200,{version:'2.0.32',pid:process.pid});
  if(wire==='/openapi.json')return direct(200,{info:{title:'opencode HttpApi',version:'0.0.1'},paths:{'/api/session':{},'/api/event':{}}});
  if(wire==='/api/experimental/migration/v1')return direct(200,{status:'completed'});
  const nativeModels=PROVIDERS.providers.flatMap(p=>Object.entries(p.models).map(([key,m])=>({...m,id:key,providerID:p.id,enabled:true,variants:Object.keys(m.variants).map(id=>({id}))})));
  if(wire==='/api/model')return direct(200,{location:{directory:dir},data:nativeModels});
  if(wire==='/api/model/default')return direct(200,{location:{directory:dir},data:nativeModels.find(m=>`${m.providerID}/${m.id}`===(process.env.FAKE_OPENCODE_MODEL??'fake/echo'))});
  if(wire==='/api/credential')return direct(200,{data:[{integrationID:'fake',id:'cred_fake',active:true,value:{type:'key',key:'fake-key'}}]});
  if(wire==='/api/config')return direct(200,[{type:'document',info:CONFIG}]);
  if(wire==='/api/event')url.pathname='/global/event';
  else if(wire==='/api/mcp')return direct(200,{location:{directory:dir},data:Object.entries(mcp.get(dir)??{}).map(([name,value])=>({name,status:{status:value.status}}))});
  else if(wire.startsWith('/api/experimental/mcp/')) {
    const b=await body(req);req.fakeBody={name:decodeURIComponent(wire.split('/').at(-1)),config:b.config};req.method='POST';url.pathname='/mcp';
  }else if(wire==='/api/session/active')return direct(200,{data:Object.fromEntries([...sessions.values()].filter(s=>s.run).map(s=>[s.id,{type:'busy'}]))});
  else if(wire==='/api/session'&&req.method==='GET') {
    const parent=url.searchParams.get('parentID');
    return direct(200,{data:[...sessions.values()].filter(s=>!parent||parent==='null'?!s.parentID:s.parentID===parent).reverse().map(nativeRow),cursor:{}});
  }else if(wire==='/api/session'&&req.method==='POST') {
    const b=await body(req);dir=b.location?.directory??dir;
    req.fakeBody={...b,permission:(b.permissions??[]).map(r=>({permission:r.action,pattern:r.resource,action:r.effect}))};url.pathname='/session';
  }else if(wire.startsWith('/api/session/')) {
    const seg=wire.split('/').filter(Boolean),sid=seg[2],action=seg[3],s=lookup(sid);
    if(!s)return direct(404,{error:'not found'});
    dir=s.directory;url.pathname=wire.slice(4);
    if(['model','agent','environment'].includes(action)) {const b=await body(req);s[action]=b.model??b.agent??b.variables;return direct(204);}
    if(action==='inbox') {
      if(req.method==='DELETE') {if(s.run)s.run.steers=s.run.steers.filter(x=>x.id!==seg[4]);return direct(204);}
      return direct(200,{data:(s.run?.steers??[]).map(x=>({id:x.id,sessionID:sid,type:'user',time:x.time,delivery:'steer',payload:{text:x.text}}))});
    }
    if(action==='message'&&seg[4]) {const m=s.messages.find(m=>m.info.id===seg[4]);return m?direct(200,{data:nativeMessage(m)}):direct(404,{error:'not found'});}
    if(['permission','form'].includes(action)) {
      if(req.method==='GET')return direct(200,{data:[...pending.values()].filter(x=>x.properties.sessionID===sid&&x.kind===(action==='form'?'question':'permission')).map(x=>action==='form'?formOf(x.properties):{...x.properties,action:x.properties.permission,resources:x.properties.patterns,save:x.properties.always,source:{type:'tool',id:x.properties.tool?.callID}})});
      const requestID=seg[4],b=await body(req);
      if(action==='permission'){waits.get(requestID)?.({reply:b.decision,message:b.message});waits.delete(requestID);return direct(204);}
      const q=pending.get(requestID)?.properties;
      waits.get(requestID)?.(req.method==='DELETE'?{rejected:true}:{answers:(q?.questions??[]).map((_,i)=>Array.isArray(b.answer[String(i)])?b.answer[String(i)]:[b.answer[String(i)]])});waits.delete(requestID);return direct(204);
    }
    if(action==='prompt') {
      const b=await body(req);
      const existing=s.messages.find(m=>m.info.id===b.id),queued=s.run?.steers.find(x=>x.id===b.id);
      if(existing||queued)return direct(200,{data:{id:b.id,sessionID:sid,type:'user',time:existing?nativeMessage(existing).time:queued.time,delivery:b.delivery}});
      let system='';
      if(relayEndpoint('env')){try{const response=await fetch(relayEndpoint('env')+'?kind=context&session='+encodeURIComponent(sid)+'&account='+encodeURIComponent(process.env.PLEIAD_OPENCODE_ACCOUNT??'login'),{headers:{authorization:'Bearer '+process.env.PLEIAD_OPENCODE_SECRET}});system=(await response.json()).system??'';}catch{}}
      direct(200,{data:{id:b.id,sessionID:sid,type:'user',text:b.text,delivery:b.delivery}});
      if(s.run){s.run.steers.push({id:b.id,text:b.text,time:{created:new Date().toISOString()}});return;}
      const user=addUser(s,b.text,{messageID:b.id,system});void run(s,user,b.text,{system});return;
    }
    if(action==='synthetic'){const b=await body(req),user=addUser(s,b.text,{synthetic:true,messageID:b.id});return direct(200,{data:{id:user.id,type:'synthetic',text:b.text}});}
    if(action==='interrupt'){const interrupted=Boolean(s.run);s.run?.abort();return direct(200,{interrupted});}
    if(action==='fork'){const b=await body(req);req.fakeBody={messageID:b.before};}
    if(action==='compact') {
      s.compacting=true;
      const b=await body(req),mid=b.id??id('msg');
      const info={id:mid,sessionID:sid,role:'assistant',summary:true,status:'running',time:{created:now()}};
      const m={info,parts:[]};s.messages.push(m);
      direct(200,{data:{id:mid,sessionID:sid,type:'compaction',delivery:'steer',time:{created:new Date(info.time.created).toISOString()}}});
      broadcast(s.directory,'session.compaction.started',{sessionID:sid,inputID:mid,reason:'manual',recent:''});
      const cancelled=s.messages.some(m=>m.info.role==='user'&&m.parts.some(p=>p.type==='text'&&p.text.startsWith('compact-abort')));
      if(cancelled || s.messages.some(m=>m.info.role==='user'&&m.parts.some(p=>p.type==='text'&&p.text.startsWith('compact-limited')))) {
        let release;const stopped=new Promise(resolve=>{release=resolve;});
        s.run={steers:[],abort:release};
        if(cancelled)busyStatus(s);
        else retryStatus(s,{attempt:1,message:'Free usage exceeded, subscribe to Go',action:{reason:'free_tier_limit'},next:now()+3000});
        await stopped;await wait(50);s.run=null;s.compacting=false;info.status='failed';(s.compactionUsage??={})[mid]={tokens:{input:7,output:2},cost:0.0003};info.error=cancelled?{type:'compaction.interrupted',message:'Compaction interrupted'}:{type:'provider.quota',message:'Free usage exceeded, subscribe to Go'};
        persist(sid);broadcast(s.directory,'session.compaction.failed',{sessionID:sid,inputID:mid,reason:'manual',error:info.error});
        broadcast(s.directory,'session.idle',{sessionID:sid});return;
      }
      await wait(10);info.status='completed';info.tokens={input:12,output:4};info.cost=0.0001;
      m.parts.push({id:id('prt'),type:'text',text:'## Summary\n- the fake conversation so far'});
      s.compacting=false;persist(sid);broadcast(s.directory,'session.compaction.ended',{sessionID:sid,reason:'manual',text:m.parts[0].text,tokens:info.tokens,cost:info.cost});
      broadcast(s.directory,'session.idle',{sessionID:sid});return;
    }
    if(!action&&req.method==='PATCH'){const b=await body(req);req.fakeBody={...b,...(b.permissions?{permission:b.permissions.map(r=>({permission:r.action,pattern:r.resource,action:r.effect}))}:{})};}
  }
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/global/health') return send(200, { healthy: true, version: 'fake' });
    if (url.pathname === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({type:'server.connected',data:{}})}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/config') return send(200, { ...(process.env.FAKE_OPENCODE_MODEL ? { model: process.env.FAKE_OPENCODE_MODEL } : {}), plugin: CONFIG.plugin ?? [] });
    if (url.pathname === '/config/providers') return send(200, PROVIDERS);
    if (url.pathname === '/provider') return send(200, { all: [{ id: 'fake', name: 'Fake' }], connected: ['fake'], default: { fake: 'echo' } });
    if (url.pathname === '/mcp' && req.method === 'GET') return send(200, Object.fromEntries(Object.entries(mcp.get(dir) ?? {}).map(([k, v]) => [k, { status: v.status }])));
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const b = await body(req);
      const entry = { status: 'connected', config: b.config };
      // 実機と同じく、足した時点で tools/list を聞く
      await fetch(b.config.url, { method: 'POST', headers: { ...b.config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }) }).then((r) => r.json()).then((r) => { entry.tools = r.result?.tools?.map((x) => x.name) ?? []; }).catch(() => { entry.status = 'failed'; });
      mcp.set(dir, { ...(mcp.get(dir) ?? {}), [b.name]: entry });
      return send(200, Object.fromEntries(Object.entries(mcp.get(dir)).map(([k, v]) => [k, { status: v.status }])));
    }
    if (url.pathname === '/permission' && req.method === 'GET') return send(200, [...pending.values()].filter((x) => x.kind === 'permission' && (!dir || x.directory === dir)).map((x) => x.properties));
    if (url.pathname === '/question' && req.method === 'GET') return send(200, [...pending.values()].filter((x) => x.kind === 'question' && (!dir || x.directory === dir)).map((x) => x.properties));
    if (url.pathname === '/session/status' && req.method === 'GET') return send(200, Object.fromEntries([...sessions.values()].filter((x) => x.run && (!dir || x.directory === dir)).map((x) => [x.id, x.run.status ?? { type: 'busy' }])));
    if (url.pathname === '/experimental/session') return send(200, [...sessions.values()].filter((s) => !s.parentID).reverse().map(row));
    if (url.pathname === '/session' && req.method === 'POST') {
      const b = await body(req);
      return send(200, row(session(dir, { title: b.title ?? null, permission: b.permission ?? [] })));
    }
    if (parts[0] === 'permission' && parts[2] === 'reply') { const b = await body(req); waits.get(parts[1])?.(b); waits.delete(parts[1]); return send(200, true); }
    if (parts[0] === 'question' && parts[2] === 'reply') { const b = await body(req); waits.get(parts[1])?.({ answers: b.answers }); waits.delete(parts[1]); return send(200, true); }
    if (parts[0] === 'question' && parts[2] === 'reject') { waits.get(parts[1])?.({ rejected: true }); waits.delete(parts[1]); return send(200, true); }
    if (parts[0] === 'session' && parts[1]) {
      const s = lookup(parts[1]);
      if (!s) return send(404, { error: 'not found' });
      const action = parts[2];
      if (!action && req.method === 'GET') return send(200, row(s));
      if (!action && req.method === 'PATCH') {
        const b = await body(req);
        if (typeof b.title === 'string') s.title = b.title;
        if (Array.isArray(b.permission)) s.permission.push(...b.permission);
        broadcast(s.directory, 'session.updated', { sessionID: s.id, info: row(s) });
        return send(200, row(s));
      }
      if (action === 'message' && req.method === 'GET') return send(200, s.messages);
      if (action === 'message' && req.method === 'POST') {
        const b = await body(req);
        const info = addUser(s, (b.parts ?? []).map((p) => p.text ?? '').join(''));
        return send(200, { info, parts: s.messages.at(-1).parts });
      }
      if (action === 'prompt_async') {
        const b = await body(req);
        const text = (b.parts ?? []).map((p) => p.text ?? '').join('');
        send(204);
        if (s.run) { s.run.steers.push(text); return; }
        const user = addUser(s, text, { system: b.system ?? null });
        void run(s, user, text, { system: b.system ?? null });
        return;
      }
      if (action === 'abort') { s.run?.abort(); return send(200, true); }
      if (action === 'children') return send(200, [...sessions.values()].filter((x) => x.parentID === s.id).map(row));
      if (action === 'fork') {
        const b = await body(req);
        const at = b.messageID ? s.messages.findIndex((m) => m.info.id === b.messageID) : s.messages.length;
        const f = session(s.directory, { title: `${s.title} (fork)`, permission: s.permission });
        const remap = new Map();
        for (const m of s.messages.slice(0, at < 0 ? s.messages.length : at)) {
          const nid = id('msg'); remap.set(m.info.id, nid);
          f.messages.push({ info: { ...m.info, id: nid, sessionID: f.id, ...(m.info.parentID ? { parentID: remap.get(m.info.parentID) ?? m.info.parentID } : {}) }, parts: m.parts.map((p) => ({ ...p, id: id('prt'), messageID: nid, sessionID: f.id })) });
        }
        return send(200, row(f));
      }
      if (action === 'summarize') {
        await body(req);
        send(200, true);
        if (s.messages.some((m) => m.info.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith('compact-limited')))) {
          let release;
          s.run = { steers: [], abort: () => release(), status: null };
          retryStatus(s, { attempt: 1, message: 'Free usage exceeded, subscribe to Go', action: { reason: 'free_tier_limit', provider: 'fake', title: 'Free limit reached', link: 'https://opencode.ai/go' }, next: now() + 3_000 });
          await new Promise((r) => { release = r; });
          s.run = null;
          broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'idle' } });
          broadcast(s.directory, 'session.idle', { sessionID: s.id });
          return;
        }
        const user = { id: id('msg'), sessionID: s.id, role: 'user', time: { created: now() } };
        s.messages.push({ info: user, parts: [{ id: id('prt'), messageID: user.id, sessionID: s.id, type: 'compaction', auto: false }] });
        broadcast(s.directory, 'message.updated', { sessionID: s.id, info: user });
        const a = assistant(s, user.id);
        a.info.summary = true;
        await a.text('## Summary\n- the fake conversation so far');
        a.finish();
        broadcast(s.directory, 'session.compacted', { sessionID: s.id });
        broadcast(s.directory, 'session.idle', { sessionID: s.id });
        return;
      }
    }
    return send(404, { error: `fake opencode: no route ${req.method} ${url.pathname}` });
  } catch (err) {
    return send(500, { error: String(err?.message ?? err) });
  }
});

const port = Number(process.argv[process.argv.indexOf('--port') + 1] ?? 0) || 0;
// 起こされた印（試験が「一覧を作るだけでは起こさない」を確かめる）
if (process.env.FAKE_OPENCODE_STARTED_FILE) { try { (await import('node:fs')).appendFileSync(process.env.FAKE_OPENCODE_STARTED_FILE, `${process.pid}
`); } catch {} }
// 起こされたときの設定（Pleiad 担当のコンテキストの専用のサーバーの確かめ。試験が FAKE_OPENCODE_LAUNCH_FILE を付けたときだけ）
if (process.env.FAKE_OPENCODE_LAUNCH_FILE) {
  const flags = Object.fromEntries(['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS']
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  (await import('node:fs')).appendFileSync(process.env.FAKE_OPENCODE_LAUNCH_FILE, `${JSON.stringify({ pid: process.pid, flags, xdg: process.env.XDG_CONFIG_HOME ?? null, config: CONFIG })}
`);
}
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`}));
});
if(process.argv.includes('--stdio')){process.stdin.resume();process.stdin.on('end',()=>server.close(()=>process.exit(0)));}
