// 設定 › 委譲（委譲先の自動選択。docs/design-system.md「設定 › 委譲」、docs/agent-delegation.md「委譲先の自動選択」）。
//
// - 先頭のスイッチ「委譲先を自動で選ぶ」
// - 「難しさの判定」: 判定に使うモデルを 1 つ選ぶ（既定 perplexity/pplx-decider-v1.2・「しない」も可）
// - 「委譲先の自動選択に使うキー」: OpenRouter の「使うキー」を設定 › API キー（承認済み 2026-10-07）から選ぶ（WS の setApiKeyUse）。
//   選ぶまでは何も送らない。未登録ならその場で登録でき（登録先は API キー）、キーは返ってこない（hasKey と keyRef だけ）。送る内容の 1 行
// - 「詳しい設定」（details）: 見出しのプルダウンで選んだレベルの候補（並べ替え・追加・外す、各候補の今の使用量と使えるかどうか、
//   レベルの既定と候補ごとの思考の強さ。承認済み 2026-10-08・ADR 0164）。レベルの名前の変更・並べ替え・追加・削除（移し先つきの
//   その場の確認）はプルダウンの各レベルの行の ⋯ メニュー（docs/design-system.md「設定 › 委譲」）。
//   作業の種類 × 難しさの表（種類の追加・名前と AI に渡す説明の編集・削除）・使用量の方針。
//   アカウントを登録したエージェントの候補は「エージェント・モデル・アカウント」の単位（「Sonnet · personal」）で、
//   追加はエージェント ▸ モデル ▸ アカウント（承認済み 2026-10-24・ADR 0264）
// - 末尾の「既定に戻す」（その場の確認。キーは残る）
//
// 状態はサーバーが持つ（delegationRouting コマンドと、変わるたびに届く delegationRoutingChanged イベント）。
// 変えたらすぐ setDelegationRouting で保存する（保存ボタンは置かない）。既定と同じ項目は送らない（既定値を凍らせない）。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）・コンテキストのスイッチ（.cx-sw）・区切りボタン（.seg）・
// 使用量の行（web/usage.css の .usage-rows）・表（.table-wrap）を使う。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { kindText, difficultyText, tierText, skipText, usageSummary, splitCandidate } from './delegation-routing-view.mjs';
import { apiKeyList, keySelect, registerForm, statusLine, manageLink } from './api-key-ui.mjs';
import { keyRadioRow, keyRadioGroup, plusKeyRow, plusRowVisible } from './plus-key-row.mjs';
import { EFFORT_LEVELS, candidateEffort, tierEffort, withEffort } from './delegation-effort.mjs';
import { effortSelect, effortFixed } from './effort-select.mjs';
import { createReorder, moveItem } from './reorder.mjs';

const SERVICE = 'openrouter';
/** 判定に使うキーの割り当て（API キーの uses の judge:routing） */
const JUDGE_USE = 'judge:routing';
/** 判定に使わない値（settings.judge の 'none'） */
const JUDGE_NONE = 'none';
const DIFFICULTIES = ['low', 'mid', 'high'];
const KIND_DESC_MAX = 300;
const LEVELS_MAX = 10;
const KINDS_MAX = 30;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 既定と違う項目だけの形（tiers・table は中の項目ごと）。全部既定なら null */
export function diffFromDefaults(value, defaults) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.fromEntries(Object.entries(value).filter(([k, v]) => !same(v, defaults?.[k])));
    return Object.keys(out).length ? out : null;
  }
  return same(value, defaults) ? null : value;
}

/** 送る値が「既定との差の全体」（サーバーが丸ごと置き換える）の項目。重ねる先は今の値ではなく既定（段の既定に戻した行が残らないように） */
const REPLACED = new Set(['efforts']);

function applyPatch(settings, patch, defaults) {
  const next = structuredClone(settings);
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value === null ? structuredClone(defaults[key])
      : value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(REPLACED.has(key) ? defaults[key] : next[key]), ...structuredClone(value) } : value;
  }
  return next;
}

function button(text, onclick, className = 'btn') {
  const b = el('button', className, text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

/** 利用者が増やすレベル・作業の種類の id（サーバーの LEVEL_ID・KIND_ID と同じ形） */
const newId = prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * @param cmd        WS コマンド
 * @param page       設定のページを切り替える（onboarding.page）
 * @param showMenu   右クリックのメニュー（x, y, items, title）
 * @param labelOf    エージェントの名前
 * @param logo       エージェントのロゴ（backend -> 要素）
 * @param modelsOf   そのエージェントのモデルの一覧（backend -> Promise<{ [id]: { label } }>）
 * @param modelName  モデルの表示名（backend, model -> 文字）
 * @param openPage   設定のほかのページへ移る（API キー）
 * @param openAccount エージェント設定のそのエージェントのアカウントを開き、その行へフォーカスを置く（backend, account -> void）
 * @param agents     候補に足せるエージェント（有効なエージェントの id。() -> string[]）
 */
export function setupDelegationSettings({ cmd, page, showMenu, labelOf, logo, modelsOf, modelName, openPage = () => {}, openAccount = () => {}, agents = () => [] }) {
  const $ = id => document.getElementById(id);
  const root = $('delegationPanel');
  let data = null, committed = null, message = '', registering = false, keyList = null, confirmingReset = false, refreshing = false;
  const pending = [];
  let saving = false, refreshSerial = 0, orderFocus = '', advancedDirty = false;
  // レベルと作業の種類の編集の状態。描き直しても続く（selLv: 候補を出しているレベル）
  const ui = { selLv: null, renLv: false, delLv: null, delTo: null, openKind: null, delKind: null };
  // 自動選択の面で押した部品（描き直したときにフォーカスを戻す）
  let judgeFocus = '', levelMenu = null;
  const names = { backend: id => labelOf(id), model: (backend, model) => modelName(backend, model) || model };

  // ---- 設定の中のレベル・作業の種類 ----
  const levels = () => data?.settings.levels ?? [];
  const kinds = () => data?.settings.kinds ?? [];
  const levelAt = id => levels().findIndex(l => l.id === id);
  const kindAt = id => kinds().find(k => k.id === id) ?? null;
  /** レベルの見せ方。名前が無ければ「レベル N」（上から何番目か。並べ替えると番号だけ変わる） */
  const levelName = id => {
    const i = levelAt(id);
    return i < 0 ? tierText(id) : levels()[i].name || t('routing.settings.levelName', { n: i + 1 });
  };
  /** レベルの番号（表のセル・メニューの右の hint。見つからなければ短い名前） */
  const levelPos = id => { const i = levelAt(id); return i < 0 ? tierText(id) : String(i + 1); };
  /** 作業の種類の見せ方。設定の名前 → 辞書（既定の種類）→ id */
  const kindName = id => kindText(id, kindAt(id)?.name || null);
  const selLevel = () => {
    const list = levels();
    if (!list.some(l => l.id === ui.selLv)) ui.selLv = list[0]?.id ?? null;
    return ui.selLv;
  };

  // ---- 骨組み
  const sw = button('', () => save({ enabled: !data?.settings.enabled }), 'cx-sw');
  sw.id = 'routingEnable';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('routing.settings.enable'));
  const swLabel = el('label', 'rm-switch-label', t('routing.settings.enable'));
  swLabel.htmlFor = 'routingEnable';
  const head = el('div', 'rm-switch');
  // まだ一度も読めていない間の場所取り。「オフ」に見える偽のスイッチを出さない（docs/design-system.md の場所取り）
  const skel = el('span', 'rm-skel');
  skel.setAttribute('role', 'img');
  skel.setAttribute('aria-label', t('routing.settings.loading'));
  head.append(swLabel, skel, sw);
  const stateLine = el('p', 'rm-state rm-strong');
  stateLine.setAttribute('role', 'status');
  stateLine.setAttribute('aria-live', 'polite');
  // 初回の読み込みが失敗したときの「再試行」（設定 › Pleiad Plus と同じ）
  const retry = button(t('routing.settings.retry'), () => refresh(), 'btn btn-quiet rt-load-retry');
  // 自動で選ぶのに効いていない理由（自動選択に使うキーが無い・使える候補が無い）。スイッチの直下に、問題があるときだけ ⚠ と直す入口
  const effective = el('div', 'rt-eff');
  effective.setAttribute('role', 'status');

  const judges = el('section', 'mp-panel rt-judges');
  const keys = el('section', 'mp-panel rt-keys');
  const advanced = el('details', 'mp-panel rt-advanced');
  const summary = el('summary', null, t('routing.settings.advanced'));
  const advancedBody = el('div');
  advanced.append(summary, advancedBody);
  const reset = el('div', 'rt-reset');
  const orderStatus = el('div', 'visually-hidden');
  orderStatus.setAttribute('role', 'status'); orderStatus.setAttribute('aria-live', 'polite'); orderStatus.setAttribute('aria-atomic', 'true');
  const announceOrder = text => { orderStatus.textContent = text; };
  root.append(head, stateLine, effective, judges, keys, advanced, reset, orderStatus);
  const ordering = createReorder({ root: advancedBody, rowSelector: '.rt-cand-row', idOf: row => row.dataset.candidate,
    current: tier => data?.settings.tiers[tier] ?? [], showMenu, announce: announceOrder,
    move: changeOrder, settled: focus => {
      if (focus) orderFocus = focus;
      if (focus || advancedDirty) paintAdvanced();
    } });
  function changeOrder(tier, candidate, to) {
    const next = moveItem(data.settings.tiers[tier], candidate, to);
    if (!next) return;
    orderFocus = `order|${tier}|${candidate}`;
    saveNested('tiers', { ...data.settings.tiers, [tier]: next });
    announceOrder(t('common.reorder.moved', { name: candidateName(candidate), position: to + 1 }));
  }

  async function refresh(args = {}) {
    const serial = ++refreshSerial;
    // まだ何も出せていないときの取り直し（初回・失敗のあと）は、場所取りに戻す
    if (!data) { message = ''; paint(); }
    try {
      const latest = await cmd('delegationRouting', args);
      if (serial !== refreshSerial) return;
      committed = latest;
      data = { ...latest, settings: pending.reduce((s, patch) => applyPatch(s, patch, latest.defaults), latest.settings) };
      message = '';
      // 分かっている設定は先に出す（キー一覧・候補の名前・使用量の表示は届き次第足す）
      paint();
      // 選べるキー。取れなくても自動選択の設定は見せる（選ぶ欄だけ使えない）
      keyList = await apiKeyList(cmd).catch(() => null);
    }
    catch (e) { message = t('routing.settings.loadFailed', { error: e.message }); }
    // 候補の名前は語彙から。まだ読んでいないエージェントの分を読んでから描く
    await Promise.all([...new Set((data?.candidates ?? []).map(c => c.backend).filter(Boolean))].map(b => modelsOf(b).catch(() => null)));
    if (serial === refreshSerial) paint();
  }
  async function save(patch) {
    if (!data) return;
    pending.push(patch);
    data = { ...data, settings: applyPatch(data.settings, patch, data.defaults) };
    message = '';
    paint();
    if (saving) return;
    saving = true;
    while (pending.length) {
      const next = pending[0];
      try {
        committed = await cmd('setDelegationRouting', { settings: next });
        message = '';
      } catch (e) {
        message = t('routing.settings.saveFailed', { error: e.message });
      }
      pending.shift();
      data = { ...committed, settings: pending.reduce((s, item) => applyPatch(s, item, committed.defaults), committed.settings) };
      paint();
    }
    saving = false;
  }
  /** 入れ子の設定（tiers・table・efforts）を変えたとき。既定と同じ項目は送らず、全部既定なら null で既定に戻す */
  const saveNested = (key, value) => save({ [key]: diffFromDefaults(value, data.defaults[key]) });
  const saveEfforts = efforts => saveNested('efforts', efforts);
  /** レベル・作業の種類の一覧を変えたとき（追加・削除・並べ替え）。配列なので既定と違えば丸ごと送る */
  const saveLevels = (list, extra = {}) => save({ levels: diffFromDefaults(list, data.defaults.levels), ...extra });
  const saveKinds = (list, extra = {}) => save({ kinds: diffFromDefaults(list, data.defaults.kinds), ...extra });

  // ---- 描く
  function paint() {
    const s = data?.settings;
    // まだ一度も読めていない間は、値を出さず場所取りと読み上げ（aria-busy・「読み込んでいます」）にする。
    // 読めた後の取り直しでは、前の値を出したまま待つ
    const loading = !s && !message;
    if (loading) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
    skel.hidden = !loading;
    sw.hidden = !s;
    if (s) sw.setAttribute('aria-checked', String(Boolean(s.enabled))); else sw.removeAttribute('aria-checked');
    sw.disabled = !s;
    stateLine.textContent = message;
    // 初回が失敗して何も出せないときだけ「再試行」を出す（読めた後の更新失敗は今の値を見せ続ける）
    if (message && !s) stateLine.append(' ', retry);
    stateLine.hidden = !message;
    paintEffective();
    if (!s) { for (const p of [judges, keys, advanced, reset]) p.hidden = true; return; }
    for (const p of [judges, keys, advanced, reset]) p.hidden = false;
    // 入力の途中（欄にフォーカス）で描き直すと打った値が消えるので、そのときは面ごとに飛ばす。
    // 自動選択の面には打つ欄が無いので常に描き直す（押したボタンにフォーカスが残り、選び直しが画面に出なかった）
    paintJudges();
    if (!keys.contains(document.activeElement) || !registering) paintKeys();
    if (!advancedBody.contains(document.activeElement) || !document.activeElement.matches('input,textarea')) paintAdvanced();
    paintReset();
  }

  // ---- 難しさの判定（1 つのモデル。しないも可）
  function paintJudges() {
    const s = data.settings;
    const active = document.activeElement;
    const focusKey = judgeFocus || (active && judges.contains(active) ? active.dataset?.focusKey ?? '' : '');
    const label = el('span', null, t('routing.settings.judgeModel'));
    label.id = 'rt-judge-label';
    const options = [...new Set([data.defaults.judge, s.judge].filter(j => j && j !== JUDGE_NONE))];
    const sel = pillMenu({ focusKey: 'judge', ariaDescribedBy: 'rt-judge-label',
      shown: s.judge === JUDGE_NONE ? t('routing.settings.judgeNone') : s.judge,
      items: [...options.map(j => ({ label: j, checked: s.judge === j, onClick: () => pick(j) })),
        { sep: true }, { label: t('routing.settings.judgeNone'), checked: s.judge === JUDGE_NONE, onClick: () => pick(JUDGE_NONE) }],
      title: t('routing.settings.judgeModel') });
    function pick(j) { if (s.judge !== j) { judgeFocus = 'judge'; save({ judge: j === data.defaults.judge ? null : j }); } }
    const row = el('div', 'rt-judge-row');
    row.append(label, sel);
    judges.replaceChildren(el('h3', null, t('routing.settings.judgeTitle')), row);
    judgeFocus = '';
    if (focusKey) judges.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }
  /** 「段の既定」と同じ pill + メニュー。focusKey で描き直しの後にフォーカスを戻す */
  function pillMenu({ shown, items, title, focusKey = '', ariaLabel = '', ariaDescribedBy = '' }) {
    const b = button('', e => {
      b.focus({ preventScroll: true });
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, items, title, { onClose: () => b.setAttribute('aria-expanded', 'false') });
      b.setAttribute('aria-expanded', 'true');
    }, 'ef-btn');
    b.dataset.focusKey = focusKey;
    b.setAttribute('aria-haspopup', 'menu');
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    if (ariaDescribedBy) b.setAttribute('aria-describedby', ariaDescribedBy);
    b.append(el('span', 'ef-v', shown), chev());
    b.setAttribute('aria-expanded', 'false');
    return b;
  }
  const chev = () => {
    const s = el('span', 'ef-chev');
    s.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return s;
  };

  /**
   * スイッチの直下の「効いていない理由」。オンのときだけ、判定に使うモデルのキーが無い・使える候補が無い、を 1 行ずつ。
   * 右に直す入口（キーの登録の欄を開く・詳しい設定の候補へ）。平常時・オフのときは何も出さない（docs/design-system.md「設定 › 委譲」）
   */
  function paintEffective() {
    const s = data?.settings;
    const lines = [];
    if (s?.enabled) {
      if (s.judge !== JUDGE_NONE && !data.key?.hasKey)
        lines.push(effLine(t('routing.settings.effective.noKey'), t('apiKeys.delegation.selectKey'), goKey));
      if (!data.candidates.some(c => c.usable))
        lines.push(effLine(t('routing.settings.effective.noCandidates'), t('routing.settings.effective.viewCandidates'), goCandidates));
    }
    effective.replaceChildren(...lines);
    effective.hidden = !lines.length;
  }
  function effLine(text, action, onClick) {
    const p = el('p', null, `⚠ ${text}`);
    p.append(button(action, onClick, 'btn link'));
    return p;
  }
  /** 自動選択に使うキーのカードへ移り、「使うキー」の選択を開いてフォーカス */
  function goKey() {
    const select = keys.querySelector(`[data-fk="sel:${SERVICE}"]`);
    keys.scrollIntoView({ block: 'start', behavior: 'smooth' });
    select?.focus({ preventScroll: true });
    select?.click();
  }
  /** 「詳しい設定」を開いてレベルの候補へ */
  function goCandidates() {
    advanced.open = true;
    advanced.scrollIntoView({ block: 'start', behavior: 'smooth' });
    summary.focus({ preventScroll: true });
  }

  function paintKeys() {
    const out = [el('div', 'rm-gh', t('apiKeys.delegation.title'))];
    const deferred = keyList?.migration?.state === 'deferred';
    const rows = [];
    const name = t('routing.settings.service.openrouter');
    const info = data.key ?? {};
    // 仮想のキー「Pleiad Plus」（state: off・AGENT_HOST_PLUS=0 なら行ごと出さない。docs/plus.md「画面の行」）
    if (plusRowVisible(info.plus)) {
      const { row } = plusKeyRow({ info: info.plus, checked: info.via === 'plus',
        onChoose: () => chooseKey('plus'), onLogin: () => cmd('plusLogin').catch(() => {}) });
      rows.push(row);
    }
    // OpenRouter（今の登録の道。選ぶと via: 'key'）
    const choices = (keyList?.keys ?? []).filter(k => k.provider === SERVICE);
    const current = choices.find(k => k.id === info.keyRef) ?? null;
    if (deferred) {
      rows.push(keyRadioRow({ name, checked: info.via === 'key', disabled: true,
        sub: info.hasKey ? t('apiKeys.deferredInUse') : t('apiKeys.deferredShort') }));
    } else {
      const sel = keySelect({ keys: choices, current: current?.id ?? null, noneLabel: choices.length ? undefined : t('apiKeys.delegation.selectKey'),
        label: t('apiKeys.delegation.selectLabel', { service: name }), focusKey: `sel:${SERVICE}`,
        provider: SERVICE, choose: id => chooseKey(id),
        register: () => { registering = true; paintKeys(); keys.querySelector('.rt-key-form input')?.focus(); } });
      const sub = el('span');
      if (info.via === 'key' && current) { const small = statusLine(current); small.append(' · ', manageLink(openPage)); sub.append(small); }
      else if (!current) sub.append(t('apiKeys.delegation.selectKey'));
      const orRow = keyRadioRow({ name, checked: info.via === 'key', disabled: !keyList, sub, end: sel.element,
        onChoose: () => { sel.open(); }, focusKey: `row:${SERVICE}` });
      // 行のどこを押してもキーの選択を開く（選択そのものは sel 内のクリック）
      sel.element.addEventListener('click', e => e.stopPropagation());
      rows.push(orRow);
      if (registering && keyList) {
        rows.push(registerForm({ provider: SERVICE, label: t('routing.settings.keyInput', { service: name }), storage: keyList.storage ?? data.storage, focusKey: `regin:${SERVICE}`,
          onSubmit: value => registerKey(value), onCancel: () => { registering = false; paintKeys(); keys.querySelector(`[data-fk="sel:${SERVICE}"]`)?.focus(); } }));
      }
    }
    out.push(keyRadioGroup(t('apiKeys.delegation.title'), rows));
    // 外部送信の同意はキーを選ぶこと（知らないと事故になるので 1 行だけ）。暗号化の注意は設定 › API キーへ移った
    out.push(el('p', 'mp-note', t('apiKeys.delegation.note')));
    keys.replaceChildren(...out);
  }
  /** 自動選択に使うキーを選ぶ（null は使わない。'plus' は仮想のキー Pleiad Plus）。選んだときから送り始める */
  async function chooseKey(id) {
    message = '';
    // 登録欄を開いたまま別の行を選んだときも、畳んでから描き直す（登録中は paintKeys が飛ばされて印が動かない）
    registering = false;
    try { await cmd('setApiKeyUse', { use: JUDGE_USE, id }); await refresh(); }
    catch (e) { message = t('routing.settings.saveFailed', { error: e.message }); paint(); }
    keys.querySelector(`[data-fk="${id === 'plus' ? 'plus' : `sel:${SERVICE}`}"]`)?.focus({ preventScroll: true });
  }
  /** その場で登録して、自動選択に使う（登録先は API キー） */
  async function registerKey(value) {
    message = '';
    try {
      const { id } = await cmd('setApiKey', { provider: SERVICE, label: '', key: value });
      await cmd('setApiKeyUse', { use: JUDGE_USE, id });
      registering = false;
      await cmd('invoke', { op: 'apiKeys.check', args: { id } }).catch(() => null);
      await refresh();
    } catch (e) { message = t('routing.settings.saveFailed', { error: e.message }); paint(); }
    keys.querySelector(`[data-fk="sel:${SERVICE}"]`)?.focus({ preventScroll: true });
  }

  // ---- 詳しい設定
  function paintAdvanced() {
    if (ordering.busy) { advancedDirty = true; return; }
    advancedDirty = false;
    const s = data.settings;
    // 強さの選択を押した後の描き直しで、押した部品へフォーカスを戻す
    const focused = orderFocus || (advancedBody.contains(document.activeElement) ? document.activeElement.dataset?.fk ?? '' : '');
    orderFocus = '';
    const out = [];
    // レベルごとの候補（見出しで選んだ 1 つのレベルだけを出す）
    const tiersHead = el('div', 'rt-sub-head');
    tiersHead.append(el('h3', null, t('routing.settings.levelsTitle')));
    out.push(tiersHead);
    const at = data.candidates.map(c => c.checkedAt).filter(Boolean).sort()[0];
    const usageLine = el('div', 'rt-usage-at');
    usageLine.append(el('small', null, at ? t('routing.settings.usageAt', { time: fmt.time(at, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('routing.settings.usageNever')));
    const again = button(refreshing ? t('routing.settings.refreshing') : t('routing.settings.refresh'), async () => {
      refreshing = true; paintAdvanced();
      await refresh({ refresh: true });
      refreshing = false; paintAdvanced();
    }, 'btn rt-refresh');
    again.disabled = refreshing || !s.enabled;
    usageLine.append(again);
    out.push(usageLine);
    out.push(levelBlock(selLevel()));
    // 作業の種類 × 難しさ
    out.push(el('h3', 'rt-sub-title', t('routing.settings.tableTitle')));
    out.push(tableBlock());
    const addKind = button(t('routing.settings.kindAdd'), () => addKind_(), 'btn rt-add');
    out.push(addKind);
    // 使用量の方針
    out.push(el('h3', 'rt-sub-title', t('routing.settings.policyTitle')));
    const policy = el('div', 'rt-policy');
    policy.append(numberField('avoidPercent', t('routing.settings.avoid'), t('routing.settings.avoidUnit'), { min: 1, max: 100, step: 1 }),
      numberField('paceLimit', t('routing.settings.pace'), t('routing.settings.paceUnit'), { min: 0.1, max: 10, step: 0.1 }));
    out.push(policy);
    advancedBody.replaceChildren(...out);
    if (focused) [...advancedBody.querySelectorAll('button')].find(b => b.dataset?.fk === focused)?.focus({ preventScroll: true });
    if (levelMenu) {
      advancedBody.querySelector('[data-fk="lvsel"]')?.setAttribute('aria-expanded', 'true');
      levelMenu(levelSelectItems());
    }
  }
  function stateOf(candidate) { return data.candidates.find(c => c.candidate === candidate) ?? null; }
  // ---- アカウント（ADR 0264）。アカウントを登録したエージェント（data.accounts にある）の候補は、アカウント 1 つの単位。
  // 書かない候補はログイン中のアカウント。登録の無いエージェントはアカウントを出さない
  const accountsOf = backend => data.accounts?.[backend] ?? null;
  const candidateOf = (backend, model, account) => `${backend}${account ? `@${account}` : ''}:${model}`;
  const scopedOf = ({ backend, account }) => Boolean(accountsOf(backend)) || account != null;
  /** アカウントの名前。ログイン中は「ログイン中のアカウント」（登録の誰かと同じ人と分かれば「（personal）」を添える） */
  function accountText(backend, account) {
    const row = accountsOf(backend)?.find(a => a.account === (account ?? ''));
    if (!account) return row?.sameAs ? t('routing.settings.accountLoginSame', { name: row.sameAs }) : t('routing.settings.accountLogin');
    return row?.name ?? account;
  }
  /** 候補の名前の文字（「Sonnet · personal」）。読み上げ・並べ替えの知らせ・強さの見出しに使う */
  function candidateName(candidate) {
    const parsed = splitCandidate(candidate);
    const model = names.model(parsed.backend, parsed.model);
    return scopedOf(parsed) ? [model, accountText(parsed.backend, parsed.account)].join(t('routing.line.join')) : model;
  }
  /** 候補の名前の要素。アカウントは区切りの後ろで折り返す（狭い画面ではアカウントが次の行へ。区切りの前は改行しない空白） */
  function candidateLabel(candidate) {
    const parsed = splitCandidate(candidate);
    const label = el('span', 'rt-label');
    label.append(names.model(parsed.backend, parsed.model));
    if (scopedOf(parsed)) label.append(' ', el('span', 'rt-dot', '·'), ' ', el('span', 'rt-acct', accountText(parsed.backend, parsed.account)));
    return label;
  }
  /**
   * 候補の下の行。アカウントを持つ候補はそのアカウントの使用量だけ（エージェントの名前は付けない）。
   * 登録したアカウントのトークンが無ければ「使えない（認証情報なし） · ログインし直す」
   */
  function candidateUsage(candidate) {
    const st = stateOf(candidate);
    const parsed = splitCandidate(candidate);
    const scoped = scopedOf(parsed);
    const join = t('routing.line.join');
    const sub = scoped ? [] : [labelOf(parsed.backend)];
    if (st?.usable) {
      if (st.deferred) sub.push(t('routing.settings.lowHeadroom', { reason: skipText(st.reason) }));
      const u = usageSummary(st); if (u) sub.push(u);
    }
    else if (st) sub.push(skipText(st.reason, st.detail));
    // 一覧に見当たらない（注意。振り分けは飛ばさず、使えるかは CLI が決める）
    if (st?.modelNotListed) sub.push(skipText('model_unknown'));
    if (!sub.length) return { st, lines: [] };
    const relogin = scoped && parsed.account && st?.detail === 'no_token' ? parsed.account : '';
    return { st, lines: [{ text: (st?.modelNotListed ? '⚠ ' : '') + sub.join(join), strong: Boolean(st?.modelNotListed), relogin }] };
  }
  const usageLines = (candidate, lines) => lines.map(line => {
    const small = el('small', line.strong ? 'rt-strong' : null, line.text);
    if (line.relogin) {
      const { backend } = splitCandidate(candidate);
      const go = button(t('routing.settings.relogin'), () => openAccount(backend, line.relogin), 'btn link rt-relogin');
      go.setAttribute('aria-label', t('routing.settings.reloginLabel', { account: accountText(backend, line.relogin) }));
      small.append(t('routing.line.join'), go);
    }
    return small;
  });
  function paintUsage() {
    paintEffective();
    const at = data.candidates.map(c => c.checkedAt).filter(Boolean).sort()[0];
    const stamp = advancedBody.querySelector('.rt-usage-at')?.querySelector('small');
    if (stamp) stamp.textContent = at ? t('routing.settings.usageAt', { time: fmt.time(at, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('routing.settings.usageNever');
    for (const row of advancedBody.querySelectorAll('.rt-cand-row')) {
      const { st, lines } = candidateUsage(row.dataset.candidate);
      row.classList.toggle('off', Boolean(st && !st.usable));
      const info = row.querySelector('.rt-cand-info');
      if (!info) continue;
      // 押せる「ログインし直す」にフォーカスがあれば、描き直しても同じ候補の同じ部品へ戻す
      const had = info.contains(document.activeElement) && document.activeElement.matches('.rt-relogin');
      for (const small of info.querySelectorAll('small')) small.remove();
      info.append(...usageLines(row.dataset.candidate, lines));
      if (had) info.querySelector('.rt-relogin')?.focus({ preventScroll: true });
    }
  }

  // ---- レベル（選択肢の行ごとの ⋯ で名前の変更・移動・削除）
  /** レベルの候補のブロック。見出しは「選ぶ pill + レベルの既定」 */
  function levelBlock(lv) {
    const block = el('div', 'rt-tier');
    if (lv) block.dataset.tier = lv;
    const list = data.settings.tiers[lv] ?? [];
    const i = levelAt(lv);
    const head = el('div', 'rt-tier-head');
    if (ui.renLv && lv) {
      // 名前の変更：見出しの pill と同じ大きさの入力欄。Enter / 外すで確定（空なら変えない）、Esc でやめる
      const input = el('input', 'rt-lv-in');
      input.type = 'text'; input.value = levels()[i]?.name ?? levelName(lv);
      input.dataset.fk = 'lvin';
      input.setAttribute('aria-label', t('routing.settings.levelRenameAria'));
      let done = false;
      const commit = keep => {
        if (done) return; done = true;
        const v = input.value.trim();
        if (keep && v && v !== levels()[i]?.name) {
          const next = levels().map(l => l.id === lv ? { ...l, name: v } : l);
          ui.renLv = false;
          saveLevels(next);
        } else ui.renLv = false;
        paintAdvanced();
        advancedBody.querySelector('[data-fk="lvsel"]')?.focus({ preventScroll: true });
      };
      input.onkeydown = e => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(e.key === 'Enter'); }
      };
      input.onblur = () => commit(true);
      head.append(input);
      queueMicrotask(() => { input.focus({ preventScroll: true }); input.select(); });
    } else if (lv) {
      const sel = pillMenu({ shown: levelName(lv), focusKey: 'lvsel', ariaLabel: t('routing.settings.levelSelect', { name: levelName(lv) }) });
      sel.dataset.fk = 'lvsel';
      sel.onclick = () => openLevelSelect(sel);
      sel.dataset.lvSel = '1';
      head.append(sel);
      head.append(levelEffortSelect(lv, list));
    } else {
      head.append(el('span', 'rt-tier-name', t('routing.settings.levelEmpty')));
    }
    block.append(head);
    // レベルの削除のその場の確認（使っている作業の種類があれば移し先を添える）
    if (lv && ui.delLv === lv) block.append(levelDeleteConfirm(lv));
    const rows = el('ol', 'rt-cand-list');
    if (lv) rows.setAttribute('aria-label', t('routing.settings.levelCandidates', { name: levelName(lv) }));
    list.forEach((candidate, j) => {
      const { backend } = splitCandidate(candidate);
      const st = stateOf(candidate);
      const name = candidateName(candidate);
      const row = el('li', 'rt-cand-row' + (st && !st.usable ? ' off' : ''));
      row.dataset.candidate = candidate;
      const info = el('div', 'rt-cand-info');
      const title = el('span', 'rt-cand-name');
      title.append(el('span', 'rt-n', `${j + 1}.`), logo(backend), candidateLabel(candidate));
      title.title = candidate;
      const usage = candidateUsage(candidate);
      info.append(title, ...usageLines(candidate, usage.lines));
      const actions = el('div', 'rt-cand-actions');
      const remove = button('', () => saveNested('tiers', { ...data.settings.tiers, [lv]: list.filter(c => c !== candidate) }), 'btn btn-icon rt-move');
      remove.setAttribute('aria-label', t('routing.settings.candidateRemove', { name }));
      remove.title = remove.getAttribute('aria-label');
      remove.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.disabled = false;
      actions.append(remove);
      const effort = el('div', 'rt-cand-effort');
      effort.append(candidateEffortSelect(lv, candidate, name));
      row.append(ordering.handle(lv, candidate, name), info, effort, actions);
      rows.append(row);
    });
    if (!list.length) block.append(el('p', 'mp-note', t('routing.settings.empty')));
    else block.append(rows);
    const add = button(t('routing.settings.addCandidate'), e => addMenu(lv, e.currentTarget), 'btn rt-add');
    add.disabled = !lv;
    block.append(add);
    return block;
  }
  /** 一覧の行で選択、右の ⋯ でそのレベルを編集する。追加は一覧の末尾 */
  function openLevelSelect(anchor) {
    const r = anchor.getBoundingClientRect();
    anchor.focus({ preventScroll: true });
    anchor.setAttribute('aria-expanded', 'true');
    levelMenu = showMenu(r.left, r.bottom + 4, levelSelectItems(), null, {
      opener: () => advancedBody.querySelector('[data-fk="lvsel"]'),
      onClose: () => { levelMenu = null; advancedBody.querySelector('[data-fk="lvsel"]')?.setAttribute('aria-expanded', 'false'); },
    });
  }
  function levelSelectItems() {
    return [
      ...levels().map(l => ({ key: l.id, label: levelName(l.id), checked: l.id === selLevel(),
        onClick: () => { ui.selLv = l.id; ui.delLv = null; paintAdvanced(); advancedBody.querySelector('[data-fk="lvsel"]')?.focus({ preventScroll: true }); },
        action: { label: t('routing.settings.levelActions', { name: levelName(l.id) }), sub: () => levelActions(l.id) } })),
      { sep: true }, { label: t('routing.settings.levelAdd'), disabled: levels().length >= LEVELS_MAX, onClick: addLevel },
    ];
  }
  function levelActions(lv) {
    const i = levelAt(lv), n = levels().length;
    return [
      { label: t('routing.settings.levelRename'), onClick: () => { ui.selLv = lv; ui.renLv = true; ui.delLv = null; paintAdvanced(); } },
      { label: t('routing.settings.levelUp'), disabled: i <= 0, keepOpen: true, onClick: () => moveLevel(lv, -1) },
      { label: t('routing.settings.levelDown'), disabled: i >= n - 1, keepOpen: true, onClick: () => moveLevel(lv, 1) },
      { sep: true },
      { label: t('routing.settings.levelDelete'), disabled: !lv || n < 2, danger: true, onClick: () => {
        ui.selLv = lv; ui.delLv = lv; ui.renLv = false;
        ui.delTo = (levels()[i + 1] ?? levels()[i - 1])?.id ?? null;
        paintAdvanced();
        advancedBody.querySelector('.mp-confirm .btn')?.focus({ preventScroll: true });
      } },
    ];
  }
  function moveLevel(lv, d) {
    const i = levelAt(lv), j = i + d;
    if (i < 0 || j < 0 || j >= levels().length) return;
    const next = [...levels()];
    const [x] = next.splice(i, 1); next.splice(j, 0, x);
    announceOrder(t('routing.settings.levelMoved', { name: levelName(lv), position: j + 1 }));
    saveLevels(next);
  }
  function addLevel() {
    const list = levels();
    let n = list.length + 1;
    while (list.some(l => l.name === t('routing.settings.levelName', { n }))) n++;
    const lv = { id: newId('l'), name: t('routing.settings.levelName', { n }) };
    const last = list.at(-1);
    const tiers = { ...data.settings.tiers, [lv.id]: [] };
    const efforts = { ...data.settings.efforts, [lv.id]: { '*': data.settings.efforts?.[last?.id]?.['*'] ?? '' } };
    ui.selLv = lv.id; ui.renLv = true; ui.delLv = null;
    saveLevels([...list, lv], { tiers: diffFromDefaults(tiers, data.defaults.tiers), efforts: diffFromDefaults(efforts, data.defaults.efforts) });
    announceOrder(t('routing.settings.levelAdded', { name: lv.name }));
  }
  function levelDeleteConfirm(lv) {
    const users = kinds().filter(k => (data.settings.table[k.id] ?? []).includes(lv));
    const to = ui.delTo && ui.delTo !== lv && levelAt(ui.delTo) >= 0 ? ui.delTo : (levels().find(l => l.id !== lv)?.id ?? null);
    const box = el('div', 'mp-confirm');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('routing.settings.levelDeleteAria'));
    box.append(el('p', 'q', t('routing.settings.levelDelConfirm', { name: levelName(lv) })));
    if (users.length && to) {
      const line = el('span', 'to');
      line.append(t('routing.settings.levelDelTo', { names: users.map(k => kindName(k.id)).join(t('routing.settings.nameJoin')) }));
      const sel = pillMenu({ shown: levelName(to), ariaLabel: t('routing.settings.levelDelToAria', { name: levelName(to) }),
        title: t('routing.settings.levelDelToTitle'),
        items: levels().filter(l => l.id !== lv).map((l, j) => ({ label: l.name || t('routing.settings.levelName', { n: levelAt(l.id) + 1 }), hint: String(levelAt(l.id) + 1), checked: l.id === to,
          onClick: () => { ui.delTo = l.id; paintAdvanced(); advancedBody.querySelector('[data-fk="delto"]')?.focus({ preventScroll: true }); } })),
        focusKey: 'delto' });
      sel.dataset.fk = 'delto';
      line.append(sel);
      box.append(line);
    }
    const acts = el('span', 'acts');
    acts.append(button(t('routing.settings.delCancel'), () => { ui.delLv = null; paintAdvanced(); advancedBody.querySelector('[data-fk="lvsel"]')?.focus({ preventScroll: true }); }),
      button(t('routing.settings.delYes'), () => deleteLevel(lv, to), 'btn danger'));
    box.append(acts);
    return box;
  }
  function deleteLevel(lv, to) {
    const name = levelName(lv);
    const next = levels().filter(l => l.id !== lv);
    const tiers = { ...data.settings.tiers }; delete tiers[lv];
    const efforts = { ...data.settings.efforts }; delete efforts[lv];
    const table = Object.fromEntries(Object.entries(data.settings.table).map(([k, row]) => [k, row.map(x => x === lv ? to : x)]));
    ui.selLv = to ?? next[0]?.id ?? null; ui.delLv = null; ui.delTo = null;
    saveLevels(next, { tiers: diffFromDefaults(tiers, data.defaults.tiers), efforts: diffFromDefaults(efforts, data.defaults.efforts), table: diffFromDefaults(table, data.defaults.table) });
    announceOrder(t('routing.settings.levelDeleted', { name }));
  }

  // ---- 思考の強さ（ADR 0164。決め方は web/delegation-effort.mjs・サーバーの decideEffort と同じ）
  const conversationOf = backend => data.conversationEfforts?.[backend] ?? '';
  /** レベルの見出しの右の「レベルの既定」。レベルの中の候補は、上書きが無ければこの値で走る */
  function levelEffortSelect(lv, list) {
    const { value, changed } = tierEffort({ settings: data.settings, defaults: data.defaults, tier: lv });
    const shown = value === '' ? t('routing.effort.conversation') : value;
    const name = levelName(lv);
    // 会話の既定はエージェントごとに違うので、レベルの候補が同じ値のときだけ「今は X」と出す
    const nows = [...new Set(list.map(c => conversationOf(splitCandidate(c).backend) || t('routing.effort.unset')))];
    const recommended = data.defaults.efforts?.[lv]?.['*'] ?? '';
    const pick = v => () => { sel.button.focus(); saveEfforts(withEffort(data.settings.efforts, lv, '*', v)); };
    const sel = effortSelect({ focusKey: `${lv}|*`, changed, align: 'right',
      label: t('routing.effort.tierLabel', { tier: name, value: shown }), head: t('routing.effort.tierHead', { tier: name }),
      parts: [{ text: t('routing.effort.tierDefault') }, { text: shown, cls: 'ef-v' }],
      rows: [{ label: t('routing.effort.followConversation'), hint: nows.length === 1 ? t('routing.effort.now', { value: nows[0] }) : t('routing.effort.perAgent'), on: value === '', pick: pick('') },
        { sep: true },
        ...EFFORT_LEVELS.map(l => ({ label: l, hint: l === recommended ? t('routing.effort.recommended') : '', on: value === l, pick: pick(l) })),
        { foot: t('routing.effort.fitNote') }] });
    return sel.element;
  }
  /** 候補の行の右の強さ。選べない候補（強さを持たないモデル・強さがモデル名に入るもの）は選択を出さず、理由を 1 語 */
  function candidateEffortSelect(tier, candidate, name) {
    const { backend } = splitCandidate(candidate);
    const e = candidateEffort({ settings: data.settings, tier, candidate, capability: stateOf(candidate)?.effort, conversation: conversationOf(backend) });
    if (e.kind === 'fixed') return effortFixed({ value: e.value, reason: t('routing.effort.byModel'), title: t('routing.effort.byModelTitle') });
    if (e.kind === 'none') return effortFixed({ reason: t('routing.effort.none'), title: t('routing.effort.noneTitle') });
    const value = e.value ?? t('routing.effort.modelDefault');
    const note = [e.source === 'tier' ? t('routing.effort.sourceTier') : e.source === 'conversation' ? t('routing.effort.sourceConversation') : '',
      e.asked ? t('routing.effort.adjusted', { asked: e.asked, value: e.value ?? '—' }) : ''].filter(Boolean).join(' ');
    const pick = v => () => { sel.button.focus(); saveEfforts(withEffort(data.settings.efforts, tier, candidate, v)); };
    const sel = effortSelect({ focusKey: `${tier}|${candidate}`, changed: e.changed, align: 'right',
      label: t('routing.effort.candLabel', { name, value, source: note }).trim(),
      head: t('routing.effort.candHead', { name, tier: levelName(tier) }),
      parts: [{ text: t('routing.effort.label') }, { text: value, cls: 'ef-v' }, ...(note ? [{ text: note, cls: 'ef-s' }] : [])],
      rows: [{ label: t('routing.effort.followTier'), hint: e.tierDefault === '' ? t('routing.effort.convShort') : e.tierValue ?? '', on: e.own === undefined, pick: pick(undefined) },
        { label: t('routing.effort.followConversation'), hint: t('routing.effort.now', { value: e.conversationValue ?? t('routing.effort.unset') }), on: e.own === '', pick: pick('') },
        { sep: true },
        ...e.options.map(l => ({ label: l, on: e.own === l, pick: pick(l) }))] });
    return sel.element;
  }
  /**
   * 候補を足すメニュー。エージェント ▸ モデル（▸ アカウント）と、backend:model を打ち込む欄。レベルにもうある組み合わせは出さず、
   * アカウントを登録したエージェントは、どのアカウントもレベルにあるモデルを出さない。打ち込んだエージェントにアカウントが複数あれば、
   * Enter の後にアカウントを選ぶ（ADR 0264）
   */
  async function addMenu(tier, anchor) {
    const list = data.settings.tiers[tier] ?? [];
    const r = anchor.getBoundingClientRect();
    const backends = [...new Set([...agents(), ...data.candidates.map(c => c.backend)].filter(Boolean))];
    const add = candidate => saveNested('tiers', { ...data.settings.tiers, [tier]: [...list, candidate] });
    // そのモデルで、まだレベルに無いアカウント（登録の無いエージェントは「アカウント無し」の 1 つ）
    const free = (backend, model) => (accountsOf(backend) ?? [{ account: '' }]).filter(a => !list.includes(candidateOf(backend, model, a.account)));
    const accountItems = (backend, model) => free(backend, model).map(a => ({ label: accountText(backend, a.account),
      ...(a.ready ? {} : { hint: t('routing.unavailable.no_token') }), onClick: () => add(candidateOf(backend, model, a.account)) }));
    const items = await Promise.all(backends.map(async backend => {
      const models = await modelsOf(backend).catch(() => null);
      const ids = Object.keys(models ?? {}).filter(id => id && free(backend, id).length);
      const modelItem = id => {
        const label = models[id]?.label ?? id, hint = label === id ? '' : id;
        return accountsOf(backend) ? { label, hint, sub: () => accountItems(backend, id) } : { label, hint, onClick: () => add(candidateOf(backend, id, '')) };
      };
      return { label: labelOf(backend), sub: () => ids.length ? ids.map(modelItem) : [{ label: t('routing.settings.noModels'), disabled: true }] };
    }));
    const typed = v => {
      const parsed = splitCandidate(v);
      if (parsed.account != null || !parsed.model || !accountsOf(parsed.backend)) { add(v); return; }
      const rest = accountItems(parsed.backend, parsed.model);
      showMenu(r.left, r.bottom + 4, rest.length ? rest : [{ label: t('routing.settings.accountsAllAdded'), disabled: true }],
        names.model(parsed.backend, parsed.model));
    };
    showMenu(r.left, r.bottom + 4, [...items, { sep: true },
      { input: { placeholder: t('routing.settings.addInput'), onCommit: typed } }],
      t('routing.settings.addTitle', { tier: levelName(tier) }));
  }

  // ---- 作業の種類 × 難しさ（種類の名前を押すと、行の下に名前と説明の欄が開く）
  function tableBlock() {
    const wrap = el('div', 'table-wrap rt-table');
    const table = el('table');
    const headRow = el('tr');
    headRow.append(el('th', null, t('routing.settings.tableKind')), ...DIFFICULTIES.map(d => el('th', null, difficultyText(d))));
    const thead = el('thead');
    thead.append(headRow);
    const body = el('tbody');
    kinds().forEach((k, i) => {
      const ev = i % 2 ? ' ev' : '';
      const open = ui.openKind === k.id;
      const tr = el('tr', ev.trim() || null);
      const th = el('th');
      th.scope = 'row';
      const name = button('', () => { ui.openKind = open ? null : k.id; ui.delKind = null; paintAdvanced(); advancedBody.querySelector(`[data-fk="kname:${k.id}"]`)?.focus({ preventScroll: true }); }, 'rt-kind');
      name.dataset.fk = `kname:${k.id}`;
      name.setAttribute('aria-expanded', String(open));
      name.setAttribute('aria-controls', `rt-kind-ed-${k.id}`);
      name.append(el('span', 't', kindName(k.id)));
      th.append(name);
      tr.append(th);
      DIFFICULTIES.forEach((d, di) => {
        const lv = data.settings.table[k.id]?.[di];
        const td = el('td');
        const b = button(levelPos(lv), e => {
          const rect = e.currentTarget.getBoundingClientRect();
          showMenu(rect.left, rect.bottom + 4, levels().map((l, j) => ({ label: l.name || t('routing.settings.levelName', { n: j + 1 }), hint: String(j + 1), checked: l.id === lv,
            onClick: () => { if (l.id !== lv) { const row = [...data.settings.table[k.id]]; row[di] = l.id; saveNested('table', { ...data.settings.table, [k.id]: row }); } } })),
          `${kindName(k.id)} · ${difficultyText(d)}`);
        }, 'btn rt-cell');
        b.setAttribute('aria-label', t('routing.settings.tableCell', { kind: kindName(k.id), difficulty: difficultyText(d), tier: levelName(lv) }));
        td.append(b);
        tr.append(td);
      });
      body.append(tr);
      if (open) body.append(kindEditorRow(k, ev));
    });
    table.append(thead, body);
    wrap.append(table);
    return wrap;
  }
  /** 開いた作業の種類の欄（名前・AI に渡す説明・削除）。表の縞に合わせるため行にも ev を付ける */
  function kindEditorRow(k, ev) {
    const tr = el('tr', `rt-kind-ed${ev}`);
    tr.id = `rt-kind-ed-${k.id}`;
    const td = el('td');
    td.colSpan = DIFFICULTIES.length + 1;
    // 名前。空は戻す（「新しい作業の種類」にしない。欄の字と表の字がずれないよう、確定まで state は動かさない）
    const nameField = el('label', 'mp-field');
    nameField.append(el('span', null, t('routing.settings.kindName')));
    const nameIn = el('input');
    nameIn.type = 'text'; nameIn.value = k.name || kindName(k.id);
    nameIn.dataset.fk = `kin:${k.id}`;
    nameIn.onchange = () => {
      const v = nameIn.value.trim();
      if (!v || v === k.name) { nameIn.value = k.name || kindName(k.id); return; }
      saveKinds(kinds().map(x => x.id === k.id ? { ...x, name: v } : x));
    };
    nameField.append(nameIn);
    // 委譲を依頼する AI に渡す説明（空なら辞書の説明・名前）。字数は打つたびに足す
    const descField = el('label', 'mp-field');
    descField.append(el('span', null, t('routing.settings.kindDesc')));
    const area = el('textarea');
    area.rows = 2; area.maxLength = KIND_DESC_MAX; area.value = k.desc || data.kindDescriptions?.[k.id] || '';
    area.dataset.fk = `kdesc:${k.id}`;
    const countId = `rt-kind-cnt-${k.id}`;
    area.setAttribute('aria-describedby', countId);
    const count = el('small', 'rt-count', `${area.value.length} / ${KIND_DESC_MAX}`);
    count.id = countId;
    const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
    area.oninput = () => { count.textContent = `${area.value.length} / ${KIND_DESC_MAX}`; fit(); };
    area.onchange = () => { if (area.value !== k.desc) saveKinds(kinds().map(x => x.id === k.id ? { ...x, desc: area.value } : x)); };
    descField.append(area, count);
    td.append(nameField, descField);
    // 削除は開いた欄の中だけ（表に列を足さない）。その場の確認、最後の 1 つは消せない
    if (ui.delKind === k.id) {
      const box = el('div', 'mp-confirm');
      box.append(el('p', 'q', t('routing.settings.kindDelConfirm', { name: kindName(k.id) })));
      const acts = el('span', 'acts');
      acts.append(button(t('routing.settings.delCancel'), () => { ui.delKind = null; paintAdvanced(); advancedBody.querySelector(`[data-fk="kdel:${k.id}"]`)?.focus({ preventScroll: true }); }),
        button(t('routing.settings.delYes'), () => deleteKind(k), 'btn danger'));
      box.append(acts);
      td.append(box);
    } else {
      const foot = el('div', 'rt-kind-foot');
      const del = button(t('routing.settings.kindDelete'), () => { ui.delKind = k.id; paintAdvanced(); advancedBody.querySelector(`#rt-kind-ed-${k.id} .mp-confirm .btn`)?.focus({ preventScroll: true }); }, 'btn danger');
      del.dataset.fk = `kdel:${k.id}`;
      del.disabled = kinds().length < 2;
      foot.append(del);
      td.append(foot);
    }
    tr.append(td);
    queueMicrotask(() => fit());
    return tr;
  }
  function deleteKind(k) {
    const name = kindName(k.id), i = kinds().indexOf(k);
    const table = { ...data.settings.table }; delete table[k.id];
    ui.openKind = null; ui.delKind = null;
    const next = kinds().filter(x => x.id !== k.id);
    saveKinds(next, { table: diffFromDefaults(table, data.defaults.table) });
    announceOrder(t('routing.settings.kindDeleted', { name }));
    orderFocus = `kname:${next[Math.min(i, next.length - 1)]?.id ?? ''}`;
  }
  function addKind_() {
    const list = kinds();
    if (list.length >= KINDS_MAX) return;
    const lv = i => levels()[Math.min(i, levels().length - 1)]?.id;
    const k = { id: newId('k'), name: t('routing.settings.kindNew'), desc: '' };
    const table = { ...data.settings.table, [k.id]: [lv(1), lv(2), lv(3)] };
    ui.openKind = k.id; ui.delKind = null;
    saveKinds([...list, k], { table: diffFromDefaults(table, data.defaults.table) });
    orderFocus = `kin:${k.id}`;
    announceOrder(t('routing.settings.kindAdded', { name: k.name }));
  }

  function numberField(key, label, unit, { min, max, step }) {
    const field = el('label', 'mp-field rt-number');
    const input = el('input');
    input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(data.settings[key]);
    input.disabled = false;
    const commit = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v === data.settings[key]) { input.value = String(data.settings[key]); return; }
      save({ [key]: v === data.defaults[key] ? null : v });
    };
    input.onchange = commit;
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
    const row = el('span', 'rt-number-row');
    row.append(input, el('span', 'rt-unit', unit));
    field.append(el('span', null, label), row);
    return field;
  }

  function paintReset() {
    const out = [];
    if (confirmingReset) {
      const ask = el('div', 'mp-confirm');
      ask.append(el('p', null, t('routing.settings.resetConfirm')));
      const buttons = el('div', 'mp-card-actions');
      buttons.append(button(t('routing.settings.keyCancel'), () => { confirmingReset = false; paintReset(); }),
        button(t('routing.settings.reset'), async () => {
          confirmingReset = false;
          await save(Object.fromEntries(Object.keys(data.defaults).map(k => [k, null])));
        }));
      ask.append(buttons);
      out.push(ask);
    } else {
      const b = button(t('routing.settings.reset'), () => { confirmingReset = true; paintReset(); });
      b.disabled = same(data.settings, data.defaults);
      out.push(b);
    }
    reset.replaceChildren(...out);
  }

  $('delegationTab').onclick = () => { page('delegation'); refresh(); };
  paint();
  return {
    refresh,
    /** 使用量だけの通知では、開いたメニューと入力欄を作り直さない。種類のない旧サーバーの通知は全体を取り直す */
    async event(ev) {
      if (root.hidden) return;
      if (ev?.change !== 'usage') return refresh();
      const serial = ++refreshSerial;
      try {
        const latest = await cmd('delegationRouting');
        if (serial !== refreshSerial || !data) return;
        data.candidates = latest.candidates;
        data.warnings = latest.warnings;
        paintUsage();
      } catch (e) { message = t('routing.settings.loadFailed', { error: e.message }); stateLine.textContent = message; stateLine.hidden = false; }
    },
  };
}
