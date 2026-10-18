// OpenCode v2 wire protocol -> Pleiad's private conversation projection.
// Public contract: OpenCode v2.0.32, commit 843a6c514e606b436a7fe713422ace0a93ad3d61.
import crypto from 'node:crypto';

const millis = value => typeof value === 'number' ? value : Date.parse(value);
const contentText = content => (content ?? []).map(c => c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text ?? '' : '').filter(Boolean).join('\n');
const toolMetadata = value => value && ({...value,...(value.sessionID ? {sessionId:value.sessionID} : {})});
export const v2Permissions = rules => (rules ?? []).map(r => ({ action: r.permission, resource: r.pattern, effect: r.action }));
export const v2Session = s => s && ({ ...s, directory: s.location?.directory ?? s.directory, time: Object.fromEntries(Object.entries(s.time ?? {}).map(([k,v]) => [k, millis(v)])) });
export function v2Retry(p) {
  let body;try{body=JSON.parse(p.error?.response?.body ?? '{}');}catch{body={};}
  const code=body?.error?.type ?? body?.error?.code;
  const reason=code==='FreeUsageLimitError'?'free_tier_limit':code==='GoUsageLimitError'?'account_rate_limit':null;
  return {type:'retry',attempt:p.attempt,next:Number.isFinite(p.at)?p.at:null,message:p.error?.message ?? '',...(reason?{action:{reason}}:{})};
}

/** One projection is used for history, live reconciliation, and offline SQLite reads. */
export function v2Message(message, sessionID) {
  const m = message ?? {};
  const info = { ...m, sessionID, role: m.type === 'compaction' ? 'assistant' : m.type,
    time: Object.fromEntries(Object.entries(m.time ?? {}).map(([k,v]) => [k, millis(v)])),
    ...(m.model ? { providerID: m.model.providerID, modelID: m.model.id } : {}),
    ...(m.type === 'compaction' ? { summary:m.status==='completed' } : {}) };
  const values = m.type === 'assistant' ? m.content ?? [] : m.type === 'compaction' ? (m.status==='completed'?[{type:'text',text:m.summary ?? ''}]:[]) : [{type:'text',text:m.text ?? ''}];
  const ordinals = new Map();
  const parts = values.map(c => {
    const ordinal = ordinals.get(c.type) ?? 0;
    ordinals.set(c.type, ordinal + 1);
    const base = { id: `${m.id}:${c.type}:${c.type === 'tool' ? c.id : ordinal}`, messageID:m.id, sessionID, type:c.type };
    if (c.type !== 'tool') return { ...base, text:c.text ?? '', ...(m.type === 'synthetic' ? {synthetic:true} : {}), time:{ start:info.time.created, ...(info.time.completed ? {end:info.time.completed} : {}) } };
    return { ...base, callID:c.id, tool:c.name, state:{ ...c.state,metadata:toolMetadata(c.state?.metadata),
      ...(c.state?.content ? {output:contentText(c.state.content)} : {}),
      ...(c.state?.error ? {error:String(c.state.error.message ?? c.state.error.data?.message ?? c.state.error.type ?? 'Tool failed')} : {}),
      time:{start:millis(c.time?.ran ?? c.time?.created), ...(c.time?.completed ? {end:millis(c.time.completed)} : {})} } };
  });
  if (m.tokens && (m.type === 'assistant' || m.type==='compaction')) parts.push({id:`${m.id}:usage`,messageID:m.id,sessionID,type:'step-finish',tokens:m.tokens,cost:m.cost ?? 0});
  return {info,parts};
}

/** 履歴と再接続で同じ出来事を作る。圧縮の本文は通常の応答へ混ぜない。 */
export function replayV2Messages(list, publish) {
  for (const message of list) {
    const {info,parts}=message;
    if(info.type==='compaction') {
      publish({type:'pleiad.compaction',properties:{sessionID:info.sessionID,message}});
      for(const part of parts.filter(p=>p.type==='step-finish'))publish({type:'message.part.updated',properties:{part}});
    } else {
      publish({type:'message.updated',properties:{info}});
      for(const part of parts)publish({type:'message.part.updated',properties:{part}});
      if(info.type==='assistant' && !info.time?.completed && info.retry)
        publish({type:'session.status',properties:{sessionID:info.sessionID,status:v2Retry(info.retry)}});
    }
  }
}

export function createV2Protocol({ call, publish, setSystem = () => {} }) {
  const sessions = new Set();
  const permissions = new Map();
  const forms = new Map();
  const tools = new Map();
  const seen = new Map();
  const turns = new Map();
  const admitted = new Set();
  const request = (method,path,options={}) => call(method,path,options);
  const value = async (method,path,options={}) => (await request(method,path,options))?.data;
  const emit = (type,properties) => publish({type,properties});
  function permission(p) {
    permissions.set(p.id,p.sessionID);
    return {...p,permission:p.action,patterns:p.resources,always:p.save,tool:p.source ? {callID:p.source.id} : null};
  }
  function question(f) {
    forms.set(f.id,f);
    return {id:f.id,sessionID:f.sessionID,fields:f.fields,questions:(f.fields ?? []).map(field=>({
      question:field.title ?? field.description ?? field.key, header:field.key, multiple:field.type==='multiselect',
      options:field.options?.map(o=>({label:o.label ?? o.value,description:o.description})),
    }))};
  }
  async function page(path, options={}) {
    const all=[]; let cursor; const visited=new Set();
    do {
      const result=await request('GET',path,{...options,query:{...options.query,limit:200,...(cursor?{cursor}:{order:'asc'})}});
      if (!Array.isArray(result?.data)) throw new Error('OpenCode v2: invalid paginated response');
      all.push(...result.data);
      cursor=result.cursor?.next;
      if(cursor && visited.has(cursor)) throw new Error('OpenCode v2: repeated pagination cursor');
      if(cursor) visited.add(cursor);
    } while(cursor);
    return all;
  }
  async function history(sid, options={}) { return (await page(`/api/session/${sid}/message`,options)).map(m=>v2Message(m,sid)); }
  async function delivery(sid, id) {
    try {
      const message = await value('GET', `/api/session/${sid}/message/${id}`);
      if (message) return {id, sessionID:sid, time:message.time, delivered:true};
    } catch (error) { if(error.status !== 404) throw error; }
    const inbox = await value('GET', `/api/session/${sid}/inbox`);
    if(!Array.isArray(inbox)) throw new Error('OpenCode v2: invalid inbox response');
    return inbox.find(item => item.id === id) ?? null;
  }
  async function admit(sid, id, body, options) {
    // The same ID is safe to retry: native admission reconciles both inbox and history.
    // A lost HTTP response says nothing about whether the write was accepted.
    let ambiguous = false;
    for (;;) {
      if(options.signal?.aborted) throw options.signal.reason ?? new Error('Interrupted');
      try { return await value('POST', `/api/session/${sid}/prompt`, {...options,body:{...body,id}}); }
      catch (error) {
        if(error.code==='OPENCODE_GONE')throw error;
        if(!ambiguous && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409) {
          error.undelivered = true;
          throw error;
        }
        ambiguous = true;
        try {
          const receipt = await delivery(sid,id);
          if(receipt) return receipt;
          if(options.signal?.aborted) throw options.signal.reason ?? error;
        } catch (lookupError) {
          if(options.signal?.aborted) throw lookupError;
        }
        await new Promise(resolve => setTimeout(resolve,500));
      }
    }
  }
  function replay(list) {
    replayV2Messages(list,publish);
  }
  async function pending(kind) {
    await discoverChildren();
    const lists=await Promise.all([...sessions].map(async sid=>{
      const rows=await value('GET',`/api/session/${sid}/${kind}`);
      if(!Array.isArray(rows)) throw new Error('OpenCode v2: invalid pending response');
      return rows.map(kind==='permission'?permission:question);
    }));
    return lists.flat();
  }
  async function discoverChildren() {
    const visited = new Set();
    for(const root of turns.keys()) {
      const queue = [root];
      while(queue.length) {
        const parent = queue.shift();
        if(visited.has(parent)) continue;
        visited.add(parent);
        const children = await page('/api/session',{query:{parentID:parent}});
        for(const child of children) {
          if(!sessions.has(child.id)) emit('pleiad.child',{sessionID:parent,childId:child.id});
          sessions.add(child.id);
          queue.push(child.id);
        }
      }
    }
  }
  async function modelCatalog(options) {
    const [models,def]=await Promise.all([value('GET','/api/model',options),value('GET','/api/model/default',options)]);
    if(!Array.isArray(models)) throw new Error('OpenCode v2: invalid model catalog');
    const providers=new Map();
    for(const m of models.filter(m=>m.enabled !== false)) {
      let p=providers.get(m.providerID);
      if(!p) {p={id:m.providerID,name:m.providerID,models:{}};providers.set(m.providerID,p);}
      p.models[m.id]={...m,variants:Object.fromEntries((m.variants ?? []).map(v=>[v.id,v]))};
    }
    return {providers:[...providers.values()],default:def ? {[def.providerID]:def.id} : {},model:def ? `${def.providerID}/${def.id}` : undefined};
  }
  async function dispatch(method,path,options={}) {
    const {body,directory,query={}}=options;
    if(path.startsWith('/api/') || path==='/openapi.json') return request(method,path,options);
    if(path==='/config/providers') return modelCatalog(options);
    if(path==='/config') {
      const entries=await request('GET','/api/config',options);
      const provider={};
      for(const entry of Array.isArray(entries)?entries:[])if(entry.info?.providers)Object.assign(provider,entry.info.providers);
      return {model:(await modelCatalog(options)).model,provider};
    }
    if(path==='/provider') {
      const entries=await value('GET','/api/credential');
      const connected=[...new Set((entries ?? []).map(c=>c.integrationID))];
      return {connected,all:connected.map(id=>({id,name:id}))};
    }
    if(path==='/mcp') {
      if(method==='GET') {
        const rows=await value('GET','/api/mcp',options);
        if(!Array.isArray(rows))throw new Error('OpenCode v2: invalid MCP catalog');
        return Object.fromEntries(rows.map(row=>[row.name,row.status]));
      }
      return request('PUT',`/api/experimental/mcp/${encodeURIComponent(body.name)}`,{...options,body:{config:body.config}});
    }
    if(path==='/session/status') {
      const active=await value('GET','/api/session/active');
      return Object.fromEntries(await Promise.all(Object.keys(active ?? {}).map(async sid=>{
        const current=(await history(sid)).findLast(m=>m.info.type==='assistant' && !m.info.time?.completed);
        return [sid,current?.info.retry?v2Retry(current.info.retry):{type:'busy'}];
      })));
    }
    if(path==='/permission') return pending('permission');
    if(path==='/question') return pending('form');
    const reply=/^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(path);
    if(reply) {
      const [,kind,id,verb]=reply;
      if(kind==='permission') {
        const sid=permissions.get(id); if(!sid) throw new Error('OpenCode v2: unknown permission request');
        return request('POST',`/api/session/${sid}/permission/${id}/reply`,{body:{decision:body.reply,...(body.message?{message:body.message}:{})}});
      }
      const f=forms.get(id);if(!f)throw new Error('OpenCode v2: unknown form');
      if(verb==='reject')return request('DELETE',`/api/session/${f.sessionID}/form/${id}`);
      const answer={};
      for(let i=0;i<f.fields.length;i++) {
        const field=f.fields[i], values=body.answers?.[i] ?? [];
        const selected = values.map(v => field.options?.find(o => (o.label ?? String(o.value)) === v)?.value ?? v);
        let v=field.type==='multiselect'?selected:selected.join(', ');
        if(field.type==='boolean') {
          if(!/^(true|false|yes|no|はい|いいえ|1|0)$/i.test(v))throw new Error('Invalid boolean form answer');
          v=/^(true|yes|はい|1)$/i.test(v);
        }
        if(field.type==='number'||field.type==='integer') {v=Number(v);if(!Number.isFinite(v)||(field.type==='integer'&&!Number.isInteger(v)))throw new Error('Invalid numeric form answer');}
        if(field.type!=='external') answer[field.key]=v;
      }
      return request('POST',`/api/session/${f.sessionID}/form/${id}/reply`,{body:{answer}});
    }
    if(path==='/experimental/session'||path==='/session') {
      if(method==='GET') {
        const rows=await value('GET','/api/session',{query:{limit:query.limit ?? 100,...(query.roots?{parentID:'null'}:{})}});
        return (rows ?? []).map(v2Session);
      }
      const s=await value('POST','/api/session',{body:{...(body?.permission?{permissions:v2Permissions(body.permission)}:{}),...(directory?{location:{directory}}:{})}});
      sessions.add(s.id);return v2Session(s);
    }
    const route=/^\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
    if(!route)throw new Error(`Unsupported OpenCode conversation operation: ${method} ${path}`);
    const [,sid,tail='']=route; sessions.add(sid);
    const at=`/api/session/${sid}`;
    if(tail.startsWith('delivery/')) return delivery(sid, tail.slice('delivery/'.length));
    if(!tail) {
      if(method==='GET')return v2Session(await value('GET',at,options));
      return request(method,at,{...options,body:{...(body.title!==undefined?{title:body.title}:{}),...(body.permission?{permissions:v2Permissions(body.permission)}:{}),...(body.metadata?{metadata:body.metadata}:{})}});
    }
    if(tail==='message'&&method==='GET')return history(sid,options);
    if(tail==='children')return (await page('/api/session',{query:{parentID:sid}})).map(v2Session);
    if(tail==='fork')return v2Session(await value('POST',`${at}/fork`,{body:body.messageID?{before:body.messageID}:{}}));
    if(tail==='abort') {
      const inbox=await value('GET',`${at}/inbox`);
      for(const item of inbox ?? [])await request('DELETE',`${at}/inbox/${item.id}`);
      return request('POST',`${at}/interrupt`,{query:{resume:false}});
    }
    if(tail==='summarize')return value('POST',`${at}/compact`,{body:{id:body.id ?? `msg_${crypto.randomUUID().replaceAll('-','')}`,delivery:'steer'}});
    if(tail==='message'&&body.noReply) return value('POST',`${at}/synthetic`,{body:{text:body.parts.map(p=>p.text??'').join(''),resume:false}});
    if(tail==='prompt_async') {
      if(!turns.has(sid))turns.set(sid,Date.now());
      if(body.model)await request('POST',`${at}/model`,{body:{model:{providerID:body.model.providerID,id:body.model.modelID,...(body.variant?{variant:body.variant}:{})}}});
      if(body.agent)await request('POST',`${at}/agent`,{body:{agent:body.agent}});
      if(body.system!==undefined)setSystem(sid,body.system);
      // A stable ID also makes an ambiguous HTTP timeout safe to reconcile.
      const id=body.id ?? `msg_${crypto.randomUUID().replaceAll('-','')}`;
      const receipt=await admit(sid,id,{text:body.parts.map(p=>p.text??'').join(''),delivery:body.delivery ?? 'steer'},options);
      if(turns.has(sid))admitted.add(sid);
      return receipt;
    }
    throw new Error(`Unsupported OpenCode conversation operation: ${method} ${path}`);
  }
  async function event(raw) {
    if(!raw?.type||!raw.data)return;
    if(raw.id) {if(seen.has(raw.id))return;seen.set(raw.id,true);if(seen.size>4096)seen.delete(seen.keys().next().value);}
    const p=raw.data,sid=p.sessionID;
    if(raw.type==='permission.asked') {emit('permission.asked',permission({...p,id:p.id??raw.id}));return;}
    if(raw.type==='form.created') {if(p.form?.sessionID!=='global')emit('question.asked',question(p.form));return;}
    if(!sid)return;
    if(raw.type.startsWith('session.compaction.')) {
      const since=turns.get(sid);
      if(since && !raw.type.endsWith('.delta'))replay((await history(sid)).filter(m=>m.info.type==='compaction' && m.info.time.created>=since));
      return;
    }
    if(raw.type==='session.created'&&p.parentID) {sessions.add(sid);emit('pleiad.child',{sessionID:p.parentID,childId:sid});}
    if(raw.type==='session.inbox.delivered') {
      admitted.add(sid);
      const m=await value('GET',`/api/session/${sid}/message/${p.inboxID}`);
      if(m)replay([v2Message(m,sid)]);return;
    }
    const mid=p.assistantMessageID;
    const text=/^session\.(text|reasoning)\.(started|delta|ended)$/.exec(raw.type);
    if(text) {
      const [,type,phase]=text,id=`${mid}:${type}:${p.ordinal}`;
      emit('message.updated',{info:{id:mid,sessionID:sid,role:'assistant'}});
      if(phase==='delta')emit('message.part.delta',{sessionID:sid,messageID:mid,partID:id,field:'text',delta:p.delta});
      else emit('message.part.updated',{part:{id,messageID:mid,sessionID:sid,type,text:p.text??'',...(phase==='ended'?{time:{end:millis(raw.created)}}:{})}});
      return;
    }
    if(raw.type.startsWith('session.tool.')) {
      const id=`${mid}:tool:${p.id}`, prior=tools.get(id)??{id,messageID:mid,sessionID:sid,type:'tool',callID:p.id,state:{}};
      if(p.name)prior.tool=p.name;
      if(raw.type==='session.tool.called')prior.state={status:'running',input:p.input,time:{start:millis(raw.created)}};
      if(raw.type==='session.tool.progress')prior.state={...prior.state,metadata:toolMetadata(p.metadata)};
      if(raw.type==='session.tool.success')prior.state={...prior.state,status:'completed',output:contentText(p.content),metadata:toolMetadata(p.metadata),time:{...prior.state.time,end:millis(raw.created)}};
      if(raw.type==='session.tool.failed')prior.state={...prior.state,status:'error',error:String(p.error?.message??p.error?.data?.message??'Tool failed'),metadata:toolMetadata(p.metadata)};
      tools.set(id,prior);emit('message.part.updated',{part:prior});return;
    }
    if(raw.type==='session.step.ended'||raw.type==='session.step.failed') {
      emit('message.part.updated',{part:{id:`${mid}:usage`,messageID:mid,sessionID:sid,type:'step-finish',cost:p.cost,tokens:p.tokens}});
      if(p.error)emit('session.error',{sessionID:sid,error:p.error});return;
    }
    if(/^session\.execution\.(succeeded|failed|interrupted)$/.test(raw.type)) {
      if(!admitted.has(sid))return;
      // Terminal full values repair dropped deltas; existing part IDs prevent double accounting.
      const since=turns.get(sid);
      if(since)replay((await history(sid)).filter(m=>m.info.time.created>=since));
      if(p.error)emit('session.error',{sessionID:sid,error:p.error});
      if(raw.type.endsWith('interrupted'))emit('session.error',{sessionID:sid,error:{name:'MessageAbortedError',message:'Interrupted'}});
      turns.delete(sid);admitted.delete(sid);emit('session.idle',{sessionID:sid});return;
    }
    if(raw.type==='session.retry.scheduled')emit('session.status',{sessionID:sid,status:v2Retry(p)});
    if(raw.type==='session.step.started')emit('session.status',{sessionID:sid,status:{type:'busy'}});
  }
  async function resync({snapshot=true}={}) {
    for(const [sid,since] of snapshot?turns:[]) {
      replay((await history(sid)).filter(m=>m.info.time.created>=since));
      emit('pleiad.resync',{sessionID:sid});
    }
    for(const p of await pending('permission'))emit('permission.asked',p);
    for(const q of await pending('form'))emit('question.asked',q);
    const active=await value('GET','/api/session/active');
    for(const sid of turns.keys())if(admitted.has(sid) && !active?.[sid]) {
      const inbox=await value('GET',`/api/session/${sid}/inbox`);
      if(!Array.isArray(inbox))throw new Error('OpenCode v2: invalid inbox response');
      if(!inbox.length) {
        // 最初の履歴取得と active の確認の間に終わった応答を回収してから締める。
        replay((await history(sid)).filter(m=>m.info.time.created>=turns.get(sid)));
        emit('session.idle',{sessionID:sid});turns.delete(sid);admitted.delete(sid);
      }
    }
  }
  return {request:dispatch,event,history,pending,resync,begin(sid,since,accepted=false){sessions.add(sid);if(since){turns.set(sid,since);if(accepted)admitted.add(sid);else admitted.delete(sid);}}};
}
