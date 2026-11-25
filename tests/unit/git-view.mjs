// git の動きの画面の部品（web/git-view.mjs・web/git-panel.mjs の純粋な部分）。
// 文の組み立て（changeText・branchLabel・filesText）と、右パネルの枠の表（gitSlots）を、最小の DOM で見る。
// 返答の下の要約行と委譲カードの「変更」の行は ADR 0354 でやめた（web/git-view.mjs に残っていないこと）。
import assert from 'node:assert/strict';
import * as view from '../../web/git-view.mjs';
import { changeText, branchLabel, filesText } from '../../web/git-view.mjs';
import { applySlots, gitSlots } from '../../web/side-panel.mjs';

export const name = 'git-view';
export const title = 'git の動きの画面: 文の組み立て・右パネルの表（要約行・委譲の変更の行は無い）';

export default async function (t) {
  assert.equal(changeText(6, 2), '+6 −2'); assert.equal(changeText(18, 0), '+18', '削除が 0 なら −0 を出さない'); assert.equal(changeText(0, 3), '+0 −3');
  assert.equal(branchLabel({ branch: 'fix/x' }), 'fix/x'); assert.equal(branchLabel({ branch: null, head: '3f2a9c1' }), 'HEAD 3f2a9c1'); assert.equal(branchLabel({ branch: null, head: null }), '（コミットなし）');
  assert.equal(filesText({ files: 2, add: 6, del: 2 }), '2 ファイル +6 −2');
  t.ok('文: +a −d・ブランチ名（分離した HEAD・コミット前）・N ファイル', true);

  assert.deepEqual(Object.keys(view).sort(), ['branchLabel', 'changeText', 'filesText'], '返答の下の要約行・委譲カードの「変更」の行の部品（ADR 0354 で削除）は残っていない');
  t.ok('要約行・委譲の「変更」の行の部品は無い（ADR 0354）', true);

  // ---- 右パネルの表（gitSlots）
  const slots = gitSlots({ label: 'git', footer: ['custom0', 'custom1'] });
  assert.deepEqual(slots.head, ['close']); assert.deepEqual(slots.footer, ['custom0', 'custom1']);
  assert.deepEqual(gitSlots({ label: 'git', head: ['customHead0'], toolbar: ['customTool0'] }).head, ['customHead0', 'wide', 'close'], 'git パネルは頭に再読み込み・広げる・閉じる');
  assert.deepEqual(gitSlots({ label: 'chrome', wide: true }).head, ['wide', 'close'], 'wide だけのパネル（Chrome の窓）は頭に広げる・閉じる');
  assert.deepEqual(gitSlots({ label: 'x' }).head, ['close'], '何も頼まなければ閉じるだけ');
  assert.deepEqual(gitSlots({ label: 'git', toolbar: ['customTool0'] }).toolbar, ['customTool0'], '道具の列にタブ');
  assert.equal(slots.aside, false); assert.equal(slots.views, false); assert.deepEqual(slots.toolbar, []); assert.equal(gitSlots({ label: 'git' }).footer, null);
  const node = (tag = 'div') => document.createElement(tag);
  const buttons = Object.fromEntries(['close', 'custom0', 'custom1', 'reload', 'use'].map((id) => { const b = node('button'); b.textContent = id; return [id, b]; }));
  const parts = { panel: node('aside'), name: node('span'), kind: node('span'), path: node('div'), actions: node(), toolbar: node(), switcher: node(), tools: node(),
    location: node(), note: node(), treePane: node(), footer: node('footer'), footActions: node(), status: node('span'), content: node(), buttons };
  applySlots(parts, { ...slots, title: 'git', subtitle: 'D:/dev/pleiad', status: '12:40 に取得' });
  assert.deepEqual(parts.footActions.children.map((c) => c.textContent), ['custom0', 'custom1'], '下の行は渡した 2 つだけ（ファイルの reload・use ではない）');
  assert.equal(parts.footer.hidden, false); assert.equal(parts.treePane.hidden, true); assert.equal(parts.status.textContent, '12:40 に取得'); assert.equal(parts.path.textContent, 'D:/dev/pleiad');
  t.ok('右パネルの表: git は閉じる・本文・下の行（取得時刻と 2 つのボタン）だけ', true);
}
