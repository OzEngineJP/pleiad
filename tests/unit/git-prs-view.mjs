// git パネルの頭の PR の行（web/git-prs.mjs。ADR 0206）: 状態の順・3 件までと「ほか N 件」・番号だけの骨組み・gh が無いときの 1 行・
// 子の会話で作成の名前・悪意のある題や URL で属性や要素を差し込めないこと。
import { prsHTML, sortPrs, prLabel, PR_SHOWN } from '../../web/git-prs.mjs';

export const name = 'git-prs-view';
export const title = 'git パネルの PR の行: 状態の順・3 件と「ほか N 件」・骨組み・gh 無しの 1 行・子の会話の名前・差し込み防止';

const pr = (number, extra = {}) => ({ number, url: `https://github.com/example/pleiad/pull/${number}`, repo: 'example/pleiad', ...extra });
const EVIL = ['a"><img src=x onerror=window.__xss=1>', "b' onmouseover='window.__xss=2", '<script>window.__xss=3</script>', '"><svg onload=window.__xss=4>'];

/** タグだけを見る: 既知のタグ名・引用符が閉じた属性・on で始まる属性が無い・タグの外に < > が裸で残らない */
function safe(html) {
  const known = new Set(['div', 'span', 'button', 'svg', 'path', 'circle', 'rect', 'a', 'p', 'polyline', 'line']);
  if (html.replace(/<[^<>]*>/g, '').match(/[<>]/)) return false;
  return (html.match(/<[^<>]*>/g) ?? []).every((tag) => {
    const bare = tag.replace(/="[^"]*"/g, '=""');
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*(?:="")?)*)\s*\/?>$/.exec(bare);
    return m && known.has(m[1].toLowerCase()) && !/\son[a-z]+(=|\s|$)/i.test(m[2]);
  });
}
const numbers = (html) => [...html.matchAll(/class="gp-pr[^"]*"[^>]*data-n="(\d+)"/g)].map((m) => Number(m[1]));

export default async function (t) {
  t.ok('PR が無ければ何も出さない', prsHTML({ prs: [] }) === '' && prsHTML() === '');

  // ---- 順: オープン → ドラフト → マージ済み → クローズ。同じ状態の中は渡された順（新しい順）
  const mixed = [pr(1, { state: 'closed' }), pr(2, { state: 'merged' }), pr(3, { state: 'draft' }), pr(4, { state: 'open' }), pr(5, { state: 'open' }), pr(6)];
  t.ok('sortPrs: 状態の順・同じ状態は渡した順・状態の無いものは最後', sortPrs(mixed).map((p) => p.number).join() === '4,5,3,2,1,6');
  t.ok('sortPrs は渡した配列を変えない', mixed.map((p) => p.number).join() === '1,2,3,4,5,6');

  // ---- 3 件まで・ほか N 件
  const six = mixed.slice(0, 5).map((p) => ({ ...p, title: `題 ${p.number}` }));
  const html = prsHTML({ prs: six });
  t.ok(`${PR_SHOWN} 件までを出す`, numbers(html).join() === '4,5,3');
  t.ok('「ほか 2 件」のボタン（開閉の状態と読み上げの名前つき）', /<button class="gp-more"[^>]*aria-expanded="false"[^>]*aria-label="[^"]*2[^"]*">[^<]*2[^<]*<\/button>/.test(html), html.slice(-260));
  const all = prsHTML({ prs: six, expanded: true });
  t.ok('広げると全部・ボタンは消える', numbers(all).join() === '4,5,3,2,1' && !all.includes('gp-more'));
  t.ok('3 件ちょうどならボタンは出ない', !prsHTML({ prs: six.slice(0, 3) }).includes('gp-more'));

  // ---- 行の中身
  const one = prsHTML({ prs: [pr(412, { title: 'Fix the thing', state: 'open', checks: 'pass' })] });
  t.ok('行はリンク（別タブ・noopener）で、番号・題・状態の語・チェックの語が入る', /<a class="gp-pr" href="https:\/\/github\.com\/example\/pleiad\/pull\/412" target="_blank" rel="noopener noreferrer"/.test(one)
    && one.includes('#412') && one.includes('Fix the thing') && /<span class="s">[^<]+<span class="ci">/.test(one) && one.includes('class="cw"'), one.slice(0, 400));
  t.ok('題は 1 行の省略に任せ、全文を title に持つ', one.includes('<span class="t" title="Fix the thing">Fix the thing</span>'));
  t.ok('色の指定を持たない（style・--diff-* を使わない）', !/--diff-|style="[^"]*color/.test(one));
  t.ok('失敗のチェックは bad（太字にする。色ではない）', prsHTML({ prs: [pr(1, { title: 'x', state: 'open', checks: 'fail' })] }).includes('class="ci bad"'));
  t.ok('マージ済み・クローズは done（題を弱める）', prsHTML({ prs: [pr(1, { title: 'x', state: 'merged' })] }).includes('class="gp-pr done"') && prsHTML({ prs: [pr(1, { title: 'x', state: 'closed' })] }).includes('class="gp-pr done"'));
  t.ok('チェックが無ければチェックの札は出ない', !prsHTML({ prs: [pr(1, { title: 'x', state: 'open' })] }).includes('class="ci'));
  const shapes = ['open', 'draft', 'merged', 'closed'].map((state) => prsHTML({ prs: [pr(1, { title: 'x', state })] }).match(/<svg[^>]*>.*?<\/svg>/s)?.[0]);
  t.ok('状態ごとに別の形（アイコン）', new Set(shapes).size === 4 && shapes.every(Boolean));

  // ---- 骨組み（番号だけ先に・題・状態は gh が返るまで）
  const sk = prsHTML({ prs: [pr(7), pr(8, { state: 'open', title: 'known' })], loading: true });
  t.ok('読み込み中: 状態の無い行は骨組み（リンクにしない・番号は出す）', /<div class="gp-pr sk" data-n="7">/.test(sk) && sk.includes('#7') && sk.includes('history-line'), sk.slice(0, 300));
  t.ok('読み込み中でも、読めた行はそのまま出す', /<a class="gp-pr"[^>]*data-n="8"/.test(sk));
  const settled = prsHTML({ prs: [pr(7)], loading: false });
  t.ok('読み込みが終わって状態が無いもの（gh 無し）は、番号・repo・リンクだけ', /<a class="gp-pr"[^>]*data-n="7"/.test(settled) && settled.includes('example/pleiad') && !settled.includes('history-line') && !settled.includes('class="s"'), settled.slice(0, 300));

  // ---- gh が無い・ログインしていない
  t.ok('no-gh: 1 行の説明', /<p class="gp-quiet">[^<]+<\/p>/.test(prsHTML({ prs: [pr(7)], reason: 'no-gh' })));
  const noGh = prsHTML({ prs: [pr(7)], reason: 'no-gh' }), noAuth = prsHTML({ prs: [pr(7)], reason: 'no-auth' });
  t.ok('no-auth は no-gh と別の文', noGh.match(/gp-quiet">([^<]+)/)?.[1] !== noAuth.match(/gp-quiet">([^<]+)/)?.[1] && noAuth.includes('gh'));
  t.ok('読み込み中は説明を出さない・理由が無ければ出さない', !prsHTML({ prs: [pr(7)], reason: 'no-gh', loading: true }).includes('gp-quiet') && !prsHTML({ prs: [pr(7)] }).includes('gp-quiet'));

  // ---- 子の会話で作成
  const child = pr(21, { title: 'child work', state: 'open', child: true }), mine = pr(20, { title: 'mine', state: 'open' });
  t.ok('子の PR は title と読み上げの名前に「子の会話で作成」', prLabel(child).includes('子の会話で作成') && !prLabel(mine).includes('子の会話で作成'), prLabel(child));
  const kids = prsHTML({ prs: [child, mine] });
  t.ok('行の title に「子の会話で作成」が入り、見える印（文字・アイコン）は足さない', /data-n="21"/.test(kids) && /<a class="gp-pr" [^>]*title="[^"]*子の会話で作成[^"]*"[^>]*data-n="21"/.test(kids)
    && !/<a class="gp-pr" [^>]*title="[^"]*子の会話で作成[^"]*"[^>]*data-n="20"/.test(kids) && !/>[^<]*子の会話[^<]*</.test(kids), kids.slice(0, 500));
  t.ok('名前に状態・チェックも入る', prLabel({ ...mine, checks: 'fail' }).includes('mine') && prLabel({ ...mine, checks: 'fail' }).split(/[,、·・]/).length >= 3, prLabel({ ...mine, checks: 'fail' }));

  // ---- 差し込み防止
  for (const evil of EVIL) {
    const h = prsHTML({ prs: [pr(1, { title: evil, state: 'open', checks: 'pass', repo: evil }), { number: '9"><x', url: `https://github.com/a/b/pull/9?q=${evil}`, state: 'merged', title: evil, child: true }], reason: 'no-gh' });
    t.ok(`題・番号・URL: ${JSON.stringify(evil).slice(0, 28)}…`, safe(h), h.slice(0, 400));
  }
  t.ok('http(s) 以外の URL はリンクにしない', !/<a[^>]*href="javascript:/i.test(prsHTML({ prs: [{ number: 1, url: 'javascript:alert(1)', state: 'open', title: 'x' }] })) && prsHTML({ prs: [{ number: 1, url: 'javascript:alert(1)', state: 'open', title: 'x' }] }).includes('<div class="gp-pr"'));
}
