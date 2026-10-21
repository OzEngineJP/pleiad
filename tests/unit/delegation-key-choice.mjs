// 設定 › 委譲「委譲先の自動選択に使うキー」（web/delegation-settings.mjs）:
// その場の登録欄を開いたまま別の行（Pleiad Plus）を選ぶと、登録欄を畳んで描き直すので印が動く。
// （描き直しは「欄にフォーカスがあって登録中」なら飛ばされる。選ぶ操作はその飛ばしを越える必要がある。）
// DOM は最小のスタブ（tests/lib/dom-stub.mjs）。起動・ブラウザー・LLM なしで回る。
import { setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { normalizeSettings } from '../../core/delegation-routing.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'delegation-key-choice';
export const title = '設定 › 委譲のキー: 登録欄を開いたまま Pleiad Plus を選ぶと、登録欄を畳んで印が動く';

const PLUS = { available: true, state: 'on', signedIn: true, status: 'plus', email: 'user@example.com',
  reachable: true, limitReached: false, resetAt: null, profileUrl: null };

export default async function (t) {
  const defaults = normalizeSettings({});
  const stored = structuredClone(defaults);
  let via = null;
  const state = () => structuredClone({
    settings: stored, defaults, kinds: [], judges: [], tiers: ['t1'], candidates: [],
    conversationEfforts: {}, storage: { encrypted: true },
    keys: { openrouter: { via, hasKey: Boolean(via), keyRef: null, plus: PLUS } },
  });
  const keyList = { keys: [], uses: {}, migration: { state: 'done' }, storage: { encrypted: true }, virtual: [], guide: null };
  const sent = [];
  const cmd = async (name, args) => {
    if (name === 'delegationRouting') return state();
    if (name === 'setApiKeyUse') { sent.push(args); via = args.id === 'plus' ? 'plus' : (args.id ? 'key' : null); return { use: args.use, id: args.id }; }
    if (name === 'invoke' && args?.op === 'apiKeys.list') return structuredClone(keyList);
    throw new Error(`unexpected command ${name}`);
  };
  const root = el('div'), tab = el('button');
  const saved = { get: document.getElementById, active: document.activeElement, focus: N.prototype.focus,
    addEventListener: document.addEventListener, removeEventListener: document.removeEventListener, createTextNode: document.createTextNode };
  document.getElementById = id => ({ delegationPanel: root, delegationTab: tab })[id] ?? null;
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  document.createTextNode = text => { const node = new N('span'); node.textContent = text; return node; };
  N.prototype.focus = function () { if (!this.disabled) document.activeElement = this; };
  try {
    const ui = setupDelegationSettings({ cmd, page() {}, showMenu() {}, labelOf: id => id, logo: () => el('span'),
      modelsOf: async () => ({}), modelName: (_b, m) => m });
    await ui.refresh();
    const row = name => root.querySelectorAll('.rm-opt').find(r => r.textContent.includes(name));
    t.ok('Pleiad Plus と OpenRouter の行が出る', Boolean(row('Pleiad Plus')) && Boolean(row('OpenRouter')));

    // キーは未登録。OpenRouter の「使うキー」の選択を開くと「＋ … のキーを登録…」がある
    row('OpenRouter').querySelector('button').onclick();
    const registerItem = root.querySelectorAll('.li').find(b => b.textContent.includes('登録'));
    t.ok('キーが無いときは選択の中に「登録…」がある', Boolean(registerItem), root.querySelectorAll('.li').map(b => b.textContent).join(' / '));
    registerItem.onclick();
    const form = root.querySelector('.rt-key-form');
    t.ok('登録欄が開く', Boolean(form));
    // ブラウザと同じく、開いた登録欄の入力にフォーカスがある状態にする
    form.querySelector('input').focus();
    t.ok('登録欄の入力にフォーカスがある', document.activeElement?.tagName === 'INPUT' && form.contains(document.activeElement));

    // 登録欄を開いたまま Pleiad Plus の行を選ぶ
    await row('Pleiad Plus').onclick();
    t.ok('選ぶと setApiKeyUse に judge:jev / plus が送られる', JSON.stringify(sent.at(-1)) === JSON.stringify({ use: 'judge:jev', id: 'plus' }));
    t.ok('登録欄を開いたまま選んでも、登録欄は畳まれる', !root.querySelector('.rt-key-form'));
    t.ok('印が Pleiad Plus に動く（描き直しが飛ばされない）', row('Pleiad Plus').getAttribute('aria-checked') === 'true');
  } finally {
    document.getElementById = saved.get; document.activeElement = saved.active; N.prototype.focus = saved.focus;
    document.addEventListener = saved.addEventListener; document.removeEventListener = saved.removeEventListener; document.createTextNode = saved.createTextNode;
  }
}
