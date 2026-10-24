// 設定 › 委譲: まだ一度も読めていない間は「オフ」に見せず、場所取りと読み上げ（aria-busy・「読み込んでいます」）。
// 読めた後の取り直しは前の値を出したまま待ち、初回の失敗は「再試行」を出す（docs/design-system.md の読み込み）
import { setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { normalizeSettings } from '../../core/delegation-routing.mjs';
import { el } from '../../web/dom.mjs';

export const name = 'delegation-loading';
export const title = '委譲の設定の読み込み: 未読込は偽の OFF でなく場所取り・初回の失敗は再試行・取り直しは前の値のまま';

export default async function (t) {
  const settings = normalizeSettings({ enabled: true });
  const state = () => structuredClone({ settings, defaults: normalizeSettings({}), tiers: ['t1'], kinds: [], judges: [],
    candidates: [], keys: {}, conversationEfforts: {}, storage: {}, warnings: [], accounts: {} });
  let fail = false, hold = null;
  const cmd = async command => {
    if (command === 'delegationRouting') { if (fail) throw new Error('load failed'); if (hold) await hold; return state(); }
    return [];
  };
  const root = el('div'), tab = el('button');
  const saved = document.getElementById;
  document.getElementById = id => ({ delegationPanel: root, delegationTab: tab })[id];
  const skel = () => root.querySelector('.rm-skel');
  const sw = () => root.querySelector('#routingEnable');
  const retry = () => root.querySelector('.rt-load-retry');
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    const ui = setupDelegationSettings({ cmd, page() {}, showMenu() {}, labelOf: id => id, logo: () => el('span'), modelsOf: async () => ({}), modelName: (_b, m) => m });
    t.ok('初期描画は場所取り（まだ一度も読めていない）',
      root.getAttribute('aria-busy') === 'true' && skel() && skel().hidden === false && skel().getAttribute('aria-label') === '読み込んでいます');
    t.ok('偽の OFF のスイッチは出さない（読めるまで仮の値を出さない）', sw().hidden === true && !sw().hasAttribute('aria-checked'));

    fail = true;
    await ui.refresh();
    t.ok('初回の読み込みが失敗したら「読み込めませんでした」と「再試行」',
      root.getAttribute('aria-busy') !== 'true' && skel().hidden === true && sw().hidden === true && Boolean(retry()) && root.textContent.includes('読み込めませんでした'));

    fail = false;
    let release; hold = new Promise(resolve => { release = resolve; });
    const retrying = retry().onclick();
    await flush();
    t.ok('「再試行」で場所取りに戻る', root.getAttribute('aria-busy') === 'true' && skel().hidden === false);
    release(); hold = null; await retrying;
    await flush();
    t.ok('読めたらスイッチが実値で出て場所取りは消える',
      root.getAttribute('aria-busy') !== 'true' && skel().hidden === true && sw().hidden === false && sw().getAttribute('aria-checked') === 'true');

    let release2; hold = new Promise(resolve => { release2 = resolve; });
    const again = ui.refresh();
    await flush();
    t.ok('読めた後の取り直しは前の値を出したまま待つ（場所取りに戻さない）',
      root.getAttribute('aria-busy') !== 'true' && skel().hidden === true && sw().hidden === false && sw().getAttribute('aria-checked') === 'true');
    release2(); hold = null; await again;
    t.ok('取り直しが終わっても実値のまま', sw().getAttribute('aria-checked') === 'true' && root.getAttribute('aria-busy') !== 'true');
  } finally {
    document.getElementById = saved;
  }
}
