// 実行: node tests/browser/remote-noise.mjs [chromium firefox webkit]
// PW_CORE で playwright-core、PW_CHROMIUM / PW_FIREFOX / PW_WEBKIT で実行ファイルを指定できる。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PW_CORE ?? (process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core'
  : 'playwright-core'));
const engines = process.argv.slice(2);
if (!engines.length) engines.push('chromium');
for (const engine of engines) assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), engine);

const files = new Map([
  ['/test.mjs', [new URL('./remote-noise-page.mjs', import.meta.url), 'text/javascript']],
  ['/noise.mjs', [new URL('../../web/remote/noise.mjs', import.meta.url), 'text/javascript']],
  ['/vectors.json', [new URL('../remote/vectors.json', import.meta.url), 'application/json']],
]);
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Noise IK checks</title>');
    return;
  }
  const file = files.get(req.url);
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': file[1] }).end(await readFile(file[0]));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  for (const engine of engines) {
    const executablePath = process.env['PW_' + engine.toUpperCase()];
    const browser = await playwright[engine].launch({ executablePath });
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + server.address().port);
      const checks = await page.evaluate(async () => (await import('/test.mjs')).run());
      console.log(engine + ' ' + browser.version() + ' PASS: ' + checks + ' checks');
    } catch (error) {
      console.error(engine + ' ' + browser.version() + ' FAIL: ' + error.message);
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
