// 実 bridge と hub に、一時的な CDP 開始失敗を与える。低い段への復元と再試行を仮想時計で確認する。
export async function checkScreencastRecovery(createBridge, createHub, t) {
  const metadata={deviceWidth:400,deviceHeight:400,pageScaleFactor:1,offsetTop:0,scrollOffsetX:0,scrollOffsetY:0};
  const low={tier:3,quality:55,maxWidth:268,maxHeight:268}, high={tier:6,quality:80,maxWidth:400,maxHeight:400};
  async function rig(multi=true) {
    let clock=0, id=0, fail=0, failRestore=0;
    const timers=new Set(), views=[], attempts=[];
    const host={summary:()=>({tabs:1,operating:false}),tabs:()=>[{targetId:'A',windowId:1}],current:()=> 'A',onChange:()=>()=>{},focus:async()=>{},
      async attach(_session,_tab,event){
        const view={active:true,running:false,format:null,
          async send(method,params){
            if(method==='Page.startScreencast'){
              attempts.push(params.quality);
              if(params.quality===80 && fail-->0)throw new Error('temporary start failure');
              if(params.quality===55 && failRestore-->0)throw new Error('temporary restore failure');
              view.format=params;view.running=true;
              queueMicrotask(()=>{if(view.active && view.running)event('Page.screencastFrame',{sessionId:++id,data:params.quality===80?'sharp':'low',metadata});});
            }
            if(method==='Page.stopScreencast')view.running=false;
            return {};
          },async detach(){view.active=false;view.running=false;},
        };views.push(view);return view;
      }};
    const bridge=createBridge({host,relay:{onTabEvent:()=>()=>{},unify:{tabHolder:{holder:()=>null}}}});
    const hub=createHub({bridge:multi?bridge:{...bridge,setFormats:undefined},now:()=>clock,setTimer(fn,ms){const timer={fn,at:clock+ms};timers.add(timer);return timer;},clearTimer(timer){timers.delete(timer);}});
    const flush=async()=>{for(let n=0;n<150;n++)await Promise.resolve();};
    const advance=async ms=>{const end=clock+ms;await flush();let guard=0;for(;;){const timer=[...timers].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!timer)break;if(++guard>1000)throw Error('retry loop');timers.delete(timer);clock=timer.at;timer.fn();await flush();}clock=end;await flush();};
    return {bridge,hub,attempts,advance,flush,set fail(n){fail=n;},set failRestore(n){failRestore=n;},running:()=>views.filter(v=>v.active&&v.running),close:async()=>{bridge.close();await flush();}};
  }
  {
    const r=await rig();
    try {
      await r.bridge.request('start','s',{options:{formats:[low]}});r.fail=1;
      const error=await r.bridge.setFormats('s',[high]).then(()=>null,e=>e.message);await r.flush();
      t.ok('bridge: 張り直し失敗を呼び出し元へ返す',error==='temporary start failure');
      t.ok('bridge: 張り直し失敗後も前の設定の配信が生きる',r.running().length===1 && r.running()[0].format.quality===55);
      await r.bridge.setFormats('s',[high]);await r.flush();
      t.ok('bridge: 同じ最上段の設定を再試行して復旧できる',r.running().length===1 && r.running()[0].format.quality===80);
    } finally {await r.close();}
  }
  for(const multi of [true,false]) for(const failures of [1,2]) {
    const r=await rig(multi), frames=[];
    const client={send(m){if(m.type==='frame'){frames.push(m.data);queueMicrotask(()=>r.hub.received(client,'s',m.seq));}}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=failures;await r.advance(300);
      t.ok(`${multi?'段別':'共有'}hub/${failures}回失敗: 高画質開始が失敗しても低い段の配信へ戻る`,r.running().length===1 && r.running()[0].format.quality===55 && frames.at(-1)==='low');
      await r.advance(10000);
      t.ok(`${multi?'段別':'共有'}hub/${failures}回失敗: 外からの更新なしで再試行して鮮明な絵が届く`,r.running().length===1 && r.running()[0].format.quality===80 && frames.at(-1)==='sharp');
      const before=r.attempts.length;await r.advance(60000);
      t.ok(`${multi?'段別':'共有'}hub/${failures}回失敗: 成功後は張り直しを繰り返さない`,r.attempts.length===before);
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
  for(const multi of [true,false]) {
    const r=await rig(multi), frames=[];
    const client={send(m){if(m.type==='frame'){frames.push(m.data);queueMicrotask(()=>r.hub.received(client,'s',m.seq));}}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=1;r.failRestore=1;await r.advance(300);
      t.ok(`${multi?'段別':'共有'}: 前の配信の復元自体が失敗する条件を試す`,r.running().length===0 && r.attempts.at(-1)===55);
      await r.advance(10000);
      t.ok(`${multi?'段別':'共有'}: 復元にも失敗しても再試行して映像が戻る`,r.running().length===1 && frames.at(-1)==='sharp');
      r.fail=1000;
      await r.hub.watch(client,'s',{width:500,height:400});
      await r.hub.unwatch(client,'s');const before=r.attempts.length;await r.advance(60000);
      t.ok(`${multi?'段別':'共有'}: 最後の閲覧者が閉じた後は再試行しない`,r.attempts.length===before && r.running().length===0);
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
}
