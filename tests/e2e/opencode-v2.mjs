import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export const name='opencode-v2';
export const title='OpenCode v2 actual CLI: MCP, Code Mode approval, hooks and instruction isolation';
export const serverEnv={AGENT_HOST_BACKENDS:'fake'};
export default async function(t,ctx) {
const root=ctx.root;
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pleiad-v2-turn-'));
const vars={};
for(const name of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','TEMP','TMP']) {vars[name]=path.join(temp,name);await fs.mkdir(vars[name],{recursive:true});}
for(const name of Object.keys(process.env))if(/API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN/.test(name))vars[name]='';
Object.assign(vars,{OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',OPENCODE_DISABLE_FILEWATCHER:'1',AGENT_HOST_BACKENDS:'opencode',AGENT_HOST_OPENCODE_BIN:process.env.AGENT_HOST_OPENCODE_BIN || 'opencode',OPENCODE_CONFIG:'',OPENCODE_DB:''});
vars.AGENT_HOST_OPENCODE_DATA=path.join(vars.XDG_DATA_HOME,'opencode');
const result={requests:[],turns:[]};
const authProvider=process.env.OPENCODE_E2E_AUTH_PROVIDER;
if(authProvider) {
  const {readAccountAuth}=await import('../../core/backends/opencode-accounts.mjs');
  const credential=readAccountAuth(null)[authProvider];
  assert.equal(credential?.type,'api','Service verification copies only an API credential, without refreshing OAuth');
  const data=path.join(vars.XDG_DATA_HOME,'opencode');await fs.mkdir(data,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(data,'auth.json'),JSON.stringify({[authProvider]:credential}),{mode:0o600,flag:'wx'});
}
await fs.mkdir(path.join(temp,'nested'),{recursive:true});
await fs.writeFile(path.join(temp,'nested','AGENTS.md'),'NATIVE_NESTED_ONLY');
await fs.writeFile(path.join(temp,'nested','note.txt'),'read fixture');
const model=http.createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const last=body.messages.findLast(m=>m.role==='user');
    const prompt=typeof last?.content==='string'?last.content:JSON.stringify(last?.content);
    const toolResults=body.messages.filter(m=>m.role==='tool');
    const wantsTool=/PROBE_TOOL|PROBE_DENY|PROBE_MCP|PROBE_READ/.test(prompt) && toolResults.length===0 && body.tools?.length>0;
    const marker=/PROBE_DENY/.test(prompt)?'FORBIDDEN':'ORIGINAL';
    const tools=body.tools?.map(t=>t.function?.name)??[];
    result.requests.push({path:req.url,stream:body.stream,tools,toolResults:toolResults.map(m=>String(m.content).slice(0,300)),wantsTool,nestedInstruction:JSON.stringify(body.messages).includes('NATIVE_NESTED_ONLY')});
    const fn=/PROBE_MCP/.test(prompt)?{name:'ply_agents_ply_task_list',arguments:'{}'}:/PROBE_READ/.test(prompt)?{name:'read',arguments:JSON.stringify({path:path.join(temp,'nested','note.txt')})}:{name:'execute',arguments:JSON.stringify({code:`return "${marker}"`})};
    const summary=/structured summary|consolidated summary|required summary template/.test(JSON.stringify(body.messages));
    const message=wantsTool?{role:'assistant',content:null,tool_calls:[{id:'call_probe',type:'function',function:fn}]}:{role:'assistant',content:summary?'## Objective\n- Preserve the fixture conversation.\n## Work State\n### Completed\n- Read the fixture.\n## Next Move\n- Continue.':'NATIVE_OK'};
    const finish=wantsTool?'tool_calls':'stop';
    res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});
    if(body.stream) {
      const delta=wantsTool?{role:'assistant',tool_calls:message.tool_calls.map((call,index)=>({index,...call}))}:message;
      const chunk=(delta,finish_reason=null,usage)=>res.write('data: '+JSON.stringify({id:'chatcmpl_probe',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'echo',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
      chunk(delta);chunk({},finish,{prompt_tokens:30,completion_tokens:5,total_tokens:35});res.end('data: [DONE]\n\n');
    }else res.end(JSON.stringify({id:'chatcmpl_probe',object:'chat.completion',created:Math.floor(Date.now()/1000),model:'echo',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:30,completion_tokens:5,total_tokens:35}}));
  }catch(error){result.mockError=String(error);res.writeHead(500);res.end();}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const config={model:'probe/echo',providers:{probe:{name:'Probe',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture'},models:{echo:{name:'Echo',limit:{context:100000,output:8000}}}}}};
await fs.mkdir(path.join(vars.XDG_CONFIG_HOME,'opencode'),{recursive:true});
await fs.writeFile(path.join(vars.XDG_CONFIG_HOME,'opencode','opencode.json'),JSON.stringify(config));
const {startServer}=await import(pathToFileURL(path.join(root,'tests/lib/server.mjs')));
const {open}=await import(pathToFileURL(path.join(root,'tests/lib/ws-client.mjs')));
let server,client;
try {
  server=await startServer({dataDir:path.join(temp,'data'),env:vars,timeoutMs:90000});
  client=await open({port:server.port,token:server.token,autoAllow:true});
  const rewrite=path.join(temp,'rewrite.mjs');
  await fs.writeFile(rewrite,`let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);if(String(i.tool_input?.code).includes('FORBIDDEN')){process.stderr.write('PROBE_BLOCKED');process.exit(2)}process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{code:'return "REWRITTEN"'}}}));});`);
  await client.cmd('savePlyHook',{value:{agent:'claude',targets:['opencode'],name:'v2-rewrite',event:'PreToolUse',matcher:'execute',command:`node "${rewrite}"`}});
  await client.cmd('setHooksOwner',{place:null,value:{owner:'ply',disabled:[]},revision:(await client.cmd('plyHooks',{})).revision});
  await client.cmd('setContextSettings',{cwd:temp,place:temp,kind:'instruction',value:{owner:'ply',user:null,directory:{sources:['common','opencode'],excludePaths:[]}}});
  let sessionId;
  for(const prompt of ['PROBE_MCP','PROBE_SIMPLE','PROBE_TOOL','PROBE_DENY','PROBE_READ']) {
    const requestStart=result.requests.length;
    const turn=await client.runTurn({backend:'opencode',cwd:temp,prompt,model:'probe/echo',mode:prompt==='PROBE_TOOL'?'ask':'full'},{ms:120000});
    sessionId=turn.sessionId;
    const text=turn.events.filter(e=>e.type==='text.delta').map(e=>e.text).join('');
    const tools=turn.events.filter(e=>e.type==='tool.result').map(e=>({text:e.text,isError:e.isError}));
    result.turns.push({prompt,outcome:turn.outcome,text,tools,errors:turn.events.filter(e=>e.type==='turnResult').map(e=>e.error)});
    assert.equal(turn.outcome,'ok');assert.equal(text,'NATIVE_OK');
    if(prompt==='PROBE_TOOL')assert(tools.some(t=>t.text?.includes('REWRITTEN')));
    if(prompt==='PROBE_DENY')assert(tools.some(t=>t.isError&&t.text?.includes('PROBE_BLOCKED')));
    if(prompt==='PROBE_MCP')assert(tools.some(t=>!t.isError&&t.text?.includes('tasks')));
    if(prompt==='PROBE_READ')assert(result.requests.slice(requestStart).every(r=>!r.nestedInstruction));
    if(prompt==='PROBE_TOOL')assert(turn.events.some(e=>e.type==='permission'&&e.toolName==='execute'));
  }
  const from=client.mark();
  const started=await client.cmd('compactConversation',{sessionId});
  assert.equal(started.status,'started');
  await client.waitFor(e=>e.type==='turnEnd'&&e.sessionId===sessionId,{from,ms:120000});
  assert(client.since(from).some(e=>e.type==='compaction'&&e.phase==='complete'));
  const before=result.requests.length;
  const resumed=await client.runTurn({sessionId,prompt:'Continue with exactly NATIVE_OK.',mode:'full'},{ms:120000});
  assert.equal(resumed.outcome,'ok');
  assert(result.requests.slice(before).every(r=>!r.nestedInstruction));
  result.compaction=true;
  if(process.env.OPENCODE_E2E_SERVICE!=='off') {
    const available=authProvider?Object.keys(await client.cmd('models',{backend:'opencode',cwd:temp})).filter(id=>id.startsWith(authProvider+'/')):[];
    const serviceModel=process.env.OPENCODE_E2E_SERVICE_MODEL || available.find(id=>id.endsWith('/openai/gpt-oss-20b')) || available[0] || 'opencode/big-pickle';
    const service=await client.runTurn({backend:'opencode',cwd:temp,prompt:'Connectivity check: reply exactly NATIVE_OK. Do not use tools.',model:serviceModel,mode:'plan'},{ms:180000});
    result.service={model:serviceModel,outcome:service.outcome,text:service.events.filter(e=>e.type==='text.delta').map(e=>e.text).join('').trim(),error:service.events.findLast(e=>e.type==='turnResult')?.error};
    assert.equal(service.outcome,'ok',JSON.stringify(result.service));assert.equal(result.service.text,'NATIVE_OK');
  }
}catch(error){result.error=String(error.stack??error);}
finally {
  client?.close();await server?.stop();await new Promise(resolve=>model.close(resolve));
  await fs.writeFile(path.join(ctx.work,'native-result.json'),JSON.stringify(result,null,2));
  await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}

if(result.error)throw new Error(result.error);
t.ok('Actual v2 CLI completes first-turn MCP, native tool approval, hooks and nested instruction isolation',result.turns.length===5);
t.ok('Native compaction completes and resumed model context excludes nested native instructions',result.compaction);
if(result.service)t.ok('The selected provider completes a real service request',result.service.outcome==='ok');
}
