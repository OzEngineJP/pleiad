// 設定 › バージョンと更新 › リリースノート（web/release-notes.mjs）: 節の組み立て・畳み・ページング・本文の入れ方・作り直しの保ち方（DOM の代役）
import { N } from '../lib/dom-stub.mjs';
import { planNotes, createReleaseNotes, stripUnsafeLinks, FOLD_LIMIT, FOLD_SHOWN, PAGE } from '../../web/release-notes.mjs';

export const name = 'release-notes';
export const title = '設定 › リリースノート: 更新前・更新後・前の版が無いときの節・6 版までは全部・超えたら 5 版 +「ほか N」・古い版は 10 版ずつ・1 版は開く・本文は textContent / Markdown・作り直しで開いた行を保つ';

const rel = (version, extra = {}) => ({ version, date: '2026-11-01', title: `題 ${version}`, ...extra });
const nums = count => Array.from({ length: count }, (_, i) => rel(`1.${count - i}.0`));
const walk = (n, fn) => { fn(n); for (const c of n.children ?? []) walk(c, fn); };
const all = (n, fn) => { const out = []; walk(n, x => { if (fn(x)) out.push(x); }); return out; };
const heads = root => all(root, n => n.matches('.rn-head'));
const rows = root => all(root, n => n.matches('.rn-row'));
const buttonsLike = (root, re) => all(root, n => n.tagName === 'BUTTON' && n.matches('.rn-more') && re.test(n.textContent));
const metas = root => all(root, n => n.matches('.rn-meta')).map(n => n.textContent);
const groupHeads = root => all(root, n => n.matches('.rn-gh')).map(n => n.textContent);

export default async function (t) {
  const focused = [], scrolled = [];
  const focusOrig = N.prototype.focus, scrollOrig = N.prototype.scrollIntoView;
  N.prototype.focus = function () { focused.push(this); };
  N.prototype.scrollIntoView = function (arg) { scrolled.push({ node: this, arg }); };
  try {
    // ---- planNotes: 更新を見つけている間
    const bundled = [rel('1.2.0'), rel('1.1.0'), rel('1.0.0')];
    const info = { version: '1.2.0', releases: bundled };
    let plan = planNotes({ info, state: { version: '1.2.0', target: '1.4.0', releases: [rel('1.4.0', { body: 'x' }), rel('1.3.0', { body: 'y' }), rel('1.2.0', { body: 'z' })] } });
    t.ok('Available: groups are new versions then past versions', plan.groups.map(g => g.key).join() === 'skip,past');
    t.ok('Available: the new group holds versions after the installed one up to the target', plan.groups[0].rows.map(r => r.version).join() === '1.4.0,1.3.0');
    t.ok('Available: the past group is the bundled list', plan.groups[1].rows.length === 3 && plan.groups[1].past);
    t.ok('Available: two new versions are not auto-opened', plan.groups[0].open === false);
    plan = planNotes({ info, state: { version: '1.2.0', target: '1.3.0', releases: [rel('1.3.0', { body: 'y' })] } });
    t.ok('Available: a single new version is auto-opened', plan.groups[0].rows.length === 1 && plan.groups[0].open === true);
    plan = planNotes({ info, state: { version: '1.2.0', target: '1.3.0', releases: [], notes: '## 本文' } });
    t.ok('Available: an empty list falls back to the latest notes', plan.groups[0].rows.length === 1 && plan.groups[0].rows[0].body === '## 本文' && plan.groups[0].rows[0].version === '1.3.0');
    plan = planNotes({ info, state: { version: '1.2.0', target: '1.3.0', releases: [] } });
    t.ok('Available: no list and no notes falls back to the plain list', plan.groups.length === 1 && plan.groups[0].head === '');

    // ---- planNotes: 更新したあと
    plan = planNotes({ info, state: { version: '1.2.0', previousVersion: '1.0.0' } });
    t.ok('Updated: this update then earlier versions', plan.groups.map(g => g.key).join() === 'skip,past');
    t.ok('Updated: this update covers versions after the previous one', plan.groups[0].rows.map(r => r.version).join() === '1.2.0,1.1.0');
    t.ok('Updated: earlier versions are the previous one and older', plan.groups[1].rows.map(r => r.version).join() === '1.0.0');
    t.ok('Updated: the count appears in the detail when more than one', plan.groups[0].detail.includes('1.0.0') && plan.groups[0].detail.includes('2'));
    plan = planNotes({ info, state: { version: '1.2.0', previousVersion: '1.1.0' } });
    t.ok('Updated: one version shows only the "from" and is auto-opened', plan.groups[0].rows.length === 1 && plan.groups[0].open === true && plan.groups[0].detail.includes('1.1.0') && !/\d+ バージョン/.test(plan.groups[0].detail));
    plan = planNotes({ info, state: { version: '1.2.0', previousVersion: '1.2.0' } });
    t.ok('Updated: a previous version that is not older gives a plain list', plan.groups.length === 1 && plan.groups[0].head === '');
    plan = planNotes({ info, state: { version: '1.2.0' } });
    t.ok('No previous version: plain list with no heading', plan.groups.length === 1 && plan.groups[0].head === '' && plan.groups[0].rows.length === 3);
    plan = planNotes({ info, state: { version: '1.2.0', previousVersion: '1.0.0', target: '1.3.0', releases: [rel('1.3.0', { body: 'a' })] } });
    t.ok('A found update wins over the previous-version record', plan.groups[0].rows[0].version === '1.3.0');
    plan = planNotes({ info: null, state: null });
    t.ok('Missing data gives an empty plain list', plan.groups.length === 1 && plan.groups[0].rows.length === 0);

    // ---- 描画: 更新前
    const root = new N('div');
    const notes = createReleaseNotes(root, { reduceMotion: () => false });
    notes.update({ info, state: { version: '1.2.0' } });
    t.ok('Plain list renders every bundled row', heads(root).length === 3 && groupHeads(root).length === 0);
    t.ok('The current version row carries the date and the "現在のバージョン" mark', metas(root)[0].endsWith(' · 現在のバージョン') && metas(root)[0].startsWith('1.2.0 · ') && metas(root)[1] === '1.1.0 · 2026/11/01');
    t.ok('Rows start closed with aria-expanded=false and an empty body', heads(root).every(h => h.getAttribute('aria-expanded') === 'false') && all(root, n => n.matches('.rn-content')).length === 0);
    heads(root)[1].onclick();
    t.ok('Clicking a row opens it and fills the body lazily', heads(root)[1].getAttribute('aria-expanded') === 'true' && rows(root)[1].classList.contains('open') && all(root, n => n.matches('.rn-content')).length === 1);
    heads(root)[1].onclick();
    t.ok('Clicking again closes it', heads(root)[1].getAttribute('aria-expanded') === 'false' && !rows(root)[1].classList.contains('open'));

    // 作り直しで開いた行を保つ・同じ内容なら作り直さない
    heads(root)[2].onclick();
    const before = root.children[0];
    notes.update({ info, state: { version: '1.2.0', phase: 'checking' } });
    t.ok('The same content is not rebuilt', root.children[0] === before);
    notes.update({ info: { ...info, releases: [...bundled, rel('0.9.0')] }, state: { version: '1.2.0' } });
    t.ok('A rebuild keeps the opened row open', heads(root).length === 4 && heads(root)[2].getAttribute('aria-expanded') === 'true');

    // 同梱のノートは textContent（タグを解釈しない）
    const evil = createReleaseNotes(new N('div'), {});
    const evilRoot = new N('div');
    const evil2 = createReleaseNotes(evilRoot, {});
    evil2.update({ info: { version: '1.0.0', releases: [rel('1.0.0', { sections: [{ title: '<b>t</b>', items: ['<script>x</script>'] }] })] }, state: { version: '1.0.0' } });
    heads(evilRoot)[0].onclick();
    const content = all(evilRoot, n => n.matches('.rn-content'))[0];
    t.ok('Bundled notes are inserted as text, not HTML', content.outerHTML.includes('&lt;script&gt;') && !content.outerHTML.includes('<script>') && content.outerHTML.includes('&lt;b&gt;t&lt;/b&gt;'));
    void evil;

    // ---- 描画: 見つけた版（GitHub の Markdown は renderMarkdown を通す）
    const found = new N('div');
    const f = createReleaseNotes(found, {});
    f.update({ info, state: { version: '1.2.0', target: '1.3.0', releases: [rel('1.3.0', { body: '## 変更\n\n- <script>alert(1)</script>\n- 直した' })] } });
    t.ok('A single found version is open with its Markdown rendered', groupHeads(found)[0].includes('新しいバージョン') && heads(found)[0].getAttribute('aria-expanded') === 'true');
    const html = all(found, n => n.matches('.rn-content'))[0].outerHTML;
    t.ok('GitHub bodies go through renderMarkdown (script is escaped, list is built)', !html.includes('<script>') && html.includes('<li>') && html.includes('直した'));
    t.ok('The past group follows the new group', groupHeads(found).length === 2 && groupHeads(found)[1].includes('これまでのバージョン'));

    // フォールバック（一覧が空）
    const fb = new N('div');
    createReleaseNotes(fb, {}).update({ info, state: { version: '1.2.0', target: '1.3.0', releases: [], notes: '- 最新の変更' } });
    heads(fb)[0].onclick();
    t.ok('An empty list falls back to state.notes, rendered as Markdown', groupHeads(fb)[0].includes('新しいバージョン') && all(fb, n => n.matches('.rn-content'))[0].outerHTML.includes('最新の変更'));

    // ---- 畳み: 6 版までは全部、7 版以上は 5 版 + 「ほか N バージョンを表示」
    t.ok('Fold constants match the design (6 / 5 / 10)', FOLD_LIMIT === 6 && FOLD_SHOWN === 5 && PAGE === 10);
    const fold = (count, previous = '0.0.1') => {
      const r = new N('div');
      const list = nums(count);
      const n = createReleaseNotes(r, {});
      n.update({ info: { version: list[0].version, releases: [...list, rel('0.0.1')] }, state: { version: list[0].version, previousVersion: previous } });
      return { r, n, list };
    };
    let g = fold(6);
    t.ok('Six versions are all shown with no fold button', all(g.r, n => n.matches('.rn-group'))[0].querySelectorAll('.rn-row').length === 6 && buttonsLike(g.r, /ほか/).length === 0);
    g = fold(7);
    const skipRows = () => all(g.r, n => n.matches('.rn-group'))[0].querySelectorAll('.rn-row');
    t.ok('Seven versions show five rows plus "ほか 2 バージョンを表示"', skipRows().length === 5 && buttonsLike(g.r, /ほか 2 バージョンを表示/).length === 1);
    focused.length = 0;
    buttonsLike(g.r, /ほか/)[0].onclick();
    t.ok('Revealing shows every row, removes the button and focuses the first revealed row', skipRows().length === 7 && buttonsLike(g.r, /ほか/).length === 0 && focused.length === 1 && focused[0] === skipRows()[5].children[0]);
    g.n.update({ info: { version: g.list[0].version, releases: [...g.list, rel('0.0.1')] }, state: { version: g.list[0].version, previousVersion: '0.0.1', phase: 'current' } });
    t.ok('A repaint keeps the revealed rows', skipRows().length === 7);

    // ---- 古い版は 10 版ずつ「さらに表示」
    const paged = new N('div');
    const longList = nums(25);
    const pn = createReleaseNotes(paged, {});
    pn.update({ info: { version: longList[0].version, releases: longList }, state: { version: longList[0].version } });
    t.ok('Older versions show ten at first with "さらに表示"', heads(paged).length === 10 && buttonsLike(paged, /さらに表示/).length === 1);
    focused.length = 0;
    buttonsLike(paged, /さらに表示/)[0].onclick();
    t.ok('"さらに表示" adds ten more and focuses the first added row', heads(paged).length === 20 && buttonsLike(paged, /さらに表示/).length === 1 && focused[0] === heads(paged)[10]);
    buttonsLike(paged, /さらに表示/)[0].onclick();
    t.ok('The last page adds the rest and removes the button', heads(paged).length === 25 && buttonsLike(paged, /さらに表示/).length === 0);

    // 新しい行は動きを減らす設定のときアニメーションを付けない
    const calm = new N('div');
    const cn = createReleaseNotes(calm, { reduceMotion: () => true });
    cn.update({ info: { version: longList[0].version, releases: longList }, state: { version: longList[0].version } });
    buttonsLike(calm, /さらに表示/)[0].onclick();
    t.ok('Reduced motion adds no entrance animation; otherwise the new rows animate', all(calm, n => n.matches('.rn-in')).length === 0 && (buttonsLike(paged, /さらに表示/)[0]?.onclick(), all(paged, n => n.matches('.rn-in')).length > 0));

    // ---- 見出しへ滑らせる
    const sRoot = new N('div');
    let calmMotion = false;
    const sn = createReleaseNotes(sRoot, { reduceMotion: () => calmMotion });
    t.ok('Scrolling without a heading returns false', sn.scrollToUpdate() === false);
    sn.update({ info, state: { version: '1.2.0', previousVersion: '1.0.0' } });
    scrolled.length = 0;
    t.ok('Scrolling to the update heading returns true and scrolls smoothly', sn.scrollToUpdate() === true && scrolled.length === 1 && scrolled[0].node.matches('.rn-gh') && scrolled[0].arg.behavior === 'smooth');
    calmMotion = true; scrolled.length = 0; sn.scrollToUpdate();
    t.ok('With reduced motion the scroll is not smooth', scrolled[0].arg.behavior === 'auto');

    // ---- 本文のリンク: 絶対の http(s) だけ残し、相対・javascript:・# は href を外す（設定の画面は file-preview の横取りの外）
    const linkBox = new N('div');
    const mkLink = (href, extra = {}) => {
      const a = new N('a');
      a.className = 'md-link';
      if (href !== null) a.setAttribute('href', href);
      for (const [k, v] of Object.entries(extra)) a.setAttribute(k, v);
      linkBox.append(a);
      return a;
    };
    const web = mkLink('https://example.com/a', { target: '_blank', rel: 'noopener noreferrer nofollow' });
    const plain = mkLink('HTTP://example.com/b', { target: '_blank' });
    const rel1 = mkLink('docs/readme.md', { 'data-file-path': 'docs/readme.md', 'data-file-line': '3' });
    rel1.classList.add('file-link');
    const rel2 = mkLink('/local-file?path=x', { 'data-file-path': 'x' });
    const script = mkLink('javascript:alert(1)');
    const hash = mkLink('#section');
    const none = mkLink(null);
    const protoRel = mkLink('//evil.example/x');
    stripUnsafeLinks(linkBox);
    t.ok('Absolute https links keep href and target', web.getAttribute('href') === 'https://example.com/a' && web.getAttribute('target') === '_blank' && web.getAttribute('rel') !== undefined);
    t.ok('The scheme is matched without regard to case', plain.getAttribute('href') === 'HTTP://example.com/b');
    t.ok('A relative link loses href, target and the file markers', [rel1, rel2].every(a => !a.hasAttribute('href') && !a.hasAttribute('target') && !a.hasAttribute('data-file-path') && !a.hasAttribute('data-file-line')) && !rel1.classList.contains('file-link'));
    t.ok('A javascript: link loses href', !script.hasAttribute('href'));
    t.ok('A # link loses href', !hash.hasAttribute('href'));
    t.ok('A protocol-relative link loses href', !protoRel.hasAttribute('href'));
    t.ok('A link without href stays without href', !none.hasAttribute('href'));

    // ---- 作り直しの要否: 先頭以外の行の本文が替わったら作り直し、同じなら作り直さず開いた行・「さらに表示」を保つ
    const mdList = body => Array.from({ length: 25 }, (_, i) => rel(`3.${25 - i}.0`, { body: i === 12 ? body : `本文 ${i}` }));
    const sigRoot = new N('div');
    const sig = createReleaseNotes(sigRoot, {});
    const sigInfo = list => ({ info: { version: list[0].version, releases: list }, state: { version: list[0].version } });
    sig.update(sigInfo(mdList('古い')));
    heads(sigRoot)[2].onclick();
    buttonsLike(sigRoot, /さらに表示/)[0].onclick();
    const keptRows = rows(sigRoot).slice();
    sig.update(sigInfo(mdList('古い')));
    t.ok('The same releases do not rebuild the list', rows(sigRoot).length === 20 && rows(sigRoot).every((r, i) => r === keptRows[i]));
    t.ok('The same releases keep the opened row and the revealed page', rows(sigRoot)[2].classList.contains('open') && heads(sigRoot).length === 20);
    sig.update(sigInfo(mdList('新しい')));
    t.ok('A changed body in a row other than the first rebuilds the list', rows(sigRoot).some((r, i) => r !== keptRows[i]));
    t.ok('A rebuild keeps the opened row and the revealed page', rows(sigRoot)[2].classList.contains('open') && heads(sigRoot).length === 20);
    const retitled = mdList('新しい'); retitled[7] = { ...retitled[7], title: '別の題' };
    const beforeTitle = rows(sigRoot).slice();
    sig.update(sigInfo(retitled));
    t.ok('A changed title rebuilds the list', rows(sigRoot).some((r, i) => r !== beforeTitle[i]) && all(sigRoot, n => n.matches('.rn-title')).some(n => n.textContent === '別の題'));
    const redated = retitled.map((r, i) => i === 3 ? { ...r, date: '2026-12-31' } : r);
    const beforeDate = rows(sigRoot).slice();
    sig.update(sigInfo(redated));
    t.ok('A changed date rebuilds the list', rows(sigRoot).some((r, i) => r !== beforeDate[i]));
  } finally {
    N.prototype.focus = focusOrig;
    N.prototype.scrollIntoView = scrollOrig;
  }
}
