import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBrowserUnifyWs, BROWSER_UNIFY_COMMANDS } from '../../core/browser-unify-ws.mjs';
import { COMMANDS } from '../../core/protocol.mjs';
import { createHtmlKeys } from '../../core/html-keys.mjs';
import { registry } from '../../core/ops/index.mjs';
import { addressCrumbs } from '../../web/address-bar.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'browser-unify-ws';
export const title = 'Conversation tab privacy, address policy and human navigation';
export default async function(t) {
  const origins = [];
  const isolated = createBrowserUnifyWs({ isolatedRoutes:{ once:value => { origins.push(value); return 'once-token'; } } });
  t.ok('vizOnce continues to issue isolated-page grants', (await isolated.handle({ command:'vizOnce', args:{ origins:['https://cdn.example'] } })).token === 'once-token' && origins.length === 1);
  for (const args of [{}, { origins:'https://a.example' }, { origins:[1] }, { origins:Array(51).fill('https://a.example') }, { origins:['x'.repeat(2049)] }]) {
    const code = await isolated.handle({ command:'vizOnce', args }).then(() => null, error => error.code);
    t.ok('invalid isolated-page grant inputs are rejected', code === 'INVALID');
  }
  t.ok('unknown commands fail explicitly', await isolated.handle({command:'unknown'}).then(() => false, error => error.code === 'UNKNOWN_COMMAND'));
  // コマンドの一覧（core/protocol.mjs）に無いものは接続の入口で落ちて返事が来ない。handle だけの試験では見えないので両方を突き合わせる
  t.ok('every browser-unify command is registered in the wire protocol', [...BROWSER_UNIFY_COMMANDS].every(command => COMMANDS.has(command)));
  t.ok('unavailable isolated listener returns no grant', (await createBrowserUnifyWs().handle({command:'vizOnce',args:{origins:[]}})).token === null);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-b1-')));
  let ws;
  try {
    const work = path.join(root, 'work'), dataDir = path.join(root, 'data'), profile = path.join(root, 'profile');
    await Promise.all([work, dataDir, profile].map(dir => fs.mkdir(dir)));
    const file = path.join(work, 'notes.md'); await fs.writeFile(file, '# Notes');
    await fs.writeFile(path.join(profile, 'Preferences'), JSON.stringify({ default_search_provider_data:{ url:'https://search.example/?q={searchTerms}' } }));
    let emit, detached = 0, touched = [], calls = [], opened = [], aiTab = null;
    const holders = new Map();   // 持ち手（無ければ AI）。aiTab は中継の AI のタブ（relay.view.current）
    const tabs = [{ sessionId:'one', targetId:'a', windowId:1, url:'https://example.com/', title:'One' }];
    const relay = {
      onTabEvent(fn) { emit = fn; return () => { emit = null; }; },
      unify:{ tabInfo:{ list:id => id === 'one' ? tabs : [] }, tabHolder:{ touch:detail => touched.push(detail), holder:(id, targetId) => holders.get(targetId) ?? { holder:'ai' } } },
      async openForConversation(id, url) { opened.push({ id, url }); return { targetId:'new-tab' }; },
      view:{ current:id => id === 'one' ? aiTab : null, async closeTab(id, targetId) { calls.push(['close', id, targetId]); }, async attach() { return {
        async send(method, params) { calls.push([method, params]); return method === 'Page.getNavigationHistory' ? { currentIndex:1, entries:[{ id:10 }, { id:20 }, { id:30 }] } : {}; },
        async detach() { detached++; },
      }; } },
    };
    const messages = [[], [], [], []];
    const clients = messages.map(list => ({ readyState:1, OPEN:1, send:message => list.push(JSON.parse(message)) }));
    const authenticated = new Set(clients.slice(0, 3)), watching = new Map([[clients[0], 'one'], [clients[1], 'two'], [clients[3], 'one']]);
    ws = createBrowserUnifyWs({ relay, mask:text => text.replaceAll('Private', '[masked]'), clients:() => authenticated, watching:client => watching.get(client), cwd:() => work, access:() => ({ dataDir }), profileDir:() => profile, ports:() => ({ pages:12345 }) });
    emit('tab:info', tabs[0]);
    t.ok('tab metadata goes only to the authenticated watcher', messages[0].length === 1 && messages.slice(1).every(list => !list.length));
    t.ok('tab payload is an event', messages[0][0].kind === 'event' && messages[0][0].event.type === 'tab:info');
    ws.snapshot(clients[0], 'one'); ws.snapshot(clients[1], 'one'); ws.snapshot(clients[3], 'one');
    t.ok('reconnect snapshot obeys the same watcher and auth checks', messages[0].at(-1).event.reset && messages[0].at(-1).event.tabs.length === 1 && messages.slice(1).every(list => !list.length));
    tabs[0].title='Private'; emit('tab:info', tabs[0]); ws.snapshot(clients[0], 'one');
    t.ok('updates and reconnect snapshots use the existing secret masking boundary', messages[0].at(-2).event.title === '[masked]' && messages[0].at(-1).event.tabs[0].title === '[masked]');
    watching.set(clients[0], 'two'); emit('tab:info', { ...tabs[0], title:'Private' });
    t.ok('switching conversations immediately stops old tab events', messages[0].length === 4);
    t.ok('screen identities are stable and distinct', ws.clientId(clients[0]) === ws.clientId(clients[0]) && ws.clientId(clients[0]) !== ws.clientId(clients[1]));
    watching.set(clients[0], 'one'); watching.set(clients[1], 'one');
    const before = messages.map(list => list.length);
    emit('tab:page-request', {sessionId:'one',by:ws.clientId(clients[0]),request:{type:'use'}});
    t.ok('page requests go only to their last touching screen', messages[0].length === before[0]+1 && messages[1].length === before[1]);
    emit('tab:page-request', {sessionId:'one',request:{type:'use'}});
    t.ok('page requests without a destination are never broadcast', messages[0].length === before[0]+1 && messages[1].length === before[1]);
    const results = [], envs = [];
    const paged = createBrowserUnifyWs({ clients:() => authenticated, watching:client => watching.get(client),
      pageRequests:{ result:async reply => { results.push(reply); return true; }, env:async change => { envs.push(change); return 2; } } });
    const reply = { sessionId:'one', targetId:'a', requestId:'req-12345678', ok:true, result:{ kept:true } };
    const delivered = await paged.handle({ command:'pageResult', args:reply, client:clients[0] });
    t.ok('pageResult hands the screen result to the page requests', delivered.delivered === true && results.length === 1 && results[0].requestId === 'req-12345678' && results[0].result.kept === true);
    const refusedBy = async (client, args) => paged.handle({ command:'pageResult', args, client }).then(() => null, error => error.code);
    const refusals = [await refusedBy(clients[2], reply), await refusedBy(clients[3], reply), await refusedBy(clients[0], { ...reply, sessionId:'two' })];
    t.ok('pageResult is refused unless the connection is authenticated and watching that conversation', refusals.every(code => code === 'INVALID') && results.length === 1);
    const env = await paged.handle({ command:'pageEnv', args:{ theme:'dark' }, client:clients[0] });
    const badTheme = await paged.handle({ command:'pageEnv', args:{ theme:'neon' } }).then(() => null, error => error.code);
    t.ok('pageEnv passes only known themes to the file pages', env.tabs === 2 && envs.length === 1 && envs[0].theme === 'dark' && badTheme === 'INVALID');
    const holding = [];
    const heldRelay = { onTabEvent:() => () => {}, unify:{ tabInfo:{ list:() => [] }, tabHolder:{ held:id => id === 'one' ? [{ targetId:'a', holder:'human', by:'screen:1', since:1, last:2, pinned:false, viewport:null }] : [] } } };
    const heldClient = { readyState:1, OPEN:1, send:message => holding.push(JSON.parse(message).event) };
    createBrowserUnifyWs({ relay:heldRelay, clients:() => new Set([heldClient]), watching:() => 'one' }).snapshot(heldClient, 'one');
    t.ok('the reconnect snapshot also tells the human-held tabs after the tab list', holding.length === 2 && holding[0].reset && holding[1].type === 'tab:holder' && holding[1].targetId === 'a' && holding[1].holder === 'human' && holding[1].sessionId === 'one');
    const unwired = await createBrowserUnifyWs({ clients:() => authenticated, watching:client => watching.get(client) }).handle({ command:'pageResult', args:reply, client:clients[0] });
    t.ok('without page requests the result is simply not delivered', unwired.delivered === false);
    const suggestion = await ws.handle({ command:'chromeAddress', args:{ sessionId:'one', input:path.join(work, 'no') }, client:clients[0] });
    t.ok('partial paths suggest inspected files', suggestion.suggestions.some(row => row.path === file));
    const missing = await ws.handle({command:'chromeAddress', args:{sessionId:'one',input:path.join(work,'missing.md')}, client:clients[0]});
    t.ok('a missing filename has an explanation before navigation', missing.reason === 'not-found' && !missing.suggestions.length);
    // chromeAddress: アドレスの候補とタブの画像は、その会話を見ている認証済みの画面にだけ返す（page:changed と同じ届け先）
    const deniedAddress = (client, args) => ws.handle({ command:'chromeAddress', args, client }).then(() => null, error => error.code);
    const screenshots = () => calls.filter(call => call[0] === 'Page.captureScreenshot').length;
    const shots = screenshots(), detachBase = detached;
    watching.set(clients[1], 'two');
    const addressCodes = await Promise.all([
      deniedAddress(clients[1], { sessionId:'one', input:'' }),
      deniedAddress(clients[2], { sessionId:'one', input:'' }),
      deniedAddress(clients[3], { sessionId:'one', input:'' }),
      deniedAddress(undefined, { sessionId:'one', input:'' }),
      deniedAddress(clients[2], { sessionId:'one', input:'', targetId:'a', thumbnail:true }),
      deniedAddress(clients[3], { sessionId:'one', input:'', targetId:'a', thumbnail:true }),
      deniedAddress(clients[0], { sessionId:'two', input:'', targetId:'a', thumbnail:true }),
    ]);
    watching.set(clients[1], 'one');
    t.ok('chromeAddress refuses suggestions and tab thumbnails unless the connection is authenticated and watching',
      addressCodes.every(code => code === 'INVALID') && screenshots() === shots);
    const thumbnail = await ws.handle({ command:'chromeAddress', args:{ sessionId:'one', input:'', targetId:'a', thumbnail:true }, client:clients[0] });
    t.ok('the watching screen still receives the tab thumbnail', thumbnail !== null && screenshots() === shots + 1 && detached === detachBase + 1);
    await ws.navigate({ sessionId:'one', targetId:'a', input:file }, { by:'screen:1', client:clients[0] });
    const destination = new URL(calls.at(-1)[1].url);
    t.ok('file navigation uses the conversation page and encoded absolute path', destination.port === '12345' && destination.pathname === '/_pleiad/s/one/file' && destination.searchParams.get('path') === file);
    t.ok('navigation marks this tab as human before sending CDP', touched.at(-1).targetId === 'a' && touched.at(-1).by === 'screen:1');
    await ws.navigate({ sessionId:'one', targetId:'a', input:'two words' }, { client:clients[0] });
    t.ok('search uses the selected Chrome profile provider', calls.at(-1)[1].url === 'https://search.example/?q=two%20words');
    const count = calls.length;
    let blocked = false;
    try { await ws.navigate({ sessionId:'one', targetId:'a', input:path.join(work, 'missing.md') }, { client:clients[0] }); } catch (error) { blocked = error.code === 'not-found'; }
    t.ok('missing paths give a reason and never become searches', blocked && calls.length === count);
    try { await ws.navigate({ sessionId:'two', targetId:'a', action:'reload' }, { client:clients[0] }); } catch {}
    t.ok('another conversation cannot operate the target', calls.length === count);
    // navigate（chromeNavigate の口）も、見ている画面からの操作だけ受ける
    const openedCount = opened.length;
    const navCodes = await Promise.all([
      ws.navigate({ sessionId:'two', action:'new' }, { client:clients[0] }).then(() => null, error => error.code),
      ws.navigate({ sessionId:'one', action:'new' }, { client:clients[2] }).then(() => null, error => error.code),
      ws.navigate({ sessionId:'one', action:'new' }, { client:clients[3] }).then(() => null, error => error.code),
      ws.navigate({ sessionId:'one', action:'new' }).then(() => null, error => error.code),
    ]);
    t.ok('navigate refuses to open or touch tabs unless the connection is authenticated and watching',
      navCodes.every(code => code === 'INVALID') && opened.length === openedCount);
    await ws.navigate({ sessionId:'one', targetId:'a', action:'back' }, { client:clients[0] });
    t.ok('back follows this tab navigation history', calls.at(-1)[0] === 'Page.navigateToHistoryEntry' && calls.at(-1)[1].entryId === 10);
    await ws.navigate({ sessionId:'one', action:'new' }, { client:clients[0] });
    t.ok('new tabs belong to the conversation and are human-held', opened.at(-1).url.endsWith('/_pleiad/s/one/new') && touched.at(-1).targetId === 'new-tab');
    t.ok('temporary CDP sessions are detached', detached === detachBase + 4);
    await ws.navigate({sessionId:'one',action:'new',input:file}, {by:'screen:1', client:clients[0]});
    t.ok('modified folder clicks may open the chosen location in a new tab', new URL(opened.at(-1).url).searchParams.get('path') === file);
    await ws.navigate({sessionId:'one',input:'about:blank'}, { client:clients[0] });
    t.ok('blank addresses work with no previous target', opened.at(-1).url.endsWith('/new') && calls.at(-1)[1].url === 'about:blank');
    tabs[0].page={kind:'file',path:file};
    await ws.navigate({sessionId:'one',targetId:'a',action:'view',view:'source'}, { client:clients[0] });
    t.ok('view changes persist in the page URL before painting', calls.at(-1)[1].expression.includes('history.replaceState') && calls.at(-1)[1].expression.includes('source'));

    // 引き継ぐ前の AI のタブは見るだけ（ADR 0321）: アドレスバーの移動・戻る・進む・再読み込み・閉じる・表示の切り替えは、どれも view-only で断り、CDP も持ち手も触らない
    aiTab = 'a';
    for (const args of [{ input:'https://moved.example/' }, { action:'back' }, { action:'forward' }, { action:'reload' }, { action:'close' }, { action:'view', view:'preview' }]) {
      const sent = calls.length, held = touched.length;
      const code = await ws.navigate({ sessionId:'one', targetId:'a', ...args }, { by:'screen:1' }).then(() => null, error => error.code);
      t.ok(`the agent tab before take-over refuses ${args.action ?? 'navigate'} with view-only, without CDP and without becoming human`, code === 'view-only' && calls.length === sent && touched.length === held,
        JSON.stringify({ code, sent:calls.slice(sent), touched:touched.slice(held) }));
    }
    await ws.navigate({ sessionId:'one', action:'new', input:'https://fresh.example/' }, { by:'screen:1' });
    t.ok('while the agent tab is view-only, a typed address still opens in a new human tab', opened.at(-1).url === 'https://fresh.example/' && touched.at(-1).targetId === 'new-tab', JSON.stringify([opened.at(-1), touched.at(-1)]));
    holders.set('a', { holder:'human' });   // [引き継ぐ] の後
    await ws.navigate({ sessionId:'one', targetId:'a', action:'reload' }, { by:'screen:1' });
    t.ok('after take-over the agent tab reloads', calls.at(-1)[0] === 'Page.reload');
    await ws.navigate({ sessionId:'one', targetId:'a', action:'close' }, { by:'screen:1' });
    t.ok('after take-over the agent tab closes', calls.at(-1)[0] === 'close' && calls.at(-1)[2] === 'a');
    holders.clear(); aiTab = 'other';
    await ws.navigate({ sessionId:'one', targetId:'a', action:'reload' });
    t.ok('a tab that is not the agent tab works as before even while its holder is ai', calls.at(-1)[0] === 'Page.reload');
    aiTab = null;

    // pageOpen: 開く先はサーバーが決める（ADR 0295 の 7）。ページは pages の port、HTML と可視化は印の出どころ
    const secret = crypto.randomBytes(32);
    const htmlKeys = createHtmlKeys({ secret });
    const watches = [];
    const hash = 'b'.repeat(64);
    const removed = [], removedClients = [];
    const openWs = createBrowserUnifyWs({ clients:() => authenticated, watching:client => watching.get(client),
      ports:() => ({ pages:12345, isolated:23456 }), cwd:() => work, access:() => ({ dataDir }),
      htmlKeys, secret, pageWatch:{ add:(...args) => watches.push(args), remove:(...args) => removed.push(args), removeClient:(id) => removedClients.push(id) },
      // 可視化の元のファイルは会話の記録（束の持ち主の行）から決める。クライアントの送った path は使わない（指摘 6）
      vizSource:async (sessionId, h) => h === hash ? { path:path.join(work, 'visualized.html') } : null,
      isolatedRoutes:{ manifest:async h => [hash, 'c'.repeat(64)].includes(h) ? { 'index.html':{ sha:'0'.repeat(64) } } : null } });
    const htmlFile = path.join(work, 'page.html'); await fs.writeFile(htmlFile, '<p>h</p>');
    const page = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'file', path:file }, client:clients[0] });
    t.ok('ページは pages の port の URL（画面が組み立てない）。開いたファイルは変化の見張りに登る',
      page.kind === 'file' && page.path === file && page.url === `http://localhost:12345${page.suffix}`
      && page.suffix.startsWith('/_pleiad/s/one/file?path=') && watches.some(w => w[0] === 'one' && w[1] === file));
    // 版の印（ADR 0320）: 「更新時刻（ミリ秒を丸めた整数）:大きさ」。開いた時点のファイルの stat と一致し、関所を通ったパスにだけ付く
    const statOf = async target => { const stat = await fs.stat(target); return `${Math.round(stat.mtimeMs)}:${stat.size}`; };
    t.ok('pageOpen（ファイル）は版の印「更新時刻:大きさ」を返す', /^\d+:\d+$/.test(page.stamp ?? '') && page.stamp === await statOf(file), String(page.stamp));
    const dirPage = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'dir', path:work }, client:clients[0] });
    t.ok('pageOpen（フォルダー）もフォルダー自身の印を返す', dirPage.kind === 'dir' && dirPage.stamp === await statOf(work), String(dirPage.stamp));
    const gitPage = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'git' }, client:clients[0] });
    t.ok('ファイルの無いページ（git）は印を持たない', gitPage.stamp === undefined);
    const html = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'html', path:htmlFile }, client:clients[0] });
    t.ok('pageOpen（HTML）も同じ形の印を返す', html.stamp === await statOf(htmlFile), String(html.stamp));
    // 中身を読む口が断るパス（会話のデータ置き場の中のもの）には、開くのも印も出さない
    const secretFile = path.join(dataDir, 'secret.txt'); await fs.writeFile(secretFile, 'top secret');
    const refusedOpen = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'file', path:secretFile }, client:clients[0] }).then(value => ({ value }), error => ({ code:error.code }));
    t.ok('データ置き場の中のファイルは pageOpen が断る（印も返さない）', refusedOpen.value === undefined && typeof refusedOpen.code === 'string', JSON.stringify(refusedOpen));
    const htmlUrl = html?.url ? new URL(html.url) : null;
    t.ok('HTML はフォルダーの印の出どころの /f/<鍵>/（鍵は引け、フォルダーは印と同じ）',
      htmlUrl && /^f[0-9a-f]{16}\.localhost$/.test(htmlUrl.hostname) && htmlUrl.port === '23456'
      && htmlUrl.pathname.startsWith('/f/') && htmlUrl.pathname.endsWith('/page.html')
      && htmlKeys.resolve(decodeURIComponent(htmlUrl.pathname.split('/')[2]))?.root === work);
    const viz = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'viz', hash }, client:clients[0] });
    t.ok('可視化は束の印の出どころの /viz/<ハッシュ>/<入口>（入口は目録で確かめる）',
      viz.url === `http://v${hash.slice(0, 24)}.localhost:23456/viz/${hash}/index.html?embed=tab`);
    const badViz = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'viz', hash:'0'.repeat(64) }, client:clients[0] }).then(() => null, e => e.code);
    const badKind = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'exec' }, client:clients[0] }).then(() => null, e => e.code);
    const stranger = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'file', path:file }, client:clients[2] }).then(() => null, e => e.code);
    const otherSession = await openWs.handle({ command:'pageOpen', args:{ sessionId:'two', kind:'file', path:file }, client:clients[0] }).then(() => null, e => e.code);
    t.ok('目録に無い束・知らない kind・見ていない接続・ほかの会話は断る',
      badViz === 'NOT_FOUND' && badKind === 'INVALID' && stranger === 'INVALID' && otherSession === 'INVALID');
    const vizMeta = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'viz', hash, title:'月ごとの売上', path:'C:/Windows/System32/evil<script>.html' }, client:clients[0] });
    t.ok('可視化の元のファイルは会話の記録から返す（クライアントの送った path は信じない。アドレスバー・ツリー・タブの題に使う）',
      vizMeta.path === path.join(work, 'visualized.html') && vizMeta.title === '月ごとの売上' && new URL(vizMeta.url).searchParams.get('title') === '月ごとの売上');
    const orphanViz = await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'viz', hash:'c'.repeat(64), path:htmlFile }, client:clients[0] });
    t.ok('記録に無い束は path を返さない（クライアントの path を反映させない）', orphanViz.path === undefined);

    // pageResolve: 隔離の URL を開いている対象へ戻す（ページ内の移動の追跡。ファイルなら見張りも登り直す）
    const watchesBefore = watches.length;
    const resolve = await openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:html.url, tab:'page:resolve' }, client:clients[0] });
    t.ok('pageResolve は鍵の URL から中身のファイルを引き、変化の見張りへ登り直す',
      resolve.kind === 'html' && resolve.path === htmlFile && watches.length === watchesBefore + 1);
    const vizResolve = await openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://localhost:23456/viz/${hash}/index.html` }, client:clients[0] });
    const vizMarkResolve = await openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://v${hash.slice(0, 24)}.localhost:23456/viz/${hash}/index.html` }, client:clients[0] });
    const [wrongPort, wrongMark, badKey, foreignKey, resolveStranger] = await Promise.all([
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://v${hash.slice(0, 24)}.localhost:9999/viz/${hash}/index.html` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://evil.localhost:23456/viz/${hash}/index.html` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://localhost:23456/f/${'X'.repeat(43)}/a.html` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'two', url:html.url }, client:clients[1] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:html.url }, client:clients[2] }).then(() => null, e => e.code),
    ]);
    t.ok('pageResolve: 直書き localhost の隔離 port も引ける。別 port・別の印・知らない鍵・他の会話の鍵・見ていない接続は断る',
      vizResolve.kind === 'viz' && vizResolve.hash === hash && vizResolve.entry === 'index.html' && vizMarkResolve.kind === 'viz'
      && wrongPort === 'INVALID' && wrongMark === 'INVALID' && badKey === 'NOT_FOUND' && foreignKey === 'INVALID' && resolveStranger === 'INVALID');

    // pageResolve の対象はフォルダーの中の HTML だけ（指摘 7）: 鍵の URL の道を変えて確かめる
    const keyUrl = new URL(html.url), key = decodeURIComponent(keyUrl.pathname.split('/')[2]), mark = keyUrl.hostname;
    for (const name of ['.env', 'notes.md', '.secret/page.html', 'page.png']) await fs.mkdir(path.join(work, name.endsWith('page.html') ? '.secret' : '.'), { recursive:true }).then(() => fs.writeFile(path.join(work, name), 'x')).catch(() => {});
    const [envFile, mdFile, dotDir, pngFile, htmMissing] = await Promise.all([
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/.env` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/notes.md` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/.secret/page.html` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/page.png` }, client:clients[0] }).then(() => null, e => e.code),
      openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/missing.htm` }, client:clients[0] }).then(() => null, e => e.code),
    ]);
    await fs.writeFile(path.join(work, 'other.htm'), '<p>h</p>');
    const htmOk = await openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/other.htm` }, client:clients[0] });
    await fs.mkdir(path.join(work, 'nested', '.hidden'), { recursive:true });
    await fs.writeFile(path.join(work, 'nested', '.hidden', 'x.html'), '<h1>hidden</h1>');
    const encodedDotPath = await openWs.handle({ command:'pageResolve', args:{ sessionId:'one', url:`http://${mark}:23456/f/${encodeURIComponent(key)}/nested%5C.hidden%5Cx.html` }, client:clients[0] }).then(() => null, e => e.code);
    t.ok('pageResolve は .env・.md・ドットで始まるフォルダー・画像・無いファイルを断り、.htm は引く',
      envFile === 'NOT_FOUND' && mdFile === 'NOT_FOUND' && dotDir === 'NOT_FOUND' && pngFile === 'NOT_FOUND' && htmMissing === 'NOT_FOUND'
      && htmOk.kind === 'html' && htmOk.path === path.join(work, 'other.htm') && encodedDotPath === 'NOT_FOUND');

    // pageOpen・pageResolve・pageWatch はタブの id を見張りの持ち主（owner）として渡す（指摘 3）
    watches.length = 0; removed.length = 0;
    await openWs.handle({ command:'pageOpen', args:{ sessionId:'one', kind:'file', path:file, tab:'page:7' }, client:clients[0] });
    await openWs.handle({ command:'pageWatch', args:{ sessionId:'one', path:file, kind:'file', tab:'page:7' }, client:clients[0] });
    t.ok('開く・外すのどちらも「画面/タブ」の持ち主を渡す',
      watches.some(w => w[3] === 'screen:1/page:7') && removed.some(w => w[0] === 'one' && w[1] === file && w[2] === 'file' && w[3] === 'screen:1/page:7'));
    openWs.screenClosed(clients[0]);
    t.ok('画面が切れるとその画面の持ち主ぶんを外す', removedClients.length === 1 && removedClients[0] === 'screen:1');

    // pageWatch: 閉じたタブの見張りを外す（見ている接続からの依頼だけ。上限の食い潰しを防ぐ）
    const watch = await openWs.handle({ command:'pageWatch', args:{ sessionId:'one', path:file, kind:'file' }, client:clients[0] });
    const watchStranger = await openWs.handle({ command:'pageWatch', args:{ sessionId:'one', path:file }, client:clients[2] }).then(() => null, e => e.code);
    const watchBad = await openWs.handle({ command:'pageWatch', args:{ sessionId:'one' }, client:clients[0] }).then(() => null, e => e.code);
    t.ok('pageWatch は見ている接続の依頼で見張りを外す',
      watch.removed === true && removed.some(w => w[0] === 'one' && w[1] === file && w[2] === 'file') && watchStranger === 'INVALID' && watchBad === 'INVALID');

    // page:changed（変わったファイルを見ている画面と、そのファイルを出しているタブへ）
    const marks = messages.map(list => list.length);
    await ws.pageChanged('one', file);
    t.ok('page:changed は版の印（読める paths のファイルの stat）を運ぶ', messages[0].at(-1).event.stamp === await statOf(file), String(messages[0].at(-1).event.stamp));
    t.ok('page:changed はその会話を見ている認証済みの画面へだけ（0 と 1 は見ている・3 は認証されていない）',
      messages[0].length === marks[0] + 1 && messages[0].at(-1).event.type === 'page:changed' && messages[0].at(-1).event.path === file
      && messages[1].length === marks[1] + 1 && messages[1].at(-1).event.type === 'page:changed' && messages[3].length === marks[3]);
    await new Promise(resolve => setTimeout(resolve, 30));
    t.ok('そのファイルを出しているタブへはページへ「changed」を届ける', calls.some(call => call[0] === 'Runtime.evaluate' && String(call[1]?.expression).includes('"changed"')));
    await ws.pageChanged('one', path.join(work, 'other.md'));
    t.ok('消えた（読めない）パスの page:changed は印を付けない', messages[0].at(-1).event.type === 'page:changed' && !('stamp' in messages[0].at(-1).event));
    await ws.pageChanged('one', secretFile);
    t.ok('関所が断るパス（データ置き場の中）の page:changed は印を付けない（更新時刻と大きさを漏らさない）', messages[0].at(-1).event.path === secretFile && !('stamp' in messages[0].at(-1).event));
    t.ok('ほかのファイルはタブへ届けない（画面へだけ）', calls.filter(call => String(call[1]?.expression ?? '').includes('"changed"')).length === 1);

    // page:moved（port が替わった。見ている画面へ今と前の port を知らせ、残ったタブは本体が付け替える）
    const moved = [];
    const movedWs = createBrowserUnifyWs({ clients:() => authenticated, watching:client => watching.get(client), ports:() => ({ pages:5001, isolated:5002 }),
      relay:{ onTabEvent:() => () => {}, migratePageTabs:async fn => { moved.push(fn('http://localhost:4333/viz/x')); return { moved:1 }; }, unify:{ tabInfo:{ list:() => [] } } },
      movedUrl:url => url === 'http://localhost:4333/viz/x' ? 'http://v1.localhost:5002/viz/x' : null });
    await movedWs.portsChanged({ previous:{ pages:[12345], isolated:[23456] } });
    t.ok('port が替わると残ったタブを付け替え、見ている画面へ今と前の port を知らせる',
      moved.length === 1 && messages[0].at(-1).event.type === 'page:moved' && messages[0].at(-1).event.ports.isolated === 5002
      && messages[0].at(-1).event.previous.isolated[0] === 23456);
    const agent = await registry.invoke({ by:'agent', via:'mcp', sessionId:'one', mode:{ scope:'full', autonomy:'never' } }, 'browser.chromeNavigate', { sessionId:'one', input:'example.com' }, { chromeNavigate:() => { throw new Error('must not run'); } });
    t.ok('navigation is absent from agent surfaces', !agent.ok);
    t.ok('Windows breadcrumbs preserve drive roots and absolute destinations', addressCrumbs('D:\\work\\notes.md').map(item => item.path).join('|') === 'D:\\|D:\\work|D:\\work\\notes.md');
    t.ok('POSIX breadcrumbs preserve absolute destinations', addressCrumbs('/work/notes.md').at(-1).path === '/work/notes.md');

    // 親が子の Chrome を見る: タブ情報は「見ている会話とその子孫」へ届く（inapp-browser.md。委譲カード・題のチップの元）
    const childTabs = [{ sessionId:'one/child', targetId:'c1', windowId:9, url:'https://child.example/', title:'Child' }];
    let famEmit = null;
    const famMessages = [];
    const famClient = { readyState:1, OPEN:1, send:message => famMessages.push(JSON.parse(message).event) };
    const famWatching = new Map([[famClient, 'one']]);
    const fam = createBrowserUnifyWs({ relay:{ onTabEvent(fn) { famEmit = fn; return () => { famEmit = null; }; },
        unify:{ tabInfo:{ list:id => id === 'one' ? tabs : id === 'one/child' ? childTabs : [] },
          tabHolder:{ held:id => id === 'one/child' ? [{ targetId:'c1', holder:'human', by:'device', since:1, last:2, pinned:false, viewport:null }] : [] } } },
      clients:() => new Set([famClient]), watching:client => famWatching.get(client), descendants:id => id === 'one' ? ['one/child'] : [] });
    fam.snapshot(famClient, 'one');
    t.ok('snapshot は見ている会話と子孫それぞれの reset と人の持ち手を送る',
      famMessages.filter(e => e.type === 'tab:info' && e.reset).map(e => e.sessionId).join(',') === 'one,one/child'
      && famMessages.some(e => e.type === 'tab:holder' && e.sessionId === 'one/child' && e.targetId === 'c1'));
    famMessages.length = 0;
    famEmit('tab:info', { ...childTabs[0], title:'Renamed' });
    famEmit('tab:holder', { sessionId:'one/child', targetId:'c1', holder:'human' });
    famEmit('tab:info', { sessionId:'two', targetId:'x', windowId:1, url:'https://x/', title:'X' });
    t.ok('子孫の tab:info・tab:holder は親画面へ届き、無関係な会話は届かない',
      famMessages.filter(e => e.sessionId === 'one/child').length === 2 && !famMessages.some(e => e.sessionId === 'two'));
    famWatching.set(famClient, 'two'); famMessages.length = 0;
    famEmit('tab:info', { ...childTabs[0], title:'Again' });
    t.ok('見ている会話を替えると子孫の届け先も替わる', famMessages.length === 0);
    famWatching.set(famClient, 'one');
    const famWatch = await fam.handle({ command:'pageWatch', args:{ sessionId:'one/child', path:file, kind:'file' }, client:famClient }).catch(e => e.code);
    t.ok('見ている会話の子孫へのページの操作も受け付ける', famWatch?.removed === true);
    fam.close();
    ws.close(); t.ok('relay subscription can be removed', emit === null);
    {
      const server = await startServer({dataDir:path.join(root, 'server'), env:{AGENT_HOST_BACKENDS:'fake'}});
      let screen;
      try {
        screen = await open(server);
        const caps = await screen.cmd('hostCapabilities');
        t.ok('server always exposes browser capabilities', Number.isInteger(caps.browserUnify?.pages) && Number.isInteger(caps.browserUnify?.isolated));
        const denied = await screen.cmd('chromeAddress', {sessionId:'one',input:''}, {ms:5000}).then(() => null, error => error.code);
        t.ok('real server refuses address requests from a socket not watching the conversation', denied === 'INVALID', String(denied));
        await screen.cmd('watchSession', {sessionId:'one'});
        const address = await screen.cmd('chromeAddress', {sessionId:'one',input:''}, {ms:5000}).then(value => ({value}), error => ({code:error.code}));
        t.ok('address requests always receive an explicit response', Array.isArray(address.value?.suggestions));
        t.ok('real server sends a reconnect snapshot to the watching socket', screen.events.some(event => event.type === 'tab:info' && event.sessionId === 'one' && event.reset));
        // 実サーバーの辿り方（core/server.mjs の descendants = 直接の子だけ・delegation.mjs と同じ確かめ）:
        // 親を見ている画面へは直接の子のタブが届き、孫・関係の無い会話は届かない
        const ply = (name, args) => `ply:${JSON.stringify({ name, arguments: args })}`;
        const run = async args => {
          for (let i = 0; i < 100; i++) {
            try { return await screen.runTurn(args); }
            catch (error) { if (!String(error.message).includes('切り替え中') || i === 99) throw error; await sleep(50); }
          }
        };
        const tasksOf = async parent => {
          const rows = await screen.cmd('agentTasks');
          return rows.filter(row => row.parentSessionId === parent && row.sessionId);
        };
        const parent = (await run({ backend:'fake', cwd:ROOT, prompt:'echo:parent' })).sessionId;
        await run({ sessionId:parent, prompt:ply('ply_delegate', { kind:'mechanical', backend:'fake', task:'echo:child', title:'child' }) });
        let child = null;
        for (let i = 0; i < 200 && !child; i++) { child = (await tasksOf(parent))[0] ?? null; if (!child) await sleep(50); }
        await run({ sessionId:parent, prompt:ply('ply_task_send', { taskId:child.taskId,
          message:ply('ply_delegate', { kind:'mechanical', backend:'fake', task:'echo:grandchild', title:'grandchild' }) }) });
        let grandchild = null;
        for (let i = 0; i < 200 && !grandchild; i++) { grandchild = (await tasksOf(child.sessionId))[0] ?? null; if (!grandchild) await sleep(50); }
        const other = (await run({ backend:'fake', cwd:ROOT, prompt:'echo:other' })).sessionId;
        const from = screen.events.length;
        await screen.cmd('watchSession', { sessionId:parent });
        const resets = screen.events.slice(from).filter(event => event.type === 'tab:info' && event.reset).map(event => event.sessionId);
        t.ok('実サーバー: 直接の子だけが届き、孫・無関係な会話は届かない',
          resets.includes(parent) && resets.includes(child.sessionId) && !resets.includes(grandchild.sessionId) && !resets.includes(other),
          `resets=${JSON.stringify(resets)} parent=${parent} child=${child.sessionId} grandchild=${grandchild.sessionId} other=${other}`);
        // 作業のダイアログの窓口（slot:'modal'。ADR 0315）: 見ている親の子孫でない会話も、モーダルが映す間は開ける。
        // 窓口を空にすれば元へ戻る。メインの窓口（親）は替わらない
        const openGrand = () => screen.cmd('pageOpen', { sessionId:grandchild.sessionId, kind:'file', path:`${ROOT}/package.json` }).then(() => 'ok', e => e.code ?? String(e.message));
        const before = await openGrand();
        const fromModal = screen.events.length;
        await screen.cmd('watchSession', { sessionId:grandchild.sessionId, slot:'modal' });
        const modalResets = screen.events.slice(fromModal).filter(event => event.type === 'tab:info' && event.reset).map(event => event.sessionId);
        const viaModal = await openGrand();
        const parentStill = await screen.cmd('pageOpen', { sessionId:parent, kind:'file', path:`${ROOT}/package.json` }).then(() => 'ok', e => e.code ?? String(e.message));
        const otherViaModal = await screen.cmd('pageOpen', { sessionId:other, kind:'file', path:`${ROOT}/package.json` }).then(() => 'ok', e => e.code ?? String(e.message));
        await screen.cmd('watchSession', { sessionId:null, slot:'modal' });
        const after = await openGrand();
        t.ok('実サーバー: モーダルの窓口が映す会話は、親の子孫でなくても開ける（窓口を空にすれば戻る）',
          before !== 'ok' && viaModal === 'ok' && parentStill === 'ok' && otherViaModal !== 'ok' && after !== 'ok' && modalResets.includes(grandchild.sessionId),
          JSON.stringify({ before, viaModal, parentStill, otherViaModal, after, modalResets }));
      } finally { screen?.close(); await server.stop(); }
    }
  } finally { ws?.close(); await fs.rm(root, { recursive:true, force:true }); }
}
