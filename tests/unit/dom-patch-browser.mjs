import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const name = 'dom-patch-browser';
export const title = '設定 › Claude のアカウントの差し替え（web/dom-patch.mjs）: 残るノード・動きの途中の描き直し・減らす動き設定を本物の画面で';
// B1_BROWSER_TEST=1 のときだけ、本物の Chrome で（tests/browser/dom-patch.mjs を別のプロセスで走らせる）
export default async function (t) {
  if (process.env.B1_BROWSER_TEST !== '1') { t.note('Set B1_BROWSER_TEST=1 for the real-page Playwright checks.'); return; }
  const script = fileURLToPath(new URL('../browser/dom-patch.mjs', import.meta.url));
  const env = { ...process.env };
  if (process.env.B1_CHROME && !env.PW_CHROMIUM) env.PW_CHROMIUM = process.env.B1_CHROME;
  const { code, out } = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', d => { buf += d; });
    child.stderr.on('data', d => { buf += d; });
    child.on('close', c => { clearTimeout(timer); resolve({ code: c, out: buf }); });
  });
  const pass = /PASS: (\d+) 判定すべて通過/.exec(out);
  t.ok('ブラウザ試験（tests/browser/dom-patch.mjs）がすべて通る', code === 0 && Boolean(pass),
    code === 0 && pass ? `${pass[1]} 判定` : `exit ${code}\n${out.split('\n').slice(-12).join('\n')}`);
}
