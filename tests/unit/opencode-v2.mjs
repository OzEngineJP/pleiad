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

  // 履歴の索引から読んだ古い会話が、今の OpenCode には無い。別のターンの承認・質問を巻き込まない。
  for(const kind of ['permission','form']) {
    const lookups=[];
    let unavailable=false;
    const stale=createV2Protocol({publish:()=>{},call:async(method,url)=>{
      lookups.push(url);
      if(url==='/api/session')return {data:[],cursor:{}};
      if(url.startsWith('/api/session/gone/'))throw Object.assign(new Error('Conversation not found'),{status:404});
      if(unavailable&&url.startsWith('/api/session/unavailable/'))throw Object.assign(new Error('Temporarily unavailable'),{status:503});
      if(url.endsWith('/permission'))return {data:[{id:'live-permission',sessionID:'live',action:'shell',resources:[],save:[]}]};
      if(url.endsWith('/form'))return {data:[{id:'live-form',sessionID:'live',fields:[]}]};
      return {data:[],cursor:{}};
    }});
    await assert.rejects(stale.request('GET','/session/gone/message'),{status:404});
    stale.begin('live',1,true);
    const route=kind==='permission'?'/permission':'/question';
    assert.equal((await stale.request('GET',route))[0].sessionID,'live');
    await stale.request('GET',route);
    assert.equal(lookups.filter(url=>url===`/api/session/gone/${kind}`).length,1);
    stale.begin('unavailable');
    unavailable=true;
    await assert.rejects(stale.request('GET',route),{status:503});
    unavailable=false;
    stale.begin('gone',1,true);
    await assert.rejects(stale.request('GET',route),{status:404});
    t.ok(`${kind}: 非実行中の 404 だけ除外し、実行中の 404 と一時障害は伝える`,true);
  }

  events.length=0;active={};inbox.set(sid,[{id:'msg_waiting'}]);
  await protocol.resync();assert(!events.some(e=>e.type==='session.idle'));
  inbox.set(sid,[]);await protocol.resync();assert(events.some(e=>e.type==='session.idle'));
  t.ok('A queued inbox item prevents a false idle result',true);

  // プロバイダーの 4xx で即終わった失敗（issue #103）: 受理（admitted）の記録が付く前・失われた後に届いても、
  // このターンの失敗として締める（落とすと session.idle が届かず「返答が来ない」まま残る）
  events.length=0;
  protocol.begin('fresh',1);            // turns はあるが admitted は無い（受理の記録より先の失敗・受理が失われた失敗）
  await protocol.event({type:'session.execution.failed',data:{sessionID:'fresh',error:{type:'provider.invalid-request',message:'region not allowed',status:400}}});
  const earlyError=events.find(e=>e.type==='session.error');
  assert(earlyError&&earlyError.properties.error.message==='region not allowed'&&events.some(e=>e.type==='session.idle'));
  events.length=0;
  protocol.begin('fresh2',1);
  await protocol.event({type:'session.execution.failed',data:{sessionID:'fresh2'}});
  assert(events.some(e=>e.type==='session.error'&&e.properties.error.message==='OpenCode execution failed')&&events.some(e=>e.type==='session.idle'));
  events.length=0;
  protocol.begin('fresh3',1);
  await protocol.event({type:'session.execution.succeeded',data:{sessionID:'fresh3'}});
  await protocol.event({type:'session.execution.failed',data:{sessionID:'stranger',error:{message:'foreign'}}});
  assert(!events.some(e=>['session.error','session.idle'].includes(e.type)));
  t.ok('A provider failure closes the turn even before admission is recorded; foreign executions still do not end it',true);

  // 受理の応答を待つ間に届いた、同じ会話の別の実行（TUI 側・前のターンの遅延）の終了で誤って締めない（issue #101 系のレビュー）。
  // 実行の終了の出来事には実行の id が無いので、ターンの開始（begin の時刻）より前に起きたものは捨て、
  // 受理前の失敗でも発言がまだ inbox に残っているなら前の実行のものとして捨てる
  events.length=0;
  protocol.begin('stale',1000);            // ターンは始まった（受理はまだ）
  await protocol.event({type:'session.execution.failed',created:999,data:{sessionID:'stale',error:{message:'previous run'}}});
  assert(!events.some(e=>['session.error','session.idle'].includes(e.type)));
  await protocol.event({type:'session.execution.failed',created:1001,data:{sessionID:'stale',error:{message:'this run'}}});
  assert(events.some(e=>e.type==='session.error'&&e.properties.error.message==='this run')&&events.some(e=>e.type==='session.idle'));
  events.length=0;
  inbox.set('queued',[ {id:'msg_ours'} ]);  // 発言がまだ並んでいる間に届いた失敗は前の実行のもの
  protocol.begin('queued',1000,false,'msg_ours');
  await protocol.event({type:'session.execution.failed',created:1001,data:{sessionID:'queued',error:{message:'previous run'}}});
  assert(!events.some(e=>['session.error','session.idle'].includes(e.type)));
  inbox.set('queued',[]);
  await protocol.event({type:'session.execution.failed',created:1002,data:{sessionID:'queued',error:{message:'ours'}}});
  assert(events.some(e=>e.type==='session.error'&&e.properties.error.message==='ours'));
  t.ok('A stale or still-queued foreign execution end does not close the turn; a fresh one does',true);

  // 履歴の idle 記録（type:'idle', outcome:'failed', error）もターンの失敗になる
  const idleError={type:'provider.invalid-request',message:'region not allowed',status:400};
  const idleMapper=createTurnMapper({sessionId:'s2',emit:()=>{}});
  replayV2Messages([v2Message({id:'msg_idle',type:'idle',outcome:'failed',time:{created:1000},error:idleError},'s2')],e=>idleMapper.handle(e));
  assert(idleMapper.error?.message==='region not allowed'&&idleMapper.error?.name==='provider.invalid-request');
  t.ok('A failed idle record in history carries the provider error into the turn result',true);

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
