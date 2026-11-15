import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const name = 'hooks-matrix-browser';
export const title = '設定 › プラグイン › Hooks の Hook × エージェントの表と、右の欄の「この場所で使うか」（ADR 0338）を本物の画面で';
// B1_BROWSER_TEST=1 のときだけ、本物の Chrome でつなぐ（tests/browser/hooks-matrix.mjs を別のプロセスで走らせる）
export default async function (t) {
  if (process.env.B1_BROWSER_TEST !== '1') { t.note('Set B1_BROWSER_TEST=1 for the real-page Playwright checks.'); return; }
  const script = fileURLToPath(new URL('../browser/hooks-matrix.mjs', import.meta.url));
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
  // 通過の行の後に落ちた（片付けの失敗など）ときも、終わりの出力を見せる
  t.ok('ブラウザ試験（tests/browser/hooks-matrix.mjs）がすべて通る', code === 0 && Boolean(pass),
    code === 0 && pass ? `${pass[1]} 判定` : `exit ${code}\n${out.split('\n').slice(-12).join('\n')}`);
}
