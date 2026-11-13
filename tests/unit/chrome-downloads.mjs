import { createChromeDownloads, DOWNLOADS_KEPT, DOWNLOAD_WAIT_MAX_SECONDS } from '../../core/chrome/downloads.mjs';
import { TAB_EVENTS } from '../../core/chrome/relay.mjs';
import { USER_TABS } from '../lib/fake-chrome-browser.mjs';
import { agent, rig } from '../lib/chrome-relay-rig.mjs';

export const name = 'chrome-downloads';
export const title = '会話の Chrome のウィンドウのダウンロード: 会話のタブで始まったものだけ記録する・画面へ知らせる・止める・エージェントの命令は断る（偽の Chrome。ADR 0328）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

export default async function (t) {
  // ===== 1. 記録（core/chrome/downloads.mjs）だけの試験 =====
  {
    const emitted = [], settled = [];
    let clock = 1000;
    const d = createChromeDownloads({ emit: (type, payload) => emitted.push({ type, ...payload }), now: () => clock });
    d.onSettled(event => settled.push(event));
    t.ok('始まりを記録して、すぐ画面へ出す（進行中・止められる）', d.begin({ sessionId: 'one', guid: 'g1', name: 'report.zip', pageUrl: 'https://site.example/files', context: 'CTX-A' }) === true
      && emitted.length === 1 && emitted[0].type === 'tab:downloads' && emitted[0].sessionId === 'one'
      && JSON.stringify(emitted[0].downloads) === JSON.stringify([{ id: 'g1', name: 'report.zip', state: 'downloading', received: 0, total: 0, path: null, startedAt: 1000, stoppable: true }]), JSON.stringify(emitted));
    t.ok('同じ guid の 2 回目・guid や会話の無い始まりは記録しない', d.begin({ sessionId: 'one', guid: 'g1', name: 'again.zip' }) === false && d.begin({ sessionId: '', guid: 'g9' }) === false && d.begin({ sessionId: 'one', guid: '' }) === false && d.list('one').length === 1);
    t.ok('知らない guid の進み具合は false（利用者自身のダウンロード）', d.progress({ guid: 'other', receivedBytes: 1, totalBytes: 2, state: 'inProgress' }) === false && emitted.length === 1);
    d.progress({ guid: 'g1', receivedBytes: 10, totalBytes: 100, state: 'inProgress' });
    d.progress({ guid: 'g1', receivedBytes: 20, totalBytes: 100, state: 'inProgress' });
    t.ok('進み具合だけの変化は、すぐには出さずにまとめる', emitted.length === 1 && d.screen('one')[0].received === 20);
    t.ok('まとめた進み具合を、少し後に 1 回で出す', await until(() => emitted.length === 2) && emitted[1].downloads[0].received === 20 && emitted[1].downloads[0].total === 100, JSON.stringify(emitted.at(-1)));
    clock = 2000;
    d.begin({ sessionId: 'one', guid: 'g2', name: '', pageUrl: 'https://site.example/files' });
    t.ok('新しい順に並ぶ。名前の無いものは download', d.screen('one').map(x => x.id).join() === 'g2,g1' && d.screen('one')[0].name === 'download');
    const waiting = d.wait('one', 30);
    let woke = false; waiting.then(() => { woke = true; });
    d.progress({ guid: 'g1', receivedBytes: 100, totalBytes: 100, state: 'completed', filePath: 'C:\\Users\\u\\Downloads\\report.zip' });
    await sleep(20);
    t.ok('終わったら completed と保存したパスを持ち、決着を知らせる', d.screen('one')[1].state === 'completed' && d.screen('one')[1].path === 'C:\\Users\\u\\Downloads\\report.zip' && d.screen('one')[1].stoppable === false
      && settled.length === 1 && settled[0].sessionId === 'one' && settled[0].download.id === 'g1' && settled[0].download.state === 'completed', JSON.stringify(settled));
    t.ok('wait は、進行中のものが残っている間は解けない', woke === false);
    d.progress({ guid: 'g2', receivedBytes: 5, totalBytes: 0, state: 'canceled' });
    await sleep(20);
    t.ok('Chrome が canceled を返したものは failed（Pleiad から止めたものではない）。wait が解ける', d.screen('one')[0].state === 'failed' && settled.at(-1).download.state === 'failed' && woke === true);
    t.ok('決着した後に届いた進み具合では変わらない', d.progress({ guid: 'g2', receivedBytes: 9, totalBytes: 9, state: 'completed', filePath: 'x' }) === true && d.screen('one')[0].state === 'failed' && settled.length === 2);
    t.ok('エージェントへ返す形（状態・名前・量・終わったもののパス・始まったページ・始まった時刻）', JSON.stringify(d.list('one')) === JSON.stringify([
      { id: 'g2', state: 'failed', name: 'download', receivedBytes: 5, totalBytes: 0, pageUrl: 'https://site.example/files', startedAt: new Date(2000).toISOString() },
      { id: 'g1', state: 'completed', name: 'report.zip', receivedBytes: 100, totalBytes: 100, path: 'C:\\Users\\u\\Downloads\\report.zip', pageUrl: 'https://site.example/files', startedAt: new Date(1000).toISOString() },
    ]), JSON.stringify(d.list('one')));
    t.ok('画面へ出す形に、始まったページの URL は載せない', emitted.every(e => !JSON.stringify(e).includes('site.example')));
    t.ok('進行中の無い会話・0 秒の wait はすぐ解ける', await Promise.race([Promise.all([d.wait('one', 30), d.wait('none', 30), d.wait('one', 0)]).then(() => true), sleep(200).then(() => false)]));

    // 止める: 止める命令の後の canceled は canceled。断られたら、以後止められないものとして出す
    d.begin({ sessionId: 'one', guid: 'g3', name: 'big.iso', context: 'CTX-A' });
    t.ok('running は、その会話の進行中のものだけを返す', JSON.stringify(d.running('one', 'g3')) === JSON.stringify({ guid: 'g3', context: 'CTX-A' }) && d.running('two', 'g3') === null && d.running('one', 'g1') === null && d.running('one', 'nope') === null);
    d.stopping('g3', true);
    d.progress({ guid: 'g3', receivedBytes: 1, totalBytes: 9, state: 'canceled' });
    t.ok('Pleiad から止めたものは canceled', d.screen('one')[0].state === 'canceled' && settled.at(-1).download.state === 'canceled');
    d.begin({ sessionId: 'one', guid: 'g4', name: 'big2.iso', context: 'CTX-A' });
    d.stopping('g4', true); d.stopping('g4', false);
    t.ok('止める命令を断られたものは、進行中のまま止められないものとして出し直す', d.screen('one')[0].state === 'downloading' && d.screen('one')[0].stoppable === false && emitted.at(-1).downloads[0].stoppable === false);
    d.progress({ guid: 'g4', receivedBytes: 1, totalBytes: 9, state: 'canceled' });
    t.ok('断られた後に Chrome が canceled を返したら failed', d.screen('one')[0].state === 'failed');

    // 既定の context: そのプロフィールが既定のときだけ止められる
    d.begin({ sessionId: 'one', guid: 'g5', name: 'a.bin', context: 'CTX-A' });
    d.begin({ sessionId: 'two', guid: 'g6', name: 'b.bin', context: 'CTX-B' });
    d.begin({ sessionId: 'two', guid: 'g7', name: 'c.bin', context: null });
    const before = emitted.length;
    d.setDefaultContext('CTX-A');
    t.ok('既定の context が分かったら、既定でないプロフィールのものは止められない（変わった会話にだけ出し直す）', d.screen('one')[0].stoppable === true && d.screen('two').find(x => x.id === 'g6').stoppable === false
      && d.screen('two').find(x => x.id === 'g7').stoppable === true && emitted.length === before + 1 && emitted.at(-1).sessionId === 'two', JSON.stringify(emitted.slice(before)));
    d.setDefaultContext('CTX-B');
    t.ok('既定の context が替わったら、止められるものも替わる', d.screen('one')[0].stoppable === false && d.screen('two').find(x => x.id === 'g6').stoppable === true);
    d.setDefaultContext(null);
    t.ok('既定の context が分からない間は、止められるものとして扱う', d.screen('one')[0].stoppable === true && d.screen('two').every(x => x.stoppable));

    // 接続が切れた: 進行中のものは unknown（画面には出さない）。同じ guid の進み具合が届いたら戻る
    const waitingTwo = d.wait('two', 30);
    d.disconnected();
    t.ok('接続が切れたら、進行中のものは unknown になり、画面の一覧から外れる', d.list('one')[0].state === 'unknown' && !d.screen('one').some(x => x.id === 'g5') && d.screen('two').length === 0
      && d.list('two').every(x => x.state === 'unknown') && settled.every(e => e.download.state !== 'unknown'));
    t.ok('接続が切れたら wait は解ける', await Promise.race([waitingTwo.then(() => true), sleep(200).then(() => false)]));
    t.ok('unknown は止められない（running に出ない）', d.running('one', 'g5') === null);
    d.progress({ guid: 'g5', receivedBytes: 3, totalBytes: 9, state: 'inProgress' });
    t.ok('つなぎ直した後に同じ guid の進み具合が届いたら、進行中に戻してすぐ出す', d.screen('one')[0].id === 'g5' && d.screen('one')[0].state === 'downloading' && emitted.at(-1).sessionId === 'one' && emitted.at(-1).downloads[0].received === 3);
    d.progress({ guid: 'g6', receivedBytes: 9, totalBytes: 9, state: 'completed', filePath: 'D:\\b.bin' });
    t.ok('unknown のまま終わりが届いたら completed', d.list('two').find(x => x.id === 'g6').state === 'completed' && settled.at(-1).download.id === 'g6');

    // 会話の id が決まった・会話を消した
    d.begin({ sessionId: 'turn-key', guid: 'g8', name: 'k.bin' });
    const waitingKey = d.wait('turn-key', 30);
    d.rebind('turn-key', 'real');
    t.ok('rebind で、記録が新しい会話の id に移る', d.list('turn-key').length === 0 && d.list('real').map(x => x.id).join() === 'g8' && emitted.at(-1).sessionId === 'real' && emitted.at(-2).sessionId === 'turn-key' && emitted.at(-2).downloads.length === 0);
    d.progress({ guid: 'g8', receivedBytes: 1, totalBytes: 1, state: 'completed', filePath: 'D:\\k.bin' });
    t.ok('rebind の後の決着は、新しい会話の id で知らせ、移す前からの wait も解ける', settled.at(-1).sessionId === 'real' && await Promise.race([waitingKey.then(() => true), sleep(200).then(() => false)]));
    d.forget('real');
    t.ok('forget で、その会話の記録が消える（同じ guid の進み具合は知らないものになる）', d.list('real').length === 0 && d.progress({ guid: 'g8', receivedBytes: 1, totalBytes: 1, state: 'inProgress' }) === false);

    // 残す数
    const many = createChromeDownloads();
    for (let i = 0; i < DOWNLOADS_KEPT + 5; i += 1) { many.begin({ sessionId: 's', guid: `m${i}`, name: `f${i}` }); if (i !== 0) many.progress({ guid: `m${i}`, receivedBytes: 1, totalBytes: 1, state: 'completed', filePath: `D:\\f${i}` }); }
    const kept = many.list('s');
    t.ok(`会話ごとに ${DOWNLOADS_KEPT} 件まで残し、終わった古いものから捨てる（進行中のものは残す）`, kept.length === DOWNLOADS_KEPT && kept[0].id === `m${DOWNLOADS_KEPT + 4}` && kept.at(-1).id === 'm0' && kept.at(-1).state === 'downloading' && !kept.some(x => x.id === 'm1'), `${kept.length} ${kept[0]?.id} ${kept.at(-1)?.id}`);
    t.ok(`wait の上限は ${DOWNLOAD_WAIT_MAX_SECONDS} 秒`, DOWNLOAD_WAIT_MAX_SECONDS === 120);
    const ac = new AbortController();
    const aborted = many.wait('s', 30, ac.signal);
    ac.abort();
    t.ok('wait は、signal が引かれたら解ける', await Promise.race([aborted.then(() => true), sleep(200).then(() => false)]));
    t.ok('出来事の名前の一覧に tab:downloads がある', TAB_EVENTS.includes('tab:downloads'));
  }

  // ===== 2. 中継: 会話のタブで始まったものだけを拾う =====
  {
    const r = await rig();
    let a1, a2;
    try {
      const events = [], settled = [];
      r.relay.onTabEvent((type, payload) => { if (type === 'tab:downloads') events.push(payload); });
      r.relay.downloads.onSettled(event => settled.push(event));
      const url1 = await r.relay.endpoint('one');
      a1 = await agent(url1);
      await a1.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await a1.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const sid = (await a1.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      await a1.cmd('Page.navigate', { url: 'https://site.example/files' }, sid);
      t.ok('中継は、つないだら Chrome のいつもの保存先のまま（default）ダウンロードのイベントだけを受ける', await until(() => r.fake.downloadListeners() === 1)
        && JSON.stringify(r.fake.downloadBehaviors()) === JSON.stringify([{ behavior: 'default', eventsEnabled: true }]), JSON.stringify(r.fake.downloadBehaviors()));

      // 利用者のタブ・知らないフレームのダウンロードは記録しない
      const userTab = r.fake.targets().find(x => x.url === USER_TABS[1].url).targetId;
      const mine = r.fake.download(userTab, { url: 'https://bank.example/statement.pdf', name: 'statement-secret.pdf' });
      r.fake.downloadProgress(mine, { received: 5, total: 10 });
      r.fake.downloadProgress(mine, { received: 10, total: 10, state: 'completed', filePath: 'C:\\Users\\u\\Downloads\\statement-secret.pdf' });
      const stray = r.fake.download('0123456789ABCDEF0123456789ABCDEF', { name: 'stray-secret.bin' });
      r.fake.downloadProgress(stray, { received: 1, total: 1, state: 'completed', filePath: 'C:\\stray-secret.bin' });
      await sleep(150);
      t.ok('利用者のタブ・知らないフレームで始まったダウンロードは、記録せず画面へも出さない', r.relay.downloads.list('one').length === 0 && events.length === 0 && settled.length === 0, JSON.stringify(events));
      t.ok('利用者のダウンロードのファイル名・URL は、中継のログにも残らない', !r.logs.some(line => /secret|bank\.example/.test(line)), r.logs.join(' | '));

      // 主フレームのリンク
      const g1 = r.fake.download(tabId, { url: 'https://site.example/files/report.zip', name: 'report.zip' });
      t.ok('会話のタブの主フレームで始まったものを記録して、画面へ出す', await until(() => r.relay.downloads.screen('one').length === 1)
        && events.at(-1)?.sessionId === 'one' && events.at(-1).downloads[0].id === g1 && events.at(-1).downloads[0].name === 'report.zip' && events.at(-1).downloads[0].state === 'downloading' && events.at(-1).downloads[0].stoppable === true, JSON.stringify(events.at(-1)));
      r.fake.downloadProgress(g1, { received: 20, total: 48 });
      t.ok('進み具合が画面へ出る', await until(() => events.at(-1)?.downloads[0]?.received === 20 && events.at(-1).downloads[0].total === 48), JSON.stringify(events.at(-1)));
      const waited = r.relay.downloads.wait('one', 30);
      r.fake.downloadProgress(g1, { received: 48, total: 48, state: 'completed', filePath: 'C:\\Users\\u\\Downloads\\report.zip' });
      t.ok('終わったら、保存したパス付きで出て、決着を知らせ、wait が解ける', await until(() => settled.length === 1) && settled[0].sessionId === 'one' && settled[0].download.state === 'completed' && settled[0].download.path === 'C:\\Users\\u\\Downloads\\report.zip' && settled[0].download.total === 48
        && await Promise.race([waited.then(() => true), sleep(500).then(() => false)]), JSON.stringify(settled));
      t.ok('エージェントへ返す一覧に、始まったページの URL と保存したパスが載る', JSON.stringify(r.relay.downloads.list('one').map(x => [x.id, x.state, x.name, x.path, x.pageUrl, x.receivedBytes, x.totalBytes]))
        === JSON.stringify([[g1, 'completed', 'report.zip', 'C:\\Users\\u\\Downloads\\report.zip', 'https://site.example/files', 48, 48]]), JSON.stringify(r.relay.downloads.list('one')));

      // target=_blank・window.open: 開いてすぐ消えるタブ
      const blank = r.fake.windowOpen(tabId, 'https://site.example/files/blank.zip');
      const g2 = r.fake.download(blank, { url: 'https://site.example/files/blank.zip', name: 'blank.zip' });
      r.fake.closeTab(blank);
      t.ok('開いてすぐ消えるタブ（target=_blank）で始まったものも、開いた会話のものとして記録する（始まったページは開いた元）', await until(() => r.relay.downloads.list('one')[0]?.id === g2)
        && r.relay.downloads.list('one')[0].pageUrl === 'https://site.example/files', JSON.stringify(r.relay.downloads.list('one')[0]));

      // cross-site の iframe・同じ process の iframe・iframe の中の iframe
      const sessionsBefore = r.fake.sessions().length;
      const frame = await r.fake.crossSiteFrame(tabId, 'https://cdn.example/frame');
      const g3 = r.fake.download(frame, { url: 'https://cdn.example/a.zip', name: 'frame.zip' });
      t.ok('cross-site の iframe で始まったものを、親のタブの会話のものとして記録する', await until(() => r.relay.downloads.list('one')[0]?.id === g3));
      const inner = r.fake.sameProcessFrame(tabId, 'https://site.example/inner');
      const g4 = r.fake.download(inner, { url: 'https://site.example/b.zip', name: 'inner.zip' });
      t.ok('同じ process の iframe で始まったものを、フレームの木から引いて記録する', await until(() => r.relay.downloads.list('one')[0]?.id === g4));
      const nested = r.fake.sameProcessFrame(frame, 'https://cdn.example/nested');
      const g5 = r.fake.download(nested, { url: 'https://cdn.example/c.zip', name: 'nested.zip' });
      r.fake.downloadProgress(g5, { received: 7, total: 7, state: 'completed', filePath: 'C:\\Users\\u\\Downloads\\nested.zip' });
      t.ok('cross-site の iframe の中の iframe で始まったものも記録し、引いている間に届いた終わりも落とさない', await until(() => r.relay.downloads.list('one')[0]?.id === g5 && r.relay.downloads.list('one')[0].state === 'completed'), JSON.stringify(r.relay.downloads.list('one')[0]));
      t.ok('フレームを読むために付けたセッションは外してある', await until(() => r.fake.sessions().length === sessionsBefore), `${sessionsBefore} -> ${r.fake.sessions().length}`);

      // ほかの会話
      a2 = await agent(await r.relay.endpoint('two'));
      const tab2 = (await a2.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const g6 = r.fake.download(tab2, { name: 'two.zip' });
      t.ok('ほかの会話のタブのものは、その会話にだけ記録する', await until(() => r.relay.downloads.list('two')[0]?.id === g6) && !r.relay.downloads.list('one').some(x => x.id === g6) && events.at(-1).sessionId === 'two');
      t.ok('ダウンロードのイベントは、エージェントの接続には配らない', ![...a1.raw, ...a2.raw].some(text => /Browser\.download|report\.zip|two\.zip/.test(text)));

      // 止める
      t.ok('ほかの会話からは止められない（上りへ送らない）', (await r.relay.downloads.stop('one', g6)).stopped === false && r.fake.downloadState(g6) === 'inProgress' && !r.chrome.calls.some(c => c.method === 'Browser.cancelDownload'));
      t.ok('終わったもの・知らない id は止められない', (await r.relay.downloads.stop('one', g1)).stopped === false && (await r.relay.downloads.stop('one', 'nope')).stopped === false && !r.chrome.calls.some(c => c.method === 'Browser.cancelDownload'));
      const stopped = await r.relay.downloads.stop('two', g6);
      const cancel = r.chrome.calls.find(c => c.method === 'Browser.cancelDownload');
      t.ok('「ダウンロードを止める」は、そのタブのプロフィールを指して Browser.cancelDownload を送る', stopped.stopped === true && cancel?.params.guid === g6 && cancel.params.browserContextId === 'CTX-DEFAULT' && !cancel.sessionId, JSON.stringify(cancel));
      t.ok('止めたものは canceled になり、決着を知らせる', await until(() => r.relay.downloads.list('two')[0]?.state === 'canceled') && settled.at(-1).sessionId === 'two' && settled.at(-1).download.state === 'canceled');
      const g7 = r.fake.download(tabId, { name: 'broken.zip' });
      await until(() => r.relay.downloads.list('one')[0]?.id === g7);
      r.fake.downloadProgress(g7, { received: 3, total: 9, state: 'canceled' });
      t.ok('Chrome の側で止まったもの（失敗・人が Chrome で止めた）は failed', await until(() => r.relay.downloads.list('one')[0]?.state === 'failed') && settled.at(-1).download.state === 'failed');

      // 既定の context が、会話のタブのプロフィールでないとき
      r.fake.setDefaultContext('CTX-Profile 1');
      const g8 = r.fake.download(tabId, { name: 'other-default.zip' });
      t.ok('そのプロフィールが CDP の既定の context でない間は、止められないものとして出す', await until(() => events.at(-1)?.downloads[0]?.id === g8 && events.at(-1).downloads[0].stoppable === false), JSON.stringify(events.at(-1)?.downloads[0]));
      t.ok('止めようとしても止まらず、進行中のまま残る', (await r.relay.downloads.stop('one', g8)).stopped === false && r.fake.downloadState(g8) === 'inProgress' && r.relay.downloads.list('one')[0].state === 'downloading'
        && r.logs.some(line => line.includes('download stop failed')));
      r.fake.setDefaultContext('CTX-DEFAULT');

      // エージェントからの命令は、引き続き断る
      const denied = [await a1.cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:\\Users\\u\\secret', eventsEnabled: true }), await a1.cmd('Browser.cancelDownload', { guid: g8 }),
        await a1.cmd('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: 'C:\\x', eventsEnabled: true }, sid), await a1.cmd('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:\\x' }, sid)];
      t.ok('エージェントからの Browser.setDownloadBehavior・Browser.cancelDownload・Page.setDownloadBehavior は断る', denied.every(m => m.error), JSON.stringify(denied.map(m => m.error?.message ?? 'ok')));
      t.ok('断ったものは上りへ送っていない（上りへ届いた保存先の設定は、中継自身の 1 回だけ）', r.fake.downloadBehaviors().length === 1 && !r.chrome.calls.some(c => c.method === 'Page.setDownloadBehavior') && r.fake.downloadState(g8) === 'inProgress');

      // Chrome との接続が切れた
      r.chrome.dropConnections();
      t.ok('Chrome との接続が切れたら、進行中のものは unknown になり、画面の一覧から外れる', await until(() => r.relay.downloads.list('one')[0]?.state === 'unknown') && !r.relay.downloads.screen('one').some(x => x.id === g8)
        && events.at(-1).sessionId === 'one' && !events.at(-1).downloads.some(x => x.id === g8));
      t.ok('切れている間は止められない', (await r.relay.downloads.stop('one', g8)).stopped === false);
      await a1.closed;
      a1 = await agent(await r.relay.endpoint('one'));
      await a1.cmd('Target.getTargets');
      t.ok('つなぎ直したら、もう一度イベントを受ける', await until(() => r.fake.downloadListeners() === 1) && r.fake.downloadBehaviors().length === 2);
      r.fake.downloadProgress(g8, { received: 4, total: 9 });
      t.ok('つなぎ直した後に同じダウンロードの進み具合が届いたら、進行中に戻る', await until(() => r.relay.downloads.list('one')[0]?.state === 'downloading' && r.relay.downloads.screen('one')[0]?.id === g8));

      // 会話の id が決まった・会話を消した
      r.relay.rebind('two', 'two-real');
      t.ok('会話の id が替わったら、記録も移る', r.relay.downloads.list('two').length === 0 && r.relay.downloads.list('two-real')[0]?.id === g6);
      r.relay.forget('one');
      t.ok('会話を消したら、その会話の記録も消える', r.relay.downloads.list('one').length === 0 && r.relay.downloads.screen('one').length === 0);
    } finally {
      a1?.close(); a2?.close();
      await r.stop();
    }
  }

  // ===== 3. 断るときは、理由と次の手の文を返す（会話の言語の文は外から渡す） =====
  {
    const asked = [];
    const r = await rig({ downloadDeniedText: id => { asked.push(id); return 'DOWNLOAD-DENIED-TEXT'; } });
    let a;
    try {
      a = await agent(await r.relay.endpoint('one'));
      const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      const replies = [await a.cmd('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: 'C:\\work', eventsEnabled: true }),
        await a.cmd('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: 'C:\\work', eventsEnabled: true }, sid),
        await a.cmd('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:\\work' }, sid), await a.cmd('Browser.cancelDownload', { guid: 'x' })];
      t.ok('ダウンロードの命令を断るときは、渡された文（理由と次の手）を返す', replies.every(m => m.error?.message === 'DOWNLOAD-DENIED-TEXT') && asked.every(id => id === 'one') && asked.length === 4,
        JSON.stringify(replies.map(m => m.error?.message ?? 'ok')));
      const other = await a.cmd('Browser.close', {});
      t.ok('ほかの断る命令の字は変わらない', other.error?.message === 'browser command denied', JSON.stringify(other));
      t.ok('断った命令は上りへ送っていない', !r.chrome.calls.some(c => c.method === 'Page.setDownloadBehavior' || c.method === 'Browser.cancelDownload'
        || (c.method === 'Browser.setDownloadBehavior' && c.params?.behavior !== 'default')), JSON.stringify(r.chrome.calls.filter(c => /Download/.test(c.method))));
    } finally {
      a?.close();
      await r.stop();
    }
  }
}
