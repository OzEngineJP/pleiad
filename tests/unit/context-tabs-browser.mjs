import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const name = 'context-tabs-browser';
export const title = '設定 › プラグイン・右パネルの 4 タブ・まとまり・絞り込み・鍵の吹き出し・Devin の自分の名前（ADR 0336）を本物の画面で';
// B1_BROWSER_TEST=1 のときだけ、本物の Chrome でつなぐ（tests/browser/context-tabs-and-lock-tip.mjs を別のプロセスで走らせる）
export default async function (t) {
  if (process.env.B1_BROWSER_TEST !== '1') { t.note('Set B1_BROWSER_TEST=1 for the real-page Playwright checks.'); return; }
  const script = fileURLToPath(new URL('../browser/context-tabs-and-lock-tip.mjs', import.meta.url));
  const env = { ...process.env };
  if (process.env.B1_CHROME && !env.PW_CHROMIUM) env.PW_CHROMIUM = process.env.B1_CHROME;
  const { code, out } = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => child.kill(), 360000);
    child.stdout.on('data', d => { buf += d; });
    child.stderr.on('data', d => { buf += d; });
    child.on('close', c => { clearTimeout(timer); resolve({ code: c, out: buf }); });
  });
  const pass = /PASS: (\d+) 判定すべて通過/.exec(out);
  t.ok('ブラウザ試験（tests/browser/context-tabs-and-lock-tip.mjs）がすべて通る', code === 0 && Boolean(pass), pass ? `${pass[1]} 判定` : out.split('\n').slice(-12).join('\n'));
}
