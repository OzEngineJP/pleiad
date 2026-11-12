// 右の欄のファイルの読み直し（ADR 0320）: 開き直すと読み直す・入力のあるタブは「更新を表示」・
// 見ていない間に変わったファイルへの追いつき（版の印）・変わっていないタブは読み直さない・新しいタブの件数が変更のページと一致する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPageTabs } from '../../web/page-tabs.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';

export const name = 'browser-files-reread';
export const title = '右の欄のファイルの読み直し: 開き直し・入力のあるタブの帯・見ていない間の変化への追いつき・件数が変更のページと一致';

const ORIGIN = 'http://app.test';

function setup(stamps) {
  const opens = [];
  const tabs = createPageTabs({
    origin: ORIGIN,
    pageOpen: async (request) => {
      opens.push(request);
      const stamp = stamps[request.path];
      return { kind: request.kind === 'dir' ? 'dir' : 'file', path: request.path, stamp,
        suffix: `/_pleiad/s/s1/${request.kind === 'dir' ? 'dir' : 'file'}?path=${encodeURIComponent(request.path)}`,
        url: `${ORIGIN}/_pleiad/s/s1/${request.kind === 'dir' ? 'dir' : 'file'}?path=${encodeURIComponent(request.path)}` };
    },
    changed: () => {},
    release: () => {},
    onError: (error) => { throw error; },
  });
  return { tabs, opens };
}

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

export default async function (t) {
  // ---- refresh: 触っていないタブは読み直し、入力のあるタブは「更新を表示」だけ ----
  {
    const stamps = { 'D:/w/a.md': '1:10', 'D:/w/b.md': '2:20' };
    const { tabs } = setup(stamps);
    const plain = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/a.md' });
    const touchedOnly = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/b.md' });
    touchedOnly.touched = true;                                   // クリック・スクロールだけ（入力ではない）
    assert.equal(tabs.refresh(plain), true);
    assert.equal(plain.reload, 1, '開き直しは読み直す（reload が進む）');
    assert.equal(tabs.refresh(touchedOnly), true);
    assert.equal(touchedOnly.reload, 1, '触っただけのタブも読み直す（入力ではない）');
    assert.equal(touchedOnly.touched, false);
    const dirty = tabs.list('s1')[0]; dirty.dirty = true;
    const before = dirty.reload;
    assert.equal(tabs.refresh(dirty), false);
    assert.equal(dirty.reload, before, '入力のあるタブは読み直さない');
    assert.equal(dirty.pending, true, '入力のあるタブは「更新を表示」を出す');
    assert.equal(tabs.refresh({ local: false }), false, '外の URL のタブは対象外');
    t.ok('refresh: 触っていないタブ・触っただけのタブは読み直し、入力のあるタブだけ帯', true);
  }

  // ---- catchUp: 版の印で見ていない間の変化に追いつく ----
  {
    const stamps = { 'D:/w/same.md': '1:10', 'D:/w/changed.md': '2:20', 'D:/w/dirty.md': '3:30', 'D:/w/ghost.md': '4:40' };
    const { tabs, opens } = setup(stamps);
    const same = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/same.md' });
    const changed = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/changed.md' });
    const dirty = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/dirty.md' });
    const web = tabs.list('s1').length;
    assert.equal(web, 3);
    // 見ていない間に 2 つのファイルが変わった
    stamps['D:/w/changed.md'] = '2:99'; stamps['D:/w/dirty.md'] = '3:99';
    dirty.dirty = true;
    tabs.catchUp('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(opens.filter((r) => r.path === 'D:/w/same.md').length, 2, '印を比べるために開き直しの問い合わせは出す');
    assert.equal(same.reload, undefined, '版が変わっていないタブは読み直さない');
    assert.equal(changed.reload, 1, '版が変わって入力の無いタブは読み直す');
    assert.equal(changed.stamp, '2:99', '読み直した版を覚える');
    assert.equal(dirty.reload, undefined, '入力のあるタブは読み直さない');
    assert.equal(dirty.pending, true, '入力のあるタブは「更新を表示」');
    // もう一度追いついても、同じ版なら読み直さない（二重に読み直さない）
    tabs.catchUp('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changed.reload, 1, 'もう追いついた版は、もう一度見比べても読み直さない');
    t.ok('catchUp: 変わらない版は読み直さない・変わった版は読み直す・入力のあるタブは帯', true);
  }

  // ---- 見えている間の変化（page:changed）が運んだ印は、戻ったときの見比べで二重に読み直さない ----
  {
    const stamps = { 'D:/w/live.md': '1:10' };
    const { tabs } = setup(stamps);
    const tab = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/live.md' });
    stamps['D:/w/live.md'] = '1:50';
    tabs.event({ type: 'page:changed', sessionId: 's1', path: 'D:/w/live.md', stamp: '1:50' });
    assert.equal(tab.reload, 1, '触っていないタブは自動で読み直す');
    assert.equal(tab.stamp, '1:50', '知らせが運んだ版を、読み直した版として覚える');
    tabs.catchUp('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tab.reload, 1, '戻ったときの見比べで、すでに見せた版は読み直さない');
    tab.touched = true;
    tabs.event({ type: 'page:changed', sessionId: 's1', path: 'D:/w/live.md', stamp: '1:60' });
    assert.equal(tab.pending, true, '触っていれば帯を出す（今までどおり）');
    t.ok('page:changed の印: 見えている間の変化は今までどおり、戻ったときに二重に読み直さない', true);
  }

  // ---- 版の印を持たない古いサーバー: 今までの決めに戻る ----
  {
    const { tabs } = setup({});
    const tab = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/old.md' });
    tabs.catchUp('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tab.reload, undefined, '印が無く URL も同じなら読み直さない');
    tab.touched = true;
    tabs.catchUp('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tab.pending, true, '印が無いときは、触ったタブに帯（従来）');
    t.ok('印の無いサーバーとのつなぎ: 従来の決めに戻る', true);
  }

  // ---- reissue の応答を待つ間にタブが別のファイルへ移った・閉じた: 古い応答で巻き戻さない ----
  {
    const gate = {};
    const hold = () => new Promise((resolve) => { gate.release = resolve; });
    let wait = null;
    const tabs = createPageTabs({
      origin: ORIGIN,
      pageOpen: async (request) => {
        const mine = wait; wait = null;                                    // 次の 1 回の問い合わせだけを止める
        if (mine) await mine;
        return { kind: 'file', path: request.path, stamp: '9:9',
          suffix: `/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}`,
          url: `${ORIGIN}/_pleiad/s/s1/file?path=${encodeURIComponent(request.path)}` };
      },
      changed: () => {}, release: () => {}, onError: (error) => { throw error; },
    });
    const moved = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/first.md' });
    const urlBefore = moved.url;
    wait = hold();
    const pending = tabs.reissue(moved);                                   // 応答を待っている
    await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/second.md' }, moved);   // その間に別のファイルへ移った（置き換え）
    const urlAfterMove = moved.url;
    assert.notEqual(urlAfterMove, urlBefore);
    gate.release(); await pending;
    assert.equal(moved.url, urlAfterMove, '移った後に届いた古い応答で、前のファイルの URL へ巻き戻さない');
    assert.equal(moved.page.path, 'D:/w/second.md');

    const closing = await tabs.open({ sessionId: 's1', kind: 'file', path: 'D:/w/third.md' });
    wait = hold();
    const pendingClose = tabs.reissue(closing);
    tabs.close(closing);
    const reloadBefore = closing.reload;
    gate.release(); await pendingClose;
    assert.equal(closing.reload, reloadBefore, '閉じた後に届いた応答では何も起こさない（読み直しも増えない）');
    assert.equal(tabs.list('s1').includes(closing), false);
    t.ok('reissue: 待つ間に別のファイルへ移った・閉じたタブへ、古い応答を当てない', true);
  }

  // ---- 新しいタブの件数は、変更のページの total.files と一致する（一時リポジトリ） ----
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-reread-count-')));
  try {
    const repo = path.join(scratch, 'repo');
    await fs.mkdir(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    const w = (file, text) => fs.writeFile(path.join(repo, file), text);
    await fs.mkdir(path.join(repo, 'sub'));
    await w('keep.txt', 'keep\n'); await w('mod.txt', 'a\n'); await w('gone.txt', 'x\n'); await w('rename-me.txt', 'same content\nline2\nline3\n'); await w('sub/in.txt', '1\n');
    await w('.gitignore', 'ignored.log\n');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init');
    const activity = createGitActivity();
    const agree = async (label) => {
      const count = await activity.changeCount(repo);
      const page = await activity.changes(repo, 'sess-count');
      assert.equal(count, page.total.files, `${label}: 件数 ${count} と変更のページ ${page.total.files}`);
      return count;
    };
    assert.equal(await agree('変更なし'), 0);
    await w('mod.txt', 'b\n');                                     // 変更
    await fs.rm(path.join(repo, 'gone.txt'));                      // 削除
    await w('new.txt', 'n\n');                                     // 未追跡
    await w('ignored.log', 'x\n');                                 // .gitignore は数えない
    await w('sub/new2.txt', 'n\n');                                // 入れ子の未追跡
    assert.equal(await agree('変更・削除・未追跡・ignore'), 4);
    sh(repo, 'add', 'mod.txt');                                    // ステージ済み
    await w('mod.txt', 'a\n');                                     // ステージ後に作業ツリーで元に戻した（HEAD と同じ内容）
    await agree('ステージ後に作業ツリーで戻した');
    await fs.rename(path.join(repo, 'rename-me.txt'), path.join(repo, 'renamed.txt')); // 名前の変更（削除 + 追加）
    sh(repo, 'add', '-A');
    await agree('名前の変更（ステージ済み）');
    sh(repo, 'commit', '-q', '-m', 'second');
    assert.equal(await agree('コミット直後'), 0);
    assert.equal(await activity.changeCount(path.join(scratch, 'not-a-repo-' + Date.now())), null, 'git 管理外は null');
    // 同時の問い合わせ（タブごとの新しいタブ・追いつき）は同じ 1 回の走りを待つ。終わった後は取り直す
    await w('shared.txt', '1\n');
    const [one, two, three] = await Promise.all([activity.changeCount(repo), activity.changeCount(repo), activity.changeCount(repo)]);
    assert.equal(one, 1); assert.equal(two, 1); assert.equal(three, 1);
    await w('shared2.txt', '2\n');
    assert.equal(await activity.changeCount(repo), 2, '前の走りが終わった後は、新しく数え直す（古い数を使い回さない）');
    t.ok('changeCount: 同時に 3 回呼んでも同じ数が返り、終わった後は数え直す（走りの共有そのものは数えない）', true);
    t.ok('changeCount: 一時リポジトリの 6 つの場面で変更のページの total.files と一致する', true);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
