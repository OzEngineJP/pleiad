import { createTabInfo, FAVICON_MAX_BYTES, pleiadPage } from '../../core/chrome/tab-info.mjs';

export const name = 'chrome-tab-info';
export const title = 'Scoped tab metadata from independent CDP sessions';
const makeInfo = (fake, options) => createTabInfo({ ...options, fetchResource: fake.fetch });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

function fake({ sessionId = 'one', targetId = 'tab', url = 'https://example.test/a', title = 'Title', bytes = Buffer.from('image'), mime = 'image/png', length, ready = true, href = 'https://example.test/icon.png', send } = {}) {
  const calls = []; let event, detached = 0;
  const tab = { sessionId, targetId, windowId: 1, info: { url, title }, async attach(fn) {
    event = fn;
    return { async send(method, params = {}) {
      calls.push({ method, params });
      if (send) { const answer = await send(method, params); if (answer !== undefined) return answer; }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{}, {}, {}] };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate') return { result: { value: { href, ready } } };
      return {};
    }, async detach() { detached++; } };
  } };
  const fetch = async (url, options) => {
    calls.push({ method: 'HTTP.fetch', params: { url, ...options } });
    const answer = await send?.('HTTP.fetch', { url, ...options });
    if (answer !== undefined) return answer;
    let consumed = false;
    const body = { locked: false, getReader() {
      body.locked = true;
      return { async read() {
        calls.push({ method: 'HTTP.read' });
        if (consumed) return { done: true };
        consumed = true;
        const chunk = await send?.('HTTP.read', {});
        return { done: false, value: chunk ? Buffer.from(chunk.data ?? '', chunk.base64Encoded ? 'base64' : 'utf8') : bytes };
      }, async cancel() { calls.push({ method: 'HTTP.cancel' }); }, releaseLock() { body.locked = false; } };
    }, async cancel() { calls.push({ method: 'HTTP.cancel' }); } };
    return { status: 200, headers: new Headers({ 'Content-Type': mime, ...(length === undefined ? {} : { 'Content-Length': String(length) }) }), body };
  };
  return { tab, fetch, calls, event: (method, params) => event(method, params), get detached() { return detached; } };
}

export default async function(t) {
  {
    const events = [], logs = [], f = fake();
    const info = makeInfo(f, { emit: (type, value) => events.push({ type, ...value }), log: value => logs.push(value) });
    info.added(f.tab); await settle();
    const row = info.list('one')[0];
    t.ok('metadata scoped to owner', row.url === f.tab.info.url && row.title === 'Title' && row.sessionId === 'one' && !info.list('two').length);
    t.ok('history both directions', row.canGoBack && row.canGoForward);
    t.ok('icon data URL', row.favicon === `data:image/png;base64,${Buffer.from('image').toString('base64')}`);
    t.ok('isolated execution context', f.calls.find(x => x.method === 'Runtime.evaluate').params.contextId === 42);
    t.ok('HTTP request omits credentials and bypasses browser cookie store', f.calls.find(x => x.method === 'HTTP.fetch').params.credentials === 'omit');
    t.ok('HTTP response stream cancelled', f.calls.some(x => x.method === 'HTTP.cancel'));
    f.event('Page.frameStartedLoading', { frameId: 'child' });
    t.ok('subframe does not change loading', !info.list('one')[0].loading);
    f.event('Page.frameStartedLoading', { frameId: 'main' });
    t.ok('main frame starts loading', info.list('one')[0].loading);
    f.event('Page.frameStoppedLoading', { frameId: 'main' }); await settle();
    t.ok('main frame stops loading', !info.list('one')[0].loading);
    t.ok('origin icon cache', f.calls.filter(x => x.method === 'HTTP.fetch').length === 1);
    f.tab.info.title = 'Changed'; info.changed(f.tab);
    t.ok('target change updates title', info.list('one')[0].title === 'Changed');
    const snapshot = info.list('one'); snapshot[0].title = 'mutated';
    t.ok('snapshot copy', info.list('one')[0].title === 'Changed');
    const second = fake({ targetId: 'second', url: 'https://example.test/second' });
    info.added(second.tab); await settle();
    t.ok('insertion order', info.list('one').map(x => x.targetId).join() === 'tab,second');
    t.ok('cache shared by origin', !second.calls.some(x => x.method === 'HTTP.fetch'));
    const third = fake({ sessionId: 'two', targetId: 'third', url: 'about:blank' });
    info.added(third.tab); await settle();
    t.ok('separate conversation snapshot', info.list('two').length === 1 && info.list('one').length === 2);
    info.removed(f.tab); await settle();
    t.ok('removal detaches and notifies', f.detached === 1 && events.some(x => x.removed && x.sessionId === 'one' && x.targetId === 'tab'));
    t.ok('logs contain no metadata', logs.length === 0);
    t.ok('every publication has owner', events.every(x => x.type === 'tab:info' && ['one', 'two'].includes(x.sessionId)));
    info.removed(second.tab); info.removed(third.tab);
  }
  for (const options of [
    { bytes: Buffer.alloc(FAVICON_MAX_BYTES + 1) },
    { length: FAVICON_MAX_BYTES + 1 },
    { mime: 'text/html' },
    { href: 'file:///private' },
    { url: 'http://localhost:8000/_pleiad/s/one/file?path=C%3A%5Cwork%5Ca.md' },
    { url: 'http://localhost:8000/_pleiad/unknown' },
  ]) {
    const f = fake(options), info = makeInfo(f);
    info.added(f.tab); await settle();
    t.ok('unsafe or oversized icon omitted', info.list('one')[0].favicon === null);
    if (options.length || options.mime) t.ok('reject before reading stream', !f.calls.some(x => x.method === 'HTTP.read'));
    if (options.href || options.url) t.ok('no request for page or non-HTTP resource', !f.calls.some(x => x.method === 'HTTP.fetch'));
    info.removed(f.tab);
  }
  {
    const f = fake({ bytes: Buffer.alloc(FAVICON_MAX_BYTES) }), info = makeInfo(f);
    info.added(f.tab); await settle();
    t.ok('64 KiB boundary accepted', info.list('one')[0].favicon !== null); info.removed(f.tab);
    const ports = { pages: 8000 }, url = 'http://localhost:8000/_pleiad/s/one/file?path=C%3A%5Cwork%5Ca.md';
    t.ok('page kind and decoded address path', pleiadPage(url, 'one', ports)?.path === 'C:\\work\\a.md');
    t.ok('foreign page is not ours', pleiadPage('http://localhost:8000/_pleiad/s/two/dir?path=x', 'one', ports) === null);
    t.ok('unknown or foreign listener is not ours', pleiadPage(url, 'one') === null && pleiadPage(url, 'one', { pages: 9000 }) === null);
    const local = fake({ url }); info.added(local.tab); await settle();
    info.setPagePorts(ports);
    t.ok('page ports can be supplied after listener binding', info.list('one')[0].page?.kind === 'file');
    info.removed(local.tab);
  }
  {
    const f = fake({ href: 'https://cdn.example.test/icon.png' }), info = makeInfo(f);
    info.added(f.tab); await settle();
    t.ok('CDN icon supported without credentials', info.list('one')[0].favicon !== null && f.calls.find(x => x.method === 'HTTP.fetch').params.credentials === 'omit');
    info.removed(f.tab);
  }
  for (const location of ['https://cdn.example.test/icon.png', 'file:///private', 'https://user:pass@example.test/icon', 'http://localhost:8000/_pleiad/s/one/file?path=x']) {
    let first = true;
    const f = fake({ send: method => {
      if (method === 'HTTP.fetch' && first) { first = false; return new Response(null, { status: 302, headers: { location } }); }
    } }), info = makeInfo(f);
    info.added(f.tab); await settle();
    const allowed = location === 'https://cdn.example.test/icon.png';
    t.ok('redirect is checked before following', f.calls.filter(x => x.method === 'HTTP.fetch').length === (allowed ? 2 : 1) && Boolean(info.list('one')[0].favicon) === allowed);
    t.ok('redirect requests remain credential-free', f.calls.filter(x => x.method === 'HTTP.fetch').every(x => x.params.credentials === 'omit' && x.params.redirect === 'manual'));
    info.removed(f.tab);
  }
  {
    const f = fake({ send: method => method === 'HTTP.fetch' ? new Response(null, { status: 302, headers: { location: '/loop' } }) : undefined });
    const info = makeInfo(f); info.added(f.tab); await settle();
    t.ok('redirect count bounded', f.calls.filter(x => x.method === 'HTTP.fetch').length === 4 && info.list('one')[0].favicon === null);
    info.removed(f.tab);
  }
  {
    let resolveRead;
    const f = fake({ send: method => method === 'HTTP.read' ? new Promise(resolve => { resolveRead = resolve; }) : undefined });
    const events = [], info = makeInfo(f, { emit: (type, value) => events.push(value) });
    info.added(f.tab); await settle();
    f.tab.info.url = 'https://new.example/'; info.changed(f.tab);
    resolveRead({ data: 'old', eof: true }); await settle();
    t.ok('stale icon cannot overwrite new navigation', info.list('one')[0].favicon === null);
    info.removed(f.tab); const count = events.length;
    f.event('Page.frameStartedLoading', { frameId: 'main' }); await settle();
    t.ok('removed tab cannot publish later', events.length === count);
  }
  {
    const logs = [], f = fake({ send: method => { if (method === 'Page.getFrameTree') throw new Error('secret URL and title'); } });
    const info = makeInfo(f, { log: value => logs.push(value) });
    info.added(f.tab); await settle();
    t.ok('CDP errors redacted in logs', logs.length === 1 && !logs[0].includes('secret')); info.removed(f.tab);
  }
  {
    const f = fake({ ready: false }), info = makeInfo(f);
    info.added(f.tab); await settle();
    t.ok('attach during navigation marks loading', info.list('one')[0].loading && !f.calls.some(x => x.method === 'HTTP.fetch'));
    info.removed(f.tab);
  }
  {
    const f = fake({ ready: false, url: 'http://localhost:8000/_pleiad/s/one/file?path=x' }), info = makeInfo(f);
    info.setPagePorts({ pages: 8000 }); info.added(f.tab); await settle();
    t.ok('Pleiad page readiness is read without requesting an icon', info.list('one')[0].loading && !f.calls.some(x => x.method === 'HTTP.fetch') && !f.calls.find(x => x.method === 'Runtime.evaluate').params.expression.includes('querySelector'));
    info.removed(f.tab);
  }
  {
    const f = fake(), info = makeInfo(f);
    info.added(f.tab); await settle();
    f.event('Page.frameStoppedLoading', { frameId: 'main' }); await settle();
    f.tab.info.url = 'https://second.test/'; info.changed(f.tab); await settle();
    t.ok('URL notification after load still refreshes icon', info.list('one')[0].favicon !== null && f.calls.filter(x => x.method === 'HTTP.fetch').length === 2);
    info.removed(f.tab);
  }
  for (const ready of [false, true]) {
    let release, first = true;
    const f = fake({ send: method => {
      if (method === 'Runtime.evaluate' && first) { first = false; return new Promise(resolve => { release = resolve; }); }
    } }), info = makeInfo(f);
    info.added(f.tab); await settle();
    f.event(ready ? 'Page.frameStartedLoading' : 'Page.frameStoppedLoading', { frameId: 'main' });
    release({ result: { value: { ready, href: 'https://example.test/icon.png' } } }); await settle();
    t.ok('loading events supersede delayed readyState', info.list('one')[0].loading === ready);
    info.removed(f.tab);
  }
  {
    let release, first = true;
    const f = fake({ send: method => {
      if (method === 'Page.getNavigationHistory') {
        if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
        return { currentIndex: 0, entries: [{}] };
      }
    } }), info = makeInfo(f);
    info.added(f.tab); await settle();
    t.ok('pending history does not hold up favicon', info.list('one')[0].favicon !== null);
    f.event('Page.navigatedWithinDocument', { frameId: 'main' }); await settle();
    release({ currentIndex: 1, entries: [{}, {}, {}] }); await settle();
    t.ok('late history cannot overwrite latest history', !info.list('one')[0].canGoBack && !info.list('one')[0].canGoForward);
    info.removed(f.tab);
  }
  {
    // Chrome は題だけの変化で targetInfoChanged を送らない。読み込みが止まったら題を読む
    let pageTitle = 'Shop B';
    const f = fake({ url: 'http://127.0.0.1:1462/', title: '127.0.0.1:1462', send: (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === 'document.title') return { result: { value: pageTitle } };
    } }), info = makeInfo(f);
    info.added(f.tab); await settle();
    t.ok('title read after attach', info.list('one')[0].title === 'Shop B');
    f.tab.info.title = '127.0.0.1:1462'; info.changed(f.tab);
    t.ok('same Chrome title keeps read title', info.list('one')[0].title === 'Shop B');
    pageTitle = 'Shop C'; f.event('Page.frameStoppedLoading', { frameId: 'main' }); await settle();
    t.ok('title read when loading stops', info.list('one')[0].title === 'Shop C');
    f.tab.info = { url: 'http://127.0.0.1:1462/next', title: '127.0.0.1:1462/next' }; info.changed(f.tab);
    t.ok('URL change drops read title', info.list('one')[0].title === '127.0.0.1:1462/next');
    info.removed(f.tab);
    const marker = fake({ url: '', title: 'PLY-963b7ae6e2f8e765' }), markers = makeInfo(marker);
    markers.added(marker.tab); await settle();
    t.ok('window marker title hidden', markers.list('one')[0].title === '');
    markers.removed(marker.tab);
  }
  {
    let release, detached = 0;
    const tab = { sessionId: 'one', targetId: 'gone', info: {}, attach: () => new Promise(resolve => { release = resolve; }) };
    const info = createTabInfo();
    info.added(tab); info.removed(tab);
    release({ detach: async () => { detached++; } }); await settle();
    t.ok('removal during attach releases session', detached === 1 && !info.list('one').length);
  }
}
