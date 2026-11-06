import http from 'node:http';
import { createIconFetch, publicAddress } from '../../core/chrome/icon-fetch.mjs';
import { createTabInfo, sameLocalHost } from '../../core/chrome/tab-info.mjs';

export const name = 'icon-fetch';
export const title = 'favicon の取得の行き先の検査（名前解決の後の IP・リダイレクトの先・ページと同じ手元の host・Pleiad の port）';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 30; i++) await tick(); }

export default async function (t) {
  t.ok('公開のアドレスだけ通す（IPv4 の private・loopback・link-local・CGNAT・文書用・マルチキャストは断る）',
    publicAddress('93.184.216.34', new Set()) && publicAddress('8.8.8.8', new Set())
    && ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255'].every(ip => !publicAddress(ip, new Set())));
  t.ok('IPv6 の loopback・ULA・link-local・IPv4 を埋めた形（::ffff:・NAT64・6to4）も中の IPv4 で断る',
    publicAddress('2606:4700::1111', new Set())
    && ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%12', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
      '64:ff9b::a00:1', '2002:7f00:1::1', '2001:db8::1'].every(ip => !publicAddress(ip, new Set())));
  t.ok('この PC のアドレスは公開でも断る', !publicAddress('93.184.216.34', new Set(['93.184.216.34'])) && !publicAddress('::ffff:93.184.216.34', new Set(['93.184.216.34'])));
  t.ok('IP でないもの・空は断る', !publicAddress('example.com', new Set()) && !publicAddress('', new Set()) && !publicAddress(undefined, new Set()));

  // 本物の待ち受け（loopback）。名前解決を差し替え、検査した IP へそのまま繋ぐかを見る
  const hits = [];
  const server = http.createServer((req, res) => { hits.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie }); res.writeHead(200, { 'content-type': 'image/png' }); res.end('png'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const lookups = [];
    const rebinding = createIconFetch({ lookup: async name => { lookups.push(name); return [{ address: '127.0.0.1', family: 4 }]; } });
    const rebound = await rebinding(`http://evil.test:${port}/favicon.ico`).then(() => 'fetched', error => error.message);
    t.ok('名前が loopback に解決されたら繋がない（DNS の付け替え）', rebound === 'blocked address' && hits.length === 0 && lookups[0] === 'evil.test');
    const mixed = createIconFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
    t.ok('公開でないアドレスが 1 つでも混ざる名前は断る', await mixed(`http://mixed.test:${port}/`).then(() => false, error => error.message === 'blocked address') && hits.length === 0);
    const direct = createIconFetch({ lookup: async () => { throw new Error('should not resolve'); } });
    t.ok('IP の直書きの loopback も断る（名前解決しない）', await direct(`http://127.0.0.1:${port}/`).then(() => false, error => error.message === 'blocked address') && hits.length === 0);
    const local = createIconFetch({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    const response = await local(`http://localhost:${port}/favicon.ico?x=1`, { local: true });
    t.ok('local（ページと同じ手元の host）なら検査せず、解決した IP へ Host を保って繋ぎ、Cookie を送らない',
      response.status === 200 && (await response.text()) === 'png' && hits.length === 1 && hits[0].url === '/favicon.ico?x=1'
      && hits[0].host === `localhost:${port}` && hits[0].cookie === undefined);
    t.ok('http・https 以外は断る', await local('file:///C:/x.png', { local: true }).then(() => false, error => error.message === 'unsupported scheme'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const page = new URL('http://localhost:5173/app');
  t.ok('ページと同じ localhost・IP の直書きの host（名前・port・scheme）だけ local にする',
    sameLocalHost(new URL('http://localhost:5173/favicon.ico'), page)
    && sameLocalHost(new URL('http://127.0.0.1:8080/i.png'), new URL('http://127.0.0.1:8080/'))
    && sameLocalHost(new URL('http://[::1]:8080/i.png'), new URL('http://[::1]:8080/'))
    && !sameLocalHost(new URL('http://localhost:5174/favicon.ico'), page)
    && !sameLocalHost(new URL('http://127.0.0.1:5173/favicon.ico'), page)
    && !sameLocalHost(new URL('https://localhost:5173/favicon.ico'), page)
    && !sameLocalHost(new URL('http://intranet.test/favicon.ico'), new URL('http://intranet.test/')));
  t.ok('Pleiad の port は、ページと同じ host でも local にしない',
    !sameLocalHost(new URL('http://localhost:7420/x.png'), new URL('http://localhost:7420/'), { main: 7420 })
    && !sameLocalHost(new URL('http://localhost:7421/x.png'), new URL('http://localhost:7421/'), { pages: 7421 })
    && !sameLocalHost(new URL('http://localhost:7422/x.png'), new URL('http://localhost:7422/'), { isolated: 7422 }));

  // tab-info から: ページの favicon が手元を指したら local を付けず、同じ手元のページなら付ける。リダイレクトの各段で決め直す
  async function iconCalls({ url, href, redirect }) {
    const calls = [];
    const fetchResource = async (target, options) => {
      calls.push({ url: target, local: options.local });
      if (redirect && calls.length === 1) return new Response(null, { status: 302, headers: { location: redirect } });
      return new Response('png', { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const info = createTabInfo({ enabled: true, fetchResource });
    info.setPagePorts({ main: 7420, pages: 7421, isolated: 7422 });
    const tab = { sessionId: 's', targetId: 't', windowId: 1, info: { url, title: '' }, async attach() {
      return { async send(method) {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{}] };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.evaluate') return { result: { value: { href, ready: true } } };
        return {};
      }, async detach() {} };
    } };
    info.added(tab); await settle();
    return calls;
  }
  const outward = await iconCalls({ url: 'https://example.test/', href: 'http://127.0.0.1:9000/x.png' });
  t.ok('公開のページの favicon が手元を指したら local を付けない（icon-fetch が断る）', outward.length === 1 && outward[0].local === false);
  const devServer = await iconCalls({ url: 'http://localhost:5173/', href: 'http://localhost:5173/favicon.ico' });
  t.ok('手元の開発サーバーのページの、同じ host の favicon は local', devServer.length === 1 && devServer[0].local === true);
  const pleiadPort = await iconCalls({ url: 'http://localhost:5173/', href: 'http://localhost:5173/favicon.ico', redirect: 'http://localhost:7420/x.png' });
  t.ok('リダイレクトの先は決め直す（Pleiad の port・別の host は local にしない）', pleiadPort.length === 2 && pleiadPort[0].local === true && pleiadPort[1].local === false);
}
