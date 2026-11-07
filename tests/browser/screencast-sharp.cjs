// Real CDP sessions use disposable Playwright pages; the production bridge and hub stay in the path.
module.exports = async function checkSharpChrome({browser, check, createScreencastHub}) {
  const {pathToFileURL} = require('node:url');
  const path = require('node:path');
  const {createChromeScreencast} = await import(pathToFileURL(path.resolve(__dirname, '../../core/chrome/screencast.mjs')).href);
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async test=>{for(let n=0;n<100;n++){if(test())return true;await sleep(25);}return false;};
  const context=await browser.newContext({viewport:{width:800,height:800}});
  const pages=new Map(), commands=[], raw=[], clients=[];
  let current='A', onChange, bridge, hub;
  for(const tab of ['A','B']) {
    const page=await context.newPage();pages.set(tab,page);
    await page.setContent('<style>body{margin:0;overflow:hidden}</style><canvas width="800" height="800"></canvas>');
    await page.evaluate(tab=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle=tab==='A'?'white':'#eee';c.fillRect(0,0,800,800);},tab);
  }
  const host={summary:()=>({tabs:2,operating:false}),tabs:()=>[...pages.keys()].map(targetId=>({targetId,windowId:1})),current:()=>current,
    onChange(fn){onChange=fn;return ()=>{};},
    async focus(){},
    async attach(_session,tab,listen){
      const cdp=await context.newCDPSession(pages.get(tab));
      let quality;
      cdp.on('Page.screencastFrame',params=>{raw.push({tab,quality,data:params.data,t:Date.now()});listen('Page.screencastFrame',params);});
      return {async send(method,params){if(method==='Page.startScreencast')quality=params.quality;commands.push({method,params,tab,t:Date.now()});return cdp.send(method,params);},detach:()=>cdp.detach()};
    }};
  const ack=c=>{const frame=c.frames.at(-1);if(frame){hub.received(c,'one',frame.seq,{mark:true});hub.received(c,'one',frame.seq);}};
  async function add(width=800,hold=false) {
    const c={frames:[],hold,send(m){if(m.type==='frame'){c.frames.push(m);if(!c.hold)queueMicrotask(()=>ack(c));}}};
    clients.push(c);await hub.watch(c,'one',{width,height:800});return c;
  }
  const high=()=>commands.filter(c=>c.method==='Page.startScreencast').at(-1)?.params.quality===80;
  const starts=()=>commands.filter(c=>c.method==='Page.startScreencast').length;
  const paint=async(tab,x)=>pages.get(tab).evaluate(x=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle='black';c.fillRect(x,100,1,1);},x);
  try {
    bridge=createChromeScreencast({host,relay:{onTabEvent:()=>()=>{},unify:{tabHolder:{holder:()=>null}}}});
    hub=createScreencastHub({bridge});
    await pages.get('A').evaluate(()=>{window.repaint=setInterval(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle='white';c.fillRect(0,0,800,800);},80);});
    const first=await add();
    check('Chrome: quiet stream becomes quality 80',await until(()=>high() && first.frames.length>=2));
    await sleep(500);
    const duplicateIdle={starts:starts(),sent:first.frames.length,raw:raw.length};
    await sleep(1200);
    check('Chrome: repeated identical Canvas repaint still produces source frames',raw.length>=duplicateIdle.raw+3 && raw.slice(duplicateIdle.raw).every(f=>f.data===raw[duplicateIdle.raw-1].data));
    check('Chrome: identical Canvas repaint at sharp quality causes no resend or restart',high() && starts()===duplicateIdle.starts && first.frames.length===duplicateIdle.sent);
    await pages.get('A').evaluate(()=>clearInterval(window.repaint));
    await sleep(500);const idle={starts:starts(),raw:raw.length,sent:first.frames.length};
    await sleep(1500);
    check('Chrome: idle produces no extra frames or restarts and no screenshots',starts()===idle.starts && raw.length===idle.raw && first.frames.length===idle.sent && !commands.some(c=>c.method==='Page.captureScreenshot'));
    const previous=first.frames.at(-1)?.data;
    await paint('A',101);
    check('Chrome: a final one-pixel update arrives on the sharp stream',await until(()=>first.frames.at(-1)?.data!==previous));
    await sleep(400);
    check('Chrome: a single fine update keeps the sharp stream',high() && starts()===idle.starts);
    const slow=await add(600,true);await until(()=>slow.frames.length>0);await sleep(500);
    const before=first.frames.at(-1)?.data;await paint('A',102);
    check('Chrome: an unacknowledged viewer does not block the other viewer',await until(()=>first.frames.at(-1)?.data!==before));
    slow.hold=false;ack(slow);
    check('Chrome: both viewers receive the latest sharp update',await until(()=>slow.frames.at(-1)?.data===first.frames.at(-1)?.data));
    const moving=starts();
    for(let x=103;x<113;x++){await paint('A',x);await sleep(45);}
    check('Chrome: sustained changes return to moving quality',commands.slice().some(c=>c.method==='Page.startScreencast' && c.params.quality===55 && c.t>=commands.filter(c=>c.method==='Page.startScreencast')[moving-1].t) && starts()>moving);
    check('Chrome: after motion ends both viewers return to sharp quality',await until(high));
    await sleep(600);const settled=starts(), settledFrames=raw.length;await sleep(1000);
    check('Chrome: quality changes converge after motion stops',starts()===settled && raw.length===settledFrames);
    current='B';onChange('one','current');
    check('Chrome: a tab switch reaches both viewers',await until(()=>raw.at(-1)?.tab==='B' && first.frames.at(-1)?.data===slow.frames.at(-1)?.data));
    await sleep(400);const b=first.frames.at(-1)?.data;await paint('B',101);
    check('Chrome: fine updates still arrive after a tab switch',await until(()=>first.frames.at(-1)?.data!==b));
    await Promise.all(clients.map(c=>hub.unwatch(c,'one')));clients.length=0;
    const reopened=await add();check('Chrome: reconnect produces a fresh sharp frame',await until(()=>high() && reopened.frames.length>0 && raw.some(f=>f.quality===80 && f.data===reopened.frames.at(-1)?.data)));
    await sleep(500);const reconnect=starts();await sleep(700);
    check('Chrome: reconnect also stops producing idle frames',starts()===reconnect);
  } finally {
    if(hub)await Promise.all(clients.map(c=>hub.unwatch(c,'one')));
    bridge?.close();await context.close();
  }
};
