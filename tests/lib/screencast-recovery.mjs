// 実 bridge と hub に、一時的な CDP 開始失敗を与える。低い段への復元と再試行を仮想時計で確認する。
export async function checkScreencastRecovery(createBridge, createHub, t) {
  const metadata={deviceWidth:400,deviceHeight:400,pageScaleFactor:1,offsetTop:0,scrollOffsetX:0,scrollOffsetY:0};
  const low={tier:3,quality:55,maxWidth:268,maxHeight:268}, high={tier:6,quality:80,maxWidth:400,maxHeight:400};
  async function rig(multi=true) {
    let clock=0, id=0, fail=0, failRestore=0, current='A', changed, gate=null;
    const timers=new Set(), views=[], attempts=[], starts=[];
    const host={summary:()=>({tabs:1,operating:false}),tabs:()=>[{targetId:current,windowId:1}],current:()=>current,onChange(fn){changed=fn;return()=>{};},focus:async()=>{},
      async attach(_session,_tab,event){
        const view={active:true,running:false,format:null,event,
          async send(method,params){
            if(method==='Page.startScreencast'){
              attempts.push(params.quality);
              starts.push({at:clock,quality:params.quality});
              if(params.quality===80&&gate)await gate.promise;
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
    return {bridge,hub,attempts,starts,advance,flush,set fail(n){fail=n;},set failRestore(n){failRestore=n;},
      later(fn,ms){timers.add({fn,at:clock+ms});},
      hold(){let release;const promise=new Promise(resolve=>{release=resolve;});gate={promise,release};},release(){const release=gate.release;gate=null;release();},
      emit(data){for(const v of views)if(v.active&&v.running)v.event('Page.screencastFrame',{sessionId:++id,data,metadata});},
      tab(tabId){current=tabId;changed('s','current');},
      running:()=>views.filter(v=>v.active&&v.running),close:async()=>{bridge.close();await flush();}};
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
  for(const multi of [true,false]) {
    const r=await rig(multi), frames=[];
    const client={send(m){if(m.type==='frame'){frames.push(m.data);queueMicrotask(()=>r.hub.received(client,'s',m.seq));}}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});await r.advance(300);r.failRestore=1000;
      for(let i=0;i<30;i++){await r.advance(20);r.emit(`moving-${i}`);await r.flush();}
      const failures=r.starts.filter(s=>s.quality===55&&s.at>0);
      t.ok(`${multi?'段別':'共有'}: 20 ms ごとの変更と ack でも再試行の 1 秒待ちを守る`,failures.length===1);
      r.failRestore=0;
      for(let i=30;i<120;i++){await r.advance(20);r.emit(`moving-${i}`);await r.flush();}
      const retries=r.starts.filter(s=>s.quality===55&&s.at>0);
      t.ok(`${multi?'段別':'共有'}: 待ちの期限後に再試行して動くページを配信する`,retries.length===2&&retries[1].at>=retries[0].at+1000&&r.running()[0]?.format.quality===55&&frames.at(-1)==='moving-119');
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
  for(const multi of [true,false]) {
    const r=await rig(multi);
    const client={send(m){if(m.type==='mark')queueMicrotask(()=>r.hub.received(client,'s',m.seq,{mark:true}));if(m.type==='frame')r.later(()=>r.hub.received(client,'s',m.seq),60);}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=1000;await r.advance(300);
      for(let i=0;i<20;i++){await r.advance(70);r.emit(`slow-${i}`);await r.flush();}
      const top=r.starts.filter(s=>s.quality===80);
      t.ok(`${multi?'段別':'共有'}: mark と frame の返事の差で段が下がる経路も再試行の期限を守る`,top.length===2&&top[1].at-top[0].at>=1000);
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
  for(const multi of [true,false]) for(const trigger of ['tab','viewer']) {
    const r=await rig(multi);
    const client={send(m){if(m.type==='frame')queueMicrotask(()=>r.hub.received(client,'s',m.seq));}};
    let changed;
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=1000;await r.advance(7300);r.hold();await r.advance(8000);
      if(trigger==='tab')r.tab('B');
      else changed=r.hub.watch(client,'s',{width:500,height:400});
      await r.flush();r.release();await changed;await r.flush();
      const before=r.starts.filter(s=>s.quality===80).length;
      await r.advance(7999);
      t.ok(`${multi?'段別':'共有'}/${trigger}: 最後の失敗要求を待つ間の明示変更でも期限を守る`,r.starts.filter(s=>s.quality===80).length===before);
      r.fail=0;await r.advance(8001);
      t.ok(`${multi?'段別':'共有'}/${trigger}: 最後の失敗要求を待つ間の明示変更を捨てずに再試行する`,r.running().length===1&&r.running()[0].format.quality===80&&(trigger==='tab'||r.running()[0].format.maxWidth===500));
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
  for(const multi of [true,false]) for(const trigger of ['content','tab','viewer']) {
    const r=await rig(multi);
    const client={send(m){if(m.type==='frame')queueMicrotask(()=>r.hub.received(client,'s',m.seq));}};
    const second={send(m){if(m.type==='frame')queueMicrotask(()=>r.hub.received(second,'s',m.seq));}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=1000;await r.advance(60300);
      const top=r.starts.filter(s=>s.quality===80), gaps=top.slice(1).map((s,i)=>s.at-top[i].at);
      t.ok(`${multi?'段別':'共有'}/${trigger}: 連続失敗は 1・2・4・8 秒待ち、5 回で復元した配信を保つ`,top.length===5&&JSON.stringify(gaps)===JSON.stringify([1000,2000,4000,8000])&&r.running()[0]?.format.quality===55);
      const before=r.attempts.length;
      for(let i=0;i<10;i++){r.emit('low');await r.advance(100);}
      await r.advance(60000);
      t.ok(`${multi?'段別':'共有'}/${trigger}: 打ち切り後は重複画像で再開しない`,r.attempts.length===before);
      r.fail=0;
      if(trigger==='content')r.emit('new-content');
      if(trigger==='tab')r.tab('B');
      if(trigger==='viewer')await r.hub.watch(second,'s',{width:400,height:400});
      await r.advance(10000);
      t.ok(`${multi?'段別':'共有'}/${trigger}: 中身・タブ・閲覧者の変更で再び画質を上げられる`,r.running().length===1&&r.running()[0].format.quality===80&&r.attempts.length>before);
    } finally {await r.hub.unwatch(second,'s');await r.hub.unwatch(client,'s');await r.close();}
  }
  for(const multi of [true,false]) {
    const r=await rig(multi), client={send(m){if(m.type==='frame')queueMicrotask(()=>r.hub.received(client,'s',m.seq));}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=1000;await r.advance(15300);
      const before=r.starts.filter(s=>s.quality===80).length;
      r.emit('new-content');await r.flush();
      await r.hub.watch(client,'s',{width:500,height:400});
      for(let i=0;i<39;i++){await r.advance(200);r.emit(`moving-${i}`);await r.flush();}
      t.ok(`${multi?'段別':'共有'}: 打ち切り後の中身や枠の変更でも最後の待ち時間を短縮しない`,r.starts.filter(s=>s.quality===80).length===before);
      r.fail=0;await r.advance(10000);
      t.ok(`${multi?'段別':'共有'}: 再開を保留した変更は期限後に最新の設定で復旧する`,r.running().length===1&&r.running()[0].format.quality===80&&r.running()[0].format.maxWidth===500);
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
  for(const multi of [true,false]) {
    const r=await rig(multi), client={send(m){if(m.type==='frame')queueMicrotask(()=>r.hub.received(client,'s',m.seq));}};
    try {
      await r.hub.watch(client,'s',{width:400,height:400});r.fail=1000;r.failRestore=1000;await r.advance(60300);
      t.ok(`${multi?'段別':'共有'}: 復元にも失敗して配信が無い場合は待ちの上限を保って復旧を続ける`,r.running().length===0&&r.starts.filter(s=>s.quality===80).length>5&&r.starts.length<30);
      r.fail=0;r.failRestore=0;await r.advance(8000);
      t.ok(`${multi?'段別':'共有'}: 復元失敗が長く続いても映像を自動復旧できる`,r.running().length===1&&r.running()[0].format.quality===80);
    } finally {await r.hub.unwatch(client,'s');await r.close();}
  }
}
