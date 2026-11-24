// 「送信を押しても送られない」不具合の診断ログ（slow-commands.log）と、送信の受付の待ち・会話を移っても続く送信（ADR 0347）の実ブラウザー試験。
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
      lastSent(command) {
        return sentLog.filter(x => x.command === command).at(-1) ?? null;
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
          sentLog.push({ command: cmd, op: parsed?.args?.op ?? null, sessionId: parsed?.args?.sessionId ?? null, settings: parsed?.args?.settings ?? null, at: Date.now() });
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

  // 送った発言の「送信中」は入力欄の上ではなく、会話の中の吹き出しの下に出る（入力欄は押した瞬間に空になる）
  const sendingBubble = (text) => page.locator('#thread .mw[data-message-id]').filter({ hasText: text }).locator('.outbox-status');
  const isSending = async (text) => (await sendingBubble(text).first().innerText({ timeout: 500 }).catch(() => '')).includes('送信中');

  const toastShown = () => page.evaluate(() => {
    const t = document.querySelector('.file-toast');
    return Boolean(t && !t.hidden);
  });

  // 1a. 設定の保存（setTurnSettings）が遅れても送信は待たない。押した時点の設定を送信に載せる
  await openSession(sA);
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="nav:model"]').click();
  await page.locator('#modelPop [data-key="model:fast"]').click();
  await page.locator('#prompt').click();
  await setPromptText('echo:SlowSettingsSend');
  const sentBefore1a = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => (await page.evaluate(() => window.__wsTest.countSent('sendMessage'))) > sentBefore1a, '1a sendMessage goes out while setTurnSettings is held');
  const send1a = await page.evaluate(() => window.__wsTest.lastSent('sendMessage'));
  assert.equal(send1a.sessionId, sA, '1a send targets the open conversation');
  assert.equal(send1a.settings?.model, 'fast', `1a send carries the model chosen before pressing: ${JSON.stringify(send1a.settings)}`);
  await page.locator('#thread .m.user', { hasText: 'echo:SlowSettingsSend' }).waitFor();
  await waitUntil(async () => (await readComposer()).noteHidden, '1a no wait note left');
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await sleep(200);
  console.log('OK 1a: a held setTurnSettings does not hold the send; the send carries the chosen model');

  // 1b. 承認モードの保存が遅れても同じ。押した時点のモードを送信に載せる
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="nav:mode"]').click();
  const modeKey1b = await page.locator('#modelPop [data-key^="mode:"][aria-selected="false"]').first().getAttribute('data-key');
  await page.locator(`#modelPop [data-key="${modeKey1b}"]`).click();
  await page.locator('#prompt').click();
  await setPromptText('echo:SlowModeSend');
  const sentBefore1b = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => (await page.evaluate(() => window.__wsTest.countSent('sendMessage'))) > sentBefore1b, '1b sendMessage goes out while the mode write is held');
  const send1b = await page.evaluate(() => window.__wsTest.lastSent('sendMessage'));
  assert.equal(`mode:${send1b.settings?.mode}`, modeKey1b, `1b send carries the chosen mode: ${JSON.stringify(send1b.settings)}`);
  await page.locator('#thread .m.user', { hasText: 'echo:SlowModeSend' }).waitFor();
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings'));
  await sleep(200);
  console.log('OK 1b: a held mode write does not hold the send; the send carries the chosen mode');

  // 1c. 送信受理（sendMessage）の遅れ -> 吹き出しの下に取り消し無しの「送信中」が出て、返ると消える
  await page.evaluate(() => window.__wsTest.holdCommand('sendMessage', 1));
  await setPromptText('echo:SlowAcceptSend');
  const userCountBefore1c = await page.locator('#thread .m.user').count();
  await page.locator('#send').click();
  await waitUntil(() => isSending('echo:SlowAcceptSend'), '1c sending status shown under the bubble');
  const ui1c = await readComposer();
  assert.ok(ui1c.noteHidden && !ui1c.sendWaitClass && ui1c.promptValue === '', `1c nothing above the input box and the input is already empty: ${JSON.stringify(ui1c)}`);
  assert.equal(await sendingBubble('echo:SlowAcceptSend').locator('button').count(), 0, '1c sendMessage wait must not show Cancel');
  await page.screenshot({ path: path.join(shotDir, 'slow-wait-sending.png') });
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('sendMessage'));
  await waitUntil(async () => (await page.locator('#thread .m.user').count()) > userCountBefore1c, '1c message accepted after release');
  await waitUntil(async () => !(await isSending('echo:SlowAcceptSend')), '1c sending status cleared');
  console.log('OK 1c: sendMessage delay shows a non-cancelable sending line under the bubble then clears');

  // 2. 受付の待ちの間に別の会話へ移っても送信は続く。移った先の欄は変わらず、知らせも出ない。戻ると送った版の下書きは片付いている
  await page.evaluate(() => window.__wsTest.holdCommand('sendMessage', 1));
  await setPromptText('echo:SwitchedSend');
  await page.locator('#send').click();
  await waitUntil(async () => isSending('echo:SwitchedSend'), '2 sending status before switch');
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await page.locator('#thread .m.user', { hasText: 'echo:BetaBody' }).waitFor();
  await waitUntil(async () => (await readComposer()).noteHidden, '2 no note on the other conversation');
  await setPromptText('beta-draft-keep');
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('sendMessage'));
  await sleep(400);
  assert.equal((await readComposer()).promptValue, 'beta-draft-keep', '2 the other conversation keeps its own text');
  assert.equal(await toastShown(), false, '2 no switched notice');
  await page.screenshot({ path: path.join(shotDir, 'slow-switched-continues.png') });
  await setPromptText('');
  await openSession(sA);
  await page.locator('#thread .m.user', { hasText: 'echo:SwitchedSend' }).waitFor();
  await waitUntil(async () => (await readComposer()).promptValue === '', '2 the sent draft is cleared on the source conversation');
  console.log('OK 2: switching during the acceptance wait keeps sending to the source and leaves the other composer alone');

  // 3. 新しい会話を作っている間に送って別の会話へ移っても、作られた会話へ送る
  const sessionsBefore3 = await page.evaluate(() => [...document.querySelectorAll('#groups .row[data-session]')].map(r => r.dataset.session));
  await page.evaluate(() => window.__wsTest.holdCommand('newSession', 1));
  await page.locator('#newSession').click();
  await setPromptText('echo:HomeSwitchSend');
  await page.locator('#send').click();
  await waitUntil(async () => isSending('echo:HomeSwitchSend'), '3 sending status while creating');
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await page.locator('#thread .m.user', { hasText: 'echo:BetaBody' }).waitFor();
  await sleep(220);
  await page.evaluate(() => window.__wsTest.unholdCommand('newSession'));
  await waitUntil(() => page.evaluate((known) => {
    const s = window.__wsTest.lastSent('sendMessage');
    return Boolean(s?.sessionId && !known.includes(s.sessionId));
  }, sessionsBefore3), '3 send goes to the created conversation');
  const created3 = (await page.evaluate(() => window.__wsTest.lastSent('sendMessage'))).sessionId;
  await sleep(300);
  assert.equal((await readComposer()).promptValue, '', '3 the other conversation composer stays empty');
  assert.equal(await toastShown(), false, '3 no switched notice');
  await page.waitForSelector(`#groups .row[data-session="${created3}"]`, { timeout: 15_000 });
  await openSession(created3);
  await page.locator('#thread .m.user', { hasText: 'echo:HomeSwitchSend' }).waitFor();
  console.log('OK 3: a send made while creating reaches the created conversation after switching away');

  // 6. 取り消しの無い待ち（受理）では欄は空で書けるまま。別の会話へ移って戻っても吹き出しの「送信中」が残り、書ける
  await openSession(sA);
  await page.evaluate(() => window.__wsTest.holdCommand('sendMessage', 1));
  await setPromptText('echo:AcceptHeld');
  await page.locator('#send').click();
  await waitUntil(async () => isSending('echo:AcceptHeld'), '6 sending status shown');
  assert.equal((await readComposer()).promptReadOnly, false, '6 prompt stays writable while sendMessage is pending');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.type('XY');
  assert.ok((await readComposer()).promptValue.endsWith('XY'), '6 can type during acceptance wait');
  await page.locator(`#groups .row[data-session="${sB}"]`).click();
  await sleep(150);
  await openSession(sA);
  await waitUntil(async () => isSending('echo:AcceptHeld'), '6 sending status restored after returning');
  assert.equal((await readComposer()).promptReadOnly, false, '6 prompt writable after switching away and back');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.type('Z');
  assert.ok((await readComposer()).promptValue.includes('Z'), '6 can type after returning');
  await page.evaluate(() => window.__wsTest.unholdCommand('sendMessage'));
  await waitUntil(async () => !(await isSending('echo:AcceptHeld')), '6 sending status cleared');
  await sleep(200);
  await setPromptText('');
  console.log('OK 6: non-cancelable acceptance wait keeps the prompt writable (also after switching back)');

  // 7. 受付の待ちの最中の Enter は二度目の送信にならない。応答が返ると 1 回だけ送られている
  await openSession(sA);
  await page.evaluate(() => window.__wsTest.holdCommand('sendMessage', 1));
  await setPromptText('echo:EnterTwice');
  const sentBefore7 = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  await page.locator('#send').click();
  await waitUntil(async () => isSending('echo:EnterTwice'), '7 sending status');
  await page.evaluate(() => document.getElementById('prompt').focus());
  await page.keyboard.press('Enter');
  await sleep(120);
  assert.ok(await isSending('echo:EnterTwice'), '7 the wait survives a second Enter');
  await page.evaluate(() => window.__wsTest.unholdCommand('sendMessage'));
  await waitUntil(async () => !(await isSending('echo:EnterTwice')), '7 sending status cleared');
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore7 + 1, '7 sent exactly once');
  console.log('OK 7: second Enter during the acceptance wait does not send twice');

  // 8. 字も添付も無い Enter は待ちとして登録しない。別の会話へ移って戻っても注記・readonly が出ない
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="nav:model"]').click();
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

  // 9. 設定の保存に失敗したら理由の行が出て、送信を押すとその行が光ってフォーカスが移り、送らない
  await page.evaluate(() => window.__wsTest.holdCommand('setTurnSettings', 1));
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="nav:model"]').click();
  await page.locator('#modelPop [data-key="model:fast"]').click();
  await page.evaluate(() => window.__wsTest.unholdCommand('setTurnSettings', true));
  await waitUntil(() => page.evaluate(() => document.getElementById('composerNote')?.dataset.kind === 'held'), '9 held reason row shown');
  await setPromptText('echo:FailedSettings');
  const sentBefore9 = await page.evaluate(() => window.__wsTest.countSent('sendMessage'));
  // 送信は押せない見た目（aria-disabled）でも押せる。押すと理由の行へ移る（web/composer-wait.mjs）
  await page.locator('#send').click({ force: true });
  await waitUntil(() => page.evaluate(() => {
    const n = document.getElementById('composerNote');
    return n?.dataset.kind === 'held' && n.classList.contains('flash') && document.activeElement === n;
  }), '9 held reason row is flashed and focused');
  assert.equal(await page.evaluate(() => window.__wsTest.countSent('sendMessage')), sentBefore9, '9 nothing sent after failed settings');
  await page.locator('#composerNote button').last().click();
  await waitUntil(async () => (await readComposer()).noteHidden, '9 hold dismissed');
  await setPromptText('');
  console.log('OK 9: failed settings show the reason row and pressing send points at it');

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

  // 新規の最初の発言は、一覧の応答や下書き保存を待たずに画面に載る。
  await page.evaluate(() => {
    window.__wsTest.holdCommand('newSession', 1);
    window.__wsTest.holdCommand('listSessions');
    window.__wsTest.holdCommand('saveDraft');
    window.__newSendWaitSeen = false;
    const outbox = document.getElementById('outbox');
    new MutationObserver(() => {
      if (outbox.textContent.includes('作業が終わると自動で送信')) window.__newSendWaitSeen = true;
    }).observe(outbox, { childList: true, subtree: true });
    document.getElementById('newSession').click();
  });
  await setPromptText('echo:NewSendWithoutList');
  await page.locator('#send').click();
  await waitUntil(async () => isSending('echo:NewSendWithoutList'), '11 first send waits while creating session');
  await page.evaluate(() => window.__wsTest.unholdCommand('newSession'));
  await page.locator('#thread .m.user', { hasText: 'echo:NewSendWithoutList' }).waitFor();
  await waitUntil(async () => {
    const st = await readComposer();
    return st.noteHidden && !st.sendDisabled;
  }, '11 accepted first send releases composer with list and draft commands still held');
  assert.equal(await page.evaluate(() => window.__newSendWaitSeen), false, '11 no work wait on a fresh conversation');
  await page.evaluate(() => {
    window.__wsTest.unholdCommand('listSessions');
    window.__wsTest.unholdCommand('saveDraft');
  });
  console.log('OK 11: first send and author bubble do not wait for the list or draft save');

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
  for (const requiredKind of ['client-pending', 'client-rtt', 'server-cmd', 'event-loop', 'submit-wait']) {
    assert.ok(kinds.has(requiredKind), `slow-commands.log contains kind=${requiredKind} (saw: ${[...kinds].join(',')})`);
  }
  const allowedTopKeys = new Set(['at', 'kind', 'source', 'command', 'ms', 'sessionId', 'outcome', 'errorCode', 'pendingCount', 'inFlight', 'windowMs', 'meanMs', 'p99Ms', 'phase', 'wait']);
  for (const entry of entries) {
    for (const k of Object.keys(entry)) assert.ok(allowedTopKeys.has(k), `unexpected key in slow log: ${k}`);
  }
  for (const forbidden of ['AlphaTitle', 'AlphaBody', 'BetaBody', 'SlowSettingsSend', 'SlowModeSend', 'SlowAcceptSend', 'SwitchedSend', 'beta-draft-keep', 'HomeSwitchSend', 'AcceptHeld', 'EnterTwice', 'FailedSettings', 'FastSend', workDir, dataDir]) {
    assert.ok(!rawLog.includes(forbidden), `slow-commands.log must not contain secret/text/title/path "${forbidden}"`);
  }
  console.log('OK 5: slow-commands.log recorded all 5 kinds with zero message/title/path leakage');
  console.log('PASS');
} finally {
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await wsClient?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
