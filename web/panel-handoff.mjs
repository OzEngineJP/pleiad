// 頭の行の「ブラウザーを開く」と、タブの列の右端の ✖（パネルを閉じる）の受け渡し
// （docs/design-system.md「会話の頭の行のアイコン」・§8「動きの語彙」）。
// - 止まっているときは本物のボタンだけ: 閉じていれば頭のアイコン、開いていれば ✖（頭のアイコンは列から外す）
// - 動いている間（パネルのばね p が 0〜1）は、2 つの間を移る絵（.panel-flier）を 1 つだけ上の層に出す。
//   位置・大きさ・色・字形を p で混ぜ、止まった時は本物と同じになるので、入れ替わる瞬間に何も変わらない
// - 頭のアイコンの置き場は (幅 + 間) × (1 − p) で縮み、左の通話・目次のアイコンも同じばねで寄る
// - 閉じた直後は、ポインターが動くまで題の杖（✨）を出さない（押した場所が広がった題の上に残るため）
// p と向き（phase: opening / closing / open / closed）と、そのときの列の幅 px は web/file-preview.mjs の onMotion から届く
// - 動いている間のコマは「書くだけ」: 両端の姿（頭のアイコンの右端・✖ の左端と大きさ・字形・色・タブの列の色）は、
//   動き始め（向きが替わったとき・窓の大きさが替わったとき・✖ が替わったとき）に 1 度だけ量って持つ。
//   どちらの位置も右の欄の左の縁（W − px）と一緒に動くので、量った時の px との差だけ寄せる（毎コマ量り直して強制レイアウトしない）

const clamp = (value) => Math.min(1, Math.max(0, value));
const lerp = (a, b, q) => a + (b - a) * q;
const mix = (a, b, q) => (q <= 0 ? a : q >= 1 ? b : `color-mix(in srgb,${b} ${(q * 100).toFixed(1)}%,${a})`);

/**
 * entry は頭の行のボタン（#browserEntry）。target() は今の ✖（無い・見えない＝狭い画面では受け渡さない）。
 * onPress は移る絵を押したとき（動いている途中でも逆へ折り返す）
 */
export function createPanelHandoff({ entry, target = () => null, onPress = null }) {
  if (!entry || typeof document === 'undefined') return { update() {}, settle() {}, get moving() { return false; } };
  let flier = null, glyphA = null, glyphB = null, markSlot = null, rest = null, phase = 'closed';
  let geo = null;   // 動き始めに量った両端の姿（update の中で作る）。null なら次のコマで量り直す
  const root = document.documentElement;
  const remeasure = () => { geo = null; };
  if (typeof window !== 'undefined') window.addEventListener('resize', remeasure);

  const usable = (node) => !!node && typeof node.getBoundingClientRect === 'function' && node.getBoundingClientRect().width > 0;
  function build() {
    flier = document.createElement('button');
    flier.type = 'button'; flier.className = 'panel-flier'; flier.tabIndex = -1; flier.hidden = true;
    flier.setAttribute('aria-hidden', 'true');
    glyphA = document.createElement('span'); glyphA.className = 'panel-flier-g';
    glyphB = document.createElement('span'); glyphB.className = 'panel-flier-g';
    markSlot = document.createElement('span'); markSlot.className = 'panel-flier-mark';
    flier.append(glyphA, glyphB, markSlot);
    flier.addEventListener('click', () => onPress?.());
    document.body.append(flier);
  }
  /** 頭のアイコンの止まった姿（幅・間・字形の大きさ・色）。閉じて止まっている間に量っておく */
  function measureRest() {
    const computed = typeof getComputedStyle === 'function' ? getComputedStyle : () => ({});
    const parent = entry.parentElement;
    const icon = entry.querySelector?.('svg.i');
    const gap = parent ? parseFloat(computed(parent).columnGap) || 0 : 0;
    rest = { width: entry.offsetWidth || 30, height: entry.offsetHeight || 30, gap,
      glyph: icon?.getBoundingClientRect?.().width || 16, color: computed(entry).color || 'currentColor' };
  }
  const unset = (node, key) => { if (typeof node.style.removeProperty === 'function') node.style.removeProperty(key); else node.style[key] = ''; };
  function clearEntry() {
    entry.classList.remove('entry-handed');
    for (const key of ['width', 'min-width', 'margin-left', 'opacity', 'overflow']) unset(entry, key);
  }
  function quietWand() {
    root.classList.add('wand-quiet');
    const wake = () => { root.classList.remove('wand-quiet'); document.removeEventListener('pointermove', wake, true); };
    document.addEventListener('pointermove', wake, true);
  }
  /** 止まった姿に揃える（open: ✖ だけ・closed: 頭のアイコンだけ）。受け渡せないとき（狭い画面）は頭のアイコンを残す */
  function settle(open) {
    if (flier) flier.hidden = true;
    const x = target();
    if (x) unset(x, 'visibility');
    clearEntry();
    geo = null;
    phase = open ? 'open' : 'closed';
    if (open && usable(x)) entry.classList.add('entry-handed');
    if (!open) measureRest();
  }
  function update(p, next, px) {
    const was = phase; phase = next;
    if (next === 'open' || next === 'closed') { settle(next === 'open'); return; }
    if (was !== next) geo = null;   // 折り返したら終点が替わる
    const x = target();
    if (geo && geo.x !== x) geo = null;   // ✖ が作り直された
    if (!geo && !usable(x)) { if (flier) flier.hidden = true; clearEntry(); return; }
    // 止まった所から開き始めたら、その瞬間の姿（指が乗った色など）を量り直す。最初のコマで色が跳ばない
    if (!rest || (was === 'closed' && next === 'opening')) { clearEntry(); measureRest(); }
    if (!flier) build();
    if (next === 'closing' && was !== 'closing') quietWand();
    if (flier.hidden || was === 'open' || was === 'closed') {
      // 絵は本物の字形を写す（線の太さ・形が同じになる）。角の印も写し、開くほど薄くする（開いている間は出さない）
      glyphA.replaceChildren(entry.querySelector('svg.i')?.cloneNode(true) ?? '');
      glyphB.replaceChildren(x.querySelector('svg')?.cloneNode(true) ?? '');
      const mark = entry.querySelector('.entry-browser-mark');
      const copy = mark?.cloneNode(true); copy?.removeAttribute('hidden');
      markSlot.replaceChildren(copy ?? '');
    }
    const q = clamp(p);
    entry.classList.remove('entry-handed');
    // 置き場を縮める（幅と左の間を一緒に。p 1 で列から外したのと同じ幅になる）。絵は移る絵が持つので本物は透かす（フォーカスは受けられる）
    entry.style.overflow = 'hidden'; entry.style.minWidth = '0'; entry.style.opacity = '0';
    entry.style.width = `${(rest.width * (1 - q)).toFixed(2)}px`;
    entry.style.marginLeft = `${(-rest.gap * q).toFixed(2)}px`;
    x.style.visibility = 'hidden';
    // 量るのは動き始めの 1 コマだけ（上で書いた幅・間を当てた姿）。px が届かない呼び方では毎コマ量る
    const fresh = !geo;
    if (fresh) {
      const home = entry.getBoundingClientRect(), to = x.getBoundingClientRect();
      const computed = getComputedStyle(x);
      geo = { x, px, homeRight: home.right, homeTop: home.top, homeHeight: home.height,
        toLeft: to.left, toTop: to.top, toHeight: to.height,
        glyph: x.querySelector('svg')?.getBoundingClientRect().width || 18,
        color: computed.color, row: x.parentElement ? getComputedStyle(x.parentElement).backgroundColor : 'transparent' };
    }
    const g = geo;
    if (!Number.isFinite(px)) geo = null;
    // 頭の行の右端も ✖ も、右の欄の左の縁（W − px）と一緒に動く。量った時の px との差だけ寄せる
    const shift = Number.isFinite(px) && Number.isFinite(g.px) ? g.px - px : 0;
    const fromLeft = g.homeRight + shift - rest.width, fromTop = g.homeTop + (g.homeHeight - rest.height) / 2;
    const size = lerp(rest.height, g.toHeight, q);
    flier.hidden = false;
    flier.style.left = `${lerp(fromLeft, g.toLeft + shift, q).toFixed(2)}px`;
    flier.style.top = `${lerp(fromTop, g.toTop, q).toFixed(2)}px`;
    flier.style.width = flier.style.height = `${size.toFixed(2)}px`;
    flier.style.setProperty('--g', `${lerp(rest.glyph, g.glyph, q).toFixed(2)}px`);
    flier.style.color = mix(rest.color, g.color, q);
    // 下を流れるタブの字と重ならないよう、動いている間だけ丸に下地（タブの列の色）を敷く
    flier.style.backgroundColor = mix('transparent', g.row, clamp(q / 0.6));
    // 窓の絵は 0〜0.5 で縮んで消え、✖ は 0.25〜0.75 で育つ（重ねて入れ替える。途中で絵が消えきるコマは無い）
    const a = clamp(q / 0.5), b = clamp((q - 0.25) / 0.5);
    glyphA.style.opacity = String(1 - a); glyphA.style.transform = `scale(${(1 - 0.4 * a).toFixed(3)})`;
    glyphB.style.opacity = String(b); glyphB.style.transform = `scale(${(0.6 + 0.4 * b).toFixed(3)})`;
    markSlot.style.opacity = String(1 - a);
    flier.classList.toggle('focus', typeof entry.matches === 'function' && entry.matches(':focus-visible'));
  }
  return { update, settle, remeasure, get moving() { return phase === 'opening' || phase === 'closing'; } };
}

