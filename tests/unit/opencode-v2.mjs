import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createV2Protocol,v2Message,replayV2Messages} from '../../core/backends/opencode-v2.mjs';
import {createTurnMapper,messagesToNormalized} from '../../core/backends/opencode-normalize.mjs';
import {backupV1Database,v2MigrationComplete,verifyV1Conversation} from '../../core/backends/opencode-migration.mjs';
import {loadSqlite} from '../../core/db.mjs';

export const name='opencode-v2';
export const title='OpenCode v2: delivery reconciliation, replay, child requests, forms, compaction and migration safety';
export default async function(t) {
  const messages=new Map(),inbox=new Map(),children=new Map(),calls=[],events=[];
  let active={},lost=false,pendingFailure=false;
  const call=async(method,url,{body,query={}}={})=>{
    calls.push({method,url,body,query});
    if(url==='/api/session/active')return {data:active};
    if(url==='/api/session')return {data:children.get(query.parentID)??[],cursor:{}};
    const [,sid,tail,id]=/^\/api\/session\/([^/]+)\/([^/]+)(?:\/([^/]+))?/.exec(url)??[];
    if(method==='GET'&&tail==='message') {
      if(id) {const message=(messages.get(sid)??[]).find(m=>m.id===id);if(!message)throw Object.assign(new Error('Not found'),{status:404});return {data:message};}
      return {data:messages.get(sid)??[],cursor:{}};
    }
    if(tail==='inbox'&&method==='GET')return {data:inbox.get(sid)??[]};
    if(method==='GET'&&['permission','form'].includes(tail)) {
      if(pendingFailure)throw new Error('Temporary lookup failure');
      return {data:sid==='child'?[tail==='permission'?{id:'permission_child',sessionID:sid,action:'shell',resources:['echo'],save:[]}:{id:'form_child',sessionID:sid,fields:[{key:'choice',title:'Choose',type:'string',options:[{label:'Visible',value:'wire-value'}]}]}]:[]};
    }
    if(tail==='prompt') {
      const receipt={id:body.id,sessionID:sid,time:{created:new Date(1000).toISOString()},type:'user',delivery:body.delivery};
      inbox.set(sid,[receipt]);
      if(lost){lost=false;throw new TypeError('Response lost after admission');}
      return {data:receipt};
    }
    return {data:null};
  };
  const protocol=createV2Protocol({call,publish:e=>events.push(e)});
  const sid='root',mid='msg_assistant';
  const mixed={id:mid,type:'assistant',time:{created:1000,completed:2000},content:[{type:'reasoning',text:'Think'},{type:'text',text:'Hello'},{type:'tool',id:'call_one',name:'read',state:{status:'completed',input:{},content:[]}},{type:'text',text:' world'},{type:'reasoning',text:'Done'}],tokens:{input:10,output:3},cost:0.1};
  const projected=v2Message(mixed,sid);
  assert.deepEqual(projected.parts.slice(0,5).map(p=>p.id),[`${mid}:reasoning:0`,`${mid}:text:0`,`${mid}:tool:call_one`,`${mid}:text:1`,`${mid}:reasoning:1`]);
  const normalized=[];
  const mapper=createTurnMapper({sessionId:sid,emit:e=>normalized.push(e)});
  const consume=()=>{for(const event of events.splice(0))mapper.handle(event);};
  await protocol.event({id:'evt_start',type:'session.text.started',created:1000,data:{sessionID:sid,assistantMessageID:mid,ordinal:0,text:''}});
  await protocol.event({id:'evt_delta',type:'session.text.delta',created:1000,data:{sessionID:sid,assistantMessageID:mid,ordinal:0,delta:'Hel'}});consume();
  messages.set(sid,[mixed]);protocol.begin(sid,1,true);
  active={[sid]:{}};
  await protocol.resync();consume();
  await protocol.event({id:'evt_delta',type:'session.text.delta',created:1000,data:{sessionID:sid,assistantMessageID:mid,ordinal:0,delta:'Hel'}});consume();
  await protocol.event({id:'evt_end',type:'session.execution.succeeded',created:2000,data:{sessionID:sid}});consume();
  assert.equal(normalized.filter(e=>e.type==='text.delta').map(e=>e.text).join(''),'Hello world');
  assert.equal(mapper.usage.costUsd,0.1);
  assert.equal(mapper.usage.inputTokens,10);
  t.ok('Mixed text/reasoning counters keep stable identities across live deltas, snapshots and terminal replay',true);

  const partial=createTurnMapper({sessionId:sid,emit:()=>{}});
  const usage=(tokens,cost)=>partial.handle({type:'message.part.updated',properties:{part:{id:'usage',messageID:mid,sessionID:sid,type:'step-finish',tokens,cost}}});
  usage({input:0,output:0},0);usage({input:10,output:3},0.1);usage({input:10,output:3},0.1);usage({input:0},0);
  assert.equal(partial.usage.inputTokens,10);assert.equal(partial.usage.costUsd,0.1);
  t.ok('A partial snapshot cannot freeze zero usage or add the same usage twice',true);

  lost=true;
  const receipt=await protocol.request('POST',`/session/${sid}/prompt_async`,{body:{id:'msg_stable',parts:[{type:'text',text:'identical body'}]}});
  assert.equal(receipt.id,'msg_stable');
  assert.equal(calls.filter(c=>c.url.endsWith('/prompt')).length,1);
  messages.set(sid,[{id:'msg_delivered',type:'user',text:'identical body',time:{created:1000}}]);
  const delivered=await protocol.request('GET',`/session/${sid}/delivery/msg_delivered`);
  assert.equal(delivered.delivered,true);
  t.ok('A lost admission response is recovered from the inbox or exact message ID without another write',true);

  children.set(sid,[{id:'child',parentID:sid}]);children.set('child',[{id:'grandchild',parentID:'child'}]);
  protocol.begin(sid,1,true);
  const permissions=await protocol.request('GET','/permission');
  assert(permissions.some(p=>p.sessionID==='child'));
  assert(events.some(e=>e.type==='pleiad.child'&&e.properties.childId==='grandchild'));
  await protocol.request('GET','/question');
  await protocol.request('POST','/question/form_child/reply',{body:{answers:[['Visible']]}});
  assert.deepEqual(calls.at(-1).body,{answer:{choice:'wire-value'}});
  pendingFailure=true;await assert.rejects(protocol.request('GET','/permission'),/lookup failure/);pendingFailure=false;
  t.ok('Reconnect discovers children recursively, restores requests, maps choice values and propagates failed lookups',true);

  events.length=0;active={};inbox.set(sid,[{id:'msg_waiting'}]);
  await protocol.resync();assert(!events.some(e=>e.type==='session.idle'));
  inbox.set(sid,[]);await protocol.resync();assert(events.some(e=>e.type==='session.idle'));
  t.ok('A queued inbox item prevents a false idle result',true);

  const raced=[];let read=0;
  const race=createV2Protocol({publish:event=>raced.push(event),call:async(method,url)=>{
    if(url.endsWith('/message'))return {data:[{...mixed,content:[{type:'text',text:++read===1?'Partial':'Final'}],...(read===1?{time:{created:1000},tokens:{input:0},cost:0}: {})}],cursor:{}};
    if(url==='/api/session/active')return {data:{}};
    return {data:[],cursor:{}};
  }});
  race.begin(sid,1,true);await race.resync();
  const lastText=raced.findLast(e=>e.properties?.part?.type==='text');
  assert.equal(lastText.properties.part.text,'Final');
  assert(raced.indexOf(lastText)<raced.findIndex(e=>e.type==='session.idle'));
  assert.equal(raced.findLast(e=>e.properties?.part?.type==='step-finish').properties.part.cost,0.1);
  t.ok('A turn finishing between history and active lookups replays final text and cost before idle',true);

  const replayed=[];
  const retry={attempt:2,at:5000,error:{message:'Wait',response:{body:JSON.stringify({error:{type:'FreeUsageLimitError'}})}}};
  replayV2Messages([v2Message({...mixed,time:{created:1000},retry},sid),v2Message({...mixed,id:'old',retry},sid),v2Message({id:'compact',type:'compaction',status:'completed',summary:'Checkpoint',tokens:{input:9},cost:0.2},sid)],e=>replayed.push(e));
  assert.equal(replayed.filter(e=>e.type==='session.status').length,1);
  assert.equal(replayed.find(e=>e.type==='session.status').properties.status.action.reason,'free_tier_limit');
  assert(replayed.some(e=>e.type==='pleiad.compaction'));
  assert(!replayed.some(e=>e.properties?.part?.text==='Checkpoint'));
  assert(replayed.some(e=>e.properties?.part?.id==='compact:usage'));
  t.ok('Replay restores an unfinished retry and compaction boundary without replaying a past retry or summary as chat',true);

  const compaction=status=>v2Message({id:'msg_compact',type:'compaction',status,reason:'manual',summary:'Summary',time:{created:1000},tokens:{input:12,output:2},cost:0.05},sid);
  assert.equal(messagesToNormalized([compaction('running')]).length,0);
  assert.equal(messagesToNormalized([compaction('failed')]).length,0);
  assert.equal(messagesToNormalized([compaction('completed')])[0].kind,'compactSummary');
  assert.equal(compaction('failed').parts[0].id,'msg_compact:usage');
  t.ok('Only completed compactions become boundaries; failed compactions retain their usage',true);

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pleiad-v2-migration-'));
  const file=path.join(dir,'opencode.db');
  const {DatabaseSync}=loadSqlite();let db=new DatabaseSync(file);
  try {
    db.exec('create table session(id text); create table session_v2(id text); create table kv(key text,value text); create table message(id text,session_id text,time_created integer,data text); create table part(message_id text,session_id text,data text,id text); create table session_message(id text,session_id text,seq integer,type text,data text);');
    db.prepare('insert into session values(?)').run(sid);
    db.prepare('insert into message values(?,?,?,?)').run('msg_old',sid,1,JSON.stringify({role:'user'}));
    db.prepare('insert into part values(?,?,?,?)').run('msg_old',sid,JSON.stringify({type:'text',text:'retained'}),'part_old');
    assert.equal(v2MigrationComplete(db),false);
    const backup=backupV1Database(file);assert(fs.existsSync(backup));
    assert.throws(()=>verifyV1Conversation(file,sid),{code:'OPENCODE_MIGRATION_LOSS'});
    db.prepare('insert into session_v2 values(?)').run(sid);
    db.prepare('insert into kv values(?,?)').run('migration.v1-v2',JSON.stringify({phase:'completed'}));
    db.prepare('insert into session_message values(?,?,?,?,?)').run('msg_old',sid,0,'user',JSON.stringify({text:'retained'}));
    verifyV1Conversation(file,sid);
    db.prepare('insert into part values(?,?,?,?)').run('msg_old',sid,JSON.stringify({type:'file',mime:'text/plain',url:'data:text/plain;base64,aGk='}),'part_inline');
    assert.throws(()=>verifyV1Conversation(file,sid),{code:'OPENCODE_MIGRATION_LOSS'});
    db.prepare('update session_message set data=? where id=?').run(JSON.stringify({text:'retained',files:[{mime:'text/plain',data:'aGk='}]}),'msg_old');
    verifyV1Conversation(file,sid);
    db.prepare('insert into part values(?,?,?,?)').run('msg_old',sid,JSON.stringify({type:'file',url:'file:///missing.png'}),'part_file');
    assert.throws(()=>verifyV1Conversation(file,sid),{code:'OPENCODE_MIGRATION_LOSS'});
    t.ok('Migration snapshots a consistent database and blocks partial or lossy conversation resumes',true);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
}
