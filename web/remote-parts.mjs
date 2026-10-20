// 設定 › リモートの 2 つのタブ（web/remote.mjs の この PC へ、web/remote-hosts.mjs の ほかの PC へ）が共に使う部品。
// 行・まとまりの見出し・詳しい画面・＋ の流れのダイアログ（アプリを入れる › つなぎ方 › つなぐ › 完了）。見え方は web/manage-panel.css の .rm-*。
// 名前・コードは相手の端末から来るので、文字は必ず textContent で入れる（el / svgEl）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { openExternalLink } from './link-open.mjs';

/** 16×16 の線画（svg.i と同じ線幅・丸端）。端末の種類と、画面の小さな印 */
const ICONS = {
  phone: [['rect', { x: 4.25, y: 1.5, width: 7.5, height: 13, rx: 1.6 }], ['path', { d: 'M7 12.4h2' }]],
  tablet: [['rect', { x: 2.5, y: 1.5, width: 11, height: 13, rx: 1.6 }], ['path', { d: 'M7 12.4h2' }]],
  laptop: [['path', { d: 'M3.5 10V4.6c0-.6.4-1 1-1h7c.6 0 1 .4 1 1V10M1.5 12.5h13' }]],
  monitor: [['rect', { x: 1.75, y: 2.5, width: 12.5, height: 8.5, rx: 1.2 }], ['path', { d: 'M6 14h4M8 11v3' }]],
  chevron: [['path', { d: 'm6.5 4 4 4-4 4' }]],
  back: [['path', { d: 'm9.5 4-4 4 4 4' }]],
  plus: [['path', { d: 'M8 3v10M3 8h10' }]],
  external: [['path', { d: 'M7 3.5H4.5c-.6 0-1 .4-1 1v7c0 .6.4 1 1 1h7c.6 0 1-.4 1-1V9M9.5 3h3.5v3.5M13 3 8 8' }]],
  check: [['path', { d: 'm3.5 8.5 3 3 6-7' }]],
  copy: [['rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.4 }], ['path', { d: 'M10.5 3.2V3c0-.6-.4-1-1-1H3.5c-.6 0-1 .4-1 1v6c0 .6.4 1 1 1h.2' }]],
  user: [['circle', { cx: 8, cy: 5.8, r: 2.6 }], ['path', { d: 'M2.8 14c.7-2.5 2.8-4 5.2-4s4.5 1.5 5.2 4' }]],
};

export function rmIcon(name, cls = '') {
  const svg = svgEl('svg', { class: `i${cls ? ` ${cls}` : ''}`, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  for (const [tag, attrs] of ICONS[name] ?? []) svg.append(svgEl(tag, attrs));
  return svg;
}

/** 中継の URL の見せる部分（ホスト名）。読めなければそのまま */
export function relayHost(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try { return new URL(s).host || s; } catch { return s; }
}

/**
 * 端末の行の絵。スマホ・タブレット・PC。タブレットは種類（platform）では分からないので名前で見分ける（iPad・Tab・タブレット）。
 * PC は名前に laptop / book があればノート、無ければ画面
 */
export function deviceIcon({ platform, name } = {}) {
  const p = String(platform ?? '').toLowerCase(), n = String(name ?? '');
  if (p === 'ios' || p === 'android') return /ipad|tablet|\btab\b|タブレット/i.test(n) ? 'tablet' : 'phone';
  return /laptop|book|ノート/i.test(n) ? 'laptop' : 'monitor';
}

export function button(text, onclick, className = 'btn') {
  const b = el('button', className, text);
  b.type = 'button';
  if (onclick) b.onclick = onclick;
  return b;
}

/** 絵と文字のボタン（「＋ 端末を追加」「コピー」） */
export function iconButton(iconName, text, onclick, className = 'btn') {
  const b = button('', onclick, className);
  b.append(rmIcon(iconName), document.createTextNode(text));
  return b;
}

/** まとまりの見出し（「自分の中継サーバー」）。行の名前より小さく弱い。右側にトグル等の要素を置ける */
export function groupHead(text, tail = null) {
  const gh = el('div', 'rm-gh', text);
  if (tail) {
    const span = el('span', 'rm-gt');
    span.append(tail);
    gh.append(span);
  }
  return gh;
}

/** 一覧の 1 行。押すと詳しい画面。sub は弱い字の 2 行目（「オフライン」だけ） */
export function listRow({ icon, name, sub = '', onclick, key }) {
  const row = button('', onclick, 'rm-row');
  if (key) row.dataset.fk = key;
  const text = el('span', 'rm-rt');
  text.append(el('span', 'rm-nm', name));
  if (sub) text.append(el('span', 'rm-sub', sub));
  const end = el('span', 'rm-end');
  end.append(rmIcon('chevron'));
  row.append(rmIcon(icon), text, end);
  return row;
}

/** 詳しい画面の頭（「‹ リモート」と、絵つきの名前） */
export function detailHead({ icon, name, onBack }) {
  const back = button('', onBack, 'rm-back');
  back.dataset.fk = 'back';
  back.append(rmIcon('back'), document.createTextNode(t('settings.nav.remote')));
  const title = el('h3', 'rm-dt-name');
  title.append(rmIcon(icon), el('span', null, name));
  return [back, title];
}

/** 項目と値の表。値が空の行は出さない */
export function keyValues(pairs) {
  const dl = el('dl', 'rm-kv');
  for (const [k, v] of pairs) if (v) dl.append(el('dt', null, k), el('dd', null, v));
  return dl;
}

/** スイッチ（.cx-sw）。名前は読み上げ用に aria-label へ */
export function switchButton(label, onclick) {
  const sw = button('', onclick, 'cx-sw');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', label);
  return sw;
}

/** 2 つ 3 つから選ぶ（.seg）。押した方に aria-pressed */
export function segment(label, options, current, onpick) {
  const seg = el('div', 'seg rm-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const b = button(text, () => onpick(value));
    b.dataset.fk = `seg-${value}`;
    b.classList.toggle('on', value === current);
    b.setAttribute('aria-pressed', String(value === current));
    seg.append(b);
  }
  return seg;
}

/** 外へのリンク（pleiad.dev・中継サーバーの立て方）。アプリの中では既定のブラウザーか内蔵ブラウザーで開く */
export function externalLink(text, url) {
  const a = el('a', 'rm-ext');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.append(document.createTextNode(text), rmIcon('external'));
  a.onclick = e => { e.preventDefault(); e.stopPropagation(); openExternalLink(url); };
  return a;
}

export const INSTALL_URL = 'https://pleiad.dev/';

/** アプリを入れる の段の PC の中身（大きな画面の絵と「相手の PC に Pleiad を入れます」と pleiad.dev） */
export function installPcBody() {
  const box = el('div', 'rm-inst');
  const big = el('span', 'rm-big-ic');
  big.append(rmIcon('monitor'));
  const stack = el('div', 'rm-stack');
  stack.append(el('p', 'rm-lead', t('settings.remote.wizard.installPc')), externalLink('pleiad.dev', INSTALL_URL));
  box.append(big, stack);
  return box;
}

/** つなぎ方 の段で選ぶ接続方法。配列、または { current, onPick, items }、または単一の sub（後方互換） */
export function methodOptions(arg = null, currentVal = 'own', onPickFn = null) {
  let items = [], current = 'own', onPick = () => {};
  if (Array.isArray(arg)) {
    items = arg;
    current = currentVal;
    onPick = onPickFn ?? (() => {});
  } else if (arg && typeof arg === 'object' && Array.isArray(arg.items)) {
    items = arg.items;
    current = arg.current ?? 'plus';
    onPick = arg.onPick ?? (() => {});
  } else {
    const sub = arg;
    items = [{ value: 'own', label: t('settings.remote.groups.own'), sub }];
    current = 'own';
  }

  const opts = el('div', 'rm-opts');
  opts.setAttribute('role', 'radiogroup');
  opts.setAttribute('aria-label', t('settings.remote.detail.method'));

  for (const item of items) {
    const val = item.value ?? item.key;
    const lbl = item.label ?? item.name;
    const isChecked = val === current;
    const option = el('div', 'rm-row rm-opt');
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(isChecked));
    option.dataset.fk = val;
    if (item.disabled) {
      option.setAttribute('aria-disabled', 'true');
    } else {
      option.tabIndex = isChecked ? 0 : -1;
      option.onclick = () => onPick(val);
      option.onkeydown = e => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.isComposing) {
          e.preventDefault();
          onPick(val);
          return;
        }
        if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const radios = [...opts.querySelectorAll('[role="radio"]:not([aria-disabled="true"])')];
        const next = (radios.indexOf(option) + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : radios.length - 1)) % radios.length;
        onPick(radios[next].dataset.fk);
        opts.querySelector(`[data-fk="${radios[next].dataset.fk}"]`)?.focus();
      };
    }
    const text = el('span', 'rm-rt');
    text.append(el('span', 'rm-nm', lbl));
    if (item.sub) {
      const s = el('span', 'rm-sub');
      if (typeof item.sub === 'string') s.append(document.createTextNode(item.sub));
      else s.append(item.sub);
      text.append(s);
    }
    option.append(el('span', `rm-rd${isChecked ? ' on' : ''}`), text);
    opts.append(option);
  }
  return opts;
}

/** 完了 の段の中身（チェックの丸と「{name} をつなぎました」） */
export function doneBody(name) {
  const done = el('div', 'rm-done');
  const ck = el('span', 'rm-ck');
  ck.append(rmIcon('check'));
  done.append(ck, el('p', 'rm-lead', t('settings.remote.wizard.done', { name })));
  return done;
}

export function errorLine(text) {
  const p = el('p', 'rm-err', text);
  p.setAttribute('role', 'alert');
  return p;
}

/** 待っている間の一行（回る印と文字） */
export function waitLine(text) {
  const p = el('p', 'rm-wait');
  p.setAttribute('role', 'status');
  const spin = svgEl('svg', { class: 'rm-spin', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  spin.append(svgEl('circle', { class: 'rm-spin-track', cx: 8, cy: 8, r: 6 }), svgEl('path', { class: 'rm-spin-arc', d: 'M8 2a6 6 0 0 1 6 6' }));
  p.append(spin, el('span', null, text));
  return p;
}

/** 入力欄（見出しつき）。note は欄の下の弱い字（環境変数の値を使っている、など） */
export function field(labelText, input, note = null) {
  const label = el('label', 'rm-field');
  label.append(el('span', 'rm-flabel', labelText), input);
  if (note) label.append(note);
  return label;
}

export function textInput({ type = 'text', placeholder = '', autocomplete = 'off', key, mono = false } = {}) {
  const i = document.createElement('input');
  i.type = type; i.placeholder = placeholder; i.autocomplete = autocomplete; i.spellcheck = false;
  i.className = `rm-inp${mono ? ' rm-mono' : ''}`;
  if (key) i.dataset.fk = key;
  return i;
}

/** 入場券の QR（web/remote.mjs の qrPath の点）を px の大きさで */
export function qrFigure({ size, d }, px) {
  const svg = svgEl('svg', { class: 'rm-qr', width: px, height: px, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': t('settings.remote.pair.qrLabel'), 'shape-rendering': 'crispEdges' });
  svg.append(svgEl('rect', { class: 'rm-qr-bg', width: size, height: size }), svgEl('path', { class: 'rm-qr-fg', d }));
  return svg;
}

/** 確認コードの見出しと大きな数字 */
export function confirmCode(code) {
  const box = el('div');
  box.append(el('span', 'rm-flabel', t('settings.remote.wizard.codeLabel')), el('p', 'rm-ccode', code));
  return box;
}

export const STEP_KEYS = ['install', 'method', 'connect', 'done'];

/**
 * ＋ の流れのダイアログ。どの段も下の並びは「やめる」|（空き）|「戻る」「次へ」で、最後の段だけ「閉じる」。
 * 中身は render で渡す。sig が前と同じなら作り直さない（状態の知らせのたびに打ち込み中の欄や居場所を崩さない）
 * @param onCancel やめる・Esc・閉じる
 */
export function createWizard({ id, onCancel }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'rm-wiz';
  dialog.id = id;
  dialog.setAttribute('aria-labelledby', `${id}Title`);
  dialog.addEventListener('cancel', e => { e.preventDefault(); onCancel(); });
  document.body.append(dialog);
  let sig = null;

  /**
   * @param o.title    「端末を追加」「PC を追加」
   * @param o.step     0〜3
   * @param o.body     中身の要素の配列
   * @param o.next     { label?, disabled?, onclick }。最後の段では閉じる
   * @param o.back     戻る（0 段目は場所だけ取って見せない）
   * @param o.sig      中身の見え方を決める値。同じなら作り直さない（next.disabled は作り直さずに直す）
   */
  function render(o) {
    const nextSig = JSON.stringify([o.title, o.step, o.sig ?? null, o.next?.label ?? '']);
    if (dialog.open && nextSig === sig) {
      // 押せるかどうかだけ変わったときは、ボタンだけ直す（打ち込み中の欄を作り直さない）
      const next = dialog.querySelector('[data-fk=next]');
      if (next) next.disabled = Boolean(o.next?.disabled);
      return false;
    }
    sig = nextSig;
    const focusKey = dialog.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    const title = el('h2', 'rm-wiz-t', o.title);
    title.id = `${id}Title`;
    const steps = el('ol', 'rm-stp');
    steps.setAttribute('aria-label', t('settings.remote.wizard.steps.label'));
    STEP_KEYS.forEach((key, i) => {
      const li = el('li', i < o.step ? 'done' : i === o.step ? 'cur' : '');
      if (i === o.step) li.setAttribute('aria-current', 'step');
      const n = el('span', 'rm-n');
      if (i < o.step) n.append(rmIcon('check')); else n.textContent = String(i + 1);
      // i18n-dynamic: settings.remote.wizard.steps.
      li.append(n, document.createTextNode(t(`settings.remote.wizard.steps.${key}`)));
      steps.append(li);
    });
    const body = el('div', 'rm-wiz-b');
    body.append(...o.body);
    const foot = el('div', 'rm-wiz-f');
    const last = o.step === STEP_KEYS.length - 1;
    const next = button(o.next?.label ?? (last ? t('settings.remote.wizard.close') : t('settings.remote.wizard.next')),
      last && !o.next?.onclick ? onCancel : o.next?.onclick, 'btn btn-primary');
    next.dataset.fk = 'next';
    next.disabled = Boolean(o.next?.disabled);
    if (last) foot.append(el('span', 'rm-sp'), next);
    else {
      const cancel = button(t('settings.remote.wizard.cancel'), onCancel);
      cancel.dataset.fk = 'cancel';
      const back = button(t('settings.remote.wizard.back'), o.back, 'btn btn-quiet');
      back.dataset.fk = 'back';
      if (o.step === 0 || !o.back) { back.classList.add('rm-hide'); back.tabIndex = -1; back.setAttribute('aria-hidden', 'true'); }
      foot.append(cancel, el('span', 'rm-sp'), back, next);
    }
    dialog.replaceChildren(title, steps, body, foot);
    if (!dialog.open) dialog.showModal();
    const again = focusKey && dialog.querySelector(`[data-fk="${focusKey}"]`);
    // 居場所は前と同じ部品へ。無ければ最初の入力欄、それも無ければ「次へ」（押せなければ「やめる」）
    (again && !again.disabled ? again : body.querySelector('input:not([disabled])') ?? (next.disabled ? foot.querySelector('[data-fk=cancel]') : next) ?? next)?.focus();
    return true;
  }
  function close() { sig = null; if (dialog.open) dialog.close(); }
  return { dialog, render, close, get open() { return dialog.open; } };
}

/** 中の文字だけ差し替える（残り時間）。毎秒の更新でダイアログを作り直さない */
export function setText(root, selector, text) {
  const node = root.querySelector(selector);
  if (node && node.textContent !== text) node.textContent = text;
}

/**
 * 一覧の面を描き直す。前と同じ見え方なら触らない。居場所（data-fk の付いた部品）は描き直した後も同じ部品へ戻す
 */
export function paintInto(root, sig, build) {
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  const active = root.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  root.replaceChildren(...build());
  if (active) root.querySelector(`[data-fk="${CSS.escape(active)}"]`)?.focus();
}
