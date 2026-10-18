// Copied into the isolated OpenCode plugin package by writePlugin().
import fs from 'node:fs';
import zlib from 'node:zlib';

const SECRET = process.env.PLEIAD_OPENCODE_SECRET ?? '';
const ACCOUNT = process.env.PLEIAD_OPENCODE_ACCOUNT ?? 'login';
const PLY_INSTRUCTIONS=process.env.PLEIAD_OPENCODE_INSTRUCTION_OWNER==='ply';
function omitSynthetic(value,texts) {
  if(typeof value==='string') {
    for(const text of texts)value=value.replaceAll('[Synthetic context]: '+text,'');
    return value;
  }
  if(Array.isArray(value))return value.map(item=>omitSynthetic(item,texts));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,omitSynthetic(item,texts)]));
  return value;
}
function encoding(name) {
  if(!name || name==='identity')return {decode:b=>b,encode:b=>b};
  if(name==='gzip')return {decode:zlib.gunzipSync,encode:zlib.gzipSync};
  if(name==='br')return {decode:zlib.brotliDecompressSync,encode:zlib.brotliCompressSync};
  if(name==='deflate')return {decode:zlib.inflateSync,encode:zlib.deflateSync};
  if(name==='zstd')return {decode:zlib.zstdDecompressSync ?? globalThis.Bun?.zstdDecompressSync,encode:zlib.zstdCompressSync ?? globalThis.Bun?.zstdCompressSync};
  return {};
}
function blockedRequest(session) {
  const url=endpoint('hook',session);url.pathname=url.pathname.replace(/\/hook$/,'/blocked');
  return new Request(url,{method:'POST',headers:{authorization:'Bearer '+SECRET}});
}
function endpoint(kind, session, context = false, fresh = false) {
  const file = process.env.PLEIAD_OPENCODE_RELAY_FILE;
  const current = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const base = current[kind] ?? process.env[`PLEIAD_OPENCODE_${kind.toUpperCase()}_URL`];
  if (!base || !SECRET) throw new Error('Pleiad relay is unavailable');
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Invalid Pleiad relay address');
  url.searchParams.set('account', ACCOUNT);
  url.searchParams.set('session', session);
  if (context) url.searchParams.set('kind', 'context');
  if (fresh) url.searchParams.set('fresh', '1');
  return url;
}
async function call(kind, session, body, context = false, fresh = false) {
  const until = Date.now() + 60000;
  for (;;) {
    let response;
    try {
      // Resolve on every attempt: Pleiad may have moved while this CLI stayed alive.
      response = await fetch(endpoint(kind, session, context, fresh), {
        method: body ? 'POST' : 'GET',
        headers: {authorization: 'Bearer ' + SECRET, ...(body ? {'content-type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
    } catch {
      if (Date.now() >= until) throw new Error('Pleiad relay connection failed');
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    if (!response.ok) throw new Error('Pleiad relay rejected this conversation');
    return response.json();
  }
}

export default {
  id: 'pleiad',
  async setup(ctx) {
    const registrations = [];
    registrations.push(await ctx.session.hook('prompt', async event => {
      try {
        const context = await call('env',event.sessionID,undefined,true);
        const required = context.requiredServers ?? [];
        const until = Date.now()+30000;
        while(required.length && Date.now()<until) {
          const tools = await ctx.tool.list();
          if(required.every(name=>tools.some(tool=>tool.options?.namespace===name)))break;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
      } catch { /* Discovery errors are enforced at tool admission. */ }
    }));
    registrations.push(await ctx.shell.hook('create.before', event => {
      for (const key of Object.keys(event.env)) {
        if (/^PLEIAD_OPENCODE_/i.test(key) || /^OPENCODE_(SERVER_)?PASSWORD$/i.test(key)) delete event.env[key];
      }
    }));
    registrations.push(await ctx.tool.hook('execute.before', async event => {
      const verdict = await call('hook', event.sessionID, {session: event.sessionID, phase: 'before', tool: event.tool, args: event.input ?? {}});
      if (verdict?.block || verdict?.error) throw new Error(String(verdict.block ?? verdict.error));
      if (verdict?.args && typeof verdict.args === 'object') event.input = verdict.args;
    }));
    registrations.push(await ctx.tool.hook('execute.after', async event => {
      try {
        const output = event.status === 'completed' ? (event.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n') : String(event.error?.message ?? '');
        const verdict = await call('hook', event.sessionID, {session: event.sessionID, phase: 'after', tool: event.tool, args: event.input ?? {}, output});
        if (verdict?.append && event.status === 'completed') event.result = {...event.result, content: [...event.result.content, {type: 'text', text: String(verdict.append)}]};
      } catch { /* A completed tool must survive a late auxiliary callback. */ }
    }));
    for (const name of ['context', 'compaction', 'title', 'generate']) {
      registrations.push(await ctx.session.hook(name, async event => {
        try {
          const context = await call('env', event.sessionID, undefined, true);
          if (context.omitMessageIDs?.length) {
            const omitted = new Set(context.omitMessageIDs);
            event.messages = event.messages.filter(message => !omitted.has(message.id));
          }
          // 圧縮済みの recent-context には元の発言 ID が残らない。
          // 指示を読み込んだ synthetic の本文と一致する箇所だけを除く。
          for(const text of context.omitTexts ?? []) {
            const synthetic='[Synthetic context]: '+text;
            for(const message of event.messages ?? []) {
              for(const part of message.content ?? [])if(part.type==='text' && part.text.includes('<conversation-checkpoint>'))
                part.text=part.text.replaceAll(synthetic,'');
            }
          }
          if (context.system) event.system.push({type: 'text', text: context.system});
        } catch { /* Auxiliary hooks cannot fail in the v2 plugin contract. */ }
      }));
    }
    // v2 の再圧縮は、フック後に保存済み recent を取り直す場合がある。
    // その再構成分も、provider へ送る直前に同じ本文一致で除く。
    if(PLY_INSTRUCTIONS)registrations.push(await ctx.session.hook('http.request',async event=>{
      let guarded=PLY_INSTRUCTIONS;
      try {
        const context=await call('env',event.sessionID,undefined,true,true);
        if(!context.omitTexts?.length || !event.request.headers.get('content-type')?.includes('application/json'))return;
        guarded=true;
        const codec=encoding(event.request.headers.get('content-encoding'));
        if(!codec.decode || !codec.encode){event.request=blockedRequest(event.sessionID);return;}
        const original=Buffer.from(codec.decode(Buffer.from(await event.request.clone().arrayBuffer()))).toString('utf8');
        const body=JSON.parse(original);
        const next=JSON.stringify(omitSynthetic(body,context.omitTexts));
        if(next===JSON.stringify(body))return;
        // SigV4 は署名済みの本文を変更できない。秘密や元の本文を転送せず理由を返す。
        if(/^AWS4-HMAC-SHA256\b/.test(event.request.headers.get('authorization')??'')){event.request=blockedRequest(event.sessionID);return;}
        const headers=new Headers(event.request.headers);headers.delete('content-length');
        event.request=new Request(event.request,{headers,body:codec.encode(Buffer.from(next))});
      }catch { if(guarded)event.request=blockedRequest(event.sessionID); }
    }));
    if(PLY_INSTRUCTIONS)registrations.push(await ctx.session.hook('experimental.ws.send',async event=>{
      try {
        const context=await call('env',event.sessionID,undefined,true,true);
        if(context.omitTexts?.length)event.frame=JSON.stringify(omitSynthetic(JSON.parse(event.frame),context.omitTexts));
      }catch {throw new Error('Pleiad instruction context is unavailable');}
    }));
    return async () => { for (const registration of registrations) await registration.dispose(); };
  },
};
