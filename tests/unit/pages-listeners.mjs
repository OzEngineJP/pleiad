// ファイルのページと隔離の 2 つのリスナー（ADR 0292 の 1・2。core/page-listener.mjs・pages-server.mjs・isolated-server.mjs・browser-unify-listeners.mjs）と、
// サーバー（いつも 2 つの port が立ち、中身の無い /_pleiad/ は 404 を返す。中身は A3・A4）。
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { COMMON_HEADERS, hostOk, startPageListener } from '../../core/page-listener.mjs';
import { startPagesServer } from '../../core/pages-server.mjs';
import { startIsolatedServer } from '../../core/isolated-server.mjs';
import { createPagesRoutes } from '../../core/pages-routes.mjs';
import { createIsolatedRoutes } from '../../core/isolated-routes.mjs';
import { PAGE_PORTS_FILE, envPort, readPagePorts, startBrowserUnifyListeners, writePagePorts } from '../../core/browser-unify-listeners.mjs';
import { MAIN_COOKIE, PAGES_COOKIE, pagesSecret } from '../../core/page-auth.mjs';
import { ENTER_PATH, MAX_TICKETS, createPageTickets } from '../../core/page-tickets.mjs';
import { waitFor } from '../lib/holder-harness.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'pages-listeners';
export const title = 'ファイルのページと隔離のリスナー（Host・メソッド・::1・port の引き継ぎ・入口の認証）とサーバー';

/** Host を自分で決めて 1 回だけ投げる（fetch は Host を変えられない） */
function request({ address = '127.0.0.1', port, pathname = '/', method = 'GET', host = `localhost:${port}`, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path: pathname, method, agent: false, headers: { host, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const common = res => Object.entries(COMMON_HEADERS).every(([key, value]) => res.headers[key] === value);

function blocker(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end('other'));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
const closeServer = server => new Promise(resolve => server.close(() => resolve()));

async function listenerChecks(t) {
  const logs = [];
  const seen = [];
  const listener = await startPageListener({
    name: 'probe', log: line => logs.push(line),
    handle(req, res, { url }) {
      seen.push(url.pathname);
      if (url.pathname === '/boom') throw new Error('boom');
      res.end('hello');
    },
  });
  try {
    const { port } = listener;
    const ok = await request({ port, pathname: '/a?b=1' });
    t.ok('Host が localhost:<port> なら渡し、共通のヘッダー（no-referrer・nosniff）が付く', ok.status === 200 && ok.body === 'hello' && common(ok) && seen.at(-1) === '/a');

    const wrongHost = await request({ port, host: `127.0.0.1:${port}` });
    const otherName = await request({ port, host: `evil.example:${port}` });
    t.ok('Host が違えば 421 で、渡さない（DNS rebinding）', wrongHost.status === 421 && otherName.status === 421 && common(wrongHost) && seen.length === 1);
    t.ok('Host の検査は大小文字を見ず、port の違いは通さない', hostOk(`LocalHost:${port}`, port) && !hostOk(`localhost:${port + 1}`, port) && !hostOk(undefined, port));

    const post = await request({ port, method: 'POST' });
    const put = await request({ port, method: 'PUT' });
    t.ok('GET・HEAD のほかは 405 で Allow: GET, HEAD', post.status === 405 && put.status === 405 && post.headers.allow === 'GET, HEAD' && common(post) && seen.length === 1);

    const head = await request({ port, method: 'HEAD', pathname: '/h' });
    t.ok('HEAD は渡す', head.status === 200 && seen.at(-1) === '/h');

    const boom = await request({ port, pathname: '/boom' });
    t.ok('渡した先が投げたら 500 にして、ログに残す', boom.status === 500 && logs.some(line => line.includes('boom')));

    if (listener.hosts.includes('::1')) {
      const v6 = await request({ address: '::1', port });
      t.ok('::1 の同じ port でも答える', v6.status === 200 && v6.body === 'hello');
    } else {
      t.ok('この PC は IPv6 が無く、127.0.0.1 だけで待つ', listener.hosts.join() === '127.0.0.1');
    }
  } finally {
    await listener.close();
  }

  // 覚えた port が塞がっている: 待たなければ空いた port、待つ間に放されればその port
  const taken = await blocker(0);
  const takenPort = taken.address().port;
  const fallback = await startPageListener({ name: 'probe', port: takenPort, waitMs: 0, log: line => logs.push(line), handle: (req, res) => res.end() });
  t.ok('覚えた port が塞がっていて待たないなら、空いた port にする', fallback.port !== takenPort && fallback.port > 0
    && logs.some(line => line.includes(`port ${takenPort} is not available`)));
  await fallback.close();
  setTimeout(() => { void closeServer(taken); }, 200);
  const waited = await startPageListener({ name: 'probe', port: takenPort, waitMs: 5000, retryMs: 25, log: line => logs.push(line), handle: (req, res) => res.end('mine') });
  try {
    t.ok('待つ間に前のサーバーが放せば、同じ port を取る', waited.port === takenPort && (await request({ port: takenPort })).body === 'mine'
      && logs.some(line => line.includes('after waiting')));
  } finally {
    await waited.close();
  }
}

async function serverChecks(t) {
  const token = 'tok-pages-listeners';
  const calls = [];
  const routes = { handle(req, res, info) { calls.push(info); res.statusCode = 404; res.end('stub'); } };
  const pages = await startPagesServer({ token, routes });
  const isolated = await startIsolatedServer({ routes: createIsolatedRoutes() });
  try {
    const outside = await request({ port: pages.port, pathname: '/x', headers: { cookie: `${PAGES_COOKIE}=${pagesSecret(token)}` } });
    t.ok('ファイルのページの port: /_pleiad/ の外は 404 で渡さない', outside.status === 404 && calls.length === 0);
    const noCookie = await request({ port: pages.port, pathname: '/_pleiad/s/a/b' });
    const mainCookie = await request({ port: pages.port, pathname: `/_pleiad/s/a/b?token=${token}`, headers: { cookie: `${MAIN_COOKIE}=${token}` } });
    t.ok('ファイルのページの port: ページの Cookie が無ければ 401（本体の Cookie・?token= も通さない）', noCookie.status === 401 && mainCookie.status === 401 && calls.length === 0);
    const withCookie = await request({ port: pages.port, pathname: '/_pleiad/s/a/b', headers: { cookie: `${PAGES_COOKIE}=${pagesSecret(token)}` } });
    t.ok('ファイルのページの port: ページの Cookie が合えば中身へ渡す（via: pages）', withCookie.body === 'stub' && calls.length === 1
      && calls[0].via === 'pages' && calls[0].url.pathname === '/_pleiad/s/a/b');
    const site = value => request({ port: pages.port, pathname: '/_pleiad/s/a/b', headers: { cookie: `${PAGES_COOKIE}=${pagesSecret(token)}`, 'sec-fetch-site': value } });
    const [sameOrigin, none, sameSite, crossSite] = await Promise.all(['same-origin', 'none', 'same-site', 'cross-site'].map(site));
    t.ok('ファイルのページの port: Sec-Fetch-Site が same-site・cross-site なら Cookie が合っても 401（隔離の origin・手元のほかのサーバーから）',
      sameOrigin.body === 'stub' && none.body === 'stub' && sameSite.status === 401 && crossSite.status === 401 && calls.length === 3);

    const stubPages = await startPagesServer({ token, routes: createPagesRoutes() });
    try {
      const empty = await request({ port: stubPages.port, pathname: '/_pleiad/s/a/b', headers: { cookie: `${PAGES_COOKIE}=${pagesSecret(token)}` } });
      t.ok('S0 のページの中身（core/pages-routes.mjs）は 404 を返すだけ', empty.status === 404 && common(empty));
    } finally {
      await stubPages.close();
    }

    // 入場券（既定のブラウザーでフォルダーのページを開く）: 1 回だけ・60 秒・OS からの起動だけ・行き先は券を作ったときのもの
    let clock = 1_000;
    const tickets = createPageTickets({ now: () => clock });
    const entered = await startPagesServer({ token, routes, tickets });
    try {
      const enter = (ticket, headers = {}) => request({ port: entered.port, pathname: `${ENTER_PATH}?ticket=${ticket}&next=/evil`, headers });
      const first = tickets.issue('/_pleiad/s/one/dir?path=D%3A%5Cwork');
      const ok = await enter(first, { 'sec-fetch-site': 'none' });
      const cookie = String(ok.headers['set-cookie'] ?? '');
      t.ok('入場券: 生きた券は 303 で券を作ったときの行き先へ移し（URL の next は見ない）、ページの Cookie を HttpOnly・Strict・/_pleiad/ で置く',
        ok.status === 303 && ok.headers.location === '/_pleiad/s/one/dir?path=D%3A%5Cwork' && cookie.startsWith(`${PAGES_COOKIE}=${pagesSecret(token)};`)
        && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\/_pleiad\//.test(cookie));
      const again = await enter(first);
      t.ok('入場券: 使った券は 2 回目は 401（Cookie を置かない）', again.status === 401 && !again.headers['set-cookie']);
      const fromPage = tickets.issue('/_pleiad/s/one/dir');
      const sameSite = await enter(fromPage, { 'sec-fetch-site': 'same-site' });
      const crossSite = await enter(tickets.issue('/_pleiad/s/one/dir'), { 'sec-fetch-site': 'cross-site' });
      t.ok('入場券: ほかのページからの移動（same-site・cross-site）では使えない', sameSite.status === 401 && crossSite.status === 401 && !sameSite.headers['set-cookie']);
      const late = tickets.issue('/_pleiad/s/one/dir');
      clock += 60_001;
      const expired = await enter(late);
      const forged = await enter('0'.repeat(64));
      const noRoutes = calls.length;
      t.ok('入場券: 60 秒を過ぎた券・作っていない券は 401。入口は中身（routes）へ渡さない', expired.status === 401 && forged.status === 401 && noRoutes === calls.length);
      const many = Array.from({ length: MAX_TICKETS + 1 }, () => tickets.issue('/_pleiad/s/one/dir'));
      t.ok('入場券: 持つのは 20 枚までで、古いものから捨てる', tickets.take(many[0]) === null && tickets.take(many.at(-1)) === '/_pleiad/s/one/dir');
      let refused = 0;
      for (const next of ['/x', 'http://evil/_pleiad/', '/_pleiad/enter?ticket=a', null]) { try { tickets.issue(next); } catch { refused++; } }
      t.ok('入場券: 行き先は /_pleiad/ の下だけ（入口そのものは行き先にしない）', refused === 4);
      const plain = await request({ port: pages.port, pathname: `${ENTER_PATH}?ticket=${tickets.issue('/_pleiad/s/one/dir')}` });
      t.ok('入場券: 券の台帳を渡していないリスナーは入口を開かない', plain.status === 401);
    } finally {
      await entered.close();
    }

    const iso = await request({ port: isolated.port, pathname: '/viz/abc/index.html' });
    const isoWrongHost = await request({ port: isolated.port, host: `127.0.0.1:${isolated.port}` });
    t.ok('隔離の port: S0 は 404 を返すだけで、Host の検査と共通のヘッダーは同じ', iso.status === 404 && common(iso) && isoWrongHost.status === 421);
  } finally {
    await Promise.all([pages.close(), isolated.close()]);
  }
}

async function portChecks(t, scratch) {
  const dataDir = path.join(scratch, 'ports');
  await fs.mkdir(dataDir);
  const deps = { dataDir, token: 'tok', pagesRoutes: createPagesRoutes(), isolatedRoutes: createIsolatedRoutes() };
  t.ok('環境変数の port: 空・数でない・範囲の外は使わず、0 は空いた port',
    envPort(undefined) === null && envPort(' ') === null && envPort('abc') === null && envPort('70000') === null && envPort('-1') === null
    && envPort('0') === 0 && envPort('8123') === 8123);
  t.ok('覚えた port が無ければ両方 null', JSON.stringify(await readPagePorts(dataDir)) === JSON.stringify({ pages: null, isolated: null }));

  const first = await startBrowserUnifyListeners({ ...deps, env: {} });
  const saved = await readPagePorts(dataDir);
  await first.close();
  t.ok('初めての起動は空いた port を 2 つ取り、page-ports.json に覚える', first.ports.pages > 0 && first.ports.isolated > 0 && first.ports.pages !== first.ports.isolated
    && saved.pages === first.ports.pages && saved.isolated === first.ports.isolated);

  const file = path.join(dataDir, PAGE_PORTS_FILE);
  const before = (await fs.stat(file)).mtimeMs;
  const second = await startBrowserUnifyListeners({ ...deps, env: {} });
  await second.close();
  t.ok('次の起動は覚えた port を取り直し、変わらなければ書き直さない', second.ports.pages === first.ports.pages && second.ports.isolated === first.ports.isolated
    && (await fs.stat(file)).mtimeMs === before);

  const fromEnv = await startBrowserUnifyListeners({ ...deps, env: { AGENT_HOST_PAGES_PORT: '0', AGENT_HOST_ISOLATED_PORT: '0' } });
  await fromEnv.close();
  const afterEnv = await readPagePorts(dataDir);
  t.ok('環境変数で決めた port は覚えない', afterEnv.pages === first.ports.pages && afterEnv.isolated === first.ports.isolated);

  const taken = await blocker(first.ports.pages);
  try {
    const moved = await startBrowserUnifyListeners({ ...deps, env: {}, waitMs: 0 });
    await moved.close();
    const afterMove = await readPagePorts(dataDir);
    t.ok('覚えた port が取れなければ空いた port にして覚え直す', moved.ports.pages !== first.ports.pages && afterMove.pages === moved.ports.pages
      && afterMove.isolated === first.ports.isolated);
  } finally {
    await closeServer(taken);
  }

  await fs.writeFile(file, '{broken');
  t.ok('壊れた page-ports.json は無いものとして読む', JSON.stringify(await readPagePorts(dataDir)) === JSON.stringify({ pages: null, isolated: null }));
  await writePagePorts(dataDir, { pages: 70000, isolated: 'x' });
  t.ok('範囲の外の port は覚えない', JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))) === JSON.stringify({ pages: null, isolated: null }));
}

async function hostChecks(t, scratch) {
  // 2 つの port が立ち、本体の /_pleiad/ は本体の Cookie だけで答える
  const onDir = path.join(scratch, 'on'), work = path.join(scratch, 'work');
  await fs.mkdir(path.join(work, 'sub'), { recursive: true });
  for (const name of ['doc.pdf', 'run.bat']) await fs.writeFile(path.join(work, name), 'x');
  await fs.mkdir(onDir);
  await fs.writeFile(path.join(onDir, 'sessions.json'), JSON.stringify({ fixture: { cwd: work, backend: 'fake' } }));
  const on = await startServer({ dataDir: onDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_OS_OPEN: 'dry' } });
  let client = null;
  try {
    client = await open({ port: on.port, token: on.token });
    let caps;
    await waitFor(async () => { caps = await client.cmd('hostCapabilities'); return caps.browserUnify?.pages > 0; }, 15_000, 'browserUnify ports');
    const saved = await readPagePorts(onDir);
    t.ok('2 つの port が立ち、hostCapabilities.browserUnify と page-ports.json に出る',
      caps.browserUnify.isolated > 0 && saved.pages === caps.browserUnify.pages && saved.isolated === caps.browserUnify.isolated);

    const pagesRes = await request({ port: caps.browserUnify.pages, pathname: '/_pleiad/s/a/b', headers: { cookie: `${PAGES_COOKIE}=${pagesSecret(on.token)}` } });
    const pagesNoCookie = await request({ port: caps.browserUnify.pages, pathname: '/_pleiad/s/a/b' });
    t.ok('ファイルのページの port の /_pleiad/: ページの Cookie で 404・無ければ 401', pagesRes.status === 404 && pagesNoCookie.status === 401);

    const mainRes = await request({ port: on.port, pathname: '/_pleiad/s/a/b', host: `127.0.0.1:${on.port}`, headers: { cookie: `${MAIN_COOKIE}=${on.token}` } });
    const mainQuery = await request({ port: on.port, pathname: `/_pleiad/s/a/b?token=${on.token}`, host: `127.0.0.1:${on.port}` });
    const mainPost = await request({ port: on.port, pathname: '/_pleiad/s/a/b', method: 'POST', host: `127.0.0.1:${on.port}`, headers: { cookie: `${MAIN_COOKIE}=${on.token}` } });
    t.ok('本体の port の /_pleiad/: 本体の Cookie で 404・?token= だけでは 401・POST は 405', mainRes.status === 404 && common(mainRes)
      && mainQuery.status === 401 && mainPost.status === 405);
    const mainSameSite = await request({ port: on.port, pathname: '/_pleiad/s/a/b', host: `127.0.0.1:${on.port}`, headers: { cookie: `${MAIN_COOKIE}=${on.token}`, 'sec-fetch-site': 'same-site' } });
    t.ok('本体の port の /_pleiad/: Sec-Fetch-Site が same-site なら本体の Cookie でも 401', mainSameSite.status === 401);

    // resolvePath の defaultAppAllowed（タブのメニューの「既定のアプリで開く」）と、フォルダーの「既定のブラウザーで開く」
    const [pdf, bat, dir] = await Promise.all(['doc.pdf', 'run.bat', 'sub'].map(p => client.cmd('resolvePath', { path: p, sessionId: 'fixture' })));
    t.ok('resolvePath: 検査した実体の名前で defaultAppAllowed を返す（.pdf は true・.bat とフォルダーは false）',
      pdf.defaultAppAllowed === true && bat.defaultAppAllowed === false && dir.defaultAppAllowed === false && dir.kind === 'directory');
    const opened = await client.cmd('openPath', { path: 'sub', sessionId: 'fixture' });
    const noSession = await client.cmd('openPath', { path: path.join(work, 'sub') }).then(() => 'opened', e => e.message);
    t.ok('openPath: フォルダーをフォルダーのページで既定のブラウザーに開く（会話の無いフォルダーは断る）',
      opened.path === await fs.realpath(path.join(work, 'sub')) && noSession !== 'opened');
  } finally {
    client?.close();
    await on.stop();
  }
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-pages-listeners-'));
  try {
    await listenerChecks(t);
    await serverChecks(t);
    await portChecks(t, scratch);
    await hostChecks(t, scratch);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
