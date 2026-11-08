// 画面内ページのタブ（web/page-tabs.mjs）と、Chrome のタブの Pleiad 印（core/chrome/tab-info.mjs の pleiadPage）。
//   - 開く先はサーバー（pageOpen）が決める: HTML・可視化は返った URL、ページは suffix（本体と同じ出どころ）
//   - ページ内の移動（locate）は URL・題・履歴の位置・対象を追い直す
//   - page:changed / page:moved は、触っていなければ読み直し・触っていれば「更新を表示」（pending）
//   - reissue は開き方から鍵と見張りを取り直す。閉じたタブの見張りは release で外す（N6）
//   - pleiadPage: 印の出どころと直書き localhost の隔離 port の両方をアプリのページと分ける（P9）
import assert from 'node:assert/strict';
import { createPageTabs } from '../../web/page-tabs.mjs';
import { pleiadPage } from '../../core/chrome/tab-info.mjs';
import { hasFileViews } from '../../web/address-bar.mjs';
import { createPageWatch } from '../../core/page-watch.mjs';

export const name = 'browser-unify-pages';
export const title = '画面内ページのタブ: サーバーが決める開く先・ページ内移動・更新の扱い・鍵と見張りの取り直し';

const ORIGIN = 'http://app.test';
const VIZ_HASH = 'b'.repeat(64);

function setup({ pageOpen, touched } = {}) {
  const releases = [], errors = [];
  let generation = 0;
  const tabs = createPageTabs({
    origin: ORIGIN,
    pageOpen: pageOpen ?? (async () => { throw new Error('unexpected pageOpen'); }),
    changed: () => generation++,
    touched,
    release: tab => releases.push(tab),
    onError: (error, tab) => errors.push([error?.code ?? error?.message, tab]),
  });
  return { tabs, releases, errors, generation: () => generation };
}

export default async function(t) {
  // ---- 開く先はサーバーが決める ----
  {
    const requests = [];
    const { tabs } = setup({ pageOpen: async request => { requests.push(request);
      if (request.kind === 'html') return { kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' };
      if (request.kind === 'viz') return { kind:'viz', url:`http://v${VIZ_HASH.slice(0, 24)}.localhost:9999/viz/${VIZ_HASH}/index.html?embed=tab&title=%E5%9B%B3`, hash:VIZ_HASH, entry:'index.html', title:'図', path:'D:/w/chart.html' };
      return { kind:'file', path:request.path, suffix:`/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}`, url:`http://localhost:1234/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}` };
    } });
    const html = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    assert.equal(requests.length, 1); assert.equal(requests[0].kind, 'html');
    assert.equal(html.url, `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, 'HTML は返った隔離 URL のまま（画面は組み立てない）');
    assert.equal(html.page.kind, 'html'); assert.equal(html.page.path, 'D:/w/a.html');
    const viz = await tabs.open({ sessionId:'s1', kind:'viz', vizHash:VIZ_HASH, entry:'index.html', title:'図', path:'D:/w/chart.html' });
    assert.equal(requests[1].kind, 'viz'); assert.equal(requests[1].hash, VIZ_HASH); assert.equal(requests[1].path, 'D:/w/chart.html');
    assert.equal(viz.page.kind, 'viz'); assert.equal(viz.page.vizHash, VIZ_HASH); assert.equal(viz.page.path, 'D:/w/chart.html', '元のファイルはアドレスバーとツリーが使う');
    const file = await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/notes.md' });
    assert.equal(file.url, `${ORIGIN}/_pleiad/s/s1/file?path=${encodeURIComponent('D:/w/notes.md')}`, 'ページは suffix を本体の出どころで使う（返った port の URL は使わない）');
    t.ok('開く先はサーバーの応答だけ（ページは suffix・隔離は返った URL。可視化は hash・入口・題・元パスを一度だけ渡す）', true);

    await assert.rejects(tabs.open({ sessionId:'s1', kind:'html', url:'https://evil.example/f/x/a.html' }), /invalid-url/);
    await assert.rejects(tabs.open({ sessionId:'s1', kind:'html', url:'http://user:pw@f0123456789abcde.localhost:9999/f/x/a.html' }), /invalid-url/);
    const viaKey = await tabs.open({ sessionId:'s1', kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' });
    t.ok('Chrome のタブを「ページ」へ戻すときは隔離 URL（鍵）をそのまま使い、別の出どころ・資格は断る',
      viaKey.url === `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html` && viaKey.page.path === 'D:/w/a.html');
  }

  // ---- ページ内の移動（locate） ----
  {
    const { tabs } = setup({ pageOpen: async () => ({ kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    const B = `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/b.html`, C = `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/c.html`;
    tabs.locate(tab, { url:B, resolved:{ kind:'html', path:'D:/w/b.html' } });
    assert.equal(tab.url, B); assert.equal(tab.canGoBack, true); assert.equal(tab.page.path, 'D:/w/b.html', 'アドレスバーのパンくずと見張りの対象が追い直される');
    tabs.locate(tab, { url:C, title:'C のページ', resolved:{ kind:'html', path:'D:/w/c.html' } });
    assert.equal(tab.title, 'C のページ'); assert.equal(tab.canGoBack, true); assert.equal(tab.canGoForward, false);
    tabs.locate(tab, { url:B });   // 中の文書が戻った
    assert.equal(tab.canGoBack, true); assert.equal(tab.canGoForward, true);
    tabs.locate(tab, { url:C });   // 進んだ
    assert.equal(tab.canGoForward, false);
    tabs.locate(tab, { url:B });
    tabs.locate(tab, { url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/d.html`, resolved:{ kind:'html', path:'D:/w/d.html' } });
    assert.equal(tab.canGoForward, false, '戻った場所から新しい移動は先を捨てる');
    tabs.activity(tab);   // 移動は触った印をリセットする（locate 内）
    tabs.locate(tab, { url:tab.url });
    assert.equal(tab.touched, false);
    t.ok('ページ内の移動で URL・題・戻る/進む・対象（パス）を追い直す（P3）', true);
  }

  // ---- 原文の表示（view） ----
  {
    const { tabs } = setup({ pageOpen: async () => ({ kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    tabs.view(tab, 'source');
    assert.equal(new URL(tab.url).searchParams.get('view'), 'source'); assert.equal(tab.view, 'source'); assert.equal(tab.reload, 1);
    tabs.view(tab, 'preview');
    assert.equal(new URL(tab.url).searchParams.get('view'), null); assert.equal(tab.reload, 2);
    t.ok('HTML のプレビュー/原文は ?view= の張り直し（N3）', hasFileViews(tab) && true);
    t.ok('原文を出せるのは HTML と、md・csv などのファイルだけ', hasFileViews({ page:{ kind:'file', path:'D:/w/a.md' } }) && hasFileViews({ page:{ kind:'file', path:'D:/w/a.html' } }) && !hasFileViews({ page:{ kind:'file', path:'D:/w/a.png' } }) && !hasFileViews({ page:{ kind:'dir' } }));
  }

  // ---- page:changed / page:moved ----
  {
    const { tabs } = setup({ pageOpen: async request => request.kind === 'html'
      ? { kind:'html', url:`http://f0123456789abcde.localhost:2345/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }
      : { kind:'file', path:request.path, suffix:`/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}`, url:`http://localhost:1234${'/'}_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}` } });
    const quiet = await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/notes.md' });
    const busy = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    tabs.activity(busy);   // 触った
    tabs.event({ type:'page:changed', sessionId:'s1', path:'D:/w/notes.md' });
    assert.equal(quiet.reload, 1, '触っていないファイルは自動で読み直す');
    tabs.event({ type:'page:changed', sessionId:'s1', path:'D:/w/a.html' });
    assert.equal(busy.reload, undefined); assert.equal(busy.pending, true, '触ったページは読み直さず「更新を表示」');
    tabs.event({ type:'page:changed', sessionId:'s1', path:'D:/w/other.md' });
    t.ok('変化の知らせ: 未操作は自動更新・操作後は更新を待たせる（決定 5）', quiet.reload === 1 && busy.pending);

    const before = busy.url;
    tabs.event({ type:'page:moved', ports:{ pages:5001, isolated:5002 }, previous:{ pages:[1234], isolated:[2345] } });
    assert.equal(new URL(busy.url).port, '5002', '隔離の port が替わると残ったタブの URL を付け替える');
    assert.equal(busy.pending, true, '触ったままなら付け替えても更新を待たせる');
    assert.equal(quiet.url, `${ORIGIN}/_pleiad/s/s1/file?path=${encodeURIComponent('D:/w/notes.md')}`, '本体の出どころのページは port の付け替えの対象外');
    const fresh = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    tabs.event({ type:'page:moved', ports:{ pages:5001, isolated:5002 }, previous:{ pages:[1234], isolated:[2345] } });
    assert.equal(fresh.url, before.replace(':2345/', ':5002/')); assert.equal(fresh.reload, 1, '触っていないタブは付け替えて読み直す');
    t.ok('port の移行: port は張り直し、触った判定も見る（N2: スクロールで触ったページも勝手に読み直さない）', true);
  }

  // ---- reissue（期限切れ・再起動のあとの鍵と見張りの取り直し） ----
  {
    const requests = [];
    const { tabs, errors } = setup({ pageOpen: async request => { requests.push(request);
      if (request.path === 'D:/w/gone.html') throw Object.assign(new Error('not found'), { code:'NOT_FOUND' });
      return { kind:request.kind === 'viz' ? 'viz' : 'html', url:`http://f0123456789abcde.localhost:5002/f/${'N'.repeat(43)}/a.html`, path:request.path,
        ...(request.kind === 'viz' ? { hash:request.hash, entry:request.entry } : {}) };
    } });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', url:`http://f0123456789abcde.localhost:2345/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' });
    await tabs.reissue(tab);
    assert.equal(requests.at(-1).kind, 'html'); assert.equal(requests.at(-1).path, 'D:/w/a.html');
    assert.equal(tab.url, `http://f0123456789abcde.localhost:5002/f/${'N'.repeat(43)}/a.html`, '新しい鍵の URL へ張り替わる');
    assert.equal(tab.reload, 1, '触っていなければ取り直したら読み直す');
    const viz = await tabs.open({ sessionId:'s1', kind:'viz', url:`http://v${VIZ_HASH.slice(0, 24)}.localhost:2345/viz/${VIZ_HASH}/index.html` });
    viz.page = { kind:'viz', vizHash:VIZ_HASH, entry:'index.html', path:'D:/w/chart.html' };
    await tabs.reissue(viz);
    assert.equal(requests.at(-1).kind, 'viz'); assert.equal(requests.at(-1).hash, VIZ_HASH); assert.equal(requests.at(-1).path, 'D:/w/chart.html');
    const broken = await tabs.open({ sessionId:'s1', kind:'html', url:`http://f0123456789abcde.localhost:2345/f/${'K'.repeat(43)}/gone.html`, path:'D:/w/gone.html' });
    await assert.rejects(tabs.reissue(broken), /not found/);
    tabs.event({ type:'page:moved', ports:{ pages:5001, isolated:5002 }, previous:{ pages:[1234], isolated:[9999] } });   // broken は前の port に合わない → 取り直しを試す
    await new Promise(resolve => setTimeout(resolve, 10));
    t.ok('鍵の取り直し: 触っていなければ読み直す。失敗は原因を画面へ返す（N2）',
      errors.length === 1 && errors[0][0] === 'NOT_FOUND');
  }

  // ---- 文書の中の履歴（histGo。親が URL を出し、枠の中の history には頼らない。指摘 1） ----
  {
    const { tabs } = setup({ pageOpen: async () => ({ kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    const A = tab.url, B = `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/b.html`, C = `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/c.html`;
    tabs.locate(tab, { url:B }); tabs.locate(tab, { url:C });
    assert.equal(tabs.histGo(tab, -1), B, '戻るは文書の中の履歴の前の場所の URL を返す');
    assert.equal(tab.url, B); assert.equal(tab.canGoBack, true); assert.equal(tab.canGoForward, true);
    assert.equal(tabs.histGo(tab, -1), A);
    assert.equal(tabs.histGo(tab, -1), null, '文書の中の履歴の先頭より前は返さない（外の履歴へ任せる）');
    assert.equal(tabs.histGo(tab, 1), B); assert.equal(tabs.histGo(tab, 1), C);
    assert.equal(tabs.histGo(tab, 1), null);
    // # の違いだけの移動も履歴に足る（hash を書き換えるページ。指摘 2）
    tabs.locate(tab, { url:`${C}#section` });
    assert.equal(tabs.histGo(tab, -1), C);
    // 原文は履歴に足す: 戻るとプレビューの URL へ戻れる（原文の文書には橋が無い。指摘 8）
    tabs.view(tab, 'source');
    assert.equal(tab.view, 'source'); assert.equal(tab.canGoBack, true);
    assert.equal(tabs.histGo(tab, -1), C);
    assert.equal(tab.view, 'preview', '戻った先が原文でなければ出し方も戻る');
    // 別の文書へ移る（travel・replace）と文書の中の履歴は張り直す（前の文書の場所を残さない）
    await tabs.open({ sessionId:'s1', kind:'git' }, tab);
    tabs.travel(tab, -1);
    assert.equal(tab.url, C, 'travel は前の文書の最後の場所へ戻る');
    assert.equal(tabs.histGo(tab, -1), null, '別の文書の中の履歴を混ぜない');
    t.ok('文書の中の履歴は親が持ち、# の違い・原文・文書の切り替えをそれぞれ正しく捌く', true);
  }

  // ---- 同じ文書の中の報告（sameDocument）は履歴に積まず置き換え、触った印を消さない（指摘 2） ----
  {
    const { tabs } = setup({ pageOpen: async () => ({ kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    const B = `http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/b.html`;
    tabs.locate(tab, { url:B });
    tabs.activity(tab);                        // 入力を打った印
    tab.pending = true;
    const marked = `${B}#q=%E3%81%82`;
    tabs.locate(tab, { url:marked, sameDocument:true });   // replaceState('#q=…') の報告
    assert.equal(tab.url, marked, 'アドレスは今の場所を映す');
    assert.equal(tab.histTrail.length, 2, '履歴には積まない（押せる「戻る」の偽物を生まない）');
    assert.equal(tabs.histPeek(tab, -1), tab.histTrail[0], '戻る先は前の文書の場所');
    assert.equal(tab.touched, true, '触った印は消さない');
    assert.equal(tab.pending, true, '「更新を表示」の印も消さない');
    assert.equal(tab.reload, undefined, '読み直しも起きない');
    t.ok('sameDocument の報告は、その場の URL を書き換えるだけで履歴・印・読み直しを動かさない', true);
  }

  // ---- reissue は URL が変わらなければ読み直さない（指摘 9） ----
  {
    const { tabs } = setup({ pageOpen: async () => ({ kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    await tabs.reissue(tab);
    assert.equal(tab.reload, undefined, '同じ URL が返れば読み直さない（つなぎ直しで触っていないタブを毎回読み直さない）');
    assert.equal(tab.page.path, 'D:/w/a.html');
    t.ok('reissue: 鍵が生きて同じ URL なら枠はそのまま（見張りはサーバーが戻す）', true);
  }

  // ---- 外の URL のタブ（kind:'web'）は変化の知らせを捌かない（指摘 5） ----
  {
    const { tabs } = setup({ pageOpen: async () => ({ kind:'html', url:`http://f0123456789abcde.localhost:9999/f/${'K'.repeat(43)}/a.html`, path:'D:/w/a.html' }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'html', path:'D:/w/a.html' });
    tab.page = { kind:'web' };   // Chrome のタブが外の URL へ移った印（syncLinkedPage が立てる）
    tabs.event({ type:'page:changed', sessionId:'s1', path:'D:/w/a.html' });
    tabs.event({ type:'page:changed', sessionId:'s1', path:'D:/w/a.html' });
    assert.equal(tab.reload, undefined, 'page を持たないタブで page:changed が落ちない');
    tab.page = null;
    tabs.event({ type:'page:changed', sessionId:'s1', path:'D:/w/a.html' });
    assert.equal(tab.reload, undefined, 'page が null でも落ちない');
    t.ok('外の URL のタブ（page なし・kind:web）は変化の知らせを捌かない', true);
  }

  // ---- 閉じたタブの見張りを外す（N6） ----
  {
    const { tabs, releases } = setup({ pageOpen: async request => ({ kind:'file', path:request.path, suffix:`/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}` }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/notes.md' });
    tabs.close(tab);
    assert.equal(releases.length, 1); assert.equal(releases[0], tab); assert.equal(tabs.list('s1').length, 0);
    t.ok('タブを閉じると release（→ pageWatch）でファイルの見張りを外す', true);
  }

  // ---- pleiadPage: Chrome のタブをアプリのページと分ける（P9） ----
  {
    const requests = [];
    const { tabs } = setup({ pageOpen: request => new Promise(resolve => {
      requests.push(request);
      setTimeout(() => resolve({ kind:'file', path:request.path, suffix:`/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}` }), request.path.endsWith('a.md') ? 15 : 1);
    }) });
    const [a, b] = await Promise.all([
      tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/a.md' }),
      tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/b.md' }),
    ]);
    assert.equal(requests[0].tab, a.targetId);
    assert.equal(requests[1].tab, b.targetId);
    assert.notEqual(a.targetId, b.targetId);
    t.ok('同時に開いたタブは pageOpen の所有者番号と一致する', requests[0].tab === a.targetId && requests[1].tab === b.targetId && a.targetId !== b.targetId);
  }

  {
    const { tabs, releases } = setup({ pageOpen:async request => ({ kind:'file', path:request.path,
      suffix:`/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}` }) });
    const tab = await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/a.md' });
    await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/b.md' }, tab);
    assert.equal(releases.length, 1);
    assert.equal(releases[0], tab);
    tabs.close(tab);
    assert.equal(releases.length, 2);
    t.ok('同じタブで別ファイルへ移ると前の見張りを外し、閉じると現在の見張りも外す', releases.length === 2 && releases.every(item => item === tab));
  }

  {
    const watch = createPageWatch({ watch:() => ({ close() {} }) });
    const tabs = createPageTabs({ origin:ORIGIN,
      pageOpen:async request => { watch.add(request.sessionId, request.path, 'file', `screen:1/${request.tab}`);
        return { kind:'file', path:request.path, suffix:`/_pleiad/s/${request.sessionId}/file?path=${encodeURIComponent(request.path)}` }; },
      release:tab => watch.remove(tab.sessionId, tab.page.path, 'file', `screen:1/${tab.targetId}`) });
    const first = await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/first.md' });
    assert.equal(watch.stats().targets, 1);
    tabs.close(first);
    assert.equal(watch.stats().targets, 0);
    const second = await tabs.open({ sessionId:'s1', kind:'file', path:'D:/w/second.md' });
    assert.equal(watch.stats().targets, 1);
    watch.removeClient('screen:1');
    assert.equal(watch.stats().targets, 0);
    t.ok('タブを閉じる操作と画面終了の両方で実際の見張り数が 0 になる', watch.stats().targets === 0);
    tabs.close(second);
    watch.close();
  }

  {
    const ports = { pages:8000, isolated:9000 };
    assert.equal(pleiadPage(`http://localhost:9000/viz/${VIZ_HASH}/index.html`, 's1', ports)?.kind, 'viz');
    assert.equal(pleiadPage(`http://localhost:9000/viz/${VIZ_HASH}/index.html`, 's1', ports)?.hash, VIZ_HASH);
    assert.equal(pleiadPage(`http://localhost:9000/f/${'K'.repeat(43)}/a.html`, 's1', ports)?.kind, 'html');
    assert.equal(pleiadPage(`http://v${VIZ_HASH.slice(0, 24)}.localhost:9000/viz/${VIZ_HASH}/index.html`, 's1', ports)?.kind, 'viz');
    assert.equal(pleiadPage(`http://f0123456789abcde.localhost:9000/f/${'K'.repeat(43)}/a.html?title=%E5%9B%B3`, 's1', ports)?.title, '図');
    assert.equal(pleiadPage(`http://f0123456789abcde.localhost:9000/f/${'K'.repeat(43)}/a.html?title=%E5%9B%B3`, 's1', ports)?.kind, 'html');
    assert.equal(pleiadPage('http://localhost:9000/viz/' + 'x'.repeat(64) + '/index.html', 's1', ports), null, '16 進でない束はアプリのページではない');
    assert.equal(pleiadPage('http://localhost:8001/viz/' + VIZ_HASH + '/index.html', 's1', ports), null, '隔離でない port はアプリのページではない');
    assert.equal(pleiadPage('https://example.test/viz/' + VIZ_HASH + '/index.html', 's1', ports), null);
    t.ok('Chrome のタブは、印の出どころと直書き localhost の隔離 port の両方で可視化・HTML と分かる（P9。スマホの中継・デバッグの形）', true);
  }
}
