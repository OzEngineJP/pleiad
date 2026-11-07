// 状態通知とコマンド応答を別々に動かす。要求した対象との一致を、要求完了の条件にはしない。
export async function checkTabState(setupChromePanel, createWindowTable, t) {
  async function ready(panel) {for(let n=0;n<100 && !panel.screencastState;n++)await new Promise(resolve=>setTimeout(resolve,5));}
  async function rig() {
    let opened=false, onClose;
    const pins=[], events=[], windows=createWindowTable();
    windows.apply({sessionId:'one',windows:1,windowIds:[1],currentWindowId:1});
    const panel=setupChromePanel({session:()=> 'one',windows,
      preview:{panelOpen:()=>opened,openPanel(options){opened=true;onClose=options.onClose;},close(){opened=false;onClose?.();}},
      async cmd(name){if(name==='browserScreencast')return {state:{tabId:'A',sequence:1}};
        if(name==='chromePinWindow')return new Promise((resolve,reject)=>pins.push({resolve,reject}));return {};}});
    panel.onTabChange(e=>{if(e?.type==='state')events.push(panel.tabId);});
    const state=(tabId,sequence)=>panel.onMessage({source:'chrome',sessionId:'one',type:'state',state:{tabId,sequence}});
    panel.open();await ready(panel);events.length=0;
    return {panel,pins,events,state};
  }
  for(const order of ['state-first','response-first']) {
    const r=await rig(), promise=r.panel.pinTab('one',{tabId:'B'});
    r.state('A',2);
    t.ok(`${order}: 要求中の古いタブの知らせで表示の選択を解除しない`,r.events.length===0);
    if(order==='state-first')r.state('B',3);
    r.pins[0].resolve({state:{tabId:'B',sequence:4}});await promise;
    if(order==='response-first')r.state('A',2);
    t.ok(`${order}: 成功応答が最新状態を採用して要求を終える`,r.panel.tabId==='B' && r.events.at(-1)==='B');
    r.state('C',5);
    t.ok(`${order}: 完了後の別経路のタブ変更を受け入れる`,r.panel.tabId==='C' && r.events.at(-1)==='C');
    r.panel.close();
  }
  {
    const r=await rig();const b=r.panel.pinTab('one',{tabId:'B'}), c=r.panel.pinTab('one',{tabId:'C'});
    r.state('B',3);r.pins[0].resolve({state:{tabId:'B',sequence:4}});await b;
    t.ok('B→C: Bの状態と成功応答を保存してもCの選択は完了させない',r.panel.tabId==='B' && r.events.length===0);
    r.pins[1].reject(new Error('no-tab'));await c;
    t.ok('B→C: Cの失敗では保存した最新のBを確定する',r.panel.tabId==='B' && r.events.at(-1)==='B');
    r.panel.close();
  }
  for(const order of ['state-first','response-first']) {
    const r=await rig();const b=r.panel.pinTab('one',{tabId:'B'});
    if(order==='state-first')r.state('C',3);
    r.pins[0].resolve({state:{tabId:'C',sequence:4}});await b;
    if(order==='response-first')r.state('B',2);
    t.ok(`${order}: 他端末のCに追い越されたB要求も完了する`,r.panel.tabId==='C' && r.events.at(-1)==='C');
    r.state('D',5);
    t.ok(`${order}: 追い越しの後のDにも追従する`,r.panel.tabId==='D' && r.events.at(-1)==='D');
    r.panel.close();
  }
  {
    const r=await rig();const b=r.panel.pinTab('one',{tabId:'B'}), c=r.panel.pinTab('one',{tabId:'C'});
    r.pins[1].resolve({state:{tabId:'C',sequence:5}});await c;
    r.state('B',3);r.pins[0].resolve({state:{tabId:'B',sequence:4}});await b;
    t.ok('逆順の状態と応答は番号で破棄し、最新のCを戻さない',r.panel.tabId==='C' && r.events.join(',')==='C');
    r.panel.close();r.panel.open();await ready(r.panel);
    t.ok('閉じて開き直すと前の選択と番号を外して最新状態を受ける',r.panel.tabId==='A');
    r.panel.close();
  }
}
