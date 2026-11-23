// 設定 › プラグインのフォルダー別の設定（ADR 0348）で 4 タブがそろえて使う印（web/context-scope-marks.mjs）を DOM の代役で確かめる。
//   - フォルダー名（パスの最後）・「● 変更」「● 追加」・上のフォルダーの「website の設定」（押すとその場所へ）
//   - 「戻す」の読み上げ（上のフォルダー／全体の設定）・全体の行の「website で別の設定」「n か所で別の設定」
//   - 行の印の優先（追加 > 変更 > 受け継ぎ。全体の設定では何も付けない）
//   - 節の頭の「?」: 押すと開き、もう一度・Esc で閉じる。右端の要素
// 実ブラウザーの通しは tests/browser/context-tabs-and-lock-tip.mjs・hooks-matrix.mjs。
import { N } from '../lib/dom-stub.mjs';

export const name = 'context-scope-marks';
export const title = 'フォルダー別の設定の印: 変更・追加・上のフォルダー・戻す・別の設定・節の頭の「?」';

const nodes = (root) => [root, ...(root.children ?? []).flatMap(nodes)];
const has = (n, cls) => String(n.className ?? '').split(/\s+/).includes(cls);

export default async function (t) {
  const { lang: originalLanguage, setLanguage } = await import('../../web/i18n.mjs');
  const saved = { document: globalThis.document };
  const listeners = [];
  globalThis.document = {
    createElement: tag => new N(tag), createElementNS: (_ns, tag) => new N(tag),
    createTextNode: text => { const node = new N('span'); node.textContent = text; return node; },
    addEventListener: (type, fn) => listeners.push([type, fn]), removeEventListener() {}, querySelector: () => null,
  };
  try {
    await setLanguage('ja');
    const m = await import('../../web/context-scope-marks.mjs');

    t.ok('フォルダー名はパスの最後（区切り・末尾の区切りによらない）',
      m.placeName('D:\\dev\\website') === 'website' && m.placeName('/srv/work/site/') === 'site' && m.placeName('C:\\') === 'C:' && m.placeName(null) === '');

    const changed = m.overrideBadge('changed'), added = m.overrideBadge('added');
    t.ok('「● 変更」「● 追加」の札（.ovb）', has(changed, 'ovb') && changed.textContent.includes('変更') && added.textContent.includes('追加'),
      [changed.textContent, added.textContent]);

    const went = [];
    const link = m.parentLink('D:\\dev\\website', p => went.push(p));
    let stopped = false;
    link.onclick({ stopPropagation: () => { stopped = true; } });
    t.ok('上のフォルダーの印は「website の設定」で、押すとその場所へ移る（行の開閉へは伝えない）',
      has(link, 'ovp') && link.textContent === 'website の設定' && link.getAttribute('aria-label') === 'website の設定を開く'
      && went[0] === 'D:\\dev\\website' && stopped, link.textContent);

    let reverted = 0;
    const toGlobal = m.revertButton({ name: 'AGENTS.md', onRevert: () => reverted++, key: 'rv:a' });
    const toParent = m.revertButton({ parent: 'D:\\dev\\website', name: 'AGENTS.md' });
    toGlobal.onclick({ stopPropagation() {} });
    t.ok('「戻す」は戻り先を読み上げる（上のフォルダーが無ければ全体の設定）',
      has(toGlobal, 'tbtn') && has(toGlobal, 'rv') && toGlobal.textContent === '戻す'
      && toGlobal.getAttribute('aria-label') === 'AGENTS.md を全体の設定に戻す'
      && toParent.getAttribute('aria-label') === 'AGENTS.md を website の設定に戻す'
      && toGlobal.dataset.cxFk === 'rv:a' && reverted === 1,
      [toGlobal.getAttribute('aria-label'), toParent.getAttribute('aria-label')]);

    t.ok('全体の設定の行の注記: 1 か所は名前、2 か所以上は数、無ければ空',
      m.elsewhereText(['D:\\dev\\website']) === 'website で別の設定'
      && m.elsewhereText(['D:\\a', 'D:\\b', 'D:\\c']) === '3 か所で別の設定'
      && m.elsewhereText([]) === '' && m.elsewhereText(undefined) === '',
      m.elsewhereText(['D:\\a', 'D:\\b', 'D:\\c']));

    const marks = (mark, place = 'D:\\dev\\website\\app') => m.rowMarks(mark, { place }).map(n => n.textContent);
    t.ok('行の印は 1 つだけ: 追加 > 変更 > 上のフォルダーの設定',
      JSON.stringify(marks({ added: true, changedHere: true, ruleFrom: 'D:\\dev\\website' })) === JSON.stringify(['追加'])
      && JSON.stringify(marks({ changedHere: true, ruleFrom: 'D:\\dev\\website' })) === JSON.stringify(['変更'])
      && JSON.stringify(marks({ ruleFrom: 'D:\\dev\\website' })) === JSON.stringify(['website の設定'])
      && marks({}).length === 0);
    t.ok('全体の設定（place が無い）では行に印を付けない', marks({ changedHere: true }, null).length === 0 && m.rowMarks(null, { place: 'D:\\x' }).length === 0);

    const right = new N('span');
    const head = m.sectionHead('スキャン場所', { tip: 'エージェントが読み込む場所です。', right: [right] });
    const q = nodes(head).find(n => has(n, 'qtip'));
    const tip = nodes(head).find(n => has(n, 'tip'));
    t.ok('節の頭: 見出し・「?」（説明とひも付け）・右端の要素',
      has(head, 'cx-sec') && q && tip && q.getAttribute('aria-describedby') === tip.id && tip.getAttribute('role') === 'tooltip'
      && q.getAttribute('aria-label') === 'スキャン場所について' && nodes(head).some(n => has(n, 'r') && n.children.includes(right)));
    q.onclick({ stopPropagation() {} });
    const openNow = has(tip, 'on') && q.getAttribute('aria-expanded') === 'true';
    q.onclick({ stopPropagation() {} });
    const closedByClick = !has(tip, 'on') && q.getAttribute('aria-expanded') === 'false';
    q.onclick({ stopPropagation() {} });
    let prevented = false;
    q.matches = () => false;
    q.onkeydown({ key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation() {} });
    t.ok('「?」は押すと開き、もう一度押す・Esc で閉じる', openNow && closedByClick && !has(tip, 'on') && prevented && q.getAttribute('aria-expanded') === 'false');
    t.ok('説明の無い節の頭には「?」を付けない', !nodes(m.sectionHead('ユーザースコープの指示')).some(n => has(n, 'qtip')));
    t.ok('外を押すと閉じるための受け口を 1 つだけ足す', listeners.filter(([type]) => type === 'pointerdown').length === 1);
  } finally {
    globalThis.document = saved.document;
    await setLanguage(originalLanguage);
  }
}
