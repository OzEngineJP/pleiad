// OpenCode v2 HTTP/SSE transport. The holder owns the --stdio lease during updates.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { spawnCli } from '../cli-installation.mjs';
import { killTree } from './antigravity-background.mjs';
import { createV2Protocol } from './opencode-v2.mjs';
import { opencodeRelay } from '../opencode-relay.mjs';
import {t} from '../i18n.mjs';

const START_TIMEOUT_MS = Number(process.env.AGENT_HOST_OPENCODE_START_MS) || 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
export function startupUrl(line) {
  let parsed;try {parsed=JSON.parse(line);}catch{return null;}
  try {
    const url=new URL(parsed?.url);
    return url.protocol==='http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname) && !url.username && !url.password ? url.origin : null;
  }catch{return null;}
}

export function createOpencodeServer({ command, env=async()=>({}), beforeStart=()=>{}, afterStart=()=>{}, held=null, account=null, origin=async()=>null, currentOrigin=()=>null, busy=()=>false }) {
  let proc=null, heldChild=null, base=null, auth=null, servedOrigin=null, starting=null, stream=null, retired=false, exitHooked=false;
  const listeners=new Set(),goneListeners=new Set();
  const accountId=account?.id ?? 'login';
  const publish=event=>{for(const fn of listeners)try{fn(event);}catch(err){console.error('  opencode: event listener failed:',err?.message);}};
  const protocol=createV2Protocol({call:rawRequest,publish,setSystem:(id,text)=>opencodeRelay.setSystem(id,text,accountId)});

  function lost(reason) {
    proc=null;heldChild=null;base=null;auth=null;servedOrigin=null;stream?.abort();stream=null;
    for(const fn of goneListeners)try{fn(new Error(`opencode serve exited: ${String(reason).slice(0,200)}`));}catch{}
  }
  async function verify() {
    const info=await rawRequest('GET','/api/info');
    const version=String(info?.version ?? info?.data?.version ?? '');
    const match=/^2\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
    if(!match || (Number(match[1])===0 && Number(match[2])<32))throw new Error(t('opencode.errors.version',{version:version||'unknown'}));
    const schema=await rawRequest('GET','/openapi.json');
    if(schema?.info?.title!=='opencode HttpApi' || !schema.paths?.['/api/session'] || !schema.paths?.['/api/event'])throw new Error('OpenCode v2 API schema does not match');
    const until=Date.now()+15*60_000;
    for(;;) {
      const migration=await rawRequest('GET','/api/experimental/migration/v1');
      if(migration?.status==='completed')break;
      if(migration?.status==='error')throw new Error(t('opencode.errors.migrationFailed'));
      if(!['required','running'].includes(migration?.status) || Date.now()>=until)throw new Error(t('opencode.errors.migrationPending'));
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    await afterStart(rawRequest);
  }
  async function start() {
    const argv=command();if(!argv)throw Object.assign(new Error('opencode is not installed'),{code:'NOT_INSTALLED'});
    const h=held?await held.acquire({argv,allowSpawn:Boolean(currentOrigin())}).catch(()=>null):null;
    if(h?.server?.base && !h.closed && !h.detached) {
      if(h.server.protocol!==2) {
        if(h.cards.size)throw new Error('OpenCode v1 is still running a turn; wait for it to finish before switching to v2');
        await h.stop();
        return start();
      }
      if(currentOrigin())await env();
      heldChild=h;base=h.server.base;auth=h.server.auth;servedOrigin=h.server.origin;
      h.onGone(exit=>{if(heldChild===h)lost(exit.code ?? exit.signal ?? exit.error);});
      try{await verify();await openStream();}catch(err){heldChild=null;base=null;auth=null;throw err;}
      return;
    }
    if(!currentOrigin())throw Object.assign(new Error('OpenCode cannot start before Pleiad is listening'),{code:'OPENCODE_ORIGIN_NOT_READY'});
    const password=crypto.randomBytes(24).toString('hex');
    const extra=await env();
    await beforeStart(extra);
    const childEnv={...process.env,...extra,OPENCODE_PASSWORD:password,OPENCODE_SERVER_PASSWORD:password,PLEIAD_OPENCODE_ACCOUNT:accountId,PLEIAD_OPENCODE_SECRET:opencodeRelay.token(accountId)};
    if(childEnv.OPENCODE_DB==='')delete childEnv.OPENCODE_DB;
    if(childEnv.OPENCODE_CONFIG==='')delete childEnv.OPENCODE_CONFIG;
    const args=['serve','--stdio','--port','0','--hostname','127.0.0.1'];
    auth=`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    try {
      if(h) {
        heldChild=h;
        const [file,...prefix]=argv;
        base=await h.spawn({command:file,args:[...prefix,...args],env:childEnv,cwd:process.cwd(),timeoutMs:START_TIMEOUT_MS});
        servedOrigin=await origin();
        h.setServer({protocol:2,base,auth,origin:servedOrigin,secret:extra.PLEIAD_OPENCODE_SECRET??null,...(account?{account}:{})});
        h.onGone(exit=>{if(heldChild===h)lost(exit.code ?? exit.signal ?? exit.error);});
      } else {
        const child=spawnCli(argv,args,{env:childEnv,stdio:['pipe','pipe','pipe']});
        proc=child;
        // Provider stderr is private; report startup status without echoing it.
        child.stderr.on('data',()=>{});
        base=await new Promise((resolve,reject)=>{
          let buffer='';
          const finish=(err,url)=>{clearTimeout(timer);child.stdout.off('data',look);child.off('error',onError);child.off('exit',onExit);err?reject(err):resolve(url);};
          const onError=err=>finish(err),onExit=code=>finish(new Error(`OpenCode exited during startup (${code})`));
          const look=chunk=>{
            buffer+=String(chunk);
            if(buffer.length>64*1024)return finish(new Error('OpenCode startup notification is too large'));
            let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);const url=startupUrl(line);if(url)return finish(null,url);}
          };
          const timer=setTimeout(()=>finish(new Error(`OpenCode did not start in ${START_TIMEOUT_MS}ms`)),START_TIMEOUT_MS);timer.unref?.();
          child.stdout.on('data',look);child.once('error',onError);child.once('exit',onExit);
        });
        child.stdout.on('data',()=>{});
        child.once('exit',code=>{if(proc===child)lost(code);});
        if(!exitHooked){exitHooked=true;process.once('exit',stopSync);}
        servedOrigin=await origin();
      }
      await verify();await openStream();
    } catch(err) {await stopNow();throw err;}
  }
  async function ensure() {
    if(retired)throw new Error('OpenCode was handed over to the next Pleiad server');
    if(starting){await starting;return {base,auth};}
    const now=currentOrigin(),moved=Boolean(base&&now&&servedOrigin!==now);
    if(!moved&&(proc||heldChild)&&base)return {base,auth};
    starting??=(async()=>{
      if(moved) {await env();servedOrigin=now;if(heldChild)heldChild.setServer({...heldChild.server,origin:now});}
      if(!((proc||heldChild)&&base))await start();
    })().finally(()=>{starting=null;});
    await starting;return {base,auth};
  }
  async function rawRequest(method,path,{directory=null,body,query={},timeoutMs=REQUEST_TIMEOUT_MS,signal}={}) {
    if(!base)throw Object.assign(new Error('OpenCode server is unavailable'),{code:'OPENCODE_GONE'});
    const qs=new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)]));
    const res=await fetch(`${base}${path}${qs.size?'?'+qs:''}`,{method,headers:{authorization:auth,accept:'application/json',...(directory?{'x-opencode-directory':encodeURIComponent(directory)}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    if(!res.ok){await res.body?.cancel();throw Object.assign(new Error(`OpenCode ${method} ${path}: HTTP ${res.status}`),{status:res.status});}
    if(res.status===204)return null;
    if(!res.headers.get('content-type')?.includes('application/json')){await res.body?.cancel();throw new Error(`OpenCode ${path}: expected JSON`);}
    return res.json();
  }
  function openStream() {
    stream?.abort();const ac=new AbortController();stream=ac;
    let connected=false;
    return new Promise((ready,reject)=>{
      const startup=setTimeout(()=>{if(!connected){ac.abort();reject(new Error('OpenCode event stream did not connect'));}},START_TIMEOUT_MS);startup.unref?.();
      void (async()=>{
        while(!ac.signal.aborted&&base) {
          try {
            const res=await fetch(`${base}/api/event`,{headers:{authorization:auth,accept:'text/event-stream'},signal:ac.signal});
            if(!res.ok||!res.body||!res.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Invalid OpenCode event stream');
            const decoder=new TextDecoder();let buffer='',data=[];
            for await(const chunk of res.body) {
              buffer+=decoder.decode(chunk,{stream:true});
              if(buffer.length>4*1024*1024)throw new Error('OpenCode event exceeded the size limit');
              let at;while((at=buffer.indexOf('\n'))>=0) {
                const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);
                if(line.startsWith('data:'))data.push(line.slice(5).trimStart());
                if(line===''&&data.length){const raw=JSON.parse(data.join('\n'));data=[];
                  if(raw.type==='server.connected') {if(connected)await protocol.resync();else{connected=true;clearTimeout(startup);ready();}}
                  else await protocol.event(raw);
                }
              }
            }
          }catch(err){if(ac.signal.aborted)break;console.error('  opencode: event stream dropped:',String(err?.message??err).slice(0,160));}
          if(!ac.signal.aborted)await new Promise(r=>{const timer=setTimeout(r,500);timer.unref?.();});
        }
        clearTimeout(startup);
      })();
    });
  }
  function stopSync() {
    const child=proc;proc=null;if(!child?.pid)return;
    try{if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGKILL');}catch{}
  }
  async function stopNow() {
    const child=proc,h=heldChild;stream?.abort();stream=null;proc=null;heldChild=null;base=null;auth=null;servedOrigin=null;
    if(h)await h.stop();else if(child?.pid) {
      const exited=child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve));
      child.stdin?.end();
      const closed=await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))]);
      if(!closed)await killTree(child.pid).catch(()=>child.kill('SIGKILL'));
      await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2000))]);
    }
  }
  return {ensure,relayAccount:accountId,async request(method,path,options){await ensure();return protocol.request(method,path,options);},
    begin:(id,since,accepted)=>protocol.begin(id,since,accepted),resync:options=>protocol.resync(options),
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},onGone(fn){goneListeners.add(fn);return()=>goneListeners.delete(fn);},
    get running(){return Boolean((proc||heldChild)&&base);},get held(){return heldChild&&!heldChild.detached&&!heldChild.closed?heldChild:null;},
    handedOff(){retired=true;stream?.abort();stream=null;heldChild=null;base=null;auth=null;servedOrigin=null;},stop:stopNow};
}
