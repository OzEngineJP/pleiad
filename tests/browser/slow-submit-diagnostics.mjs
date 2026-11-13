// 「送信を押しても送られない」不具合の診断ログ（slow-commands.log）と、送信前の待ち表示・取り消し・会話切り替え通知の実ブラウザー試験。
// 本物のサーバー（fake バックエンド・一時のデータ置き場）を起動し、WebSocket の特定の命令だけをテスト側で遅らせて検証する。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

function findChromium() {
  if (process.env.PW_CHROMIUM && fs.existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  const baseDir = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const head = fs.readdirSync(baseDir).filter(d => d.startsWith('chromium_headless_shell-')).sort().at(-1);
  if (head) {
    const exe = path.join(baseDir, head, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
    if (fs.existsSync(exe)) return exe;
  }
  const full = fs.readdirSync(baseDir).filter(d => d.startsWith('chromium-')).sort().at(-1);
  if (full) {
    const exe = path.join(baseDir, full, 'chrome-win64/chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('Playwright chromium executable not found');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'slow-submit-'));
const dataDir = path.join(base, 'data');
const workDir = path.join(base, 'work');
fs.mkdirSync(dataDir);
fs.mkdirSync(workDir);
const shotDir = process.env.SLOW_SUBMIT_SHOTS || 'D:/dev/pleiad/temporary/screenshots';
fs.mkdirSync(shotDir, { recursive: true });

let server, wsClient, browser, ctx;
try {
  server = await startServer({
    dataDir,
    env: {
      AGENT_HOST_BACKENDS: 'fake',
      AGENT_HOST_LOCALE: 'ja',
      AGENT_HOST_SLOW_CLIENT_MS: '180',
      AGENT_HOST_SLOW_SERVER_MS: '1',
      AGENT_HOST_SLOW_LOOP_MS: '5',
      AGENT_HOST_SLOW_LOOP_WINDOW_MS: '80',
      AGENT_HOST_SLOW_SUBMIT_MS: '180',
    },
  });
  wsClient = await open({ ...server });
  await wsClient.cmd('authLogin', { backend: 'fake' });
  await wsClient.cmd('completeSetup', { backend: 'fake' });
  const sA = (await wsClient.runTurn({ backend: 'fake', cwd: workDir, prompt: 'echo:AlphaBody' })).sessionId;
  await wsClient.cmd('setTitle', { sessionId: sA, title: 'AlphaTitle' });
  const sB = (await wsClient.runTurn({ backend: 'fake', cwd: workDir, prompt: 'echo:BetaBody' })).sessionId;
  await wsClient.close();
  wsClient = null;

  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // WebSocket の特定 command の送信をテスト側で一時停止（hold）できるフックを仕込む
  await ctx.addInitScript(() => {
    const OrigWS = window.WebSocket;
    const held = new Map();
    const holdRules = new Map();
    const sentLog = [];
    window.__wsTest = {
      sentLog,
      holdCommand(command, count = Infinity) {
        holdRules.set(command, count);
      },
      // corrupt: 止めていた命令を、存在しない会話に向けて流す（サーバーが失敗を返す = 保存の失敗の再現）
      unholdCommand(command, corrupt = false) {
        holdRules.delete(command);
        const list = held.get(command) ?? [];
        held.delete(command);
        for (const sendNow of list) sendNow(corrupt);
      },
      countSent(command) {
        return sentLog.filter(x => x.command === command).length;
      },
    };
    window.WebSocket = function WrappedWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      const origSend = ws.send.bind(ws);
      ws.send = (data) => {
        let parsed = null;
        try { parsed = JSON.parse(String(data)); } catch {}
        const cmd = parsed?.command;
        if (cmd) {
          sentLog.push({ command: cmd, op: parsed?.args?.op ?? null, at: Date.now() });
          const remaining = holdRules.get(cmd);
          if (remaining > 0) {
            if (remaining === 1) holdRules.delete(cmd);
            else if (Number.isFinite(remaining)) holdRules.set(cmd, remaining - 1);
            if (!held.has(cmd)) held.set(cmd, []);
            held.get(cmd).push((corrupt) => origSend(corrupt
              ? JSON.stringify({ ...parsed, args: { ...parsed.args, sessionId: 'no-such-session' } })
              : data));
            return;
          }
        }
        return origSend(data);
      };
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  });

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`);
  await page.waitForSelector(`#groups .row[data-session="${sA}"]`, { timeout: 20_000 });
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());

  const openSession = async (id) => {
    await page.locator(`#groups .row[data-session="${id}"]`).click();
    await page.waitForSelector('.m.user', { timeout: 15_000 });
  };
  const setPromptText = async (text) => {
    await page.evaluate((v) => {
      const p = document.getElementById('prompt');
      p.focus();
      p.value = v;
      p.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  };
  const readComposer = () => page.evaluate(() => {
    const note = document.getElementById('composerNote');
    const cancel = note?.querySelector('button');
    const send = document.getElementById('send');
    const prompt = document.getElementById('prompt');
    return {
      noteHidden: note?.hidden ?? true,
      noteText: note?.textContent ?? '',
      cancelVisible: Boolean(cancel && !cancel.hidden),
      sendDisabled: Boolean(send?.disabled),
      sendWaitClass: Boolean(send?.classList.contains('wait')),
      promptReadOnly: Boolean(prompt?.readOnly),
      promptValue: prompt?.value ?? '',
    };
  });

  // 1a. 設定変更（setTurnSettings）の遅れ -> 注記が出て、返ると送信されて注記が消える
  await openSession(sA);
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="model:fast"]').click();
  await page.locator('#prompt').click();
  await setPromptText('echo:SlowSettingsSend');
  const userCountBefore1a = await page.locator('#thread .m.user').count();
  await page.locator('#send').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return !st.noteHidden && st.cancelVisible && st.sendWaitClass && st.promptReadOnly;
  }, '1a waitingSettings note shown');
  const ui1a = await readComposer();
  assert.ok(ui1a.noteText.includes('設定の反映を待っています'), `unexpected noteText 1a: ${ui1a.noteText}`);
  assert.equal(ui1a.sendDisabled, true, '1a send button disabled while waiting');
  await page.screenshot({ path: path.join(shotDir, 'slow-wait-settings.png') });
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await waitUntil(async () => (await page.locator('#thread .m.user').count()) > userCountBefore1a, '1a message sent after setTurnSettings');
  await waitUntil(async () => (await readComposer()).noteHidden, '1a note cleared');
  console.log('OK 1a: setTurnSettings delay shows note then sends cleanly');

  // 1b. モード変更（setMode）の遅れ -> 注記が出て、返ると送信される
  await page.evaluate(() => window.__wsTest.holdCommand('setMode', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key^="mode:"]:not(.on)').first().click();
  await page.locator('#prompt').click();
  await setPromptText('echo:SlowModeSend');
  const userCountBefore1b = await page.locator('#thread .m.user').count();
  await page.locator('#send').click();
  await waitUntil(async () => !(await readComposer()).noteHidden, '1b waitingSettings note shown for modeWrite');
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('setMode'));
  await waitUntil(async () => (await page.locator('#thread .m.user').count()) > userCountBefore1b, '1b message sent after setMode');
  await waitUntil(async () => (await readComposer()).noteHidden, '1b note cleared');
  console.log('OK 1b: setMode delay shows note then sends cleanly');

  // 1c. 送信受理（sendMessage）の遅れ -> 取り消し無しの送信中注記が出て、返ると完了する
  await page.evaluate(() => window.__wsTest.holdCommand('sendMessage', 1));
  await setPromptText('echo:SlowAcceptSend');
  const userCountBefore1c = await page.locator('#thread .m.user').count();
  await page.locator('#send').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return !st.noteHidden && st.noteText.includes('送信を受け付けています');
  }, '1c sending note shown');
  const ui1c = await readComposer();
  assert.equal(ui1c.cancelVisible, false, '1c sendMessage wait must not show Cancel');
  await page.screenshot({ path: path.join(shotDir, 'slow-wait-sending.png') });
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('sendMessage'));
  await waitUntil(async () => (await page.locator('#thread .m.user').count()) > userCountBefore1c, '1c message accepted after release');
  await waitUntil(async () => (await readComposer()).noteHidden, '1c note cleared');
  console.log('OK 1c: sendMessage delay shows non-cancelable sending note then completes');

  // 2. 「取り消す」で送られず、ボタン活性・字が残り、遅延解決しても送らない＆切り替え通知が出ない
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="model:tiny"]').click();
  await page.locator('#prompt').click();
  await setPromptText('cancel-keep-draft-secret');
  const sentBefore2 = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return !st.noteHidden && st.cancelVisible;
  }, '2 waiting note with cancel');
  await page.locator('#composerNote button').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return st.noteHidden && !st.sendDisabled && !st.promptReadOnly;
  }, '2 composer restored right after cancel');
  assert.equal((await readComposer()).promptValue, 'cancel-keep-draft-secret', '2 prompt text preserved');
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await sleep(250);
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore2, '2 late response does not send');
  const toastHidden2 = await page.evaluate(() => {
    const t = document.querySelector('.file-toast');
    return !t || t.hidden;
  });
  assert.equal(toastHidden2, true, '2 user cancel must not trigger switched notification');
  await setPromptText('');
  console.log('OK 2: cancel stops send, restores input, and ignores late completion without notification');

  // 3a. 待ち中に別の会話へ切り替えると送らず、元会話に下書きが残り、通知＋「開く」が出る
  await page.evaluate(() => window.__wsTest.holdCommand('setMode', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key^="mode:"]:not(.on)').first().click();
  await page.locator('#prompt').click();
  await setPromptText('switched-session-draft-body');
  const sentBefore3a = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => !(await readComposer()).noteHidden, '3a waiting note before switch');
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await waitUntil(async () => {
    const st = await readComposer();
    return st.noteHidden && !st.sendDisabled;
  }, '3a note hidden on target conversation');
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('setMode'));
  await waitUntil(async () => page.evaluate(() => {
    const t = document.querySelector('.file-toast');
    return Boolean(t && !t.hidden && t.querySelector('.file-toast-action'));
  }), '3a switched toast with action');
  const toastInfo3a = await page.evaluate(() => ({
    text: document.querySelector('.file-toast-text')?.textContent ?? '',
    actionLabel: document.querySelector('.file-toast-action')?.textContent ?? '',
  }));
  assert.ok(toastInfo3a.text.includes('AlphaTitle'), `3a toast mentions source session title: ${toastInfo3a.text}`);
  assert.ok(toastInfo3a.text.includes('別の会話へ移ったので送っていません'), `3a toast explains unsent draft: ${toastInfo3a.text}`);
  assert.equal(toastInfo3a.actionLabel, '開く', `3a action label is 開く: ${toastInfo3a.actionLabel}`);
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore3a, '3a does not send when switched');
  await page.screenshot({ path: path.join(shotDir, 'slow-switched-toast.png') });
  await page.locator('.file-toast-action').click();
  await waitUntil(async () => (await readComposer()).promptValue === 'switched-session-draft-body', '3a open action restores original session draft');
  console.log('OK 3a: switch mid-wait notifies with title & working 開く link and preserves draft');

  // 3b & 4. 新しい会話作成待ち中の切り替え通知、および新規会話作成→連続設定反映で二重注記が出ない
  await page.evaluate(() => window.__wsTest.holdCommand('newSession', 1));
  await page.locator('#newSession').click();
  await setPromptText('home-switch-draft-body');
  const sentBefore3b = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return !st.noteHidden && st.noteText.includes('会話ができしだい送ります');
  }, '3b home newSession queued note');
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('newSession'));
  await waitUntil(async () => page.evaluate(() => {
    const t = document.querySelector('.file-toast');
    return Boolean(t && !t.hidden && t.querySelector('.file-toast-action'));
  }), '3b switched toast from home newSession');
  const toastText3b = await page.evaluate(() => document.querySelector('.file-toast-text')?.textContent ?? '');
  assert.ok(!toastText3b.includes('(no title)') && toastText3b.includes('前の会話への送信は'), `3b untitled fallback notice: ${toastText3b}`);
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore3b, '3b home newSession switch does not send');
  await page.locator('.file-toast-action').click();
  await waitUntil(async () => (await readComposer()).promptValue === 'home-switch-draft-body', '3b open action opens created session with home draft');
  console.log('OK 3b: home newSession switch notifies and opens created session with draft');

  // 4. 新しい会話の予約から続けて書き込みを待つときに、注記が二重にならない（作成中の連続待機 & 作成直後の押し直し）
  const setTurnCountBefore4 = await page.evaluate(() => window.__wsTest.countSent('setTurnSettings'));
  await page.evaluate(() => {
    window.__wsTest.holdCommand('newSession', 1);
    window.__wsTest.holdCommand('setTurnSettings', 1);
  });
  await page.locator('#newSession').click();
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key^="model:"]:not(.on)').first().click();
  await page.locator('#prompt').click();
  await setPromptText('echo:HomeChainedSend');
  await page.locator('#send').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return !st.noteHidden && st.noteText.includes('会話ができしだい送ります');
  }, '4 queued newSession note');
  await page.evaluate(() => window.__wsTest.unholdCommand('newSession'));
  // 会話作成後に sendDraftSettings が setTurnSettings を投げ、まだ設定反映待ちの間も注記は 1 つだけ
  await waitUntil(async () => (await page.evaluate(() => window.__wsTest.countSent('setTurnSettings'))) > setTurnCountBefore4, '4 sendDraftSettings issued setTurnSettings');
  await sleep(220);
  assert.equal(await page.locator('.composer-note:not([hidden])').count(), 1, '4 still one note after newSession -> sendDraftSettings');
  // 取り消してから設定反映待ち中に押し直しても二重にならない
  await page.locator('#composerNote button').click();
  await waitUntil(async () => (await readComposer()).noteHidden, '4 cancelled queued note');
  await page.locator('#send').click();
  await waitUntil(async () => {
    const st = await readComposer();
    return !st.noteHidden && st.noteText.includes('設定の反映を待っています');
  }, '4 re-submit enters waitingSettings cleanly');
  assert.equal(await page.locator('.composer-note:not([hidden])').count(), 1, '4 exactly one visible composer note without duplicates');
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await waitUntil(async () => page.evaluate(() => [...document.querySelectorAll('#thread .m.user')].some(n => n.textContent.includes('HomeChainedSend'))), '4 message eventually sent');
  await waitUntil(async () => (await readComposer()).noteHidden, '4 note cleared after send');
  console.log('OK 4: single-note transition across newSession queue and post-creation settingsWrite without duplicates');

  // 6. 取り消しの無い待ち（受理）では欄を書けるままにする。別の会話へ移って戻っても書ける
  await openSession(sA);
  await page.evaluate(() => window.__wsTest.holdCommand('sendMessage', 1));
  await setPromptText('echo:AcceptHeld');
  await page.locator('#send').click();
  await waitUntil(async () => (await readComposer()).noteText.includes('送信を受け付けています'), '6 sending note shown');
  assert.equal((await readComposer()).promptReadOnly, false, '6 prompt stays writable while sendMessage is pending');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.type('XY');
  assert.ok((await readComposer()).promptValue.endsWith('XY'), '6 can type during acceptance wait');
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await sleep(150);
  await openSession(sA);
  await waitUntil(async () => (await readComposer()).noteText.includes('送信を受け付けています'), '6 note restored after returning');
  assert.equal((await readComposer()).promptReadOnly, false, '6 prompt writable after switching away and back');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.type('Z');
  assert.ok((await readComposer()).promptValue.includes('Z'), '6 can type after returning');
  await page.evaluate(() => window.__wsTest.unholdCommand('sendMessage'));
  await waitUntil(async () => (await readComposer()).noteHidden, '6 note cleared');
  await sleep(200);
  await setPromptText('');
  console.log('OK 6: non-cancelable acceptance wait keeps the prompt writable (also after switching back)');

  // 7. 待ちの最中の Enter が、進行中の待ち（注記・「取り消す」・readonly）を壊さない。応答が返ると 1 回だけ送られる
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="model:smart"]').click();
  await setPromptText('echo:EnterTwice');
  const sentBefore7 = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => { const st = await readComposer(); return !st.noteHidden && st.cancelVisible && st.promptReadOnly; }, '7 waiting note with cancel and readonly');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.press('Enter');
  await sleep(120);
  const ui7 = await readComposer();
  assert.ok(!ui7.noteHidden && ui7.cancelVisible && ui7.promptReadOnly, `7 note/cancel/readonly survive a second Enter: ${JSON.stringify(ui7)}`);
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await waitUntil(async () => (await page.evaluate(() => window.__wsTest.countSent('sendMessage'))) > sentBefore7, '7 sent after release');
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore7 + 1, '7 sent exactly once');
  await waitUntil(async () => (await readComposer()).noteHidden, '7 note cleared');
  console.log('OK 7: second Enter during a wait keeps the wait and sends once');

  // 8. 字も添付も無い Enter は待ちとして登録しない。別の会話へ移って戻っても注記・readonly が出ない
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="model:tiny"]').click();
  await setPromptText('');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.press('Enter');
  await sleep(60);
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await sleep(150);
  await openSession(sA);
  await sleep(300);
  const ui8 = await readComposer();
  assert.ok(ui8.noteHidden && !ui8.promptReadOnly, `8 empty submit leaves no note and no readonly after switching back: ${JSON.stringify(ui8)}`);
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await sleep(200);
  console.log('OK 8: empty Enter registers no wait');

  // 9. 設定の保存の失敗が待ちの後に分かる -> 理由の行が出て、光ってフォーカスが移る
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="model:fast"]').click();
  await setPromptText('echo:FailedSettings');
  const sentBefore9 = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => { const st = await readComposer(); return !st.noteHidden && st.cancelVisible; }, '9 waiting note shown');
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings', true));
  await waitUntil(() => page.evaluate(() => {
    const n = document.getElementById('composerNote');
    return n?.dataset.kind === 'held' && n.classList.contains('flash') && document.activeElement === n;
  }), '9 held reason row is shown, flashed and focused');
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore9, '9 nothing sent after failed settings');
  await page.locator('#composerNote button').last().click();
  await waitUntil(async () => (await readComposer()).noteHidden, '9 hold dismissed');
  await setPromptText('');
  console.log('OK 9: failed settings after a visible wait points at the reason row');

  // 10. 速い送信（150ms 未満）は欄を readonly にしない
  await openSession(sA);
  await page.evaluate(() => {
    const p = document.getElementById('prompt');
    window.__roAdds = 0;
    // 入力欄の readOnly への代入を数える（欄は属性ではなくプロパティで持つ）。true を入れた回数
    const proto = Object.getOwnPropertyDescriptor(p, 'readOnly') ? p : Object.getPrototypeOf(p);
    const desc = Object.getOwnPropertyDescriptor(proto, 'readOnly');
    let cur = Boolean(p.readOnly);
    Object.defineProperty(p, 'readOnly', {
      configurable: true,
      get: () => (desc?.get ? desc.get.call(p) : cur),
      set: (v) => { if (v) window.__roAdds++; if (desc?.set) desc.set.call(p, v); else cur = v; },
    });
    // 検出できることの確認: readonly を一度入れて戻すと数えられる
    p.readOnly = true; p.readOnly = false;
  });
  await sleep(50);
  assert.equal(await page.evaluate(() => window.__roAdds), 1, '10 observer detects readonly');
  await page.evaluate(() => { window.__roAdds = 0; });
  await setPromptText('echo:FastSend');
  const userCount10 = await page.locator('#thread .m.user').count();
  await page.locator('#send').click();
  await waitUntil(async () => (await page.locator('#thread .m.user').count()) > userCount10, '10 fast message sent');
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__roAdds), 0, '10 fast submit never made the prompt readonly');
  console.log('OK 10: fast submit never sets readonly');

  // 報告バッチの送信完了を少し待ってからサーバーを正常停止（close 時に slow-commands.log へフラッシュされる）
  await sleep(300);
  await ctx.close(); ctx = null;
  await browser.close(); browser = null;
  await server.stop(); server = null;

  assert.equal(pageErrors.length, 0, `no page errors: ${pageErrors.join('; ')}`);

  // 5. slow-commands.log の検証（必須種別が揃い、会話本文・タイトル・パスが一切含まれないこと）
  const logPath = path.join(dataDir, 'slow-commands.log');
  assert.ok(fs.existsSync(logPath), 'slow-commands.log exists');
  const rawLog = fs.readFileSync(logPath, 'utf8');
  const entries = rawLog.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const kinds = new Set(entries.map(e => e.kind));
  console.log('slow-commands.log entries:', entries.length, 'kinds:', [...kinds].join(','));
  for (const requiredKind of ['client-pending', 'client-rtt', 'server-cmd', 'event-loop', 'submit-wait', 'submit-switched']) {
    assert.ok(kinds.has(requiredKind), `slow-commands.log contains kind=${requiredKind} (saw: ${[...kinds].join(',')})`);
  }
  const allowedTopKeys = new Set(['at', 'kind', 'source', 'command', 'ms', 'sessionId', 'outcome', 'errorCode', 'pendingCount', 'inFlight', 'windowMs', 'meanMs', 'p99Ms', 'phase', 'wait']);
  for (const entry of entries) {
    for (const k of Object.keys(entry)) assert.ok(allowedTopKeys.has(k), `unexpected key in slow log: ${k}`);
  }
  for (const forbidden of ['AlphaTitle', 'AlphaBody', 'BetaBody', 'SlowSettingsSend', 'SlowModeSend', 'SlowAcceptSend', 'cancel-keep-draft-secret', 'switched-session-draft-body', 'home-switch-draft-body', 'HomeChainedSend', 'AcceptHeld', 'EnterTwice', 'FailedSettings', 'FastSend', workDir, dataDir]) {
    assert.ok(!rawLog.includes(forbidden), `slow-commands.log must not contain secret/text/title/path "${forbidden}"`);
  }
  console.log('OK 5: slow-commands.log recorded all 6 kinds with zero message/title/path leakage');
  console.log('PASS');
} finally {
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await wsClient?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
