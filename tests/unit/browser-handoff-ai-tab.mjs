// AI のタブを別に持ち、引き継ぐまで映像は見るだけ（ADR 0321。ADR 0296 の「映像に触れたら人の操作になる」「引き継ぐのボタンを置かない」の置き換え）:
//   - 中継: 人が開いたタブは AI のタブを替えない（attach・準備のコマンドでも）・AI が明示に操作したタブが AI のタブになる・閉じたら履歴の前の AI のタブへ戻る（popup は開いた元へ）
//   - 中継: 許可の一覧（CLAIMS）のコマンドは 1 つずつ、人が開いたタブを AI のタブにする（一覧から 1 つ消すと落ちる）・一覧に無いコマンドでは移らない・履歴は 20 件まで
//   - サーバー: 引き継ぐ前の AI のタブの映像への入力は 'view-only' で断り、人の操作に数えない（シート・ファイル・貼り付けも）・引き継いだあとは通る・人が開いたタブは今までどおり触れる
//   - サーバー: 見るだけの AI のタブの確認の窓は、人がタブを替えた・パネルを閉じたくらいでは閉じない（人が引き継いだタブ・人のタブは今までどおり閉じる）
//   - 画面の部品: 映像（見るだけの間は送らない）・行（<名前> が Chrome を操作中 [引き継ぐ]）・押したら強調
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';
import { createTabHolder, HUMAN_TIMEOUT_MS } from '../../core/chrome/tab-holder.mjs';
import { createControlBadge } from '../../web/chrome-control.mjs';
import { createScreencastInput } from '../../web/screencast-frame.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'browser-handoff-ai-tab';
export const title = 'AI のタブを別に持つ・引き継ぐまで映像は見るだけ（ADR 0321）: 中継の今のタブ・サーバーの view-only・[引き継ぐ] の行・映像の封じ（偽の Chrome・DOM の代役）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) return false; await sleep(10); } return true; }

export default async function (t) {
  // ===== 1. 中継: AI のタブは AI が操作したタブだけ =====
  {
    const r = await rig();
    let a;
    try {
      a = await agent(await r.relay.endpoint('one'));
      t.ok('AI が何も操作していない間は AI のタブは無い', r.relay.view.current('one') === null);
      const human = (await r.relay.openForConversation('one', 'https://human.test/')).targetId;
      t.ok('人がパネルから開いたタブは AI のタブにならない（最初のタブへも戻さない）', !!human && r.relay.view.current('one') === null, String(r.relay.view.current('one')));
      t.ok('shown: AI のタブが無い間は窓の最初のタブ（撮影・窓の特定など、引き継ぎの対象でない所が使う）', r.relay.view.shown('one') === human, String(r.relay.view.shown('one')));
      const made = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      t.ok('AI が開いたタブが AI のタブになる', r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      const human2 = (await r.relay.openForConversation('one', 'https://human2.test/')).targetId;
      t.ok('そのあとに人が開いたタブも、AI のタブを替えない', !!human2 && r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      t.ok('shown: AI のタブがあれば、最初のタブ（人のタブ）ではなく AI のタブ', r.relay.view.shown('one') === made && r.relay.state('one').lastWindowId === r.fake.targets().find(x => x.targetId === made)?.windowId,
        JSON.stringify([r.relay.view.shown('one'), r.relay.state('one').lastWindowId]));
      // agent-browser は、人が開いたタブにも自分から attach し、準備のコマンドを送る（実測 2026-11-12、agent-browser 0.38.1 の順）。それでは AI のタブは移らない
      const sid = (await a.cmd('Target.attachToTarget', { targetId: human, flatten: true })).result.sessionId;
      for (const method of ['Runtime.runIfWaitingForDebugger', 'Page.enable', 'Runtime.enable', 'Network.enable', 'Target.setAutoAttach', 'Page.getFrameTree'])
        await a.cmd(method, method === 'Target.setAutoAttach' ? { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } : {}, sid);
      t.ok('人が開いたタブに AI がつないで準備しただけでは、AI のタブは移らない', r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      // 自動 attach の接続（relay が真似て attach する）でも同じ
      const b = await agent(await r.relay.endpoint('one'));
      try {
        await b.cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        const human3 = (await r.relay.openForConversation('one', 'https://human3.test/')).targetId;
        const attached = await until(() => b.events.some(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === human3));
        const bsid = b.events.find(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === human3)?.params.sessionId;
        for (const method of ['Runtime.runIfWaitingForDebugger', 'Page.enable', 'Runtime.enable', 'Page.getFrameTree']) await b.cmd(method, {}, bsid);
        t.ok('自動 attach の接続が人のタブにつながり準備しても、AI のタブは移らない', attached && r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      } finally { b.close(); }
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid);
      t.ok('AI が人のタブを明示に操作したら（Runtime.evaluate）、そのタブが AI のタブになる', r.relay.view.current('one') === human, String(r.relay.view.current('one')));
      const sid2 = (await a.cmd('Target.attachToTarget', { targetId: human2, flatten: true })).result.sessionId;
      await a.cmd('Page.bringToFront', {}, sid2);
      t.ok('タブの明示の切り替え（Page.bringToFront）でも、そのタブが AI のタブになる', r.relay.view.current('one') === human2, String(r.relay.view.current('one')));
      await a.cmd('Target.closeTarget', { targetId: human2 });
      t.ok('AI のタブが閉じたら、履歴の 1 つ前の AI のタブへ戻る（人のタブの最初へではない）', await until(() => r.relay.view.current('one') === human), String(r.relay.view.current('one')));
      await a.cmd('Target.closeTarget', { targetId: human });
      t.ok('それも閉じたら、さらに前の AI のタブへ戻る', await until(() => r.relay.view.current('one') === made), String(r.relay.view.current('one')));

      // popup: AI のタブが開いた popup を AI が操作 → 閉じたら開いた元へ戻る
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      const madeSid = (await a.cmd('Target.attachToTarget', { targetId: made, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, madeSid);
      r.fake.windowOpen(made, 'https://pop.test/', { popup: true });
      const popupSeen = await until(() => a.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === made));
      const popup = a.events.find(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === made)?.params.targetInfo.targetId;
      t.ok('AI のタブが開いた popup は、開いただけでは AI のタブにならない', popupSeen && r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      const popSid = (await a.cmd('Target.attachToTarget', { targetId: popup, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, popSid);
      t.ok('popup を AI が操作したら popup が AI のタブ', r.relay.view.current('one') === popup, String(r.relay.view.current('one')));
      await a.cmd('Target.closeTarget', { targetId: popup });
      t.ok('popup が閉じたら、開いた元の AI のタブへ戻る', await until(() => r.relay.view.current('one') === made), String(r.relay.view.current('one')));

      // 人が開いたタブの popup も人のタブ（準備では AI のタブにならない）
      const human4 = (await r.relay.openForConversation('one', 'https://human4.test/')).targetId;
      r.fake.windowOpen(human4, 'https://pop2.test/');
      const hp = await until(() => a.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === human4));
      const humanPopup = a.events.find(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === human4)?.params.targetInfo.targetId;
      const hpSid = (await a.cmd('Target.attachToTarget', { targetId: humanPopup, flatten: true })).result.sessionId;
      await a.cmd('Page.getFrameTree', {}, hpSid);
      t.ok('人のタブが開いた popup に AI がつないで準備しても、AI のタブは移らない', hp && r.relay.view.current('one') === made, String(r.relay.view.current('one')));

      // エージェントがつなぎ直す（agent-browser の再起動）: 範囲のタブ全部に attach して準備しても、AI のタブは替わらない
      a.close(); await a.closed;
      a = await agent(await r.relay.endpoint('one'));
      const { targetInfos } = (await a.cmd('Target.getTargets')).result;
      for (const info of [...targetInfos].reverse()) {
        const s = (await a.cmd('Target.attachToTarget', { targetId: info.targetId, flatten: true })).result.sessionId;
        await a.cmd('Page.enable', {}, s); await a.cmd('Page.getFrameTree', {}, s);
      }
      t.ok('エージェントがつなぎ直して全部のタブにつないでも、AI のタブは前のまま', targetInfos.length >= 3 && r.relay.view.current('one') === made, JSON.stringify([targetInfos.length, r.relay.view.current('one')]));

      // AI のタブを全部閉じた: 人のタブだけ → AI のタブは無し（最初のタブの例外は shown だけ）
      await a.cmd('Target.closeTarget', { targetId: made });
      t.ok('AI のタブが全部閉じたら無し（人のタブを AI のタブにしない）', await until(() => r.relay.view.current('one') === null), String(r.relay.view.current('one')));
      const firstTab = r.relay.view.tabs('one')[0]?.targetId;
      t.ok('shown は AI のタブが無いときだけ窓の最初のタブ', !!firstTab && r.relay.view.shown('one') === firstTab, JSON.stringify([r.relay.view.shown('one'), firstTab]));
      // Chrome との接続が切れた: タブは無くなり、AI のタブも無し（古い id を指さない）
      r.chrome.dropConnections();
      t.ok('Chrome との接続が切れたら、AI のタブは無し', await until(() => r.relay.view.current('one') === null && r.relay.view.shown('one') === null), String(r.relay.view.shown('one')));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 1b. 中継: 許可の一覧（CLAIMS）の 1 つずつ・一覧に無いコマンド・履歴の上限 =====
  {
    const r = await rig();
    const holder = r.relay.unify.tabHolder;
    let a;
    try {
      a = await agent(await r.relay.endpoint('one'));
      const made = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      // 人が開いて触り、持ち手が AI に戻ったタブ（人のタブの印は残る）
      const humanTab = async () => {
        const id = (await r.relay.openForConversation('one', 'https://human.test/')).targetId;
        holder.touch({ sessionId: 'one', targetId: id, by: 'pc' });
        holder.release('one', id);
        const sid = (await a.cmd('Target.attachToTarget', { targetId: id, flatten: true })).result.sessionId;
        return { id, sid };
      };
      const settle = (promise, ms = 1500) => Promise.race([promise, sleep(ms)]);
      // 一覧の全部を 1 つずつ（正規表現の一覧と同じ並び。1 つ消すと、その行が落ちる）
      const claims = [
        ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }], ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }], ['Input.insertText', { text: 'x' }],
        ['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 1 }] }], ['Input.imeSetComposition', { text: 'x', selectionStart: 1, selectionEnd: 1 }],
        ['Runtime.evaluate', { expression: '1' }], ['Runtime.callFunctionOn', { functionDeclaration: '() => 1', objectId: 'x' }],
        ['Runtime.compileScript', { expression: '1', sourceURL: '', persistScript: false }], ['Runtime.runScript', { scriptId: '1' }],
        ['Page.navigate', { url: 'https://human.test/next' }], ['Page.reload', {}], ['Page.navigateToHistoryEntry', { entryId: 0 }], ['Page.bringToFront', {}],
        ['Page.captureScreenshot', {}], ['Page.printToPDF', {}], ['Page.handleJavaScriptDialog', { accept: false }], ['Page.stopLoading', {}],
        ['Page.setDocumentContent', { frameId: 'F', html: '' }],
        ['Accessibility.getFullAXTree', {}], ['Accessibility.getPartialAXTree', { backendNodeId: 1 }], ['Accessibility.queryAXTree', { backendNodeId: 1 }],
        ['Accessibility.getRootAXNode', {}], ['Accessibility.getChildAXNodes', { id: '1' }],
        ['DOM.getDocument', {}], ['DOM.querySelector', { nodeId: 1, selector: 'a' }], ['DOM.querySelectorAll', { nodeId: 1, selector: 'a' }], ['DOM.getOuterHTML', { nodeId: 1 }],
        ['DOM.describeNode', { nodeId: 1 }], ['DOM.resolveNode', { backendNodeId: 11 }], ['DOM.getBoxModel', { backendNodeId: 11 }], ['DOM.getContentQuads', { backendNodeId: 11 }],
        ['DOM.performSearch', { query: 'a' }], ['DOM.focus', { backendNodeId: 11 }], ['DOM.scrollIntoViewIfNeeded', { backendNodeId: 11 }],
        ['DOM.setFileInputFiles', { files: [], backendNodeId: 11 }], ['DOM.setAttributeValue', { nodeId: 1, name: 'a', value: 'b' }],
        ['DOM.setAttributesAsText', { nodeId: 1, text: 'a=b' }], ['DOM.setOuterHTML', { nodeId: 1, outerHTML: '<a></a>' }], ['DOM.setNodeValue', { nodeId: 1, value: 'x' }],
        ['DOM.removeNode', { nodeId: 1 }],
      ];
      // 人が触った後の最初の操作のコマンドは、門が 1 回だけ撮り直しを求めて断る（tab-holder）。断られたコマンドでは移らず、送り直したもので移る
      for (const [method, params] of claims) {
        const { id, sid } = await humanTab();
        const before = r.relay.view.current('one');
        let res = await settle(a.cmd(method, params, sid));
        const refused = /snapshot/.test(res?.error?.message ?? '');
        const stayed = r.relay.view.current('one') === made;
        if (refused) res = await settle(a.cmd(method, params, sid));
        t.ok(`CLAIMS: ${method} を受けた人のタブ（持ち手は AI に戻っている）が AI のタブになる${refused ? '（撮り直しを求めて断った 1 回目では移らない）' : ''}`,
          before === made && stayed === refused && r.relay.view.current('one') === id, JSON.stringify([before, refused, stayed, r.relay.view.current('one')]));
        r.fake.closeTab(id);
        await until(() => r.relay.view.current('one') === made);
      }
      // ブラウザーの単位の明示の切り替え
      {
        const { id } = await humanTab();
        await a.cmd('Target.activateTarget', { targetId: id });
        t.ok('Target.activateTarget（ブラウザーの単位の切り替え）も、人のタブを AI のタブにする', r.relay.view.current('one') === id, String(r.relay.view.current('one')));
        r.fake.closeTab(id);
        await until(() => r.relay.view.current('one') === made);
      }
      // 一覧に無いコマンド（attach・各 enable・準備・読むだけの問い合わせ・Emulation・Network など）では、どれを送っても移らない
      const { id: idle, sid: idleSid } = await humanTab();
      const passive = [
        ['Runtime.runIfWaitingForDebugger', {}], ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
        ['Page.enable', {}], ['Runtime.enable', {}], ['Network.enable', {}], ['DOM.enable', {}], ['Accessibility.enable', {}], ['CSS.enable', {}], ['Log.enable', {}],
        ['Page.setLifecycleEventsEnabled', { enabled: true }], ['Page.addScriptToEvaluateOnNewDocument', { source: '0' }], ['Page.getFrameTree', {}],
        ['Page.createIsolatedWorld', { frameId: idle, worldName: 'agent' }], ['Page.getNavigationHistory', {}], ['Page.getLayoutMetrics', {}],
        ['Runtime.addBinding', { name: 'agentBinding' }], ['Runtime.getProperties', { objectId: 'x' }], ['Runtime.releaseObject', { objectId: 'x' }],
        ['Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }], ['Emulation.setUserAgentOverride', { userAgent: 'x' }],
        ['Network.setExtraHTTPHeaders', { headers: {} }], ['Network.setCacheDisabled', { cacheDisabled: true }], ['DOM.disable', {}],
      ];
      for (const [method, params] of passive) {
        await settle(a.cmd(method, params, idleSid));
        t.ok(`一覧に無い ${method} では、人のタブは AI のタブにならない`, r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      }
      for (const [method, params] of [['Target.attachToTarget', { targetId: idle, flatten: true }], ['Browser.getVersion', {}], ['Target.getTargets', {}], ['Target.getTargetInfo', { targetId: idle }], ['Target.setDiscoverTargets', { discover: true }]]) {
        await settle(a.cmd(method, params));
        t.ok(`ブラウザーの単位の ${method} では、人のタブは AI のタブにならない`, r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      }
      r.fake.closeTab(idle);

      // 履歴の上限: AI が 22 個のタブを順に作ると、持ち越しに載るのは新しい 20 個（新しい順）
      const opened = [];
      for (let i = 0; i < 22; i += 1) opened.push((await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId);
      const carried = () => r.relay.snapshot().entries.find(item => item.id === 'one');
      const ai = carried()?.ai ?? [];
      t.ok('AI のタブの履歴は 20 件まで（新しい順。古いものから落ちる）', ai.length === 20 && JSON.stringify(ai) === JSON.stringify(opened.slice(2).reverse()) && !ai.includes(made),
        JSON.stringify(ai));
      // 閉じたタブは履歴から外れ、AI のタブは 1 つ前へ戻る
      await a.cmd('Target.closeTarget', { targetId: opened[21] });
      t.ok('閉じたタブは持ち越しの履歴から外れ、AI のタブは 1 つ前のタブへ戻る', await until(() => !(carried()?.ai ?? []).includes(opened[21]) && r.relay.view.current('one') === opened[20]),
        JSON.stringify([carried()?.ai, r.relay.view.current('one')]));
      // 人のタブの印も 20 件まで
      const humans = [];
      for (let i = 0; i < 22; i += 1) humans.push((await r.relay.openForConversation('one', `https://h${i}.test/`)).targetId);
      const marks = carried()?.human ?? [];
      t.ok('人のタブの印も 20 件まで（古いものから落ちる）', marks.length === 20 && humans.slice(2).every(id => marks.includes(id)) && !marks.includes(humans[0]), JSON.stringify(marks));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 1c. 中継: 持ち越しの読み込み（Chrome につなぐ前。つないだ後の「もう無いタブ」の掃除とは別に、読む時点で字の id だけ受ける）=====
  {
    const r = await rig();
    try {
      const many = Array.from({ length: 25 }, (_, i) => `H${i}`);
      await r.relay.restore({ v: 1, port: null, chrome: null, windows: [], entries: [
        { id: 'old', key: 'a'.repeat(48), stopped: false, paused: null, ai: ['T1', 42, '', 'z'.repeat(101), null, { id: 'T2' }, 'T1', ...many], human: ['T3', 7, 'T3', ''] },
        { id: 'older', key: 'b'.repeat(48), stopped: false, paused: null },   // 旧版の形（ai・human が無い）
      ] });
      const item = id => r.relay.snapshot().entries.find(entry => entry.id === id);
      t.ok('持ち越しの読み込み: 字の id だけ受け（数・空・101 字以上・null・object は捨て、重なりは 1 つ）、20 件まで',
        JSON.stringify(item('old')?.ai) === JSON.stringify(['T1', ...many.slice(0, 19)]) && JSON.stringify(item('old')?.human) === JSON.stringify(['T3']), JSON.stringify(item('old')));
      t.ok('旧版の形（ai・human が無い）も読め、AI のタブは無し', !!item('older') && item('older').ai === undefined && item('older').human === undefined && r.relay.view.current('older') === null, JSON.stringify(item('older')));
    } finally { await r.stop(); }
  }

  // ===== 2. サーバー: AI のタブの映像への入力は引き継ぐまで断る =====
  {
    let clock = 1, tabListener, aiTab = 'T'; const calls = [];
    const holder = createTabHolder({ now: () => clock, emit: (type, payload) => tabListener?.(type, payload) });
    const relay = { unify: { tabHolder: holder }, onTabEvent(fn) { tabListener = fn; return () => { tabListener = null; }; } };
    const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 1, operating: true }), tabs: () => [{ targetId: 'T', windowId: 1 }], current: () => aiTab, focus: async () => {},
      async attach() {
        return { async send(method, params) { calls.push({ method, params }); if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }; if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } }; return { result: { value: true } }; }, detach: async () => {} };
      } };
    const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
    const pc = { send() {} };
    const cmd = input => screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId: 'T', input }, chrome: { hub, bridge }, client: pc });
    const mouse = () => calls.filter(call => call.method === 'Input.dispatchMouseEvent');
    try {
      await hub.watch(pc, 's', { width: 560, height: 700 });
      const tap = await cmd({ type: 'tap', x: 30, y: 40 });
      t.ok('引き継ぐ前の AI のタブへの入力は view-only で断る', tap.ok === false && tap.code === 'view-only', JSON.stringify(tap));
      t.ok('断った入力はページへ送らず、人の操作にも数えない', mouse().length === 0 && holder.holder('s', 'T').holder === 'ai', JSON.stringify(holder.holder('s', 'T')));
      const key = await cmd({ type: 'text', text: 'x' });
      t.ok('文字・キーも同じく断る', key.ok === false && key.code === 'view-only' && !calls.some(call => /^Input\./.test(call.method)));
      const cursor = await cmd({ type: 'cursor', x: 3, y: 4 });
      t.ok('カーソルの問い合わせ（読むだけ）は断らない', cursor.code !== 'view-only', JSON.stringify(cursor));
      // シート（ファイル・選択肢・確認の窓・入力欄）と貼り付け（画面は貼った字を type: 'text' で送る）・ほかの入力も、引き継ぐまでは断る
      const sent = calls.length;
      for (const input of [
        { type: 'files', files: [{ name: 'a.txt', data: 'aGk=' }] }, { type: 'select', id: 1, selected: [0] }, { type: 'dialog', accept: true, text: 'x' },
        { type: 'field', id: 1, value: 'x' }, { type: 'text', text: '貼り付けた\n複数行の字' }, { type: 'key', key: 'Enter' }, { type: 'scroll', x: 1, y: 1, dy: 100 },
        { type: 'composition', text: 'あ' }, { type: 'context', x: 1, y: 1 }, { type: 'drag', phase: 'start', x: 1, y: 1 }, { type: 'copy' }, { type: 'menu', x: 1, y: 1 },
      ]) {
        const res = await cmd(input);
        t.ok(`見るだけの間は ${input.type} も view-only で断る（ページへ何も送らない）`, res.ok === false && res.code === 'view-only' && calls.length === sent, JSON.stringify([res, calls.slice(sent).map(call => call.method)]));
      }
      t.ok('断った入力では、ファイルを入れず（DOM.setFileInputFiles）選択肢も選ばず、人の操作にもならない',
        !calls.some(call => call.method === 'DOM.setFileInputFiles' || /__plyInput\.select/.test(call.params?.expression ?? '')) && holder.holder('s', 'T').holder === 'ai');
      holder.touch({ sessionId: 's', targetId: 'T', by: 'pc' });   // [引き継ぐ]（chromeTakeOver by: screen）が行うのと同じ持ち手の触り
      const after = await cmd({ type: 'tap', x: 30, y: 40 });
      t.ok('引き継いだあとは入力が通り、ページへ届く', after.ok === true && mouse().some(call => call.params.type === 'mouseReleased'), JSON.stringify(after));
      clock += HUMAN_TIMEOUT_MS + 1;
      holder.gate({ sessionId: 's', targetId: 'T', method: 'Input.dispatchMouseEvent', paused: null });   // 60 秒で AI へ戻す（門が戻す）
      const before = mouse().length;
      const back = await cmd({ type: 'tap', x: 1, y: 1 });
      t.ok('60 秒で AI に戻ったあとは、また見るだけ', back.ok === false && back.code === 'view-only' && mouse().length === before, JSON.stringify(back));
      aiTab = null;   // 人が開いたタブ（AI のタブではない）
      holder.release('s', 'T');
      const human = await cmd({ type: 'tap', x: 30, y: 40 });
      t.ok('人が開いたタブ（AI のタブでない）は、今までどおり引き継がずに触れて人の操作になる', human.ok === true && holder.holder('s', 'T').holder === 'human', JSON.stringify(human));
    } finally { hub.closeAll?.(); bridge.close?.(); }
  }

  // ===== 2b. サーバー: 見るだけの AI のタブの確認の窓は、人の画面の出入りでは閉じない =====
  {
    let tabListener; const aiTab = 'T'; const calls = [], listeners = [];
    const holder = createTabHolder({ now: () => 1, emit: (type, payload) => tabListener?.(type, payload) });
    const relay = { unify: { tabHolder: holder }, onTabEvent(fn) { tabListener = fn; return () => { tabListener = null; }; } };
    const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 2, operating: true }), tabs: () => [{ targetId: 'T', windowId: 1 }, { targetId: 'U', windowId: 1 }], current: () => aiTab, focus: async () => {},
      async attach(_sessionId, targetId, onEvent) {
        listeners.push({ targetId, onEvent });
        return { async send(method, params) { calls.push({ targetId, method, params }); if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }; if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } }; return { result: { value: true } }; }, detach: async () => {} };
      } };
    const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
    const pc = { send() {} };
    const dialogOn = targetId => { for (const item of listeners) if (item.targetId === targetId) item.onEvent('Page.javascriptDialogOpening', { type: 'confirm', message: 'ok?' }); };
    const answered = targetId => calls.filter(call => call.targetId === targetId && call.method === 'Page.handleJavaScriptDialog').length;
    try {
      await hub.watch(pc, 's', { width: 560, height: 700 });
      dialogOn('T');
      await bridge.request('pin', 's', { tabId: 'U' });   // 人が右パネルでほかのタブを選んだ
      await sleep(20);
      t.ok('見るだけの AI のタブの確認の窓は、人がほかのタブへ替えても閉じない（キャンセルを送らない）', answered('T') === 0, JSON.stringify(calls.filter(call => call.method === 'Page.handleJavaScriptDialog')));
      await bridge.request('pin', 's', {});   // 固定を解いて AI のタブへ戻る
      dialogOn('T');
      await hub.unwatch(pc, 's');   // パネルを閉じた
      await sleep(20);
      t.ok('見るだけの AI のタブの確認の窓は、パネルを閉じても閉じない', answered('T') === 0, JSON.stringify(calls.filter(call => call.method === 'Page.handleJavaScriptDialog')));

      await hub.watch(pc, 's', { width: 560, height: 700 });
      dialogOn('T');
      holder.touch({ sessionId: 's', targetId: 'T', by: 'pc' });   // 人が引き継いだ
      await hub.unwatch(pc, 's');
      await sleep(20);
      t.ok('人が引き継いだ AI のタブの窓は、今までどおりパネルを閉じるとキャンセルする', answered('T') >= 1 && calls.find(call => call.targetId === 'T' && call.method === 'Page.handleJavaScriptDialog')?.params?.accept === false);
      holder.release('s', 'T');

      await hub.watch(pc, 's', { width: 560, height: 700 });
      await bridge.request('pin', 's', { tabId: 'U' });
      dialogOn('U');
      await bridge.request('pin', 's', {});   // 人のタブから AI のタブへ戻る
      await sleep(20);
      t.ok('人のタブ（AI のタブでない）の窓は、今までどおりタブを替えるとキャンセルする', answered('U') >= 1);
    } finally { hub.closeAll?.(); bridge.close?.(); }
  }

  // ===== 3. 画面の部品: 行 =====
  const oldDoc = globalThis.document, oldWindow = globalThis.window;
  const doc = new N('document'); Object.assign(doc, { createElement: tag => new N(tag), createElementNS: (_ns, tag) => new N(tag), getElementById: () => null, head: new N('head'), body: new N('body') });
  globalThis.document = doc; globalThis.window = new N('window');
  try {
    const taken = [], resumed = [];
    const badge = createControlBadge({ mount: new N('div'), onTakeOver: () => taken.push(1), onResume: () => resumed.push(1) });
    badge.update({ visible: true, mode: 'ai', name: 'Claude' });
    t.ok('AI のタブを見ている間の行: 「Claude が Chrome を操作中」と [引き継ぐ]', badge.element.hidden === false && badge.button.textContent === '引き継ぐ' && /Claude/.test(badge.element.textContent) && badge.element.getAttribute('role') === 'status' && badge.element.dataset.mode === 'ai', badge.element.outerHTML);
    badge.button.onclick();
    t.ok('[引き継ぐ] は onTakeOver を呼ぶ（AI に戻すは呼ばない）', taken.length === 1 && resumed.length === 0);
    await sleep(0);
    badge.update({ visible: true, mode: 'human' });
    t.ok('引き継ぐと行は「あなたが操作中 [AI に戻す]」になる（同じ行・名前の字は変わる）', badge.button.textContent === 'AI に戻す' && badge.element.dataset.mode === 'human' && /あなたが操作中/.test(badge.element.textContent), badge.element.outerHTML);
    badge.update({ visible: true, mode: 'ai', name: 'Claude' });
    badge.nudge();
    t.ok('見るだけの映像に触れると [引き継ぐ] を強調する（nudge）', badge.button.classList.contains('nudge'));
    badge.update({ visible: true, mode: 'human' });
    badge.nudge();
    t.ok('人が操作中の行は強調しない', !badge.button.classList.contains('nudge'));
    badge.destroy();

    // ===== 4. 画面の部品: 映像の封じ =====
    const listeners = new Map();
    const surface = new N('div'); surface.addEventListener = (type, fn) => { listeners.set(type, fn); };
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
    const img = new N('img');
    const sent = []; let view = true, blocked = 0;
    const input = createScreencastInput({ surface, img, getFrame: () => ({ width: 400, height: 300 }), send: value => { sent.push(value); return Promise.resolve({}); }, viewOnly: () => view, onBlocked: () => { blocked++; } });
    const keydown = listeners.get('keydown');
    if (keydown) {
      const ev = { key: 'a', target: surface, preventDefault() { this.prevented = true; }, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
      keydown(ev);
      t.ok('見るだけの間のキーはページへ送らず、触れたことだけ知らせる', sent.length === 0 && blocked === 1 && ev.prevented === true, JSON.stringify({ sent, blocked }));
      const tab = { key: 'Tab', target: surface, preventDefault() { this.prevented = true; }, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
      keydown(tab);
      t.ok('Tab は奪わない（[引き継ぐ] へ移れる）', !tab.prevented && blocked === 1);
      view = false;
      const ev2 = { key: 'a', target: surface, preventDefault() { this.prevented = true; }, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
      keydown(ev2);
      await sleep(0);
      t.ok('引き継いだあと（見るだけでない）のキーはページへ送る', sent.some(value => value.type === 'text' || value.type === 'key'), JSON.stringify(sent));
    } else t.ok('keydown の窓口がある', false, [...listeners.keys()].join());
    input.destroy?.();
  } finally { globalThis.document = oldDoc; globalThis.window = oldWindow; }
}
