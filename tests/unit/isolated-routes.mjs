// 隔離の origin の中身（ADR 0295 の 3。core/isolated-routes.mjs・html-keys.mjs）。
//   - /viz/<束のハッシュ>/<相対パス>: 目録から引いた中身を、応答のヘッダーの CSP（sandbox・束のパスだけの読み先）で返す。
//     入口は ?embed= で会話の枠と同じ包み（meta の CSP は書かない）。?once=<印> の出どころだけ足す
//   - /f/<鍵>/<相対パス>: HTML のファイルのフォルダーの下だけ。外・ドットで始まる名前・データ置き場・期限切れの鍵は 404
//   - `..`・区切りの混じり・知らない束は 404。HEAD は中身なし。Host が違えば 421（リスナー）
//   - 実際のサーバー: 可視化の行が束を持ち、隔離の port がその束を配る
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createIsolatedRoutes, relativeSegments } from '../../core/isolated-routes.mjs';
import { startIsolatedServer } from '../../core/isolated-server.mjs';
import { createHtmlKeys } from '../../core/html-keys.mjs';
import { collectBundle } from '../../core/viz-bundle.mjs';
import { waitFor } from '../lib/holder-harness.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { VISUALIZE_START as S, VISUALIZE_END as E } from '../../web/visualize-reference.mjs';

export const name = 'isolated-routes';
export const title = '隔離の origin の可視化の束と HTML のファイル（ヘッダーの CSP・フォルダーの外・鍵の期限・一度だけの印・実際のサーバー）';

function request({ port, pathname = '/', method = 'GET', host = `localhost:${port}`, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, agent: false, headers: { host, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const csp = res => res.headers['content-security-policy'] ?? '';
const directive = (res, name) => csp(res).split('; ').find(part => part.startsWith(`${name} `)) ?? '';

async function routeChecks(t, scratch) {
  const dataDir = path.join(scratch, 'data');
  const access = { dataDir, uploadDir: path.join(dataDir, 'uploads') };
  await fs.mkdir(access.uploadDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'secret.txt'), 'secret');
  const work = path.join(scratch, 'work');
  const outside = path.join(scratch, 'outside');
  await fs.mkdir(path.join(work, 'assets'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'o.txt'), 'outside');
  const entry = path.join(work, 'chart.html');
  const html = '<!doctype html><html><head><title>c</title></head><body><img src="assets/a.png"><script>fetch("assets/d.json")</script></body></html>';
  await fs.writeFile(entry, html);
  await fs.writeFile(path.join(work, 'assets', 'a.png'), 'PNG');
  await fs.writeFile(path.join(work, 'assets', 'd.json'), '{"d":1}');
  await fs.writeFile(path.join(work, 'page2.html'), '<p>two</p>');
  await fs.writeFile(path.join(work, '.env'), 'SECRET=1');
  // Shift_JIS の「表」（0x95 0x5C）。UTF-8 としては読めない
  await fs.writeFile(path.join(work, 'sjis.html'), Buffer.concat([Buffer.from('<meta charset="Shift_JIS"><p>'), Buffer.from([0x95, 0x5c]), Buffer.from('</p>')]));
  await fs.symlink(dataDir, path.join(work, 'data-link'), 'junction');
  await fs.symlink(outside, path.join(work, 'out-link'), 'junction');

  const bundle = await collectBundle(entry, access, { dataDir, entryBody: html });
  let prefs = {};
  let clock = Date.now();
  const htmlKeys = createHtmlKeys({ now: () => clock });
  const routes = createIsolatedRoutes({ dataDir, store: { getPrefs: async () => prefs }, htmlKeys, fileAccessFor: () => access, sweepDelayMs: null, now: () => clock });
  const server = await startIsolatedServer({ routes });
  const port = server.port;
  const viz = rest => `/viz/${bundle.hash}/${rest}`;
  try {
    const conv = await request({ port, pathname: viz('chart.html?embed=conversation&theme=dark') });
    t.ok('入口は会話の枠と同じ包みで、CSP は応答のヘッダー（sandbox・allow-same-origin なし）だけ',
      conv.status === 200 && csp(conv).startsWith('sandbox allow-scripts allow-downloads allow-forms; ') && !csp(conv).includes('allow-same-origin')
      && !conv.body.includes('http-equiv="Content-Security-Policy"') && conv.body.includes('ply-visualize-height') && conv.body.includes('color-scheme:dark')
      && conv.body.includes('ply-preview-blocked') && conv.body.includes("'localStorage'") && conv.headers['content-type'] === 'text/html; charset=utf-8');
    t.ok('読み先は束のパスだけ（img・connect）。ほかの束・本体の port は入らない',
      directive(conv, 'img-src') === `img-src http://localhost:*/viz/${bundle.hash}/ https: data: blob:` && directive(conv, 'connect-src') === `connect-src http://localhost:*/viz/${bundle.hash}/ https:`);
    t.ok('ヘッダー: CORP cross-origin・Permissions-Policy・no-referrer・nosniff・HTML は保存しない',
      conv.headers['cross-origin-resource-policy'] === 'cross-origin' && /camera=\(\)/.test(conv.headers['permissions-policy'])
      && conv.headers['referrer-policy'] === 'no-referrer' && conv.headers['x-content-type-options'] === 'nosniff' && conv.headers['cache-control'] === 'no-store');
    const tab = await request({ port, pathname: viz('chart.html?embed=tab'), headers: { 'sec-fetch-dest': 'document' } });
    t.ok('別のタブ（embed=tab）は高さの知らせも橋も入れない', tab.status === 200 && !tab.body.includes('ply-visualize-height') && !tab.body.includes('ply-preview-blocked'));
    const titled = await request({ port, pathname: viz(`chart.html?embed=tab&title=${encodeURIComponent('売上 <b>')}`), headers: { 'sec-fetch-dest': 'document' } });
    const framedTitle = await request({ port, pathname: viz('chart.html?embed=panel&title=x'), headers: { 'sec-fetch-dest': 'iframe' } });
    t.ok('別のタブは題を包みの <title> にする（エスケープする）。枠の中では付けない',
      titled.body.includes('<title>売上 &#60;b&#62;</title>') && !framedTitle.body.includes('<title>x</title>'));
    const page2 = await request({ port, pathname: viz('page2.html'), headers: { 'sec-fetch-dest': 'iframe' } });
    t.ok('束の中の別の HTML（枠の中で開いた）には、頭に保存庫の代わりと橋を差し込む', page2.status === 200 && page2.body.startsWith('<script>') && page2.body.includes('ply-preview-open-link') && page2.body.endsWith('<p>two</p>'));
    const raw = await request({ port, pathname: viz('chart.html'), headers: { 'sec-fetch-dest': 'document' } });
    t.ok('枠の外で開いた HTML は橋を入れず、doctype の後ろに保存庫の代わりだけ', raw.body.startsWith('<!doctype html><script>') && !raw.body.includes('ply-preview-blocked'));

    const png = await request({ port, pathname: viz('assets/a.png') });
    const cached = await request({ port, pathname: viz('assets/a.png'), headers: { 'if-none-match': png.headers.etag } });
    t.ok('束の中のファイルは型と etag 付きで返し、同じなら 304', png.status === 200 && png.body === 'PNG' && png.headers['content-type'] === 'image/png'
      && png.headers['access-control-allow-origin'] === '*' && cached.status === 304 && cached.raw.length === 0);
    const json = await request({ port, pathname: viz('assets/d.json') });
    t.ok('文字のファイルは utf-8', json.headers['content-type'] === 'application/json; charset=utf-8' && json.body === '{"d":1}');
    const upper = await request({ port, pathname: viz('ASSETS/A.PNG') });
    t.ok('大小文字の違いは、1 つに決まるなら引く', upper.status === 200 && upper.body === 'PNG');
    const head = await request({ port, pathname: viz('assets/a.png'), method: 'HEAD' });
    t.ok('HEAD は中身なしで長さだけ', head.status === 200 && head.raw.length === 0 && head.headers['content-length'] === '3');

    const notFound = await Promise.all([
      viz(''), viz('%2e%2e/secret.txt'), viz('assets%2Fa.png'), viz('assets%5Ca.png'), viz('.env'), viz('missing.png'),
      `/viz/${'0'.repeat(64)}/chart.html`, '/viz/nothex/chart.html', '/viz/', '/other', `/viz/${bundle.hash}/%E0%A4%A`,
    ].map(pathname => request({ port, pathname })));
    t.ok('`..`・区切りの混じり・束に無いもの・知らない束・壊れた %・知らない場所は 404', notFound.every(res => res.status === 404), notFound.map(res => res.status).join(','));
    t.ok('相対パスの部分の検査', JSON.stringify(relativeSegments(['a', 'b%20c'])) === '["a","b c"]' && relativeSegments(['..']) === null
      && relativeSegments(['a', '']) === null && relativeSegments(['C:']) === null && relativeSegments(['a%00']) === null);
    const wrongHost = await request({ port, pathname: viz('chart.html'), host: `127.0.0.1:${port}` });
    t.ok('Host が localhost:<port> でなければ 421（リスナー）', wrongHost.status === 421);

    // 確認あり: 許した出どころと、一度だけの印の出どころだけ
    prefs = { confirmExternalLoads: true, externalSitePermissions: [{ origin: 'https://always.example', mode: 'always' }] };
    const token = routes.once(['https://once.example/x', 'http://plain.example']);
    const withOnce = await request({ port, pathname: viz(`chart.html?embed=panel&once=${token}`) });
    const withoutOnce = await request({ port, pathname: viz('chart.html?embed=panel') });
    const forged = await request({ port, pathname: viz('chart.html?embed=panel&once=https%3A%2F%2Fevil.example') });
    t.ok('確認ありなら、許した出どころと一度だけの印の出どころだけを読み先にする（印でない値は無視）',
      directive(withOnce, 'img-src').includes('https://once.example') && directive(withOnce, 'img-src').includes('https://always.example')
      && !directive(withoutOnce, 'img-src').includes('https://once.example') && !csp(forged).includes('evil') && !csp(withoutOnce).includes(' https:;'));
    t.ok('一度だけの印は https が無ければ作らない', routes.once(['http://plain.example']) === null);
    prefs = {};

    // HTML のファイル（/f/<鍵>/）
    t.ok('鍵は絶対パスの HTML のファイルにだけ出す', htmlKeys.issue({ path: path.join(work, 'assets', 'd.json') }) === null && htmlKeys.issue({ path: 'chart.html' }) === null);
    const key = htmlKeys.issue({ sessionId: 's1', path: entry });
    t.ok('同じファイルにもう一度出すと同じ鍵（22 文字）', /^[A-Za-z0-9_-]{22}$/.test(key) && htmlKeys.issue({ sessionId: 's1', path: entry }) === key);
    const file = await request({ port, pathname: `/f/${key}/` });
    t.ok('/f/<鍵>/ は入口の HTML を sandbox allow-scripts のヘッダーで返し、枠の中なら橋を差し込む',
      file.status === 200 && csp(file).startsWith('sandbox allow-scripts; ') && !csp(file).includes('allow-forms')
      && directive(file, 'img-src').startsWith(`img-src http://localhost:*/f/${key}/ `) && file.body.includes('ply-preview-blocked') && file.body.endsWith('</html>'));
    const fileAsset = await request({ port, pathname: `/f/${key}/assets/a.png` });
    t.ok('鍵のフォルダーの下のファイルは読める', fileAsset.status === 200 && fileAsset.body === 'PNG' && fileAsset.headers['content-type'] === 'image/png');
    const sjis = await request({ port, pathname: `/f/${key}/sjis.html` });
    t.ok('UTF-8 で読めない HTML は文書の meta charset で返す', sjis.headers['content-type'] === 'text/html; charset=Shift_JIS' && sjis.raw.includes(Buffer.from([0x95, 0x5c])));
    const denied = await Promise.all([
      `/f/${key}/.env`, `/f/${key}/%2e%2e/outside/o.txt`, `/f/${key}/data-link/secret.txt`, `/f/${key}/out-link/o.txt`, `/f/${key}/assets`,
      `/f/${key}/missing.html`, `/f/${'A'.repeat(22)}/`, '/f/short/', '/f/',
    ].map(pathname => request({ port, pathname })));
    t.ok('ドットで始まる名前・フォルダーの外（`..`・ジャンクション）・データ置き場・フォルダー・無いもの・知らない鍵は 404',
      denied.every(res => res.status === 404), denied.map(res => res.status).join(','));
    const onceKey = htmlKeys.issue({ sessionId: 's1', path: entry, once: ['https://o.example', 'http://p.example'] });
    prefs = { confirmExternalLoads: true };
    const onceFile = await request({ port, pathname: `/f/${onceKey}/` });
    const plainFile = await request({ port, pathname: `/f/${key}/` });
    t.ok('「一度だけ読み込む」は別の鍵で、その鍵だけが出どころ（https）を持つ',
      onceKey !== key && directive(onceFile, 'img-src').includes('https://o.example') && !csp(onceFile).includes('p.example') && !csp(plainFile).includes('o.example'));
    prefs = {};
    clock += 24 * 60 * 60 * 1000;
    const expired = await request({ port, pathname: `/f/${key}/` });
    t.ok('鍵は 24 時間で消える', expired.status === 404 && htmlKeys.resolve(key) === null);
    const fresh = htmlKeys.issue({ sessionId: 's1', path: entry });
    htmlKeys.close();
    t.ok('サーバーの終わり（close）で鍵は全部消える', fresh !== key && htmlKeys.resolve(fresh) === null);
  } finally {
    routes.close();
    await server.close();
  }
}

/** 実際のサーバー: 可視化の行が束を持ち、隔離の port が束を配る */
async function serverChecks(t, scratch) {
  const work = path.join(scratch, 'srv-work');
  await fs.mkdir(path.join(work, 'img'), { recursive: true });
  const file = path.join(work, 'chart.html');
  await fs.writeFile(file, '<img src="img/a.svg"><p>first</p>');
  await fs.writeFile(path.join(work, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const prompt = `\n${S}${JSON.stringify({ path: file })}${E}`;
  const env = { AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, AGENT_HOST_OS_OPEN: 'dry' };
  {
    const server = await startServer({ env, dataDir: path.join(scratch, 'srv') });
    const client = await open({ ...server, autoAllow: true });
    try {
      const sessionId = (await client.cmd('newSession', { backend: 'codex', cwd: work })).sessionId;
      const turn = await client.runTurn({ sessionId, prompt });
      const present = turn.events.find(event => event.type === 'present' && event.kind === 'visualization');
      let caps;
      await waitFor(async () => { caps = await client.cmd('hostCapabilities'); return caps.browserUnify?.isolated > 0; }, 15_000, 'isolated port');
      const saved = await client.cmd('loadSession', { sessionId });
      const bundle = present?.bundle;
      t.ok('可視化の行（配信と保存の両方）が束を持つ', bundle?.entry === 'chart.html' && bundle.files.map(f => f.path).join(',') === 'chart.html,img/a.svg'
        && saved.presents[0].bundle?.hash === bundle.hash);
      const isolated = caps.browserUnify.isolated;
      const entry = await request({ port: isolated, pathname: `/viz/${bundle.hash}/chart.html?embed=conversation` });
      const svg = await request({ port: isolated, pathname: `/viz/${bundle.hash}/img/a.svg` });
      t.ok('隔離の port がその束を配る（入口と隣のファイル）', entry.status === 200 && entry.body.includes('first') && svg.status === 200
        && svg.headers['content-type'] === 'image/svg+xml; charset=utf-8');
    } finally {
      client.close();
      await server.stop();
    }
  }
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-isolated-routes-')));
  try {
    await routeChecks(t, scratch);
    await serverChecks(t, scratch);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
