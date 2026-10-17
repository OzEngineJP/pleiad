import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'chrome-window-switch';
export const title = '右パネル「Chrome の映像」の見るウィンドウの切り替え: 番号のチップ・固定と追う・印の移動・閉じたウィンドウからの戻り・引き継ぎ中の無効・閉じる確かめ（DOM の代役）';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function rig({ paused = false, risk = null, failPin = false } = {}) {
  const commands = [], menus = [];
  const windows = createWindowTable();
  let body = null, toolbar = null, panelOpen = false, isPaused = paused;
  const preview = { openPanel: opts => { body = opts.body; toolbar = opts.toolbar; panelOpen = true; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; } };
  const panel = setupChromePanel({
    cmd: async (name, args) => {
      commands.push([name, args]);
      if (name === 'browserScreencast') return { state: { suspended: false } };
      if (name === 'chromePinWindow') { if (failPin) throw new Error('pin failed'); return { pinnedWindowId: args.windowId }; }
      return {};
    },
    preview, browser: { available: () => true }, session: () => 'conv', windows, paused: () => isPaused, closeRisk: () => risk,
    showMenu: (x, y, items, title) => menus.push({ items, title }),
  });
  const ev = (ids, current, extra = {}) => ({ sessionId: 'conv', windows: ids.length, windowIds: ids, currentWindowId: current, ...extra });
  const send = (...args) => { const e = ev(...args); panel.windowEvent(e); return e; };
  const chips = () => body.querySelectorAll('.cp-sw-chip');
  const selected = () => chips().filter(chip => chip.attrs['aria-selected'] === 'true').map(chip => chip.querySelector('.cp-sw-num').textContent);
  const agentChips = () => chips().filter(chip => 'data-agent' in chip.attrs).map(chip => chip.querySelector('.cp-sw-num').textContent);
  return { panel, windows, commands, menus, ev, send, chips, selected, agentChips, body: () => body, toolbar: () => toolbar,
    root: () => body.querySelector('.cp-sw'), screen: () => body.querySelector('.cp-screen'), follow: () => body.querySelector('.cp-sw-follow'),
    pins: () => commands.filter(([name]) => name === 'chromePinWindow').map(([, args]) => args), setPaused: value => { isPaused = value; },
    frame: seq => panel.onMessage({ source: 'chrome', sessionId: 'conv', type: 'frame', seq, data: 'AAAA', metadata: { deviceWidth: 390, deviceHeight: 700 } }),
    dialog: () => body.querySelector('.cp-dlg'), yes: () => body.querySelector('.cp-dlg-yes'), no: () => body.querySelector('.btn-quiet') };
}

export default async function (t) {
  const old = { raf: globalThis.requestAnimationFrame, rect: N.prototype.getBoundingClientRect, toggle: N.prototype.toggleAttribute, window: globalThis.window };
  globalThis.requestAnimationFrame = fn => { queueMicrotask(fn); return 1; };
  N.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 });
  N.prototype.toggleAttribute = function (name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); };
  globalThis.window = { innerHeight: 800, devicePixelRatio: 1 };
  try {
    // 窓が 1 つなら何も足さない。2 つ以上で番号のチップが出る
    {
      const r = rig();
      r.windows.apply(r.ev([7], 7));
      r.panel.open();
      await flush();
      t.ok('窓が 1 つなら、チップの列は開かない（何も足さない）', r.chips().length <= 1 && !('data-open' in r.root().attrs));
      r.send([7, 9], 7);
      t.ok('窓が 2 つになると、番号のチップの列が開く', 'data-open' in r.root().attrs && r.chips().length === 2);
      t.ok('チップは 1、2 の番号で、tablist の中の tab', r.chips().map(chip => chip.querySelector('.cp-sw-num').textContent).join() === '1,2'
        && r.chips().every(chip => chip.attrs.role === 'tab') && r.body().querySelector('.cp-sw-list').attrs.role === 'tablist');
      t.ok('追っている間は、エージェントのいるウィンドウが選ばれ、そのチップに印が付く', r.selected().join() === '1' && r.agentChips().join() === '1');
      t.ok('固定の印は出さない', !('data-pinned' in r.screen().attrs));
      t.ok('選ばれたチップだけがタブ移動の対象（roving tabindex）', r.chips().map(chip => chip.attrs.tabindex).join() === '0,-1');
      t.ok('追う側のボタンは「追っている」状態（aria-pressed）', r.follow().attrs['aria-pressed'] === 'true' && r.follow().classList.contains('on'));
    }

    // 押すと固定して映像が替わる。追うを押すと解ける
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.frame(1);
      r.chips()[1].onclick();
      t.ok('チップを押すと、そのウィンドウを固定する命令を送る', JSON.stringify(r.pins()) === JSON.stringify([{ sessionId: 'conv', windowId: 9 }]));
      t.ok('サーバーの知らせを待たず、押したチップが選ばれ、固定の印が出る', r.selected().join() === '2' && 'data-pinned' in r.screen().attrs);
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      t.ok('サーバーから固定が届いても、選びは変わらない', r.selected().join() === '2' && 'data-pinned' in r.screen().attrs);
      t.ok('固定中は、選ばれたチップの読み上げに「固定中」が入る', /固定/.test(r.chips()[1].attrs['aria-label']));
      t.ok('固定中は、追うボタンは「追っていない」状態', r.follow().attrs['aria-pressed'] === 'false' && !r.follow().classList.contains('on') && 'data-away' in r.follow().attrs);

      // 固定している間にエージェントが別のウィンドウへ移っても、映像は動かない。印だけ移って 1 回光る
      r.send([7, 9], 9, { pinnedWindowId: 9 });
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      t.ok('固定中にエージェントが移っても、映像のウィンドウは動かず、印だけ移る', r.selected().join() === '2' && r.agentChips().join() === '1');
      t.ok('印が移ったチップは 1 回光る', r.chips()[0].classList.contains('flash'));

      r.follow().onclick();
      t.ok('追うボタンで固定を解く命令を送る（windowId は null）', JSON.stringify(r.pins().at(-1)) === JSON.stringify({ sessionId: 'conv', windowId: null }));
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: null });
      t.ok('固定を解くと、エージェントのウィンドウに戻る', r.selected().join() === '1' && !('data-pinned' in r.screen().attrs));
      t.ok('戻りの動きとして、追うボタンが 1 回光る', r.follow().classList.contains('flash'));
      r.follow().onclick();
      t.ok('追っている間に追うボタンを押すと、映っているウィンドウを固定する（承認済みのモックと同じ）', JSON.stringify(r.pins().at(-1)) === JSON.stringify({ sessionId: 'conv', windowId: 7 }));
    }

    // 矢印キー
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9, 11], 7));
      r.panel.open();
      await flush();
      let prevented = 0;
      r.chips()[0].onkeydown({ key: 'ArrowRight', preventDefault: () => { prevented++; } });
      r.chips()[1].onkeydown({ key: 'End', preventDefault: () => { prevented++; } });
      r.chips()[2].onkeydown({ key: 'Home', preventDefault: () => { prevented++; } });
      r.chips()[0].onkeydown({ key: 'ArrowLeft', preventDefault: () => { prevented++; } });
      t.ok('→ ・End ・Home ・← で、隣・端のウィンドウを選ぶ（左端で ← は動かない）', r.pins().map(p => p.windowId).join() === '9,11,7,7' && prevented === 4);
      r.chips()[0].onkeydown({ key: 'a', preventDefault: () => { prevented++; } });
      t.ok('ほかのキーは奪わない', prevented === 4 && r.pins().length === 4);
    }

    // 引き継ぎ中は切り替えられない
    {
      const r = rig({ paused: true });
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      t.ok('引き継ぎ中は、チップも追うボタンも押せず、列を薄くする', r.chips().every(chip => chip.disabled === true) && r.follow().disabled === true && 'data-paused' in r.root().attrs);
      r.chips()[1].onclick();
      r.follow().onclick();
      t.ok('引き継ぎ中に押しても、何も送らない', r.pins().length === 0);
      r.setPaused(false);
      r.panel.refresh();
      t.ok('引き継ぎが終わると、押せるようにもどる', r.chips().every(chip => chip.disabled === false) && r.follow().disabled === false && !('data-paused' in r.root().attrs));
      r.setPaused(true);
      r.panel.setOperating(true);
      t.ok('この端末から操作している間（端末の引き継ぎ）は、切り替えられる', r.chips().every(chip => chip.disabled === false) && r.follow().disabled === false);
      r.panel.setOperating(false);
      t.ok('ほかの端末が操作している間（この端末は見るだけ）は、切り替えられない', r.chips().every(chip => chip.disabled === true));
      r.setPaused(false);
    }

    // 固定が失敗したら知らせて、選びを実際の状態に戻す
    {
      const r = rig({ failPin: true });
      // 知らせ（file-actions の notify）は document に直に出すので、代役の本体を用意する
      const saved = { body: document.body, query: document.querySelector };
      document.body = new N('body'); document.querySelector = sel => document.body.querySelector(sel);
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.chips()[1].onclick();
      t.ok('押した直後は押したチップが選ばれる', r.selected().join() === '2');
      await flush();
      await flush();
      t.ok('固定できなかったら知らせ、選びは実際の状態に戻る', document.body.querySelector('.file-toast')?.textContent === 'pin failed' && r.selected().join() === '1' && !('data-pinned' in r.screen().attrs));
      document.body = saved.body; document.querySelector = saved.query;
    }

    // 見ているウィンドウが閉じたら、約 1 秒薄くして残し、追う側に戻る
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.frame(1);
      r.chips()[1].onclick();
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      r.send([7], 7);
      t.ok('見ていたウィンドウが閉じると、映像を薄くして残す（閉じたチップも残る）', r.screen().classList.contains('ended') && r.chips().length === 2
        && r.chips()[1].classList.contains('ghost') && r.chips()[1].disabled === true);
      t.ok('薄くしている間は、固定の印も外れている（固定は解けている）', !('data-pinned' in r.screen().attrs));
      await wait(1100);
      t.ok('約 1 秒後に、追う側（残った窓）に戻る', !r.screen().classList.contains('ended') && r.chips().length <= 1 && !('data-open' in r.root().attrs));
    }
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.frame(1);
      r.send([9], 9);
      t.ok('追っていたウィンドウが閉じたときも、同じく薄くして残す', r.screen().classList.contains('ended'));
      await wait(1100);
      t.ok('1 秒後は列が閉じ、残ったウィンドウを映す', !r.screen().classList.contains('ended') && !('data-open' in r.root().attrs));
    }

    // ⋯ の「表示中のウィンドウを閉じる」: 映像に映っているウィンドウ（固定していればそれ）を、確かめてから閉じる
    {
      const r = rig({ risk: 'human' });
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.chips()[1].onclick();
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      r.toolbar().at(-1).onclick();
      const item = r.menus[0].items.at(-1);
      t.ok('⋯ の最後は「表示中のウィンドウを閉じる」。ウィンドウ n の行は無い', r.menus[0].items.length === 1 && item.label.length > 0);
      item.onClick();
      t.ok('確かめにはウィンドウの番号が入り、引き継ぎ中の注意が付く', r.dialog().hidden === false && /2/.test(r.body().querySelector('.cp-dlg-t').textContent)
        && r.body().querySelector('.cp-dlg-n') !== null);
      r.yes().onclick();
      await flush();
      const closes = r.commands.filter(([name]) => name === 'chromeCloseWindow');
      t.ok('「閉じる」で、固定している（映っている）ウィンドウだけを閉じる', closes.length === 1 && closes[0][1].windowId === 9 && closes[0][1].sessionId === 'conv');
    }
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 9));
      r.panel.open();
      await flush();
      r.toolbar().at(-1).onclick();
      r.menus[0].items.at(-1).onClick();
      r.yes().onclick();
      await flush();
      const closes = r.commands.filter(([name]) => name === 'chromeCloseWindow');
      t.ok('固定していなければ、エージェントのいるウィンドウを閉じる', closes.length === 1 && closes[0][1].windowId === 9);
    }

    // 会話の題の列: この会話と窓のある子の会話。子の Chrome を映しても会話は移らない
    {
      const commands = [], menus = [], opened = [], windows = createWindowTable();
      let body = null, toolbar = null, panelOpen = false;
      const preview = { openPanel: opts => { body = opts.body; toolbar = opts.toolbar; panelOpen = true; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; } };
      const rows = [{ sessionId: 'conv', taskId: null, title: null, windows: 1, state: 'idle' },
        { sessionId: 'kid', taskId: 'tk', title: '価格を調べる', windows: 2, state: 'running', waiting: false },
        { sessionId: 'gone', taskId: 'tg', title: '終了', windows: 0, state: 'idle' }];
      windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      windows.apply({ sessionId: 'kid', windows: 2, windowIds: [21, 22], currentWindowId: 21, operating: true });
      const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return name === 'browserScreencast' ? { state: { suspended: false } } : name === 'chromePinWindow' ? { pinnedWindowId: args.windowId } : {}; },
        preview, browser: { available: () => true }, session: () => 'conv', windows, children: () => rows, getAgentName: id => (id === 'kid' ? 'Codex' : 'Claude'),
        showMenu: (x, y, items, title) => menus.push({ items, title }), openConversation: id => opened.push(id), menuItems: () => [{ label: 'PC で操作する', onClick: () => {} }] });
      panel.open();
      await flush();
      const convChips = () => body.querySelectorAll('.cp-sw-conv');
      const numChips = () => body.querySelectorAll('.cp-sw-chip').filter(chip => !chip.classList.contains('cp-sw-conv'));
      const labels = () => convChips().map(chip => chip.querySelector('.cp-sw-t').textContent);
      t.ok('窓のある子の会話があれば、上の列に会話の題（この会話・子の題）が出る。窓の無い子は出さない', labels().join() === 'この会話,価格を調べる' && 'data-open' in body.querySelector('.cp-sw').attrs, labels().join());
      t.ok('子の会話のウィンドウが 2 つ以上なら、その題の後ろに番号のチップ。子のエージェントの印は弧', numChips().length === 2
        && numChips().filter(chip => 'data-agent' in chip.attrs).length === 1 && convChips()[1].querySelector('.run') !== null);
      t.ok('映している会話（この会話。番号が無い）の題が選ばれている', convChips()[0].attrs['aria-selected'] === 'true' && convChips()[1].attrs['aria-selected'] === 'false');
      convChips()[1].onclick();
      await flush();
      t.ok('子の題を押すと、会話は移らずに子の Chrome を映す（この会話の映像を止めて、子の映像を見始める）', panel.sessionId === 'kid' && panel.owner === 'conv'
        && commands.some(([name, args]) => name === 'browserScreencastStop' && args.sessionId === 'conv') && commands.some(([name, args]) => name === 'browserScreencast' && args.sessionId === 'kid'));
      t.ok('子を映している間は、子の番号のチップに敷きがあり、題は映している印', numChips().filter(chip => chip.attrs['aria-selected'] === 'true').length === 1 && convChips().every(chip => chip.attrs['aria-selected'] === 'false') && 'data-on' in convChips()[1].attrs);
      t.ok('映像の名前は子のエージェント', /Codex/.test(body.querySelector('.cp-screen').attrs['aria-label']));
      toolbar.at(-1).onclick();
      const menu = menus.at(-1).items.map(item => item.label);
      t.ok('⋯ の先頭に呼ぶ側の行（PC で操作する）、子を映している間は「会話を開く」、最後は「表示中のウィンドウを閉じる」', menu[0] === 'PC で操作する' && menu.includes('会話を開く') && /閉じる/.test(menu.at(-1)), JSON.stringify(menu));
      menus.at(-1).items.find(item => item.label === '会話を開く').onClick();
      t.ok('「会話を開く」で子の会話へ移る', opened.join() === 'kid');
      convChips()[0].onclick();
      await flush();
      t.ok('この会話の題で戻る', panel.sessionId === 'conv');
      toolbar.at(-1).onclick();
      t.ok('この会話を映している間は「会話を開く」を出さない', !menus.at(-1).items.some(item => item.label === '会話を開く'));
      // 子の番号を押すと、子へ替えてからそのウィンドウを固定する
      numChips()[1].onclick();
      await flush(); await flush();
      t.ok('ほかの会話の番号を押すと、その会話を映してからそのウィンドウを固定する', panel.sessionId === 'kid' && commands.some(([name, args]) => name === 'chromePinWindow' && args.sessionId === 'kid' && args.windowId === 22));
      panel.close();
      // 会話を開くときに子を指す（委譲カードの「Chrome のウィンドウを見る」）
      panel.open(null, { target: 'kid' });
      await flush();
      t.ok('open の target で、子の Chrome を映して開く（会話は移らない）', panel.sessionId === 'kid' && panel.owner === 'conv');
      panel.close();
    }

    // タブの列: 映しているウィンドウのタブが 2 つ以上のとき。押すと固定・端末で操作している間だけ ×・開いたタブへ移ったら光る
    {
      const r = rig({ paused: true });
      r.windows.apply(r.ev([7], 7));
      r.setPaused(false);
      r.panel.open();
      await flush();
      const state = (list, extra = {}) => r.panel.onMessage({ source: 'chrome', sessionId: 'conv', type: 'state', state: { tabId: 'T1', agentTabId: 'T1', pinnedTabId: null, suspended: false, list, ...extra } });
      const tabsRoot = () => r.body().querySelector('.cp-tabs');
      const tabChips = () => r.body().querySelectorAll('.cp-tab-b');
      state([{ tabId: 'T1', windowId: 7, title: 'Example Store' }]);
      t.ok('タブが 1 つなら、タブの列は開かない', !('data-open' in tabsRoot().attrs));
      state([{ tabId: 'T1', windowId: 7, title: 'Example Store' }, { tabId: 'T2', windowId: 7, title: 'Shop B' }, { tabId: 'T9', windowId: 99, title: '別の窓' }]);
      t.ok('タブが 2 つ以上なら、映しているウィンドウのタブの題が並ぶ（ほかのウィンドウのタブは出さない）', 'data-open' in tabsRoot().attrs && tabChips().map(chip => chip.querySelector('.cp-sw-t').textContent).join() === 'Example Store,Shop B');
      t.ok('タブは tablist の中の tab。エージェントのタブに印', tabsRoot().querySelector('.cp-sw-list').attrs.role === 'tablist' && tabChips().every(chip => chip.attrs.role === 'tab') && tabChips()[0].querySelector('.cp-sw-dot, .run') !== null);
      t.ok('上の列が閉じていると、「追う」は下の列の右端に移る', tabsRoot().querySelector('.cp-sw-follow') !== null);
      t.ok('見るだけの間は × を出さない', r.body().querySelectorAll('.cp-tab-x').every(x => x.hidden === true));
      tabChips()[1].onclick();
      t.ok('タブを押すと、そのタブを固定する命令を送り、押したタブが選ばれる', JSON.stringify(r.pins().at(-1)) === JSON.stringify({ sessionId: 'conv', windowId: 7, tabId: 'T2' }) && tabChips()[1].attrs['aria-selected'] === 'true');
      await flush();
      state([{ tabId: 'T1', windowId: 7, title: 'Example Store' }, { tabId: 'T2', windowId: 7, title: 'Shop B' }], { tabId: 'T2', pinnedTabId: 'T2' });
      t.ok('タブを固定している間は、固定の印と「追う」が外れた状態', 'data-pinned' in r.screen().attrs && r.follow().attrs['aria-pressed'] === 'false');
      r.setPaused(true);
      r.panel.setOperating(true);
      t.ok('端末で操作している間は、タブに × が出る', r.body().querySelectorAll('.cp-tab-x').every(x => x.hidden === false));
      r.body().querySelectorAll('.cp-tab-x')[1].onclick({ stopPropagation() {} });
      await flush();
      t.ok('× で、そのタブを閉じる命令を送る', JSON.stringify(r.commands.filter(([name]) => name === 'chromeCloseTab').at(-1)?.[1]) === JSON.stringify({ sessionId: 'conv', tabId: 'T2' }));
      // ページが開いたタブへサーバーが移った
      state([{ tabId: 'T1', windowId: 7, title: 'Example Store' }, { tabId: 'G', windowId: 7, title: 'Sign in' }, { tabId: 'T2', windowId: 7, title: 'Shop B' }], { tabId: 'G', pinnedTabId: 'G' });
      const google = tabChips().find(chip => chip.querySelector('.cp-sw-t').textContent === 'Sign in');
      t.ok('開いたタブへ移ったら、そのチップが選ばれて 1 回光る', google?.attrs['aria-selected'] === 'true' && google.classList.contains('flash'));
      r.panel.setOperating(false);
    }

    // PC で操作している間のリモートの端末: 幕に「この端末で操作する」
    {
      const asked = [];
      const commands = [], windows = createWindowTable();
      let body = null, panelOpen = false;
      const preview = { openPanel: opts => { body = opts.body; panelOpen = true; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; } };
      windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      let remotePc = true;
      const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return name === 'browserScreencast' ? { state: { suspended: true } } : {}; },
        preview, browser: { available: () => true }, session: () => 'conv', windows, paused: () => true, canOperateHere: () => remotePc, operateHere: async id => { asked.push(id); } });
      panel.open();
      await flush(); await flush();
      const here = body.querySelector('.cp-veil-here');
      t.ok('PC で操作している間（映像を止めている）、幕に「PC で操作中」と「この端末で操作する」', body.querySelector('.cp-veil').hidden === false && here.hidden === false && /PC で操作中/.test(body.querySelector('.cp-veil-text').textContent));
      here.onclick();
      await flush();
      t.ok('押すと、その会話を端末へ移す（operateHere）', asked.join() === 'conv');
      remotePc = false;
      panel.refresh();
      t.ok('PC の画面では出さない（映像を止めています）', here.hidden === true && /映像を止めています/.test(body.querySelector('.cp-veil-text').textContent));
      panel.close();
    }

    // 窓の番号は会話の中で安定する（閉じても詰めない）
    {
      const windows = createWindowTable();
      windows.apply({ sessionId: 'a', windows: 2, windowIds: [7, 9], currentWindowId: 7 });
      windows.apply({ sessionId: 'a', windows: 1, windowIds: [9], currentWindowId: 9 });
      windows.apply({ sessionId: 'a', windows: 2, windowIds: [9, 11], currentWindowId: 9 });
      t.ok('番号は出た順に付き、窓が閉じても詰めず、新しい窓は次の番号', windows.list('a').map(row => row.number).join() === '2,3');
      windows.apply({ sessionId: 'a', windows: 2, windowIds: [9, 11], currentWindowId: 9, pinnedWindowId: 11 });
      t.ok('固定したウィンドウをテーブルが覚える', windows.pinned('a') === 11 && windows.list('a').find(row => row.windowId === 11).pinned === true);
      windows.apply({ sessionId: 'a', windows: 1, windowIds: [9], currentWindowId: 9, pinnedWindowId: 11 });
      t.ok('ウィンドウに無い固定は無かったことにする', windows.pinned('a') === null);
    }
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle; globalThis.window = old.window;
  }
}
