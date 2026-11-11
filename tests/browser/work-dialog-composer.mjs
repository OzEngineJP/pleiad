// 作業のダイアログ（#workDialog）の入力欄（ADR 0315 段 4）。実ブラウザー。
//   1. 委譲された子を開くと、会話の下にメインと同じ部品の入力欄が出る（本文・＋・チップ・送信・▾。呼び出し・背景は出さない）
//   2. 終わった子へ送ると、すぐ届いて子が再開する。メインの下書きは変わらない
//   3. 下書きは子ごと（別の子へ切り替えても、閉じて開き直しても残る）
//   4. 走っている子へ送ると「送信待ち」になり、取り消せる
//   5. 子が流れている間（読み直しが速い）に打っても、文字・キャレットが消えない
//   5b. モデルの面にアカウントの節が出て、選ぶと子の次のターンの予約（setTurnSettings）に流れる
// 実行: node tests/browser/work-dialog-composer.mjs   （会話の agent-browser の窓を使う。WORK_DIALOG_COMPOSER_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-composer-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_COMPOSER_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(120);
  }
  throw new Error(`timeout: ${label}`);
};
const shot = (name) => { if (shots) { try { ab('screenshot', path.join(shots, `${name}.png`)); } catch (e) { console.log('shot failed', name, e.message.slice(0, 80)); } } };
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open({
    ...server,
    autoAllow: true,
  });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });

  const stream = (label, n, ms) => Array.from({ length: n }, (_, i) => ({ tool: 'Bash', input: { command: `${label} ${i}` }, result: `out ${label} ${i}`, ms }));
  const doneScript = { steps: [{ text: 'ひとつめの子です。' }] };
  const runScript = { steps: [{ text: 'はじめます。' }, ...stream('run', 400, 250), { text: 'おわり。' }] };
  const runFile = path.join(base, 'run-steps.json');
  fs.writeFileSync(runFile, JSON.stringify(runScript));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Composer' });
  const parent = first.sessionId;
  const delegate = async (title, task) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await sleep(250);
      }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    return { taskId: JSON.parse(res.text).taskId };
  };
  const done = await delegate('終わった子', 'steps:' + JSON.stringify(doneScript));
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId !== parent, { from: 0, ms: 30_000 });
  const running = await delegate('走っている子', `steps:@${runFile}`);
  await sleep(1200);
  // アカウントの節を出すための登録（委譲の依頼のあとに。登録すると委譲の設定の対象になる。トークンの持ち主の確認は失敗してもそのまま保存される）
  await client.cmd('saveClaudeAccount', { name: '仕事用', token: 'sk-ant-oat01-work-dialog-composer-test' });

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 2), 'delegate cards');

  const clickOn = (sel, label) => {
    const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
    assert.ok(ok, `target exists: ${label}`);
    try { ab('click', '[data-probe="pick"]'); } finally { evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe')); }
  };
  const dialogOpen = () => evaluate(() => document.getElementById('workDialog').open);
  const openCard = async (taskId, label) => {
    const isOpen = () => evaluate(id => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId && !!document.querySelector(`#workList [data-key="t:${id}"][aria-current="true"]`), taskId);
    for (let tries = 0; ; tries++) {
      await sleep(700);
      if (!dialogOpen()) clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${taskId}"] .tc-go`, `card ${label}`);
      else clickOn(`#workList [data-key="t:${taskId}"]`, `row ${label}`);
      const until = Date.now() + 4000;
      while (Date.now() < until && !isOpen()) await sleep(150);
      if (isOpen()) return;
      assert.ok(tries < 3, `dialog for ${label}`);
    }
  };
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => !dialogOpen(), 'dialog closed');
  };
  const composerState = () => evaluate(() => {
    const f = document.getElementById('wkComposer') ?? document.querySelector('.wk-composer');
    const vis = n => !!n && !n.hidden && n.offsetParent !== null;
    return {
      shown: vis(f),
      outsideBody: !!f && !document.getElementById('workBody').contains(f),
      prompt: !!document.getElementById('wkPrompt'), value: document.getElementById('wkPrompt')?.value ?? null,
      send: vis(document.getElementById('wkSend')), sendMore: vis(document.getElementById('wkSendMore')),
      attach: !!f?.querySelector('[id^="wkAttach"]') || !!document.getElementById('wkAttachBtn'),
      call: vis(document.getElementById('wkCall')) || vis(document.getElementById('wkMic')),
      chips: [...(f?.querySelectorAll('.crow .chip') ?? [])].map(c => c.id).filter(Boolean),
    };
  });

  // ---- 1. 終わった子を開く ----
  await openCard(done.taskId, 'done');
  await wait(() => evaluate(() => !!document.querySelector('#workBody .bg-thread')), 'thread');
  await wait(() => composerState().shown, 'composer shown');
  const s1 = composerState();
  console.log('composer', JSON.stringify(s1));
  assert.ok(s1.outsideBody, 'composer is outside #workBody');
  assert.ok(s1.send, 'send button');
  assert.ok(!s1.call, 'no call button');
  shot('1-done-1280');

  console.log('PASS: the composer shows body, attach, chips, send; no call button; it sits outside #workBody');

  // 画面の中で、送ったコマンドを採る
  evaluate(() => {
    const log = window.__cmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command) log.push({ command: m.command, sessionId: m.args?.sessionId ?? null, prompt: m.args?.prompt ?? null, patch: m.args?.settings ?? m.args?.patch ?? m.args ?? null }); } catch { /* 文字でないフレーム */ }
      return send.call(this, data);
    };
  });
  const cmds = (name) => evaluate(n => window.__cmds.filter(c => c.command === n), name);
  const typeInto = (id, text) => evaluate(([i, v]) => { const n = document.getElementById(i); n.focus(); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, [id, text]);
  const childOf = () => evaluate(() => document.getElementById('workBody').dataset.sessionId);
  const doneChild = childOf();

  // ---- 2. 終わった子へ送る。メインの下書きは変わらない ----
  typeInto('prompt', 'メインの下書き');
  await sleep(900);
  typeInto('wkPrompt', '続きをお願いします');
  await sleep(500);
  assert.equal(evaluate(() => document.getElementById('prompt').value), 'メインの下書き', 'main draft unchanged by typing in the modal');
  const sentMark = client.mark();
  clickOn('#wkSend', 'send');
  await wait(() => cmds('sendMessage').concat(cmds('runTurn')).some(c => c.sessionId === doneChild && /続きをお願いします/.test(c.prompt ?? '')), 'sent to the child');
  await wait(() => evaluate(() => /続きをお願いします/.test(document.getElementById('workBody').textContent)), 'the message shows in the child thread');
  assert.equal(evaluate(() => document.getElementById('wkPrompt').value), '', 'modal draft cleared after sending');
  assert.equal(evaluate(() => document.getElementById('prompt').value), 'メインの下書き', 'main draft survives the modal send');
  assert.ok(!cmds('sendMessage').concat(cmds('runTurn')).some(c => c.sessionId === parent && /続きをお願いします/.test(c.prompt ?? '')), 'nothing was sent to the parent');
  await wait(() => evaluate(() => (document.getElementById('workBody').textContent.match(/ひとつめの子です/g) ?? []).length >= 1), 'child answered');
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === doneChild, { from: sentMark, ms: 30_000 });
  console.log('PASS: sending to a finished child reaches it and shows in its thread; the main draft is untouched');

  // ---- 3. 下書きは子ごと ----
  typeInto('wkPrompt', '終わった子の書きかけ');
  await sleep(900);
  await openCard(running.taskId, 'running');
  await wait(() => evaluate(id => document.getElementById('workBody').dataset.sessionId && document.getElementById('workBody').dataset.sessionId !== id, doneChild), 'switched to the running child');
  await wait(() => composerState().shown, 'composer shown for the running child');
  assert.equal(composerState().value, '', 'the other child draft does not leak');
  typeInto('wkPrompt', '走っている子の書きかけ');
  await sleep(900);
  await openCard(done.taskId, 'done again');
  await wait(() => evaluate(id => document.getElementById('workBody').dataset.sessionId === id, doneChild), 'back to the done child');
  await wait(() => composerState().value === '終わった子の書きかけ', 'done child draft restored');
  await closeDialog();
  assert.ok(!composerState().shown, 'composer hidden when the dialog closes');
  await openCard(done.taskId, 'reopen');
  await wait(() => composerState().value === '終わった子の書きかけ', 'draft survives closing the dialog');
  assert.equal(evaluate(() => document.getElementById('prompt').value), 'メインの下書き', 'main draft still unchanged');
  console.log('PASS: drafts are per child; they survive switching and closing the dialog; the main draft stays');

  // ---- 4. 走っている子へ送る: 送信待ちになり、取り消せる ----
  await openCard(running.taskId, 'running 2');
  await wait(() => evaluate(id => document.getElementById('workBody').dataset.sessionId && document.getElementById('workBody').dataset.sessionId !== id, doneChild), 'on the running child');
  const runChild = childOf();
  await wait(() => composerState().value === '走っている子の書きかけ', 'running child draft restored');
  clickOn('#wkSend', 'send to running');
  await wait(() => evaluate(() => /送信待ち/.test(document.getElementById('wkOutbox')?.textContent ?? '')), 'queued note shows');
  assert.ok(evaluate(() => /作業が終わると自動で送信/.test(document.getElementById('wkOutbox').textContent)), 'queued note wording matches the main');
  console.log('outbox text:', evaluate(() => document.getElementById('wkOutbox').textContent.replace(/\s+/g, ' ').trim()));
  assert.equal(evaluate(() => document.getElementById('wkPrompt').value), '', 'draft cleared once queued');
  const cancelMark = cmds('messageAction').length;
  evaluate(() => { const b = [...document.querySelectorAll('#wkOutbox button')].find(x => /取り消す/.test(x.textContent)); b?.click(); });
  await wait(() => cmds('messageAction').length > cancelMark && cmds('messageAction').at(-1).sessionId === runChild, 'cancel sent to the child');
  await wait(() => evaluate(() => !/送信待ち/.test(document.getElementById('wkOutbox')?.textContent ?? '')), 'queued row gone after cancel');
  console.log('PASS: sending to a running child queues it; cancel removes it');

  // ---- 5. 子が流れている間に打っても、文字・キャレット・フォーカスが消えない ----
  const rereadsBefore = cmds('loadSession').filter(c => c.sessionId === runChild).length;
  evaluate(() => { const n = document.getElementById('wkPrompt'); n.focus(); });
  for (let i = 0; i < 16; i++) {
    evaluate(ch => { document.execCommand('insertText', false, ch); }, i % 2 ? 'あ' : 'a');
    await sleep(180);
  }
  const typed = evaluate(() => { const n = document.getElementById('wkPrompt'); return { v: n.value, caret: n.selectionStart, focus: document.activeElement === n }; });
  assert.equal(typed.v, 'aあaあaあaあaあaあaあaあ', 'typed text kept while the child streams');
  assert.equal(typed.caret, 16, 'caret at the end');
  assert.ok(typed.focus, 'focus kept in the composer');
  const rereadsAfter = cmds('loadSession').filter(c => c.sessionId === runChild).length;
  console.log(`PASS: typing while the child streams keeps text/caret/focus (re-reads during typing: ${rereadsAfter - rereadsBefore})`);

  // ---- 5a. 変換中（IME）: 子が流れて会話が読み直されても、入力欄の value に書き戻さず、選択・フォーカスも動かさない ----
  // 本物の IME は合成できないので、compositionstart から compositionend の間に value への代入が 1 度も起きないこと
  // （起きると変換が確定前に切れる）と、キャレット・フォーカスが動かないことを、読み直しが走る間じゅう確かめる
  evaluate(() => {
    const n = document.getElementById('wkPrompt');
    let proto = n, desc = null;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
    window.__valSets = 0;
    window.__imePrev = n.value;
    Object.defineProperty(n, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { window.__valSets++; desc.set.call(this, v); } });
    n.focus();
    n.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    desc.set.call(n, 'に');
    n.setSelectionRange(1, 1);
    n.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'に', inputType: 'insertCompositionText' }));
  });
  const imeBefore = cmds('loadSession').filter(c => c.sessionId === runChild).length;
  await sleep(2500);
  const ime = evaluate(() => { const n = document.getElementById('wkPrompt'); return { v: n.value, caret: n.selectionStart, focus: document.activeElement === n, sets: window.__valSets }; });
  const imeReads = cmds('loadSession').filter(c => c.sessionId === runChild).length - imeBefore;
  console.log('ime', JSON.stringify(ime), 're-reads', imeReads);
  evaluate(() => {
    const n = document.getElementById('wkPrompt');
    n.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' }));
    delete n.value;
    n.value = window.__imePrev;
    n.setSelectionRange(n.value.length, n.value.length);
    n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(ime.sets, 0, 'the composer never writes value during a composition');
  assert.equal(ime.v, 'に', 'the composing text is kept');
  assert.equal(ime.caret, 1, 'caret does not move during a composition');
  assert.ok(ime.focus, 'focus kept during a composition');
  console.log(`PASS: composing text is untouched while the child streams (re-reads during composition: ${imeReads})`);

  // ---- 5b. アカウントの節: メインと同じ面に出て、選ぶと子の予約に流れる ----
  clickOn('#wkModelChip', 'model chip (accounts)');
  await wait(() => evaluate(() => !!document.querySelector('#workDialog [data-key^="account:"]')), 'account rows in the child model pop');
  const accountRows = evaluate(() => [...document.querySelectorAll('#workDialog [data-key^="account:"]')].map(n => ({ key: n.dataset.key, on: n.getAttribute('aria-selected') === 'true' || n.getAttribute('aria-checked') === 'true' || n.classList.contains('on') })));
  console.log('account rows', JSON.stringify(accountRows));
  assert.ok(accountRows.length >= 2, 'signed-in account + the registered account');
  assert.ok(accountRows[0].key === 'account:' && accountRows[0].on, 'the signed-in account is the default selection');
  const before = cmds('setTurnSettings').length;
  const registered = accountRows.find(r => r.key !== 'account:').key;
  evaluate(key => document.querySelector(`#workDialog [data-key="${key}"]`).click(), registered);
  await wait(() => cmds('setTurnSettings').length > before, 'setTurnSettings sent');
  const sentSettings = cmds('setTurnSettings').at(-1);
  console.log('setTurnSettings', JSON.stringify(sentSettings));
  assert.equal(sentSettings.sessionId, runChild, 'the reservation goes to the child');
  assert.ok(JSON.stringify(sentSettings.patch).includes(registered.slice('account:'.length)), 'the reservation carries the chosen account');
  assert.equal(composerState().value, 'aあaあaあaあaあaあaあaあ', 'the draft is kept');
  ab('press', 'Escape');
  await sleep(300);
  console.log('PASS: the child model pop shows the account section and the choice is reserved for the child');

  // ---- 5c. 入力欄の上の帯: 文脈のメーターのメニュー（今すぐ圧縮・設定）と、使用量のチップ（メインと同じ） ----
  // 文脈の使用量は子のターンの終わりに届く。走っている子はまだ流れているので、終わった子で見る
  await openCard(done.taskId, 'done for the strip');
  await wait(() => evaluate(id => document.getElementById('workBody').dataset.sessionId === id, doneChild), 'on the done child');
  await wait(() => evaluate(() => { const w = document.getElementById('wkContextMeterWrap'); return !!w && !w.hidden && w.offsetWidth > 0; }), 'context meter shows in the modal strip');
  const strip = evaluate(() => {
    const vis = n => !!n && !n.hidden && n.offsetWidth > 0;
    return { strip: vis(document.getElementById('wkContextStrip')), meter: vis(document.getElementById('wkContextMeter')), chip: vis(document.getElementById('wkUsageChip')),
      meterText: document.getElementById('wkContextMeter').textContent, chipText: document.getElementById('wkUsageChip').textContent };
  });
  console.log('strip', JSON.stringify(strip));
  assert.ok(strip.strip && strip.meter && strip.chip, 'the strip shows the context meter and the usage chip');
  clickOn('#wkUsageChip', 'usage chip');
  await wait(() => evaluate(() => { const p = document.getElementById('wkUsagePop'); return !!p && !p.hidden && p.offsetWidth > 0; }), 'usage pop opens');
  const popBox = evaluate(() => { const p = document.getElementById('wkUsagePop'), r = p.getBoundingClientRect(), d = document.getElementById('workDialog').getBoundingClientRect(); return { inside: document.getElementById('workDialog').contains(p), top: r.top, bottom: r.bottom, left: r.left, right: r.right, d: { top: d.top, bottom: d.bottom, left: d.left, right: d.right } }; });
  console.log('usage pop', JSON.stringify(popBox));
  assert.ok(popBox.inside, 'the usage pop lives inside the dialog (above the backdrop)');
  assert.ok(popBox.top >= 0 && popBox.bottom <= 800 && popBox.left >= popBox.d.left - 1 && popBox.right <= popBox.d.right + 1, 'the usage pop is inside the dialog');
  assert.ok(evaluate(() => document.getElementById('usagePop').hidden), 'the main usage pop stays closed');
  shot('5c-usage-pop');
  ab('press', 'Escape');
  await wait(() => evaluate(() => document.getElementById('wkUsagePop').hidden), 'usage pop closes with Esc');
  assert.ok(dialogOpen(), 'Esc closes only the usage pop');
  clickOn('#wkContextMeter', 'context meter');
  await wait(() => evaluate(() => { const p = document.getElementById('wkContextMeterPop'); return !!p && !p.hidden && p.offsetWidth > 0; }), 'meter menu opens');
  assert.ok(evaluate(() => !document.getElementById('wkMeterCompact').disabled), 'compact is enabled for the fake agent (it can compact)');
  shot('5c-meter-menu');
  const compactMark = cmds('compactConversation').length;
  clickOn('#wkMeterCompact', 'compact now');
  await wait(() => cmds('compactConversation').length > compactMark, 'compactConversation sent');
  assert.equal(cmds('compactConversation').at(-1).sessionId, doneChild, 'the compaction goes to the child, not the open main conversation');
  assert.ok(evaluate(() => document.getElementById('wkContextMeterPop').hidden), 'the menu closes after choosing');
  console.log('PASS: the modal strip has the meter menu (compact goes to the child) and the usage chip with its pop inside the dialog');

  // ---- 5d. 帯は列の幅で縮む（メインの fitContextStrip と同じ。右の欄を開くと詳細の列が狭まる）。はみ出さず、字が切れない ----
  const stripFit = () => evaluate(() => {
    const strip = document.getElementById('wkContextStrip');
    const sr = strip.getBoundingClientRect();
    const kids = [...strip.children].filter(n => n.offsetParent).map(n => { const r = n.getBoundingClientRect(); return { id: n.id || n.className, right: Math.round(r.right - sr.left), w: Math.round(r.width) }; });
    const clipped = ['wkContextMeter', 'wkUsageChip'].filter(id => { const n = document.getElementById(id); return n && n.offsetWidth > 0 && getComputedStyle(n).overflowX !== 'visible' && n.scrollWidth > n.clientWidth + 3; }).map(id => { const n = document.getElementById(id); return `${id}:${n.scrollWidth}>${n.clientWidth}`; });
    return { w: Math.round(sr.width), cls: strip.className, meter: document.getElementById('wkContextMeter').textContent, chip: document.getElementById('wkUsageChip').textContent, kids,
      overflow: kids.some(k => k.right > Math.round(sr.width) + 1), clipped, pane: document.getElementById('workBody').dataset.paneKind ?? '', composerRight: Math.round(document.querySelector('.wk-composer').getBoundingClientRect().right), scrollW: document.documentElement.scrollWidth };
  });
  for (const width of [1280, 1100, 900]) {
    await closeDialog();
    ab('set', 'viewport', String(width), '800');
    await sleep(500);
    await openCard(done.taskId, `done at ${width}`);
    await wait(() => evaluate(() => { const w = document.getElementById('wkContextMeterWrap'); return !!w && !w.hidden && w.offsetWidth > 0; }), `strip at ${width}`);
    await sleep(500);
    const plain = stripFit();
    console.log(`strip ${width} (no pane)`, JSON.stringify(plain));
    assert.ok(!plain.overflow && plain.clipped.length === 0, `strip fits at ${width} without a pane: ${JSON.stringify(plain)}`);
    shot(`5d-strip-${width}`);
    if (evaluate(() => !!document.getElementById('workTocEntry') && document.getElementById('workTocEntry').offsetWidth > 0)) {
      clickOn('#workTocEntry', 'open the right pane');
      await sleep(900);
      const withPane = stripFit();
      console.log(`strip ${width} (pane)`, JSON.stringify(withPane));
      assert.ok(!withPane.overflow && withPane.clipped.length === 0, `strip fits at ${width} with the right pane: ${JSON.stringify(withPane)}`);
      shot(`5d-strip-${width}-pane`);
    }
  }
  await closeDialog();
  ab('set', 'viewport', '1280', '800');
  await sleep(400);
  await openCard(done.taskId, 'done after the strip widths');
  console.log('PASS: the strip shrinks with the column (compact / tight) and never overflows or clips');

  // ---- 6. Esc: 開いているメニュー → ダイアログ。書きかけは子ごとに残り、開き直すと戻る ----
  clickOn('#wkModelChip', 'model chip');
  await wait(() => evaluate(() => [...document.querySelectorAll('.pop, [role=listbox], [role=menu]')].some(n => n.offsetWidth > 0 && n.closest('#workDialog'))), 'model pop open');
  ab('press', 'Escape');
  await sleep(400);
  assert.ok(dialogOpen(), 'first Esc closes only the model pop (the dialog stays)');
  evaluate(() => document.getElementById('wkPrompt').focus());
  ab('press', 'Escape');
  await wait(() => !dialogOpen(), 'second Esc closes the dialog');
  await openCard(running.taskId, 'running after Esc');
  await wait(() => composerState().value === 'aあaあaあaあaあaあaあaあ', 'the draft is back after Esc and reopening');
  console.log('PASS: Esc closes the open menu first, then the dialog; the draft comes back');
  shot('6-running-1280');

  // ---- 7. 360 幅: 見出しのボタンは 44px、入力欄は画面の中・最後の発言は入力欄の上 ----
  await closeDialog();
  ab('set', 'viewport', '360', '720');
  await sleep(500);
  await openCard(done.taskId, 'done at 360');
  await wait(() => evaluate(() => document.getElementById('workDialog').open && document.querySelector('.work-split.showing') && !!document.querySelector('#workBody .bg-thread')), 'detail at 360');
  await wait(() => composerState().shown, 'composer shown at 360');
  await sleep(500);
  const narrow = evaluate(() => {
    const box = n => { const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const f = document.querySelector('.wk-composer');
    const msgs = [...document.querySelectorAll('#workBody .bg-thread .m')];
    const buttons = [...document.querySelectorAll('#workHead :is(.bg-back,#workTocEntry,#workBrowserEntry,#workMore,.bg-open)')].filter(n => n.offsetWidth > 0).map(n => ({ id: n.id || n.className, ...box(n) }));
    return { vh: innerHeight, composer: box(f), last: msgs.length ? box(msgs.at(-1)) : null, buttons, scrollW: document.documentElement.scrollWidth };
  });
  console.log('360', JSON.stringify(narrow));
  const strip360 = stripFit();
  console.log('strip 360', JSON.stringify(strip360));
  assert.ok(!strip360.overflow && strip360.clipped.length === 0 && (/^コンテキスト\d+%$/.test(strip360.meter) || strip360.kids.some(k => k.id === 'wkContextStripStatus')), `strip fits at 360 with the short meter (or the status chip while the phase is shown, like main): ${JSON.stringify(strip360)}`);
  assert.ok(narrow.composer.bottom <= narrow.vh, 'composer is inside the viewport');
  assert.ok(narrow.last.bottom <= narrow.composer.top + 1, 'last message is above the composer');
  assert.ok(narrow.buttons.length >= 3 && narrow.buttons.every(b => b.w >= 44 && b.h >= 44), `heading buttons are 44px: ${JSON.stringify(narrow.buttons)}`);
  assert.ok(narrow.scrollW <= 360, 'no horizontal overflow');
  shot('7-done-360');
  console.log('PASS: at 360 the heading buttons are 44px and the composer / last message are visible');
  ab('set', 'viewport', '1280', '800');

  console.log('PASS (so far)');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
