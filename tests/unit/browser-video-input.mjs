import { inputCommands, createPageInput } from '../../core/chrome/input.mjs';
import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';
import { createTabHolder } from '../../core/chrome/tab-holder.mjs';
import { createScreencastInput } from '../../web/screencast-frame.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'browser-video-input';
export const title = '映像の触り心地: ドラッグ選択・2・3 回押し・右クリックのメニュー・コピーと切り取り・カーソル・読むだけの問い合わせ';
export default async function (t) {
  // ---- 入力の約束事（inputCommands）
  const accel = process.platform === 'darwin' ? 4 : 2;
  const doubleTap = inputCommands({ type: 'tap', x: 10, y: 20, clicks: 2 });
  t.ok('2 回押しは clickCount 2 で押す・離す', doubleTap[1][1].clickCount === 2 && doubleTap[2][1].clickCount === 2);
  t.ok('3 回押しは 3、4 回目以降も 3 で止める', inputCommands({ type: 'tap', x: 1, y: 1, clicks: 3 })[1][1].clickCount === 3 && inputCommands({ type: 'tap', x: 1, y: 1, clicks: 9 })[1][1].clickCount === 3);
  const selectAll = inputCommands({ type: 'key', key: 'a', modifiers: ['accel'] });
  t.ok('すべて選択は OS に合わせた修飾のキー', selectAll.length === 2 && selectAll[0][0] === 'Input.dispatchKeyEvent' && (selectAll[0][1].modifiers & accel) === accel && selectAll[1][1].modifiers === selectAll[0][1].modifiers);
  t.ok('修飾の無い英字キーは送らない（文字は text で送る）', inputCommands({ type: 'key', key: 'a' }).length === 0);
  const shiftArrow = inputCommands({ type: 'key', key: 'ArrowLeft', modifiers: ['shift'] });
  t.ok('Shift+矢印は修飾つきで押す・離す', shiftArrow[0][1].modifiers === 8 && shiftArrow[1][1].modifiers === 8);
  t.ok('知らない修飾名は落とす', !('modifiers' in inputCommands({ type: 'key', key: 'ArrowLeft', modifiers: ['bogus'] })[0][1]));
  t.ok('ドラッグの押下・移動・解放は変わらない', ['start', 'move', 'end'].map(phase => inputCommands({ type: 'drag', phase, x: 10, y: 20 })[0][1].type).join() === 'mousePressed,mouseMoved,mouseReleased');

  // ---- ページからの問い合わせ（createPageInput）
  {
    const calls = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's' };
      if (method === 'Runtime.evaluate') return { result: { value: { text: '選んだ文字', editable: true, link: 'https://a/b', cursor: 'text' } } };
      return {};
    };
    const input = createPageInput({ send });
    try {
      await input.start();
      const info = await input.input({ type: 'inspect', x: 10, y: 20 });
      t.ok('右クリックの問い合わせは隔離 world の inspect で、結果を返す', info.text === '選んだ文字' && calls.at(-1).params.expression === 'globalThis.__plyInput.inspect(10,20)' && calls.at(-1).params.contextId === 7);
      await input.input({ type: 'selection' });
      t.ok('コピーは今の選択を読む', calls.at(-1).params.expression === 'globalThis.__plyInput.selection()');
      await input.input({ type: 'cursor', x: 1.6, y: 2.4 });
      t.ok('カーソルは点の下のものだけを読む', calls.at(-1).params.expression === 'globalThis.__plyInput.cursorAt(2,2)');
      const before = calls.length;
      const bad = await input.input({ type: 'inspect', x: '1);bad()', y: 2 });
      t.ok('式に端末の文字を混ぜない（数でない座標は断る）', bad === null && calls.length === before);
      t.ok('ページが替わって問い合わせられないときは null を返す', (await input.input({ type: 'selection' })) !== undefined);
    } finally { await input.dispose(); }
  }

  // ---- 会話の映像への振り分け（core/chrome/screencast.mjs の input）
  {
    const calls = [], messages = [];
    const holder = createTabHolder();
    const relay = { unify: { tabHolder: holder }, onTabEvent(fn) { return () => {}; } };
    const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 1, operating: true }), tabs: () => [{ targetId: 'T', windowId: 1 }], current: () => 'T', focus: async () => {},
      async attach(sid, tid, event) {
        return { async send(method, params) { calls.push({ method, params });
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
          if (method === 'Runtime.evaluate') return { result: { value: { text: '選択', editable: true, link: 'https://a/b', cursor: 'pointer' } } };
          return {};
        }, detach: async () => {} };
      } };
    const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
    const pc = { send: message => messages.push(message) };
    const cmd = (input, tabId = 'T') => screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId, input }, chrome: { hub, bridge }, client: pc });
    try {
      await hub.watch(pc, 's', { width: 560, height: 700 });
      const holder_ = () => holder.holder('s', 'T')?.holder;
      const wasHuman = holder_() === 'human';
      const hovered = await cmd({ type: 'cursor', x: 30, y: 40 });
      const cursorCall = calls.at(-1);
      t.ok('カーソルの問い合わせは人の操作にしない（読むだけ）', hovered.ok && hovered.result?.info?.cursor === 'pointer' && cursorCall.params.expression === 'globalThis.__plyInput.cursorAt(30,40)' && (holder_() === 'human') === wasHuman);
      const copy = await cmd({ type: 'copy' });
      t.ok('コピーは選択を読んで人の操作になる', copy.ok && copy.result?.info?.text === '選択' && holder_() === 'human' && calls.at(-1).params.expression === 'globalThis.__plyInput.selection()');
      const menu = await cmd({ type: 'menu', x: 5, y: 6 });
      t.ok('右クリックのメニューは点の下のものを読む', menu.ok && menu.result?.info?.link === 'https://a/b' && calls.at(-1).params.expression === 'globalThis.__plyInput.inspect(5,6)');
      t.ok('座標の無いメニューは断る', (await cmd({ type: 'menu' })).code === 'invalid-input');
      t.ok('見ていない接続からの問い合わせは断る', (await screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId: 'T', input: { type: 'cursor', x: 1, y: 1 } }, chrome: { hub, bridge }, client: { send() {} } })).code === 'not-watching');
    } finally { await hub.unwatch(pc, 's'); bridge.close(); holder.forget({ sessionId: 's' }); }
  }

  // ---- 端末の面（web/screencast-frame.mjs）
  {
    const oldDoc = globalThis.document, oldNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldFocus = N.prototype.focus, oldBlur = N.prototype.blur;
    const doc = { createElement: tag => new N(tag), getElementById: () => null, head: new N('head'), body: new N('body'), activeElement: null };
    const copied = [], copiedFail = new Set();
    globalThis.document = doc;
    Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Win32', clipboard: { writeText: text => copiedFail.has(text) ? Promise.reject(new Error('denied')) : (copied.push(text), Promise.resolve()) } }, configurable: true });
    N.prototype.focus = function () { doc.activeElement = this; }; N.prototype.blur = function () { if (doc.activeElement === this) doc.activeElement = null; };
    const surface = new N('div');
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    surface.setPointerCapture = () => {};
    const img = new N('img'); img.naturalWidth = 800; img.naturalHeight = 600; img.getBoundingClientRect = surface.getBoundingClientRect;
    const frame = { metadata: { deviceWidth: 800, deviceHeight: 600 } };
    const sent = [], errors = [], opened = []; let menu = null, copyInfo = { text: '選択', editable: false, link: null }, menuInfo = copyInfo;
    const input = createScreencastInput({ surface, img, phone: false, getFrame: () => frame,
      send: value => { sent.push(value); const info = value.type === 'copy' ? copyInfo : value.type === 'menu' ? menuInfo : value.type === 'cursor' ? { cursor: 'pointer' } : null; return Promise.resolve(info ? { info } : {}); },
      showMenu: (x, y, items, title) => { menu = { x, y, items, title }; },
      openLink: url => opened.push(url),
      onError: error => errors.push(error) });
    const pointer = (type, x, y, stamp, extra = {}) => surface.dispatchEvent({ type, target: img, button: 0, pointerId: 1, clientX: x, clientY: y, timeStamp: stamp, ...extra });
    const key = (key, extra = {}) => { let prevented = false; surface.dispatchEvent({ type: 'keydown', target: surface, key, preventDefault() { prevented = true; }, ...extra }); return prevented; };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      // マウスのドラッグはページの選択（スクロールにしない）
      pointer('pointerdown', 50, 50, 1000, { pointerType: 'mouse' }); pointer('pointermove', 150, 50, 1010, { pointerType: 'mouse' }); pointer('pointerup', 150, 50, 1020, { pointerType: 'mouse' });
      await sleep(0);
      t.ok('マウスのドラッグはページへドラッグを送る（スクロールにしない）', sent.map(v => `${v.type}:${v.phase ?? ''}`).join() === 'drag:start,drag:move,drag:end' && sent[0].x === 50 && sent[1].x === 150);
      sent.length = 0;
      // 指のドラッグはスクロール
      pointer('pointerdown', 50, 50, 1100, { pointerType: 'touch' }); pointer('pointermove', 50, 150, 1110, { pointerType: 'touch' }); pointer('pointerup', 50, 150, 1120, { pointerType: 'touch' });
      await sleep(0);
      t.ok('1 本指の移動はスクロール', sent.length === 1 && sent[0].type === 'scroll' && sent[0].dy === -100);
      sent.length = 0;
      // 連続した押しは 2・3 と数える
      for (let i = 0; i < 3; i++) { pointer('pointerdown', 60, 60, 2000 + i * 150, { pointerType: 'mouse' }); pointer('pointerup', 60, 60, 2020 + i * 150, { pointerType: 'mouse' }); }
      await sleep(0);
      t.ok('続けた押しは 2・3 回と数える', sent.map(v => v.clicks).join() === '1,2,3');
      sent.length = 0;
      pointer('pointerdown', 400, 400, 2600, { pointerType: 'mouse' }); pointer('pointerup', 400, 400, 2620, { pointerType: 'mouse' });
      await sleep(0);
      t.ok('離れた場所の押しは 1 回に戻る', sent.length === 1 && sent[0].clicks === 1);
      sent.length = 0;
      // 右クリックのメニュー
      menuInfo = { text: '選んだ文字', editable: false, link: 'https://a/b' };
      surface.dispatchEvent({ type: 'contextmenu', target: img, clientX: 100, clientY: 100, preventDefault() {} });
      await sleep(0);
      t.ok('右クリックはページへ点の下のものを聞いて手元のメニューを出す', sent[0]?.type === 'menu' && sent[0].x === 100 && menu && menu.items.some(item => item.label === 'リンクを開く'));
      const copyItem = menu.items.find(item => item.label === 'コピー');
      copyItem.onClick(); await sleep(0);
      t.ok('メニューのコピーは手元のクリップボードへ書く', copied.at(-1) === '選んだ文字');
      menu.items.find(item => item.label === 'リンクを開く').onClick();
      t.ok('リンクを開くは Chrome のタブへ移す頼み', opened.at(-1) === 'https://a/b');
      menu.items.find(item => item.label === 'すべて選択').onClick(); await sleep(0);
      t.ok('すべて選択は accel のキー', sent.at(-1).type === 'key' && sent.at(-1).key === 'a' && sent.at(-1).modifiers?.includes('accel'));
      menu.items.find(item => item.label === 'リンクをコピー').onClick(); await sleep(0);
      t.ok('リンクをコピーはリンク先を書く', copied.at(-1) === 'https://a/b');
      menu = null; sent.length = 0;
      menuInfo = { text: '', editable: false, link: null };
      surface.dispatchEvent({ type: 'contextmenu', target: img, clientX: 10, clientY: 10, preventDefault() {} });
      await sleep(0);
      t.ok('選んだ文字が無ければコピーは押せない', menu.items.find(item => item.label === 'コピー').disabled === true && !menu.items.some(item => item.label === '切り取り'));
      // 切り取りは編集できる選択だけ
      menu = null; menuInfo = { text: '欄の文字', editable: true, link: null };
      surface.dispatchEvent({ type: 'contextmenu', target: img, clientX: 10, clientY: 10, preventDefault() {} });
      await sleep(0);
      menu.items.find(item => item.label === '切り取り').onClick(); await sleep(0);
      t.ok('切り取りはコピーが通ってから消すキーを送る', copied.at(-1) === '欄の文字' && sent.at(-1).key === 'Backspace');
      // キーボード
      sent.length = 0;
      const aPrevented = key('a', { ctrlKey: true }); await sleep(0);
      t.ok('Ctrl+A は手元でなくページへすべて選択', aPrevented && sent.at(-1).key === 'a' && sent.at(-1).modifiers.includes('accel'));
      copyInfo = { text: 'ページの文字', editable: false };
      t.ok('Ctrl+C はページの選択をコピーする', key('c', { ctrlKey: true }));
      await sleep(0);
      t.ok('コピーの結果を手元のクリップボードへ書く', sent.at(-1).type === 'copy' && copied.at(-1) === 'ページの文字');
      const beforeSent = sent.length, beforeCopied = copied.length;
      key('x', { ctrlKey: true }); await sleep(0);
      t.ok('編集できない選択の Ctrl+X は何もしない', copied.length === beforeCopied && sent.length === beforeSent + 1);
      copyInfo = { text: '欄の文字', editable: true };
      key('x', { ctrlKey: true }); await sleep(0);
      t.ok('編集できる選択の Ctrl+X はコピーしてから消す', copied.at(-1) === '欄の文字' && sent.at(-1).key === 'Backspace');
      sent.length = 0;
      const shiftPrevented = key('ArrowLeft', { shiftKey: true }); await sleep(0);
      t.ok('Shift+矢印は修飾つきのキー（欄の選択を伸ばす）', shiftPrevented && sent[0].type === 'key' && sent[0].modifiers.includes('shift'));
      sent.length = 0;
      const charPrevented = key('あ'); await sleep(0);
      t.ok('普通の文字は変わらず text', charPrevented && sent[0].type === 'text' && sent[0].text === 'あ');
      sent.length = 0;
      // カーソル
      surface.dispatchEvent({ type: 'pointermove', target: img, pointerId: 2, pointerType: 'mouse', clientX: 30, clientY: 40, timeStamp: 3000 });
      await sleep(120);
      t.ok('hover で点の下のカーソルを聞いて合わせる', sent[0]?.type === 'cursor' && sent[0].x === 30 && img.style.cursor === 'pointer' && surface.style.cursor === 'pointer');
      sent.length = 0;
      surface.dispatchEvent({ type: 'pointerleave' });
      t.ok('離れたらカーソルを戻す', img.style.cursor === 'auto');
      // 読むだけの問い合わせは押して動かしている間は送らない
      pointer('pointerdown', 100, 100, 4000, { pointerType: 'mouse' });
      surface.dispatchEvent({ type: 'pointermove', target: img, pointerId: 2, pointerType: 'mouse', clientX: 40, clientY: 40, timeStamp: 4010 });
      await sleep(120);
      t.ok('押している間はカーソルを聞かない', !sent.some(v => v.type === 'cursor'));
      input.reset();
      t.ok('指を離した後も、間近の問い合わせを再開する', img.style.cursor === 'auto');
      // コピーの失敗は知らせる
      copyInfo = { text: '秘密', editable: false }; copiedFail.add('秘密');
      key('c', { ctrlKey: true }); await sleep(0);
      t.ok('クリップボードへ書けなければ失敗を知らせる', errors.at(-1)?.message?.includes('コピーできませんでした'));
    } finally { input.destroy(); globalThis.document = oldDoc; if (oldNav) Object.defineProperty(globalThis, 'navigator', oldNav); N.prototype.focus = oldFocus; if (oldBlur) N.prototype.blur = oldBlur; else delete N.prototype.blur; }
  }
}
