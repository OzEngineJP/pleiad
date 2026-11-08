// ブラウザーの欄の上の列（docs/inapp-browser.md「見るウィンドウを選ぶ」。会話の題とウィンドウの番号のチップ）。
// 65c79c80 で消えた部品を、今のタブの列（.bu-tabs）の上へ戻したもの。下の列・閉じる前の確かめは
// web/tab-strip.mjs・web/chrome-panel.mjs の今の部品が受け持つ（タブの × もそちら）。
//   - 会話の題のチップ（この会話と、窓のある子の会話が 2 つ以上のとき）と、ウィンドウの番号のチップ（その会話のウィンドウが 2 つ以上のとき）。
//     番号を押すとそのウィンドウを固定して映像が替わる。会話の題を押すと、その会話の Chrome を映す（会話は移らない）。エージェントが操作中のウィンドウには弧、操作していないときは点
//   - 「エージェントを追う」: 固定を外して、エージェントが操作するウィンドウ・タブを映す。見えている最初の列の右端に置く（置き場は呼ぶ側が決める）
// 文言は呼ぶ側の t で引く。DOM は document.createElement だけで作る（テストの代役の DOM で動く）。
import { el, svgEl } from './dom.mjs';
import { runMark } from './arc.mjs';

const FLASH_MS = 760;

/** 照準の絵（エージェントを追う）。24×24 の線画 */
function locateIcon() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 12, cy: 12, r: 5.5 }), svgEl('path', { d: 'M12 3v3M12 18v3M3 12h3M18 12h3' }),
    svgEl('circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }));
  return svg;
}

/** 固定中の印（ピン）の絵 */
export function pinIcon() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7' }));
  return svg;
}

const flashNode = (node, ms = FLASH_MS) => {
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  return setTimeout(() => node.classList.remove('flash'), ms);
};

/** 選んだチップの下へ敷きを動かし、列の見える範囲へ寄せる */
function placePad(list, pad, node) {
  const left = node?.offsetLeft, width = node?.offsetWidth;
  if (!Number.isFinite(left) || !Number.isFinite(width) || !width) return;
  pad.style.width = `${width}px`;
  pad.style.transform = `translateX(${left}px)`;
  const view = list.scrollLeft ?? 0, box = list.clientWidth ?? 0;
  if (box && left - 3 < view) list.scrollLeft = left - 3;
  else if (box && left + width + 3 > view + box) list.scrollLeft = left + width + 3 - box;
}

/** エージェントの印（操作中は弧、そうでなければ点、依頼待ちは印の色の点） */
function agentMark(kind) {
  if (kind === 'run') return [runMark()];
  if (kind === 'dot' || kind === 'wait') return [el('span', kind === 'wait' ? 'cp-sw-dot wait' : 'cp-sw-dot')];
  return [];
}

/**
 * 上の列（会話の題と番号のチップ）。
 * @param t        翻訳
 * @param onPick   (windowId, sessionId) 番号のチップを押した・矢印で選んだ（sessionId はそのウィンドウの会話。会話の題を出していなければ undefined）
 * @param onPickConv (sessionId) 会話の題のチップを押した・矢印で選んだ
 * @param onFollow ()         「エージェントを追う」を押した
 * @param getName  エージェントの名前
 */
export function createWindowSwitch({ t, onPick = () => {}, onPickConv = () => {}, onFollow = () => {}, getName = () => 'Claude' } = {}) {
  const root = el('div', 'cp-sw');
  const inner = el('div', 'cp-sw-in');
  const row = el('div', 'cp-sw-row');
  const list = el('div', 'cp-sw-list'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', t('browser.chromeWindow.switchLabel'));
  const pad = el('span', 'cp-sw-pad'); pad.setAttribute('aria-hidden', 'true');
  const follow = el('button', 'btn btn-icon cp-sw-follow'); follow.type = 'button';
  follow.setAttribute('aria-label', t('browser.chromeWindow.follow')); follow.title = t('browser.chromeWindow.follow');
  follow.append(locateIcon());
  follow.onclick = () => onFollow();
  row.append(list, follow); inner.append(row); root.append(inner);

  const chips = new Map();   // key -> { node, kind: 'conv'|'window', id, sessionId, ... }（番号のチップの key は会話の題を出していなければ windowId）
  let order = [], flashTimer = 0, followFlashTimer = 0, picked = null;

  const pickKey = key => {
    const chip = chips.get(key);
    if (!chip) return;
    if (chip.kind === 'conv') onPickConv(chip.sessionId); else onPick(chip.id, chip.sessionId);
  };
  function chipKeydown(key) {
    return event => {
      const open = order.filter(id => !chips.get(id)?.ghost);
      const index = open.indexOf(key);
      const target = { ArrowRight: open[Math.min(open.length - 1, index + 1)], ArrowLeft: open[Math.max(0, index - 1)], Home: open[0], End: open.at(-1) }[event.key];
      if (target == null) return;
      event.preventDefault();
      picked = target;
      pickKey(target);
      chips.get(target)?.node.focus?.();
    };
  }

  function makeWindowChip(key, windowId, number, sessionId) {
    const node = el('button', 'cp-sw-chip'); node.type = 'button'; node.setAttribute('role', 'tab');
    const num = el('span', 'cp-sw-num', String(number));
    const mark = el('span', 'cp-sw-ag'); mark.setAttribute('aria-hidden', 'true');
    node.append(num, mark);
    node.onclick = () => pickKey(key);
    node.onkeydown = chipKeydown(key);
    return { node, kind: 'window', id: windowId, sessionId, number, num, mark, ghost: false, running: null };
  }
  function makeConvChip(key, sessionId) {
    const node = el('button', 'cp-sw-chip cp-sw-conv'); node.type = 'button'; node.setAttribute('role', 'tab');
    const mark = el('span', 'cp-sw-cm'); mark.setAttribute('aria-hidden', 'true');
    const label = el('span', 'cp-sw-t');
    node.append(mark, label);
    node.onclick = () => pickKey(key);
    node.onkeydown = chipKeydown(key);
    return { node, kind: 'conv', sessionId, label, mark, markKind: undefined };
  }

  return {
    root, row, list, follow,
    /**
     * @param items [{ windowId, number, sessionId, selected, agent, running?, ghost? }]（全会話の並び。convs があるときは題の後ろにその会話の分だけ置く）
     * @param convs [{ sessionId, label, selected, current, mark: 'run'|'wait'|null, agent? }]（2 つ以上のときだけ）
     * @param agentRunning エージェントが操作中か（印を弧にする・単一会話の既定。item.running が会話ごとの上書き）
     * @param pinned 固定中（follow は薄く・選んだ番号の読み上げに「固定中」）
     * @param away エージェントが別のウィンドウにいる（follow を濃く）
     * @param disabled 押せない（PC で引き継いでいる間・ほかの端末が操作している間）
     * @param flashId 1 回光らせるウィンドウ（エージェントの印が移った先）
     * @param followHere 上の列に「エージェントを追う」を置く（false なら呼ぶ側が別の列へ置く）
     */
    paint({ items = [], convs = [], agentRunning = false, pinned = false, away = false, disabled = false, flashId = null, followHere = true } = {}) {
      const keyOf = item => (convs.length ? `w:${item.sessionId}:${item.windowId}` : item.windowId);
      const entries = [];
      if (convs.length) {
        for (const conv of convs) {
          entries.push({ kind: 'conv', key: `c:${conv.sessionId}`, conv });
          for (const item of items) if (item.sessionId === conv.sessionId) entries.push({ kind: 'window', key: keyOf(item), item });
        }
      } else for (const item of items) entries.push({ kind: 'window', key: keyOf(item), item });
      const keys = new Set(entries.map(entry => entry.key));
      for (const [key, chip] of [...chips]) if (!keys.has(key) || chip.kind !== entries.find(entry => entry.key === key)?.kind) { chip.node.remove(); chips.delete(key); }
      const name = getName();
      for (const entry of entries) {
        let chip = chips.get(entry.key);
        if (entry.kind === 'conv') {
          const conv = entry.conv;
          if (!chip) { chip = makeConvChip(entry.key, conv.sessionId); chips.set(entry.key, chip); }
          chip.label.textContent = conv.label;
          chip.node.title = conv.label;
          chip.node.setAttribute('aria-selected', String(conv.selected === true));
          chip.node.tabIndex = conv.selected ? 0 : -1;
          chip.node.disabled = false;
          chip.node.toggleAttribute('data-on', conv.current === true);
          chip.node.setAttribute('aria-label', conv.label + (conv.mark === 'run' ? `, ${t('browser.chromeWindow.chipAgentRunning', { name: conv.agent || name })}` : conv.mark === 'wait' ? `, ${t('browser.chromeWindow.childWaiting')}` : ''));
          if (chip.markKind !== (conv.mark ?? null)) { chip.markKind = conv.mark ?? null; chip.mark.replaceChildren(...agentMark(chip.markKind)); }
          continue;
        }
        const item = entry.item;
        if (!chip) { chip = makeWindowChip(entry.key, item.windowId, item.number, item.sessionId); chips.set(entry.key, chip); }
        if (chip.number !== item.number) { chip.number = item.number; chip.num.textContent = String(item.number); }
        chip.ghost = item.ghost === true;
        chip.node.classList.toggle('ghost', chip.ghost);
        chip.node.setAttribute('aria-selected', String(item.selected === true));
        chip.node.tabIndex = item.selected ? 0 : -1;
        chip.node.disabled = disabled || chip.ghost;
        if (item.agent) chip.node.setAttribute('data-agent', ''); else chip.node.removeAttribute('data-agent');
        const running = item.running ?? agentRunning;
        const conv = convs.find(c => c.sessionId === item.sessionId);
        chip.node.setAttribute('aria-label', (conv ? `${conv.label}, ` : '') + t('browser.chromeWindow.windowNumber', { n: item.number })
          + (item.agent ? `, ${running ? t('browser.chromeWindow.chipAgentRunning', { name: conv?.agent || name }) : t('browser.chromeWindow.chipAgentIdle', { name: conv?.agent || name })}` : '')
          + (item.selected && pinned ? `, ${t('browser.chromeWindow.pinned')}` : ''));
        // 印: 操作中は弧、そうでなければ点。窓が替わるときだけ作り直す
        chip.node.toggleAttribute('data-idle', item.agent === true && !running);
        if (item.agent && chip.running !== running) {
          chip.mark.replaceChildren(...(running ? [runMark()] : []));
          chip.running = running;
        } else if (!item.agent) { chip.mark.replaceChildren(); chip.running = null; }
      }
      // 並びを揃える（先頭は pad。足りない分だけ足し、焦点のあるチップを入れ直さない）
      if (list.children[0] !== pad) list.prepend(pad);
      entries.forEach((entry, index) => {
        const node = chips.get(entry.key).node, current = Array.from(list.children)[index + 1];
        if (current === node) return;
        if (current) current.before(node); else list.append(node);
      });
      order = entries.map(entry => entry.key);
      root.toggleAttribute('data-open', convs.length >= 2 || items.length >= 2);
      root.toggleAttribute('data-run', agentRunning);
      root.toggleAttribute('data-paused', disabled);
      list.setAttribute('aria-label', convs.length ? t('browser.chromeWindow.convSwitchLabel') : t('browser.chromeWindow.switchLabel'));
      follow.disabled = disabled;
      follow.setAttribute('aria-pressed', String(!pinned));
      follow.classList.toggle('on', !pinned);
      follow.toggleAttribute('data-away', away);
      if (followHere && follow.parentNode !== row) row.append(follow);
      const selected = entries.find(entry => (entry.kind === 'conv' ? entry.conv.selected : entry.item.selected));
      if (selected) placePad(list, pad, chips.get(selected.key)?.node);
      // 印が移ったウィンドウ（映している会話の分）を 1 回光らせる
      const flashKey = flashId == null ? null : entries.find(entry => entry.kind === 'window' && entry.item.windowId === flashId && (!convs.length || convs.find(c => c.sessionId === entry.item.sessionId)?.current))?.key;
      if (flashKey != null && chips.get(flashKey)) { clearTimeout(flashTimer); flashTimer = flashNode(chips.get(flashKey).node); }
    },
    /** 「エージェントを追う」を光らせる（固定を外した直後の戻りの動き） */
    flashFollow() { clearTimeout(followFlashTimer); followFlashTimer = flashNode(follow); },
    /** 矢印で選んだ直後の描き直しで、焦点を選んだチップに残す */
    focusPicked() { if (picked != null) { chips.get(picked)?.node.focus?.(); picked = null; } },
    focusChip(windowId) { chips.get(windowId)?.node.focus?.(); },
    chip: key => chips.get(key)?.node ?? null,
    dispose() { clearTimeout(flashTimer); clearTimeout(followFlashTimer); },
  };
}
