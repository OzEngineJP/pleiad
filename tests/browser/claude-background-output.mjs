// Claude の裏のコマンドを作業ダイアログの詳細（端末の表示）で読む（実ブラウザー。docs/design-system.md「バックグラウンド」）:
//   - 「出力の取得に対応していません」ではなく、コマンド（Bash の input.command）と出力を 1 つの端末に出す。端末の色の制御文字は出さない
//   - 開いている間は出力が増え、末尾にいれば末尾を追う。上へ戻して読んでいる間は位置を保つ
//   - 末尾 8 KiB だけのときは全体の大きさを状態の行に出す
//   - ［停止］で止まり、止めた後も最後の出力を残す
// 実行: node tests/browser/claude-background-output.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（偽の Claude Code CLI tests/lib/fake-claude-cli.mjs・一時のデータ置き場・別ポート）だけと話す。LLM も実データも使わない。
// 偽の CLI は get_task_output（末尾 8 KiB・全体の大きさ）と stop_task を本物と同じ control の口で答えるので、SDK の Query.getTaskOutput から画面までを通す
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-claude-bg-output-'));
const work = path.join(scratch, 'work');
fs.mkdirSync(work);
let server, client, browser;
try {
  const gates = await createFakeGates(scratch);
  const fake = await installFakeClaude(path.join(scratch, 'cli'));
  server = await startServer({ dataDir: path.join(scratch, 'data'), timeoutMs: 30_000,
    env: { AGENT_HOST_BACKENDS: 'claude', ...fake.env, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), ...gates.env, AGENT_HOST_LOCALE: 'ja' } });
  client = await open({ port: server.port, token: server.token });
  const first = await client.runTurn({ backend: 'claude', cwd: work, prompt: 'hello' }, { ms: 60_000 });
  check(first.outcome === 'ok', '偽の CLI で会話を始める', server.tail(10));
  const sessionId = first.sessionId;

  // 裏のコマンド: 600 行から始めて 150 ms ごとに 1 行増える（末尾 8 KiB を超える）。gate は開けない（止めるのは画面の［停止］）
  const from = client.mark();
  const steps = [{ bg: { gate: 'never', description: 'Start dev server', command: 'npm run dev -- --port 5173', everyMs: 150, prefill: 600 } }, { text: 'started' }];
  void client.cmd('runTurn', { sessionId, prompt: `script:${JSON.stringify({ steps })}` }).catch(() => {});
  await client.waitFor(e => e.type === 'phase' && e.sessionId === sessionId && e.state === 'waiting', { ms: 60_000, from });

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.waitForSelector(`.row[data-session="${sessionId}"]`, { timeout: 20_000 });
  await page.evaluate(id => document.querySelector(`.row[data-session="${id}"]`).click(), sessionId);
  await page.waitForFunction(() => { const b = document.getElementById('workEntryButton'); return b && !b.hidden && b.offsetParent; }, null, { timeout: 20_000 });
  await page.evaluate(() => document.getElementById('workEntryButton').click());
  await page.waitForSelector('#workDialog .bg-row', { timeout: 10_000 });
  await page.evaluate(() => [...document.querySelectorAll('#workDialog .bg-row')].find(b => b.textContent.includes('Start dev server')).click());
  await page.waitForFunction(() => document.querySelector('#workBody .tc-term')?.textContent.includes('line '), null, { timeout: 15_000 });

  const view = () => page.evaluate(() => {
    const term = document.querySelector('#workBody .tc-term');
    return {
      text: term?.textContent ?? '', status: document.querySelector('#workBody [role=status]')?.textContent ?? '',
      stop: Boolean(document.querySelector('#workHead .work-stop:not(:disabled)')), cursor: Boolean(term?.querySelector('.tc-term-cursor')),
      last: Number([...(term?.textContent ?? '').matchAll(/line (\d+)/g)].at(-1)?.[1] ?? 0),
    };
  });
  const v1 = await view();
  // 見た目を確かめるときは SHOT=<png のパス>
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  check(!v1.text.includes('出力の取得に対応していません'), '「出力の取得に対応していません」を出さない', v1.status);
  check(v1.text.includes('npm run dev -- --port 5173'), 'コマンド（Bash の input.command）を端末の頭に出す', v1.text.slice(0, 200));
  check(!/\x1b|\[32m/.test(v1.text), '端末の色の制御文字を出さない', v1.text.slice(-120));
  check(v1.status.includes('稼働中') && /出力は末尾のみ（全体 \d[\d.,]* KB）/.test(v1.status), '状態の行は稼働中と、末尾だけのときの全体の大きさ', v1.status);
  check(v1.stop && v1.cursor, '走っている間は［停止］と端末のカーソル', v1);

  // 末尾にいれば末尾を追う
  await page.evaluate(() => { const t = document.querySelector('#workBody .tc-term'); t.scrollTop = t.scrollHeight; });
  await page.waitForFunction(n => Number([...(document.querySelector('#workBody .tc-term')?.textContent ?? '').matchAll(/line (\d+)/g)].at(-1)?.[1] ?? 0) > n, v1.last, { timeout: 15_000 });
  const follow = await page.evaluate(() => { const t = document.querySelector('#workBody .tc-term'); return t.scrollHeight - t.scrollTop - t.clientHeight; });
  check(follow < 2, '出力が増えると、末尾にいれば末尾を追う', follow);

  // 上へ戻して読んでいる間は位置を保つ
  await page.evaluate(() => { document.querySelector('#workBody .tc-term').scrollTop = 40; });
  const v2 = await view();
  await page.waitForFunction(n => Number([...(document.querySelector('#workBody .tc-term')?.textContent ?? '').matchAll(/line (\d+)/g)].at(-1)?.[1] ?? 0) > n, v2.last, { timeout: 15_000 });
  const kept = await page.evaluate(() => document.querySelector('#workBody .tc-term').scrollTop);
  check(Math.abs(kept - 40) < 2, '上へ戻して読んでいる間は、出力が増えても位置を保つ', kept);

  // ［停止］: 止まり、最後の出力を残す
  await page.evaluate(() => document.querySelector('#workHead .work-stop').click());
  await page.waitForFunction(() => document.querySelector('#workBody [role=status]')?.textContent.includes('終了') && !document.querySelector('#workBody .tc-term-cursor'), null, { timeout: 20_000 });
  const v3 = await view();
  check(v3.last >= v2.last && v3.text.includes('npm run dev'), '止めた後も最後の出力を残す', { last: v3.last, before: v2.last });
  check(!v3.stop, '止めた後は［停止］を押せない', v3);
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { ms: 30_000, from });
  check(true, '止めるとターンが終わる');
  check(!errors.length, '画面のエラーが無い', errors);

  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`claude-background-output: ${results.length} 件 通過`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.error(`NG  ${e.message}`);
  if (server) console.error(server.tail(20));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  client?.close();
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
