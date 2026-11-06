// 入力欄の書きかけのサーバーの写し（core/drafts.mjs・drafts.*。ADR 0157 の F35）: 保存・読む・空で消す・古い写しで上書きしない・画面の道具だけ。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markdownToDoc, caret, backspaceAtStart, docToMarkdown, snapshotEditing, restoreEditing } from '../../web/md-doc.mjs';
import { createDrafts } from '../../core/drafts.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'drafts-store';
export const title = '入力欄の書きかけのサーバーの写し: 保存・読む・空で消す・古い写しで上書きしない・画面の道具だけ';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drafts-store-'));
  const drafts = createDrafts({ dataDir: tmp });
  try {
    t.ok('無ければ null', drafts.load({ key: 'thread:c_1:p_1' }) === null);
    drafts.save({ key: 'thread:c_1:p_1', text: '書きかけ', at: 100 });
    t.ok('保存した本文と時刻を読める', drafts.load({ key: 'thread:c_1:p_1' })?.text === '書きかけ' && drafts.load({ key: 'thread:c_1:p_1' }).at === 100);
    t.ok('古い写しでは上書きしない', drafts.save({ key: 'thread:c_1:p_1', text: '古い', at: 50 }).saved === false && drafts.load({ key: 'thread:c_1:p_1' }).text === '書きかけ');
    drafts.save({ key: 'thread:c_1:p_1', text: '続き', at: 200 });
    t.ok('新しい写しで上書きする', drafts.load({ key: 'thread:c_1:p_1' }).text === '続き');
    drafts.save({ key: 'thread:c_1:p_1', text: '  ', at: 300 });
    t.ok('空にすると消える', drafts.load({ key: 'thread:c_1:p_1' }) === null);
    const deps = { locale: 'ja', drafts, audit: () => {} };
    const human = { by: 'human', via: 'ui', local: true };
    const saved = await registry.invoke(human, 'drafts.save', { key: 'k_1', text: 'あいう' }, deps);
    const loaded = await registry.invoke(human, 'drafts.load', { key: 'k_1' }, deps);
    t.ok('drafts.save・load は画面から使える', saved.ok && loaded.ok && loaded.result.text === 'あいう', JSON.stringify([saved, loaded]));
    const exited = backspaceAtStart({ blocks: markdownToDoc('> a\n> b'), sel: caret(1, 0) });
    const text = docToMarkdown(exited.blocks), editing = snapshotEditing(exited.blocks);
    const stored = await registry.invoke(human, 'drafts.save', { key: 'state', text, editing }, deps);
    const fresh = createDrafts({ dataDir: tmp });
    try {
      const d = fresh.load({ key: 'state' });
      t.ok('再接続した保存先でも編集境界と2行を復元できる', stored.ok && d.text === text && restoreEditing(d.text, d.editing).length === 2);
      const op = await registry.invoke(human, 'drafts.load', { key: 'state' }, { ...deps, drafts: fresh });
      t.ok('操作APIの往復でも編集情報を失わない', op.ok && JSON.stringify(op.result.editing) === JSON.stringify(editing));
      fresh.save({ key: 'invalid', text, editing: { ...editing, v: 99 } });
      t.ok('不明な版は本文を保存して編集情報のみ捨てる', fresh.load({ key: 'invalid' }).text === text && !fresh.load({ key: 'invalid' }).editing);
    } finally { fresh.close(); }
    const ai = await registry.invoke({ by: 'agent', via: 'cli', sessionId: 's1' }, 'drafts.load', { key: 'k_1' }, deps);
    t.ok('AI からは使えない（画面の道具）', !ai.ok);
    t.ok('MCP・CLI に出さない', ['drafts.save', 'drafts.load'].every((id) => registry.get(id).surfaces.mcp === false && !registry.get(id).surfaces.cli));
  } finally {
    drafts.close();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
