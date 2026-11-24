// 回答待ちの質問と、答えられずに閉じた質問（Issue #231）・ログイン切れの中断の行（Issue #232）を実ブラウザーで確かめる:
//   - 質問への回答だけを待っている会話は、一覧の行が「回答待ち」になる（「承認待ち」ではない）
//   - 中断で閉じた質問は、会話に「答えられずに閉じた質問」として理由・時刻と同じ選択肢で残り、開き直しても残る
//   - 選んで「この答えを送る」と、答えが発言として送られ、カードのボタンが下がる
//   - ログインが切れて止まった会話は、開き直しても末尾に「ログイン切れ」の行が出る
// 実行: node tests/browser/closed-questions.mjs   （SHOT_DIR=<ディレクトリ> で各場面を撮る。playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// fake のバックエンドのサーバー（一時のデータ置き場・別ポート）だけと話す。LLM も実データも使わない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-closed-questions-ui-'));
const work = path.join(scratch, 'work');
fs.mkdirSync(work);
const shotDir = process.env.SHOT_DIR;
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
let server, client, browser;
try {
  server = await startServer({ dataDir: path.join(scratch, 'data'), timeoutMs: 30_000, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  client = await open({ port: server.port, token: server.token });
  await client.cmd('authLogin', { backend: 'fake' });   // 未ログインの案内が画面を覆わないように
  const sid = (await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:hi' }, { ms: 30_000 })).sessionId;
  const authSid = (await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:auth' }, { ms: 30_000 })).sessionId;

  // 質問を出したまま（ターンは答えを待って止まる）
  let from = client.mark();
  void client.cmd('runTurn', { sessionId: sid, prompt: 'question' }).catch(() => {});
  const card = await client.waitFor(e => e.type === 'permission' && e.kind === 'question' && e.sessionId === sid, { from, ms: 20_000 });

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // 最初の案内（閉じても開き直す）は、撮る絵からだけ隠す
  const shot = async (name) => { if (!shotDir) return; await page.screenshot({ path: path.join(shotDir, name), style: '#onboardingDialog{display:none!important}' }); };
  const openSession = async (id) => {
    await page.waitForSelector(`.row[data-session="${id}"]`, { timeout: 20_000 });
    await page.evaluate(x => document.querySelector(`.row[data-session="${x}"]`).click(), id);
  };
  const load = async () => {
    await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  };
  await load();
  await openSession(sid);
  await page.waitForSelector(`.mw[data-key="perm:${card.id}"] .opt`, { timeout: 15_000 });

  // ---- 一覧の行は「回答待ち」
  await page.waitForFunction(id => document.querySelector(`.row[data-session="${id}"]`)?.textContent.includes('回答待ち'), sid, { timeout: 10_000 }).catch(() => {});
  const rowText = await page.evaluate(id => document.querySelector(`.row[data-session="${id}"]`)?.textContent ?? '', sid);
  await shot('1-waiting-answer.png');
  check(rowText.includes('回答待ち') && !rowText.includes('承認待ち'), '質問への回答だけを待つ会話の行は「回答待ち」と言う', rowText);

  // ---- 中断で閉じた質問は、理由・時刻と同じ選択肢で残る
  from = client.mark();
  await client.cmd('abort', { sessionId: sid });
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from, ms: 20_000 });
  const closedSel = `.mw[data-closed-question="${card.id}"]`;
  await page.waitForSelector(closedSel, { timeout: 10_000 });
  const view = () => page.evaluate(sel => {
    const row = document.querySelector(sel);
    return {
      head: row?.querySelector('.card-head')?.textContent ?? '',
      options: [...(row?.querySelectorAll('.opt-label') ?? [])].map(n => n.textContent),
      buttons: [...(row?.querySelectorAll('.card-actions button') ?? [])].map(b => b.textContent),
      res: row?.querySelector('.card-actions .res')?.textContent ?? '',
    };
  }, closedSel);
  const v1 = await view();
  const oldCard = await page.evaluate(id => Boolean(document.querySelector(`.mw[data-key="perm:${id}"]`)), card.id);
  await shot('2-closed-question.png');
  check(v1.head.includes('答えられずに閉じた質問') && v1.head.includes('中断したため閉じました'), '閉じた質問のカードに、閉じたことと理由を出す', v1.head);
  check(v1.options.join() === 'A,B', '同じ選択肢を出す', v1.options);
  check(v1.buttons.includes('この答えを送る') && v1.buttons.includes('もう一度聞いてもらう'), '「この答えを送る」「もう一度聞いてもらう」を出す', v1.buttons);
  check(!oldCard, '元の質問のカード（別の場所で処理された）は閉じた質問のカードに置き換わる');
  const rowAfter = await page.evaluate(id => document.querySelector(`.row[data-session="${id}"]`)?.textContent ?? '', sid);
  check(!rowAfter.includes('回答待ち'), '閉じた後の一覧の行は「回答待ち」でなくなる', rowAfter);

  // ---- 開き直しても残る
  await load();
  await openSession(sid);
  await page.waitForSelector(closedSel, { timeout: 15_000 });
  const v2 = await view();
  check(v2.head.includes('中断したため閉じました') && v2.buttons.includes('この答えを送る'), '開き直しても閉じた質問のカードが残る', v2);

  // ---- 選んで答えを送る
  await page.evaluate(sel => document.querySelector(`${sel} .opt`).click(), closedSel);
  const enabled = await page.evaluate(sel => [...document.querySelectorAll(`${sel} .card-actions button`)].find(b => b.textContent === 'この答えを送る')?.disabled === false, closedSel);
  check(enabled, '選ぶと「この答えを送る」が押せる');
  from = client.mark();
  await page.evaluate(sel => [...document.querySelectorAll(`${sel} .card-actions button`)].find(b => b.textContent === 'この答えを送る').click(), closedSel);
  const sent = await client.waitFor(e => e.type === 'userMessage' && e.sessionId === sid, { from, ms: 20_000 }).catch(() => null);
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from, ms: 20_000 }).catch(() => null);
  await page.waitForTimeout(500);
  const v3 = await view();
  await shot('3-answer-sent.png');
  const sentText = JSON.stringify(sent ?? {});
  check(sentText.includes('どれにする？: A'), '答え（質問と選んだラベル）が発言として送られる', sentText.slice(0, 400));
  check(v3.buttons.length === 0 && v3.res === '送りました', '送ったカードはボタンを下げ、「送りました」を出す', v3);

  // ---- ログインが切れて止まった会話（#232）
  from = client.mark();
  await client.cmd('runTurn', { sessionId: authSid, prompt: 'fail-auth' }).catch(() => {});
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === authSid, { from, ms: 20_000 });
  await load();
  await openSession(authSid);
  await page.waitForSelector('.m.sys.interrupted[data-interrupted="auth"], .m.sys.auth-fail', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const authText = await page.evaluate(() => document.querySelector('.m.sys.interrupted[data-interrupted="auth"], .m.sys.auth-fail')?.textContent ?? '');
  await shot('4-auth-interrupt.png');
  check(authText.includes('ログイン'), '開き直した会話の末尾にログイン切れの行を出す', authText);

  check(errors.length === 0, 'ページのエラーが無い', errors);
  console.log(results.map(r => `OK  ${r}`).join('\n'));
  console.log(`全て通過 ${results.length} 件`);
} catch (error) {
  console.log(results.map(r => `OK  ${r}`).join('\n'));
  console.error(`失敗: ${error.message}`);
  if (server) console.error(server.tail?.(20));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  client?.close();
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
}
