// 会話の途中で使えるエージェントが 0 件になった（直した直後も）ときの、空の会話の中央の一覧（docs/desktop-onboarding.md「使えるエージェントが無いとき」）。
// ダイアログは出さない。同じ行の部品（web/agent-row.mjs）で並べ、直ると 900ms 待ってから 240ms で薄れて消える。
// 送信ボタンを押せなくする（下書きは書ける）のは呼び出し側（client.mjs の syncRunState が blocks() を読む）
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';

/**
 * @param {object} o
 * @param {HTMLElement} o.host        置き場（#noAgent）
 * @param {object} o.kit              createRowKit の束
 * @param {() => object[]} o.agents   行にするエージェント（説明つき）
 * @param {() => boolean} o.wanted    いま出すべきか（0 件・空の会話・案内のダイアログが出ていない）
 * @param {() => Promise<unknown>} o.recheck  ［状態を再確認］
 * @param {() => void} [o.onChange]   出入りしたとき（送信ボタンの状態を合わせる）
 */
export function setupNoAgent({ host, kit, agents, wanted, recheck, onChange }) {
  let shown = false, leaving = false, checking = false, timer = 0, lastBlocks = false;
  const blocks = () => shown && !leaving;
  const notify = () => { if (blocks() !== lastBlocks) { lastBlocks = blocks(); onChange?.(); } };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const list = el('div', 'alist');
  list.setAttribute('role', 'list');
  const heading = el('div', 'setup-h', t('app.noUsableAgent'));
  heading.setAttribute('role', 'status');
  const btn = el('button', 'btn', t('settings.agents.recheck'));
  btn.type = 'button';
  btn.onclick = async () => {
    if (checking) return;
    checking = true; paintButton();
    try { await recheck(); } finally { checking = false; paintButton(); }
  };
  const bar = el('div', 'recheck'); bar.append(btn);
  const inner = el('div', 'setup-in'); inner.append(heading, list, bar);
  host.className = 'setup'; host.append(inner);
  host.hidden = true;

  function paintButton() {
    btn.replaceChildren(...(checking ? [runMark(), document.createTextNode(t('settings.agents.recheck'))] : [document.createTextNode(t('settings.agents.recheck'))]));
    btn.setAttribute('aria-busy', checking ? 'true' : 'false');
  }
  function hide() { clearTimeout(timer); shown = false; leaving = false; host.hidden = true; host.classList.remove('leave'); notify(); }
  function sync() {
    const want = wanted();
    if (want) {
      clearTimeout(timer); leaving = false; host.classList.remove('leave');
      if (!shown) { shown = true; host.hidden = false; }
      kit.paint(list, agents(), { desc: true });
      notify();
      return;
    }
    if (!shown || leaving) return;
    // 直った: 900ms の間そのまま見せ、240ms で薄れる（動きを減らす設定では待たずに消す）
    leaving = true; notify();
    if (reduced()) return hide();
    timer = setTimeout(() => { host.classList.add('leave'); timer = setTimeout(hide, 240); }, 900);
  }
  /** 送信ボタンを押せなくするか（出ている間と、消えるまでの間は止める。消えたら押せる） */
  return { sync, blocks, visible: () => shown };
}
