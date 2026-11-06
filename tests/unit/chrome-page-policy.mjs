// 中継の移動の検査とコマンドの前後のふるい（core/chrome/page-policy.mjs、ADR 0292 の 4）。
//   - 移動の検査の表: 本体の port はどのホスト名でも断る・ファイルのページはその会話の localhost だけ・隔離は localhost だけ・ほかの localhost の port は通す
//   - 止めた要求（JS の移動・サブリソース）: 同じ表で失敗させる。旗が off（port は main だけ）でも本体の port は止める
//   - Cookie: pleiad_* を結果とイベントから除き、Pleiad の port・名前・パスの読み書きを断る
//   - 偽の Chrome の上の中継: 本体の port への Page.navigate・人やページの JS の移動・ほかの会話のページ・旗が off のとき
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { createPagePolicy, pleiadVerdict, safeUrl } from '../../core/chrome/page-policy.mjs';

export const name = 'chrome-page-policy';
export const title = '中継の移動の検査と Cookie のふるい: 本体の port はどの名前でも断る・ファイルのページはその会話だけ・pleiad_* を隠す（表と偽の Chrome）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

const MAIN = 7420, PAGES = 7431, ISOLATED = 7432;
const ON = { main: MAIN, pages: PAGES, isolated: ISOLATED };
const OFF = { main: MAIN, pages: null, isolated: null };
const ME = 'conv-a';

export default async function (t) {
  // ---- 移動の検査の表（allowUrl）
  {
    const policy = createPagePolicy({ ports: () => ON });
    const allow = url => policy.allowUrl(url, { sessionId: ME, via: 'navigate' });
    const table = [
      // 本体の port: どの名前でも断る
      [`http://127.0.0.1:${MAIN}/`, false], [`http://localhost:${MAIN}/`, false], [`http://[::1]:${MAIN}/`, false], [`http://0.0.0.0:${MAIN}/`, false],
      [`http://LOCALHOST:${MAIN}/`, false], [`http://localhost.:${MAIN}/`, false], [`http://127.0.0.2:${MAIN}/`, false], [`http://2130706433:${MAIN}/`, false],
      [`http://0x7f.1:${MAIN}/`, false], [`http://[::ffff:127.0.0.1]:${MAIN}/`, false], [`http://a.localhost:${MAIN}/`, false], [`http://0:${MAIN}/`, false],
      [`https://127.0.0.1:${MAIN}/`, false], [`http://127.0.0.1:${MAIN}/_pleiad/s/${ME}/file`, false], [`http://localtest.me:${MAIN}/`, false],
      // ファイルのページ: この会話の localhost だけ
      [`http://localhost:${PAGES}/_pleiad/s/${ME}/file?path=a.md`, true], [`http://localhost:${PAGES}/_pleiad/s/${ME}/`, true],
      [`http://LOCALHOST:${PAGES}/_pleiad/s/${ME}/dir`, true],
      [`http://localhost:${PAGES}/_pleiad/s/conv-b/file`, false], [`http://localhost:${PAGES}/_pleiad/s/${ME}`, false],
      [`http://localhost:${PAGES}/_pleiad/s/${ME}x/file`, false], [`http://localhost:${PAGES}/_pleiad/s/x/../conv-b/file`, false],
      [`http://localhost:${PAGES}/_pleiad/s/${ME}/../conv-b/file`, false], [`http://localhost:${PAGES}/_pleiad/s/${ME}/%2e%2e/conv-b/file`, false],
      [`http://localhost:${PAGES}/`, false], [`http://localhost:${PAGES}/favicon.ico`, false],
      [`http://127.0.0.1:${PAGES}/_pleiad/s/${ME}/file`, false], [`http://[::1]:${PAGES}/_pleiad/s/${ME}/file`, false], [`http://0.0.0.0:${PAGES}/_pleiad/s/${ME}/file`, false],
      [`http://localhost.:${PAGES}/_pleiad/s/${ME}/file`, false], [`https://localhost:${PAGES}/_pleiad/s/${ME}/file`, false], [`http://a.localhost:${PAGES}/_pleiad/s/${ME}/file`, false],
      // 隔離: localhost だけ（パスは問わない）
      [`http://localhost:${ISOLATED}/viz/abc/index.html`, true], [`http://localhost:${ISOLATED}/f/key/a.html`, true],
      [`http://127.0.0.1:${ISOLATED}/viz/abc/`, false], [`http://[::1]:${ISOLATED}/`, false], [`http://0.0.0.0:${ISOLATED}/`, false], [`http://localhost.:${ISOLATED}/`, false],
      // ほか: 今のまま（dev サーバー・外のサイトは通す。file: などは safeUrl が断る）
      ['http://localhost:5173/', true], ['http://127.0.0.1:3000/api', true], ['http://[::1]:8080/', true], ['https://example.com/', true], ['about:blank', true],
      ['file:///C:/Users/x/secret.txt', false], ['chrome://settings', false], ['javascript:alert(1)', false], [`http://u:p@localhost:${ISOLATED}/`, false],
    ];
    const wrong = table.filter(([url, expected]) => allow(url) !== expected).map(([url, expected]) => `${url} → ${!expected}`);
    t.ok(`移動の検査の表（${table.length} 件）が通す・断るのとおり`, wrong.length === 0, wrong.join(' / '));
    t.ok('ほかの会話から見ると、その会話のファイルのページは断る', !policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/${ME}/file`, { sessionId: 'conv-b', via: 'create' })
      && policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/conv-b/file`, { sessionId: 'conv-b', via: 'open' }));
    t.ok('会話の id が無いと、ファイルのページは通さない', !policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/${ME}/file`, {}) && !policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/${ME}/file`));
    t.ok('会話の id は % で書いても同じに見る（%2F は id の中の / として別物）', policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/conv%2Da/file`, { sessionId: ME })
      && !policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/conv-a%2Fx/file`, { sessionId: ME }) && !policy.allowUrl(`http://localhost:${PAGES}/_pleiad/s/%E0%A4/file`, { sessionId: ME }));
    t.ok('safeUrl の判定はそのまま（認証情報つき・file: は断る）', !safeUrl('http://u:p@localhost:5173/') && safeUrl('http://localhost:5173/'));
    t.ok('pleiadVerdict は Pleiad の port でなければ null（今の扱い）', pleiadVerdict('http://localhost:5173/', { ports: ON, sessionId: ME }) === null && pleiadVerdict('data:text/html,x', { ports: ON }) === null
      && pleiadVerdict('nope', { ports: ON }) === null && pleiadVerdict(`http://localhost:${MAIN}/`, { ports: null }) === null);

    // 旗が off: port は main だけ。本体の port だけを断り、ほかは今のまま
    const off = createPagePolicy({ ports: () => OFF });
    t.ok('旗が off でも本体の port はどの名前でも断る', ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].every(host => !off.allowUrl(`http://${host}:${MAIN}/`, { sessionId: ME })));
    t.ok('旗が off なら、ほかの port は今のまま通す（ファイルのページの port の番号も、ただの localhost の port）', off.allowUrl(`http://127.0.0.1:${PAGES}/`, { sessionId: ME }) && off.allowUrl('http://localhost:5173/', { sessionId: ME }));
    // サーバーが立つ前（port が null）・口が投げる
    const none = createPagePolicy();
    t.ok('port が分かる前は今のまま（safeUrl だけ）', none.allowUrl(`http://127.0.0.1:${MAIN}/`) && !none.allowUrl('file:///x') && none.intercepts === false);
    const throwing = createPagePolicy({ ports: () => { throw new Error('x'); } });
    t.ok('ports() が投げても今のまま動く', throwing.allowUrl('https://a.example/') && throwing.intercepts === false && throwing.request({ url: `http://127.0.0.1:${MAIN}/` }) === null);
  }

  // ---- 止めた要求（request）と Fetch の patterns
  {
    let ports = OFF;
    const policy = createPagePolicy({ ports: () => ports });
    const req = (url, sessionId = ME, resourceType = 'Document') => policy.request({ sessionId, targetId: 'T', url, resourceType, frameId: 'T' });
    t.ok('旗が off でも intercepts（どのタブにも中継のセッションを付ける）', policy.intercepts === true);
    t.ok('旗が off の patterns は、今の主フレームの Document と本体の port の全部の種類', JSON.stringify(policy.fetchPatterns([{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]))
      === JSON.stringify([{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }, { urlPattern: `*:${MAIN}/*`, requestStage: 'Request' }]));
    t.ok('本体の port への JS の移動・fetch・画像は失敗させる（旗が off でも）', ['Document', 'XHR', 'Fetch', 'Image', 'Script'].every(type => req(`http://localhost:${MAIN}/api/x`, ME, type) === 'block')
      && req(`http://[::1]:${MAIN}/`) === 'block' && req(`http://0.0.0.0:${MAIN}/`) === 'block');
    t.ok('ほかの要求は止めない（null で今の扱いへ）', req('https://example.com/') === null && req('http://localhost:5173/') === null && req('data:text/plain,x') === null && req('') === null);
    ports = ON;
    t.ok('旗が on の patterns は 3 つの port', policy.fetchPatterns([]).map(p => p.urlPattern).join(' ') === `*:${MAIN}/* *:${PAGES}/* *:${ISOLATED}/*` && policy.fetchPatterns([]).every(p => p.requestStage === 'Request' && !p.resourceType));
    t.ok('ほかの会話のファイルのページ・違う名前の 2 つの port への要求は失敗させる', req(`http://localhost:${PAGES}/_pleiad/s/conv-b/api/raw?path=a.png`, ME, 'Image') === 'block'
      && req(`http://127.0.0.1:${PAGES}/_pleiad/s/${ME}/file`) === 'block' && req(`http://127.0.0.1:${ISOLATED}/viz/x/`) === 'block');
    t.ok('この会話のファイルのページ・隔離への要求は止めない', req(`http://localhost:${PAGES}/_pleiad/s/${ME}/api/raw?path=a.png`, ME, 'Image') === null && req(`http://localhost:${ISOLATED}/viz/x/a.js`, ME, 'Script') === null);
    t.ok('既定の port（80・443）なら pattern は * にする', JSON.stringify(createPagePolicy({ ports: () => ({ main: 80 }) }).fetchPatterns([])) === '[{"urlPattern":"*","requestStage":"Request"}]');
  }

  // ---- Cookie のふるい（before・after・event）
  {
    const policy = createPagePolicy({ ports: () => ON });
    const before = (method, params) => { try { return { ok: policy.before({ sessionId: ME, targetId: 'T', method, params }) }; } catch (error) { return { error: error.message }; } };
    const cookies = [{ name: 'pleiad_pages', value: 'SECRET', domain: 'localhost', path: '/_pleiad/' }, { name: 'pleiad_x', value: 'S2', domain: 'localhost', path: '/' }, { name: 'app', value: 'v', domain: 'localhost', path: '/' }];
    const result = { cookies };
    const after = policy.after({ sessionId: ME, targetId: 'T', method: 'Network.getCookies', params: {}, result });
    t.ok('Network.getCookies の結果から pleiad_* を除く（ほかは残す・元は変えない）', JSON.stringify(after.cookies.map(c => c.name)) === '["app"]' && result.cookies.length === 3);
    const plain = { cookies: [{ name: 'app', value: 'v' }] };
    t.ok('除く物が無ければ同じ結果・cookies の無い結果はそのまま', policy.after({ method: 'Network.getCookies', result: plain }) === plain && policy.after({ method: 'Runtime.evaluate', result: { result: { value: 'pleiad_pages=1' } } }).result.value === 'pleiad_pages=1');
    t.ok('旗が off でも pleiad_* は除く', JSON.stringify(createPagePolicy({ ports: () => OFF }).after({ method: 'Network.getCookies', result }).cookies.map(c => c.name)) === '["app"]');

    const refused = [
      ['Network.getCookies', { urls: [`http://localhost:${PAGES}/_pleiad/s/${ME}/file`] }], ['Network.getCookies', { urls: ['http://localhost:5173/', `http://localhost:${ISOLATED}/`] }],
      ['Network.getCookies', { urls: [`http://127.0.0.1:${MAIN}/`] }],
      ['Network.setCookie', { name: 'pleiad_pages', value: 'x', url: 'http://localhost:5173/' }], ['Network.setCookie', { name: 'a', value: 'x', url: `http://localhost:${PAGES}/_pleiad/` }],
      ['Network.setCookie', { name: 'a', value: 'x', url: `http://localhost:${ISOLATED}/` }], ['Network.setCookie', { name: 'a', value: 'x', domain: 'localhost', path: '/_pleiad/' }],
      ['Network.setCookie', { name: 'a', value: 'x', domain: '.LOCALHOST.', path: '/_pleiad' }], ['Network.setCookie', { name: 'a', value: 'x', url: 'http://localhost:5173/', path: '/_pleiad/s/' }],
      ['Network.setCookies', { cookies: [{ name: 'ok', value: 'v', url: 'http://localhost:5173/' }, { name: 'pleiad_pages', value: 'x', domain: 'localhost' }] }],
      ['Network.deleteCookies', { name: 'pleiad_pages', domain: 'localhost' }], ['Network.deleteCookies', { name: 'x', url: `http://localhost:${PAGES}/` }],
      ['Network.deleteCookies', { name: 'agent_host_token', url: `http://127.0.0.1:${MAIN}/` }],
    ];
    const wrongRefused = refused.filter(([method, params]) => !before(method, params).error).map(([method, params]) => `${method} ${JSON.stringify(params)}`);
    t.ok(`Pleiad の port・名前・パスを指す Cookie の読み書きは断る（${refused.length} 件）`, wrongRefused.length === 0, wrongRefused.join(' / '));
    const passed = [
      ['Network.getCookies', {}], ['Network.getCookies', { urls: ['http://localhost:5173/'] }], ['Network.setCookie', { name: 'app', value: 'v', url: 'http://localhost:5173/' }],
      ['Network.setCookie', { name: 'app', value: 'v', domain: 'localhost', path: '/' }], ['Network.setCookies', { cookies: [{ name: 'app', value: 'v', domain: 'example.com' }] }],
      ['Network.deleteCookies', { name: 'app', domain: 'localhost' }], ['Runtime.evaluate', { expression: 'pleiad_pages' }],
    ];
    const wrongPassed = passed.filter(([method, params]) => before(method, params).ok !== params).map(([method, params]) => `${method} ${JSON.stringify(params)}`);
    t.ok(`ほかの Cookie の読み書き・ほかのコマンドは素通し（${passed.length} 件）`, wrongPassed.length === 0, wrongPassed.join(' / '));
    t.ok('断る文に Cookie の値・URL を載せない', !/SECRET|localhost|7431/.test(before('Network.setCookie', { name: 'pleiad_pages', value: 'SECRET', url: `http://localhost:${PAGES}/` }).error));

    // イベント（要求に付いた Cookie の見出し）
    const extra = policy.event({ sessionId: ME, method: 'Network.requestWillBeSentExtraInfo', params: {
      requestId: '1', headers: { Cookie: 'app=v; pleiad_pages=SECRET', Accept: '*/*' },
      associatedCookies: [{ blockedReasons: [], cookie: { name: 'pleiad_pages', value: 'SECRET' } }, { blockedReasons: [], cookie: { name: 'app', value: 'v' } }],
    } });
    t.ok('requestWillBeSentExtraInfo の Cookie の見出しと associatedCookies から pleiad_* を除く', extra.headers.Cookie === 'app=v' && extra.headers.Accept === '*/*'
      && JSON.stringify(extra.associatedCookies.map(c => c.cookie.name)) === '["app"]' && extra.requestId === '1');
    const only = policy.event({ method: 'Network.requestWillBeSentExtraInfo', params: { headers: { cookie: 'pleiad_pages=SECRET' }, associatedCookies: [] } });
    t.ok('pleiad_* だけの Cookie の見出しは見出しごと除く（小文字の名前も）', !('cookie' in only.headers));
    const response = policy.event({ method: 'Network.responseReceived', params: { response: { url: 'x', requestHeaders: { Cookie: 'pleiad_pages=SECRET; a=1' }, requestHeadersText: 'GET / HTTP/1.1\r\nCookie: pleiad_pages=SECRET\r\nHost: localhost\r\n' } } });
    t.ok('responseReceived の requestHeaders・requestHeadersText からも除く', response.response.requestHeaders.Cookie === 'a=1' && !response.response.requestHeadersText.includes('SECRET')
      && response.response.requestHeadersText.includes('Host: localhost') && response.response.url === 'x');
    const ws = policy.event({ method: 'Network.webSocketWillSendHandshakeRequest', params: { request: { headers: { Cookie: 'pleiad_pages=SECRET' } } } });
    t.ok('WebSocket の手前の見出しからも除く', !JSON.stringify(ws).includes('SECRET'));
    const other = { result: { value: 'pleiad_pages=SECRET' } };
    t.ok('Network・Fetch のほかのイベントはそのまま', policy.event({ method: 'Runtime.consoleAPICalled', params: other }) === other);
  }

  // ---- ページの Cookie を入れる口（connected・beforeOpen・tabCookie）
  {
    const calls = [];
    const send = (method, params) => { calls.push({ method, params }); return {}; };
    let cookie = null;
    const logs = [];
    const policy = createPagePolicy({ ports: () => ON, cookie: () => cookie, log: line => logs.push(line) });
    t.ok('旗が off（cookie が null）なら、つながっても・開く前も何も入れない', policy.connected({ send }) === undefined && policy.beforeOpen({ url: `http://localhost:${PAGES}/_pleiad/s/${ME}/file`, send }) === undefined && (await sleep(10), calls.length === 0));
    cookie = { name: 'pleiad_pages', value: 'SECRET', path: '/_pleiad/', httpOnly: true, sameSite: 'Strict' };
    policy.connected({ send });
    t.ok('つながると Storage.setCookies で入れる（localhost・Path・HttpOnly・Strict・ファイルのページの port）', await until(() => calls.length === 1)
      && calls[0].method === 'Storage.setCookies' && JSON.stringify(calls[0].params.cookies) === JSON.stringify([{ name: 'pleiad_pages', value: 'SECRET', url: `http://localhost:${PAGES}/_pleiad/`, path: '/_pleiad/', httpOnly: true, sameSite: 'Strict', sourceScheme: 'NonSecure', sourcePort: PAGES }]));
    const opening = policy.beforeOpen({ url: `http://localhost:${PAGES}/_pleiad/s/${ME}/file`, send });
    t.ok('ファイルのページを開く前は入れ直して待たせる', opening instanceof Promise && (await opening) === undefined && calls.length === 2);
    t.ok('ほかの URL を開く前は何もしない', policy.beforeOpen({ url: 'https://example.com/', send }) === undefined && policy.beforeOpen({ url: `http://localhost:${ISOLATED}/viz/x/`, send }) === undefined && calls.length === 2);
    const failing = policy.beforeOpen({ url: `http://localhost:${PAGES}/_pleiad/s/${ME}/file`, send: () => { throw new Error('boom'); } });
    t.ok('入れるのに失敗しても開くのは止めない（投げない・ログに値を書かない）', (await failing.then(() => true, () => false)) && logs.some(line => line.includes('boom')) && !logs.some(line => line.includes('SECRET')));
    const tabCalls = [];
    t.ok('タブのセッションに入れる口（既定の context でないプロフィール）', await policy.tabCookie((method, params) => { tabCalls.push({ method, params }); return { success: true }; })
      && tabCalls[0]?.method === 'Network.setCookie' && tabCalls[0].params.url === `http://localhost:${PAGES}/_pleiad/` && tabCalls[0].params.value === 'SECRET');
  }

  // ---- 偽の Chrome の上の中継
  {
    let ports = null;
    const r = await rig({ hooks: { pagePolicy: deps => createPagePolicy({ ...deps, ports: () => ports }) } });
    let a;
    try {
      ports = OFF;
      a = await agent(await r.relay.endpoint(ME));
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      t.ok('旗が off でも、タブに中継のセッションと本体の port の Fetch が付く', await until(() => r.chrome.calls.some(c => c.method === 'Fetch.enable' && c.sessionId && c.params.patterns?.some(p => p.urlPattern === `*:${MAIN}/*`))));
      const navs = [];
      for (const host of ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']) navs.push(await a.cmd('Page.navigate', { url: `http://${host}:${MAIN}/` }, sid));
      t.ok('本体の port への Page.navigate は、4 つのホスト名のどれでも断る（旗が off でも）', navs.every(n => n.error?.message === 'navigation denied'), JSON.stringify(navs.map(n => n.error?.message ?? n.result)));
      t.ok('本体の port の URL で createTarget は断る', (await a.cmd('Target.createTarget', { url: `http://localhost:${MAIN}/` })).error?.message === 'navigation denied');
      // ページの JS の移動（location = …）は検査を通らず、Fetch で止まる
      const jsNav = await r.fake.navigateUser(tabId, `http://localhost:${MAIN}/`);
      t.ok('ページの JS の本体の port への移動は、中継の Fetch で失敗する（旗が off でも）', jsNav?.errorText === 'net::ERR_BLOCKED_BY_CLIENT', JSON.stringify(jsNav));
      const devNav = await a.cmd('Page.navigate', { url: 'http://localhost:5173/' }, sid);
      t.ok('dev サーバーなど、ほかの localhost の port は今のまま通す', !devNav.error && !devNav.result?.errorText, JSON.stringify(devNav));
      const cookies = await a.cmd('Network.getCookies', {}, sid);
      t.ok('Network.getCookies は今のまま（今のページの Cookie）', cookies.result?.cookies?.[0]?.name === 'page');

      // 旗が on
      ports = ON;
      r.relay.setPageCookie({ name: 'pleiad_pages', value: 'SECRET', path: '/_pleiad/', httpOnly: true, sameSite: 'Strict' });
      const own = await a.cmd('Page.navigate', { url: `http://localhost:${PAGES}/_pleiad/s/${ME}/file?path=a.md` }, sid);
      t.ok('この会話のファイルのページへは移れる', !own.error && !own.result?.errorText, JSON.stringify(own));
      const otherNav = await a.cmd('Page.navigate', { url: `http://localhost:${PAGES}/_pleiad/s/conv-b/file` }, sid);
      t.ok('ほかの会話のファイルのページへの Page.navigate は断る', otherNav.error?.message === 'navigation denied');
      const otherJs = await r.fake.navigateUser(tabId, `http://localhost:${PAGES}/_pleiad/s/conv-b/file`);
      t.ok('ほかの会話のファイルのページへの JS の移動は Fetch で失敗する', otherJs?.errorText === 'net::ERR_BLOCKED_BY_CLIENT');
      t.ok('2 つの port を localhost 以外の名前で指す移動は断る', (await a.cmd('Page.navigate', { url: `http://127.0.0.1:${ISOLATED}/` }, sid)).error?.message === 'navigation denied'
        && (await a.cmd('Page.navigate', { url: `http://localhost:${ISOLATED}/viz/x/` }, sid)).error === undefined);
      const setOwn = await a.cmd('Network.setCookie', { name: 'a', value: 'x', url: `http://localhost:${PAGES}/_pleiad/` }, sid);
      t.ok('ファイルのページの port の Cookie を植えるのは断る（中継の今のページの検査を通っても）', /cookies are not available/.test(setOwn.error?.message ?? ''), JSON.stringify(setOwn));
      const before = r.chrome.calls.length;
      const opened = await a.cmd('Target.createTarget', { url: `http://localhost:${PAGES}/_pleiad/s/${ME}/dir` });
      const setCalls = r.chrome.calls.slice(before).filter(c => c.method === 'Storage.setCookies' && !c.sessionId);
      t.ok('ファイルのページを開く前に、中継の接続で Storage.setCookies を送る', !opened.error && setCalls.length === 1 && setCalls[0].params.cookies?.[0]?.url === `http://localhost:${PAGES}/_pleiad/`, JSON.stringify(opened));
      t.ok('中継のログに Cookie の値を書かない', !r.logs.some(line => line.includes('SECRET')));
    } finally {
      a?.close();
      await r.stop();
    }
  }
}
