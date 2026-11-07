// 同じ縮小 JPEG になる実画像を使い、止まった後は高画質の screencast 自体が変更を運ぶことを確かめる。
export async function checkScreencastSharp(createHub, t, images = null) {
  const pair = images ?? JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../fixtures/screencast-fine-detail.json', import.meta.url), 'utf8'));
  const flush = async () => { for (let i=0;i<16;i++) await Promise.resolve(); };
  async function rig({viewers=1, multi=true, initialState=true, restartDelay=0, scale=1}={}) {
    let time=1000, receive, state, formats=[], current=pair.sharp, id=0, captures=0, changes=0;
    const timers=new Set(), clients=[], histories=[];
    const clock={now:()=>time,setTimer(fn,ms){const timer={fn,at:time+ms};timers.add(timer);return timer;},clearTimer(timer){timers.delete(timer);}};
    const emit=(data,stream=formats[0]?.tier ?? 3,metadata=pair.metadata,tabId)=>receive('s',{id:++id,stream,data,metadata,format:formats.find(f=>f.tier===stream),...(tabId?{tabId}:{})});
    const initial=()=>{for (const f of formats) emit(f.quality===80 && f.maxWidth>=400 ? current : pair.low, f.tier);};
    const restart=list=>{formats=list;changes++;clock.setTimer(initial,restartDelay);};
    const bridge={onFrame(fn){receive=fn;},onState(fn){state=fn;},onEnded(){},ack(){},
      async request(action,argsId,{options}={}) {
        if(action==='start') {
          const s=Math.max(1,Math.min(2,options.scale ?? 1));
          restart(options.formats ?? [{tier:0,quality:options.quality,maxWidth:Math.round(Math.max(200,Math.min(1920,options.width*s))),maxHeight:Math.round(Math.max(200,Math.min(1920,options.height*s)))}]);
          if(initialState) state('s',{tabId:'A',sequence:1});
          return {state:{tabId:'A',sequence:1}};
        }
      },
      // 旧実装にも damage を与え、撮影ごとに反響2枚が返る条件で循環を検出する。
      capture(){captures++;clock.setTimer(()=>emit(pair.low),10);clock.setTimer(()=>emit(pair.low),20);return Promise.resolve({data:current});},
      ...(multi?{async setFormats(_id,list){restart(list);return {multi:true};}}:{}),
    };
    const hub=createHub({bridge,...clock});
    async function add(width=400) {
      const history=[];
      const c={hold:false,fast:false,send(m){if(m.type==='frame'){history.push(m);if(!c.hold)queueMicrotask(()=>{if(c.fast)hub.received(c,'s',m.seq,{mark:true});hub.received(c,'s',m.seq);});}}};
      clients.push(c);histories.push(history);await hub.watch(c,'s',{width,height:400,scale});return c;
    }
    for(let n=0;n<viewers;n++) await add();
    async function advance(ms) {
      const end=time+ms;await flush();let guard=0;
      for(;;){const timer=[...timers].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!timer)break;
        if(++guard>10000)throw new Error('静止中のタイマーが収束しない');timers.delete(timer);time=timer.at;timer.fn();await flush();}
      time=end;await flush();
    }
    return {advance,emit,add,hub,clients,histories,
      update(){current=pair.updatedSharp;initial();}, damage:initial,
      tab(tabId){state('s',{tabId,sequence:++id+10});initial();},
      state:(tabId,sequence)=>state('s',{tabId,sequence}),
      get captures(){return captures;},get changes(){return changes;},get formats(){return formats;},
      close:()=>Promise.all(clients.map(c=>hub.unwatch(c,'s')))};
  }
  for(const multi of [true,false]) for(const viewers of [1,2]) {
    const r=await rig({multi,viewers});await r.advance(1000);
    t.ok(`${multi?'段別':'共有'}/${viewers}台: 静まったら最上段の実 JPEG が全員に届く`,r.histories.every(h=>h.at(-1)?.data===pair.sharp));
    const before=r.changes, frames=r.histories.map(h=>h.length);
    await r.advance(60_000);
    t.ok(`${multi?'段別':'共有'}/${viewers}台: 静止60秒で撮影0回・張り直し0回・再送0枚`,r.captures===0 && r.changes===before && r.histories.every((h,i)=>h.length===frames[i]));
    r.update();await r.advance(1000);
    t.ok(`${multi?'段別':'共有'}/${viewers}台: 低画質では同じになる最後の細かい変更も全員に届く`,r.histories.every(h=>h.at(-1)?.data===pair.updatedSharp));
    t.ok(`${multi?'段別':'共有'}/${viewers}台: 単発の細かい変更で段を戻さず追加撮影もしない`,r.captures===0 && r.changes===before);
    for(const delay of [10,45,500,1500]){await r.advance(delay);r.damage();r.damage();}
    await r.advance(1000);
    t.ok(`${multi?'段別':'共有'}/${viewers}台: 遅い重複と重複2枚で静止中の処理が増えない`,r.changes===before && r.captures===0);
    await r.close();
  }
  {
    const r=await rig({multi:false,scale:0.75});await r.advance(1000);
    t.ok('表示倍率が1未満の共有配信でもChromeの撮影寸法と一致して鮮明な絵が届く',r.histories[0].at(-1)?.data===pair.sharp);
    await r.close();
  }
  {
    const r=await rig({initialState:false});await r.advance(0);r.damage();r.damage();await r.advance(1000);
    t.ok('最初の状態通知より早い重複でも例外にならず最上段へ移る',r.histories[0].at(-1)?.data===pair.sharp && r.captures===0);
    await r.close();
  }
  for(const restartDelay of [10,500]) {
    const r=await rig({restartDelay});await r.advance(300);r.update();await r.advance(restartDelay+1000);
    t.ok(`張り直しの途中に更新しても、最初の絵が${restartDelay}ms後に届いたとき本物の変更を捨てない`,r.histories[0].at(-1)?.data===pair.updatedSharp);
    const before=r.changes;await r.advance(10000);
    t.ok(`張り直しの応答が${restartDelay}msでも静止中は収束する`,r.changes===before && r.captures===0);
    await r.close();
  }
  {
    const r=await rig();await r.advance(1000);r.update();await r.advance(20);
    r.emit(pair.sharp,6);await r.advance(20);
    t.ok('高画質で変更が続いたら通信量に応じた段へ戻す',r.formats[0].tier===3);
    await r.advance(1000);
    t.ok('動きが止まれば再び最上段へ移り、1回の動きで切り替えは最大3回',r.formats[0].tier===6 && r.changes<=4);
    const before=r.changes;r.tab('B');await r.advance(1000);
    t.ok('タブ切り替え後の最初の絵で低画質へ戻さず、静止中の切り替えも増えない',r.changes===before);
    await r.add(600);await r.advance(1000);
    t.ok('静止中の追加閲覧者にも鮮明な絵が届く',r.histories.every(h=>h.at(-1)?.data===pair.updatedSharp));
    await r.close();
    const next=await rig();await next.advance(1000);
    t.ok('最後の閲覧者が閉じて開き直した後も最上段へ移る',next.histories[0].at(-1)?.data===pair.sharp && next.captures===0);
    await next.close();
  }
  {
    const r=await rig();await r.advance(0);r.clients[0].fast=true;
    for(let n=0;n<15;n++){r.emit(`moving-${n}`);await r.advance(10);}
    t.ok('通信が速ければ動作中にも最上段へ上がる',r.formats[0].tier===6);
    r.emit(pair.sharp,6);await r.advance(0);
    const lower=await r.add();await r.advance(0);await r.advance(1000);
    t.ok('既存の最上段を保ったまま静止しても、低い段の閲覧者へ鮮明な画像を渡す',r.histories[1].at(-1)?.data===pair.sharp);
    const before=r.changes;await r.add();await r.advance(60_000);
    t.ok('動作中も最上段だった場合、同寸法の追加閲覧者へ画像を渡し、余計に張り直さない',r.histories[2].at(-1)?.data===pair.sharp && r.changes===before);
    void lower;await r.close();
  }
  {
    const r=await rig();await r.advance(1000);
    r.emit(pair.updatedSharp,6,pair.metadata,'B');await r.advance(0);
    r.state('B',2);await r.advance(0);await r.add();await r.advance(60_000);
    t.ok('新タブの画像が状態より先でも、状態確定後の全閲覧者と追加閲覧者に届く',r.histories.every(h=>h.at(-1)?.data===pair.updatedSharp));
    await r.close();
  }
}
