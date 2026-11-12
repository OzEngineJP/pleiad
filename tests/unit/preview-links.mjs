import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ACTIVITY_BRIDGE, LINK_BRIDGE, visualizationDocument } from '../../web/visualize-document.mjs';
import { handlePreviewLinkMessage, openExternalLink } from '../../web/link-open.mjs';

export const name = 'preview-links';
export const title = '隔離したプレビューのリンクを親で確認して開く';

export default function(t) {
  const sent=[]; const handlers={};
  const links=()=>sent.filter(m=>m.type==='ply-preview-open-link');
  const location={hash:'',href:'http://iso.localhost/',protocol:'http:',assign(){},reload(){}};
  const child={
    URL, location, window:{}, parent:{postMessage:data=>sent.push(data)},
    document:{title:'',addEventListener:(name,fn)=>{handlers[name]=fn;}},
    history:{pushState(){},replaceState(){},back(){},forward(){}},
    addEventListener:(name,fn)=>{handlers[`win:${name}`]=fn;},
  };
  vm.runInNewContext(LINK_BRIDGE.replace(/^<script>|<\/script>$/g,''),child);
  const anchor=(href,target='')=>({getAttribute:()=>href,target});
  const dispatch=(href,target='',{ctrlKey=false,type='click',button=0}={})=>{
    let stopped=false;
    handlers[type]({target:{closest:()=>anchor(href,target)},ctrlKey,metaKey:false,button,preventDefault(){stopped=true;}});
    return stopped;
  };
  assert(dispatch('https://example.com/page','_blank'));
  assert.equal(links().length,1);
  assert.equal(links()[0].url,'https://example.com/page');
  assert.equal(links()[0].newWindow,true);
  assert(dispatch('https://example.com/self','_self'));
  assert.equal(links()[1].newWindow,false);
  assert(dispatch('#section','_blank'));
  assert.equal(location.hash,'#section');
  assert.equal(links().length,2);
  assert(dispatch('javascript:alert(1)'));
  assert.equal(links().length,2);
  child.window.open('http://example.com/','_blank');
  assert.equal(links()[2].url,'http://example.com/');
  assert.equal(links()[2].external,false);
  assert.equal(links()[0].external,false,'ふつうのクリックは開き先の設定に従う');
  assert(dispatch('https://example.com/ctrl','',{ctrlKey:true}));
  assert.equal(links()[3].external,true,'Ctrl/⌘+クリックは既定のブラウザー');
  assert(dispatch('https://example.com/middle','',{type:'auxclick',button:1}));
  assert.equal(links()[4].external,true,'中クリックは既定のブラウザー');
  assert(!dispatch('https://example.com/right','',{type:'auxclick',button:2}));
  assert.equal(links().length,5,'右クリックは拾わない');
  assert(!visualizationDocument('x',{resize:false}).includes('ply-preview-open-link'));
  t.ok('リンクと window.open を通知し、同一ページのアンカーは枠内で動かす',true);

  // 読み直す前の位置を親へ預け（宛先は命令の送り元の出どころ）、読み込み直した文書で戻す（少しの間追う・利用者が触れたらやめる）
  {
    const parentWin={}, posted=[], listeners={}, timers=[]; let now=0, reloads=0;
    const scroller={scrollLeft:40,scrollTop:620,max:{x:1000,y:620},laid:true,getClientRects(){return this.laid?[{}]:[];}};
    const behaviors=[];
    const scrollTo=o=>{behaviors.push(o.behavior);scroller.scrollLeft=Math.min(o.left,scroller.max.x);scroller.scrollTop=Math.min(o.top,scroller.max.y);};
    const ctx={
      URL, window:{}, parent:parentWin, scrollTo,
      location:{hash:'',href:'http://iso.localhost/',protocol:'http:',assign(){},reload(){reloads++;},replace(){}},
      document:{title:'',scrollingElement:scroller,documentElement:scroller,addEventListener(){}},
      history:{pushState(){},replaceState(){}},
      addEventListener:(name,fn)=>{(listeners[name]??=[]).push(fn);},
      removeEventListener:(name,fn)=>{listeners[name]=(listeners[name]??[]).filter(f=>f!==fn);},
      setTimeout:(fn,ms)=>{const timer={fn,at:now+ms};timers.push(timer);return timer;},
      clearTimeout:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);},
      Date:{now:()=>now},
    };
    parentWin.postMessage=(data,origin)=>posted.push({data,origin});
    vm.runInNewContext(LINK_BRIDGE.replace(/^<script>|<\/script>$/g,''),ctx);
    const command=(command,{source=parentWin,origin='http://localhost:7000'}={})=>listeners.message.forEach(fn=>fn({source,origin,data:{type:'pleiad:page-command',command}}));
    const tick=ms=>{now+=ms;for(const timer of timers.filter(item=>item.at<=now)){timers.splice(timers.indexOf(timer),1);timer.fn();}};
    const saved=()=>posted.filter(m=>m.data.type==='pleiad:page-scroll');

    command({type:'reload'},{source:{}});
    assert.equal(reloads,0,'親以外の窓の命令では読み直さない');
    assert.equal(saved().length,0);
    command({type:'reload'});
    assert.equal(reloads,1);
    assert.deepEqual(saved().map(m=>[m.data.x,m.data.y,m.origin]),[[40,620,'http://localhost:7000']],'読み直す前に縦・横の位置を、命令の送り元の出どころ宛てに知らせる（* へは送らない）');
    command({type:'reload'},{origin:'null'});
    assert.equal(reloads,2,'出どころが分からなくても読み直しは止めない');
    assert.equal(saved().length,1,'出どころが http(s) でないなら位置は送らない');

    // 枠が見えない間（右の欄が閉じている・別の会話）は中の位置が 0 に見える。見えていたときの最後の位置を知らせる
    scroller.laid=true;scroller.scrollLeft=33;scroller.scrollTop=444;
    listeners.scroll.forEach(fn=>fn());
    scroller.laid=false;scroller.scrollLeft=0;scroller.scrollTop=0;
    listeners.scroll.forEach(fn=>fn());
    command({type:'reload'});
    assert.deepEqual([saved().at(-1).data.x,saved().at(-1).data.y],[33,444],'見えない間は 0 でなく、見えていたときの最後の位置を知らせる');
    scroller.laid=true;scroller.scrollLeft=40;scroller.scrollTop=620;

    // 見えるまで待ってから戻す（見えない間は追いつづけず、見えてから 3 秒ほど追う）
    scroller.laid=false;scroller.scrollLeft=0;scroller.scrollTop=0;scroller.max={x:1000,y:2000};
    command({type:'scroll-restore',x:40,y:900});
    for(let i=0;i<20;i++)tick(400);
    assert.equal(scroller.scrollTop,0,'見えない間は動かさない');
    assert.equal(timers.length,1,'見えない間も待ちは続く（開くのが遅れても戻せる）');
    scroller.laid=true;
    tick(400);
    assert.deepEqual([scroller.scrollLeft,scroller.scrollTop],[40,900],'見えたら位置に戻す');
    assert.equal(timers.length,0);

    // scroll-behavior: smooth の HTML でも、戻す処理は即座に動かす（アニメーションにしない）
    assert(behaviors.length>0&&behaviors.every(b=>b==='instant'),'戻す処理の scrollTo は behavior: instant');

    // 追っている間に次の読み直しが来たら、その時点の位置ではなく目的地を返す（連続した読み直しで位置を化けさせない）
    scroller.scrollLeft=0;scroller.scrollTop=0;scroller.max={x:1000,y:200};
    command({type:'scroll-restore',x:40,y:900});
    assert.equal(scroller.scrollTop,200,'高さが足りず、追っている途中');
    command({type:'reload'});
    assert.deepEqual([saved().at(-1).data.x,saved().at(-1).data.y],[40,900],'追っている間の reload は目的地を知らせる');
    // 追うのをやめた後（届いた・期限・利用者が触れた）は今の位置
    scroller.max={x:1000,y:2000};tick(80);
    assert.equal(timers.length,0);
    command({type:'reload'});
    assert.deepEqual([saved().at(-1).data.x,saved().at(-1).data.y],[40,900]);
    scroller.scrollLeft=7;scroller.scrollTop=8;
    command({type:'reload'});
    assert.deepEqual([saved().at(-1).data.x,saved().at(-1).data.y],[7,8],'追い終えた後は今の位置');
    scroller.scrollLeft=0;scroller.scrollTop=0;scroller.max={x:1000,y:200};
    command({type:'scroll-restore',x:40,y:900});
    listeners.wheel.forEach(fn=>fn({isTrusted:true}));
    scroller.scrollLeft=11;scroller.scrollTop=12;
    command({type:'reload'});
    assert.deepEqual([saved().at(-1).data.x,saved().at(-1).data.y],[11,12],'利用者が触れて追うのをやめた後は目的地でなく今の位置');
    scroller.max={x:1000,y:2000};

    // 戻す: 高さがまだ無ければ追い、届いたらやめる
    scroller.scrollLeft=0;scroller.scrollTop=0;scroller.max={x:1000,y:200};
    command({type:'scroll-restore',x:40,y:900});
    assert.equal(scroller.scrollTop,200,'いま届くところまでは先に動かす');
    tick(80);tick(80);
    assert.equal(scroller.scrollTop,200,'まだ高さが足りない間は待つ');
    scroller.max={x:1000,y:2000};
    tick(80);
    assert.deepEqual([scroller.scrollLeft,scroller.scrollTop],[40,900],'高さが届いたら縦・横の位置に着く');
    assert.equal(timers.length,0,'着いたら追うのをやめる');

    // 短くなったページ: 届くところまで動かし、期限で追うのをやめる
    const started=now;
    scroller.scrollLeft=0;scroller.scrollTop=0;scroller.max={x:0,y:300};
    command({type:'scroll-restore',x:0,y:900});
    for(let i=0;i<60&&timers.length;i++)tick(80);
    assert.equal(scroller.scrollTop,300,'短くなったら届くところまで');
    assert.equal(timers.length,0,'期限（3 秒ほど）で追うのをやめる');
    assert(now-started<8000);

    // 利用者が触れたらやめる（作られたイベントでは止まらない）
    scroller.scrollLeft=0;scroller.scrollTop=0;scroller.max={x:0,y:100};
    command({type:'scroll-restore',x:0,y:900});
    listeners.wheel.forEach(fn=>fn({isTrusted:false}));
    assert.equal(timers.length,1,'ページの作ったイベントでは止まらない');
    listeners.wheel.forEach(fn=>fn({isTrusted:true}));
    assert.equal(timers.length,0,'利用者のホイールで追うのをやめる');
    scroller.max={x:0,y:2000};tick(500);
    assert.equal(scroller.scrollTop,100,'やめた後は動かさない');
    assert.equal((listeners.wheel??[]).length,0,'見張りは外す');
    command({type:'scroll-restore',x:'a',y:-5});
    assert.equal(scroller.scrollTop,0,'数でない値や負の値は 0 として扱う');
    command({type:'scroll-restore',x:0,y:50},{source:{}});
    assert.equal(scroller.scrollTop,0,'親以外の窓の命令では動かさない');
  }
  t.ok('隔離のページの橋: 読み直す前の位置を送り元の出どころへ預け、戻す命令は少し追って届かなければ止め、利用者の操作でやめる',true);

  // ページの活動の橋: 利用者の入力より前の scroll（読み直しでの復元・戻す処理）は「触れた」に数えない。入力の後の scroll は数える
  {
    const parentWin={}, posted=[], docListeners={}, winListeners={};
    const ctx={
      parent:parentWin, window:{},
      document:{addEventListener:(name,fn)=>{(docListeners[name]??=[]).push(fn);}},
      addEventListener:(name,fn)=>{(winListeners[name]??=[]).push(fn);},
    };
    parentWin.postMessage=(data,origin)=>posted.push({data,origin});
    vm.runInNewContext(ACTIVITY_BRIDGE.replace(/^<script>|<\/script>$/g,''),ctx);
    const fire=(type,{isTrusted=true}={})=>(docListeners[type]??[]).forEach(fn=>fn({type,isTrusted}));
    winListeners.message.forEach(fn=>fn({source:parentWin,origin:'http://localhost:7000',data:{type:'pleiad:page-activity-init'}}));
    fire('scroll');
    assert.equal(posted.length,0,'入力の前の scroll（復元・戻す処理）は活動に数えない');
    fire('wheel',{isTrusted:false});
    fire('scroll');
    assert.equal(posted.length,0,'作られた入力では武装しない');
    fire('wheel');
    fire('scroll');
    assert.deepEqual(posted.map(m=>[m.data.type,m.data.input,m.origin]),[['pleiad:page-activity',false,'http://localhost:7000']],'利用者のホイールの後の scroll は活動に数える');

    const second={posted:[],docListeners:{},winListeners:{}};
    const ctx2={parent:{postMessage:(data,origin)=>second.posted.push({data,origin})},window:{},
      document:{addEventListener:(name,fn)=>{(second.docListeners[name]??=[]).push(fn);}},addEventListener:(name,fn)=>{(second.winListeners[name]??=[]).push(fn);}};
    vm.runInNewContext(ACTIVITY_BRIDGE.replace(/^<script>|<\/script>$/g,''),ctx2);
    second.winListeners.message.forEach(fn=>fn({source:ctx2.parent,origin:'http://localhost:7000',data:{type:'pleiad:page-activity-init'}}));
    const fire2=type=>(second.docListeners[type]??[]).forEach(fn=>fn({type,isTrusted:true}));
    for(const type of['touchstart','keydown','mousedown','pointerdown']){
      const one={posted:[],listeners:{}};
      const c={parent:{postMessage:(d,o)=>one.posted.push({d,o})},window:{},document:{addEventListener:(n,f)=>{(one.listeners[n]??=[]).push(f);}},addEventListener:(n,f)=>{(one.listeners[n]??=[]).push(f);}};
      vm.runInNewContext(ACTIVITY_BRIDGE.replace(/^<script>|<\/script>$/g,''),c);
      one.listeners.message.forEach(fn=>fn({source:c.parent,origin:'http://localhost:7000',data:{type:'pleiad:page-activity-init'}}));
      one.listeners[type].forEach(fn=>fn({type,isTrusted:true}));
      one.posted.length=0;
      one.listeners.scroll.forEach(fn=>fn({type:'scroll',isTrusted:true}));
      assert(type==='pointerdown'||one.posted.length===1,`${type} の後の scroll は活動に数える`);
    }
    fire2('scroll');
    assert.equal(second.posted.length,0);
  }
  t.ok('活動の橋: 利用者の入力より前の scroll は数えず、ホイール・タッチ・キー・マウスの後は数える',true);

  const originalDocument=globalThis.document;
  const trusted={}, forged={}, opened=[];
  const frame={contentWindow:trusted};
  globalThis.document={
    querySelectorAll:()=>[frame],
    createElement:()=>({click(){opened.push({href:this.href,target:this.target,rel:this.rel});},remove(){}}),
    body:{append(){}},
  };
  try {
    const message=(source,url)=>({source,data:{type:'ply-preview-open-link',url,newWindow:true}});
    assert.equal(handlePreviewLinkMessage(message(forged,'https://example.com/')),false);
    assert.equal(handlePreviewLinkMessage(message(trusted,'javascript:alert(1)')),false);
    assert.equal(handlePreviewLinkMessage(message(trusted,'https://user:pass@example.com/')),false);
    assert.equal(opened.length,0);
    assert.equal(handlePreviewLinkMessage(message(trusted,'https://example.com/')),true);
    assert.deepEqual(opened,[{href:'https://example.com/',target:'_blank',rel:'noopener noreferrer nofollow'}]);
    assert.equal(handlePreviewLinkMessage(message(trusted,'http://example.com/')),true);
    assert.equal(opened.length,2);
  } finally { globalThis.document=originalDocument; }
  t.ok('親は現在の枠の WindowProxy と URL を確認し、偽の送り元を無視する',true);

  // デスクトップのホストの画面: 既定のブラウザーへは殻の口で渡す（窓の setWindowOpenHandler は https しか通さない）
  const originalWindow=globalThis.window;
  const commands=[];
  globalThis.window={plyDesktop:{openExternal:url=>{commands.push(url);return Promise.resolve(true);}}};
  try {
    assert.equal(openExternalLink('http://localhost:5173/x'),true);
    assert.equal(openExternalLink('https://example.com/'),true);
    assert.deepEqual(commands,['http://localhost:5173/x','https://example.com/']);
    assert.equal(openExternalLink('file:///C:/a.html'),false);
    assert.equal(openExternalLink('https://user:pass@example.com/'),false);
    assert.equal(commands.length,2);
  } finally { globalThis.window=originalWindow; }
  t.ok('デスクトップでは既定のブラウザーを殻の口で開き、http の localhost も渡せる',true);
}
