import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { tierText, skipText, usageSummary, splitCandidate } from './delegation-routing-view.mjs';
import { EFFORT_LEVELS, candidateEffort, tierEffort, withEffort } from './delegation-effort.mjs';
import { effortSelect } from './effort-select.mjs';
import { paintWhoChip, renderModel, panel } from './composer-controls.mjs';
import { createReorder, moveItem } from './reorder.mjs';
import { ROLES_BY_AGENT, KIND, KIND_LABEL } from './compat-presets.mjs';

const LEVELS_MAX = 10;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 既定と違う項目だけの形（tiers・table は中の項目ごと）。全部既定なら null */
export function diffFromDefaults(value, defaults) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.fromEntries(Object.entries(value).filter(([k, v]) => !same(v, defaults?.[k])));
    return Object.keys(out).length ? out : null;
  }
  return same(value, defaults) ? null : value;
}

function button(text, onclick, className = 'btn') {
  const b = el('button', className, text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

/** 利用者が増やすレベル・作業の種類の id（サーバーの LEVEL_ID・KIND_ID と同じ形） */
const newId = prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;


export function createRoutingLevels({ root, advancedBody, getData, paintAdvanced, save, showMenu, labelOf, modelsOf, modelName,
  agents = () => [], openConns = null, openAccount = () => {}, cmd, announceOrder = () => {}, refreshUsage = async () => {},
  allowDefault = false, minCandidates = 0, needsRepaint = () => false }) {
  const ui = { selLv: null, renLv: false, delLv: null, delTo: null };
  let levelMenu = null, activePicker = null, rechecking = '', orderFocus = '';
  const kinds = () => getData()?.settings.kinds ?? [];
  const names = { backend: id => labelOf(id), model: (backend, model, account = '') => model ? modelName(backend, model, account) || model : t('chat.next.useDefault') };

  // ---- 設定の中のレベル・作業の種類 ----
  const levels = () => getData()?.settings.levels ?? [];
  const levelAt = id => levels().findIndex(l => l.id === id);
  /** レベルの見せ方。名前が無ければ「レベル N」（上から何番目か。並べ替えると番号だけ変わる） */
  const levelName = id => {
    const i = levelAt(id);
    return i < 0 ? tierText(id) : levels()[i].name || t('routing.settings.levelName', { n: i + 1 });
  };
  /** レベルの番号（表のセル・メニューの右の hint。見つからなければ短い名前） */
  const levelPos = id => { const i = levelAt(id); return i < 0 ? tierText(id) : String(i + 1); };
  /** 作業の種類の見せ方。設定の名前 → 辞書（既定の種類）→ id */
  const selLevel = () => {
    const list = levels();
    if (!list.some(l => l.id === ui.selLv)) ui.selLv = list[0]?.id ?? null;
    return ui.selLv;
  };

  const saveNested = (key, value) => save({ [key]: diffFromDefaults(value, getData().defaults[key]) });
  const saveEfforts = efforts => saveNested('efforts', efforts);
  /** レベル・作業の種類の一覧を変えたとき（追加・削除・並べ替え）。配列なので既定と違えば丸ごと送る */
  const saveLevels = (list, extra = {}) => save({ levels: diffFromDefaults(list, getData().defaults.levels), ...extra });
  const ordering = createReorder({ root: advancedBody, rowSelector: '.rt-cand-row', idOf: row => row.dataset.candidate,
    current: tier => getData()?.settings.tiers[tier] ?? [], showMenu, announce: announceOrder,
    move: changeOrder, settled: focus => {
      if (focus) orderFocus = focus;
      if (focus || needsRepaint()) paintAdvanced();
    } });
  function changeOrder(tier, candidate, to) {
    const next = moveItem(getData().settings.tiers[tier], candidate, to);
    if (!next) return;
    orderFocus = `order|${tier}|${candidate}`;
    saveNested('tiers', { ...getData().settings.tiers, [tier]: next });
    announceOrder(t('common.reorder.moved', { name: candidateName(candidate), position: to + 1 }));
  }

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

  function stateOf(candidate) { return getData().candidates.find(c => c.candidate === candidate) ?? null; }
  // ---- アカウント（ADR 0264）。アカウントを登録したエージェント（getData().accounts にある）の候補は、アカウント 1 つの単位。
  // 書かない候補はログイン中のアカウント。登録の無いエージェントはアカウントを出さない
  const accountsOf = backend => getData().accounts?.[backend] ?? null;
  const candidateOf = (backend, model, account) => `${backend}${account ? `@${account}` : ''}:${model}`;
  const scopedOf = ({ backend, account }) => Boolean(accountsOf(backend)) || account != null;
  /** アカウントの名前。ログイン中は「ログイン中のアカウント」（登録の誰かと同じ人と分かれば「（personal）」を添える） */
  function accountText(backend, account) {
    const row = accountsOf(backend)?.find(a => a.account === (account ?? ''));
    if (!account) return row?.sameAs ? t('routing.settings.accountLoginSame', { name: row.sameAs }) : t('routing.settings.accountLogin');
    return row?.name ?? account;
  }
  // ---- 互換の接続先（ADR 0361）。候補は `backend@<接続先>:model`（モデルは接続先の ID をそのまま）。
  // 一覧と状態はサーバーの getData().endpoints（エージェントごと。state は ready / check_failed / key_unreadable）
  const endpointsOf = backend => getData().endpoints?.[backend] ?? [];
  const endpointInfo = id => Object.values(getData().endpoints ?? {}).flat().find(e => e.id === id) ?? null;
  const endpointCandidate = (backend, model, endpoint) => `${backend}@${endpoint}:${model}`;
  const endpointLabelOf = candidate => {
    const { endpoint } = splitCandidate(candidate);
    return endpointInfo(endpoint)?.name ?? stateOf(candidate)?.endpointLabel ?? t('chat.endpoint.deleted');
  };
  /** 接続先の状態の言葉（使えるなら null） */
  const endpointProblem = e => !e ? t('routing.unavailable.no_endpoint') : e.state && e.state !== 'ready' ? t(`routing.unavailable.${e.state}`) : null;
  /** 候補のモデルとアカウントの表示名（「Sonnet · personal」。互換の接続先は「z-ai/glm-4.6 · OpenRouter」） */
  function candidateName(candidate) {
    const parsed = splitCandidate(candidate);
    if (parsed.endpoint) return [parsed.model || t('chat.next.useDefault'), endpointLabelOf(candidate)].join(t('routing.line.join'));
    const model = names.model(parsed.backend, parsed.model, parsed.account ?? '');
    return scopedOf(parsed) ? [model, accountText(parsed.backend, parsed.account)].join(t('routing.line.join')) : model;
  }
  /**
   * 候補の下の行。アカウントを持つ候補はそのアカウントの使用量だけ（エージェントの名前は付けない）。
   * 登録したアカウントのトークンが無ければ「使えない（認証情報なし） · ログインし直す」
   */
  function candidateUsage(candidate) {
    const st = stateOf(candidate);
    const parsed = splitCandidate(candidate);
    const join = t('routing.line.join');
    // 互換の接続先は「エージェント · 使用量は読めない」。使えなければ理由と、確認に失敗なら「確認し直す」
    if (parsed.endpoint) {
      const sub = [labelOf(parsed.backend), st && !st.usable ? skipText(st.reason, st.detail) : t('routing.settings.endpointNoUsage')];
      return { st, lines: [{ text: sub.join(join), recheck: st?.detail === 'check_failed' ? parsed.endpoint : '' }] };
    }
    const scoped = scopedOf(parsed);
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
    if (line.recheck) {
      const name = endpointInfo(line.recheck)?.name ?? line.recheck;
      const go = button(rechecking === line.recheck ? t('compat.checking') : t('routing.settings.recheck'), () => recheckEndpoint(line.recheck, name), 'btn link rt-relogin rt-recheck');
      // 確かめている間も押したリンクにフォーカスを残す（disabled にするとフォーカスが外れる）
      if (rechecking === line.recheck) go.setAttribute('aria-disabled', 'true');
      go.setAttribute('aria-label', t('routing.settings.recheckLabel', { name }));
      small.append(t('routing.line.join'), go);
    }
    return small;
  });
  /** 確認に失敗した接続先を確かめ直す（エージェント設定の接続先の［接続を確認］と同じ操作）。結果は読み上げ、状態は届く通知で描き直す */
  async function recheckEndpoint(id, name) {
    if (rechecking) return;
    rechecking = id; paintUsage();
    try {
      const r = await cmd('compatEndpointRecheck', { id });
      announceOrder(r?.ok ? t('compat.list.recheckOk', { name }) : t('compat.list.recheckFailed', { name, error: r?.error ?? '' }));
    } catch (e) { announceOrder(e.message); }
    rechecking = '';
    await refreshUsage();
    paintUsage();
  }
  function paintUsage() {
    for (const row of advancedBody.querySelectorAll('.rt-cand-row')) {
      const { st, lines } = candidateUsage(row.dataset.candidate);
      row.classList.toggle('off', Boolean(st && !st.usable));
      const info = row.querySelector('.rt-cand-info');
      if (!info) continue;
      // 押せる「ログインし直す」にフォーカスがあれば、描き直しても同じ候補の同じ部品へ戻す
      const had = info.contains(document.activeElement) && document.activeElement.matches('.rt-relogin');
      for (const small of info.querySelectorAll('small')) small.remove();
      info.append(...usageLines(row.dataset.candidate, lines));
      // 確かめ直して使えるようになり「確認し直す」が消えたら、フォーカスは候補のチップへ
      if (had) (info.querySelector('.rt-relogin') ?? row.querySelector('.rt-picker-chip'))?.focus({ preventScroll: true });
    }
  }

  // ---- レベル（選択肢の行ごとの ⋯ で名前の変更・移動・削除）
  /** レベルの候補のブロック。見出しは「選ぶ pill + レベルの既定」 */
  function levelBlock(lv) {
    const block = el('div', 'rt-tier');
    if (lv) block.dataset.tier = lv;
    const list = getData().settings.tiers[lv] ?? [];
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
      const st = stateOf(candidate);
      const name = candidateName(candidate);
      const row = el('li', 'rt-cand-row' + (st && !st.usable ? ' off' : ''));
      row.dataset.candidate = candidate;
      const info = el('div', 'rt-cand-info');
      const title = el('div', 'rt-cand-name');
      title.append(el('span', 'rt-n', `${j + 1}.`), candidatePicker(lv, candidate, j));
      info.append(title, ...usageLines(candidate, candidateUsage(candidate).lines));
      const actions = el('div', 'rt-cand-actions');
      const remove = button('', () => saveNested('tiers', { ...getData().settings.tiers, [lv]: list.filter(c => c !== candidate) }), 'btn btn-icon rt-move');
      remove.setAttribute('aria-label', t('routing.settings.candidateRemove', { name }));
      remove.title = remove.getAttribute('aria-label');
      remove.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.disabled = Object.values(getData().settings.tiers).flat().length <= minCandidates;
      actions.append(remove);
      row.append(ordering.handle(lv, candidate, name), info, actions);
      rows.append(row);
    });
    if (!list.length) block.append(el('p', 'mp-note', t('routing.settings.empty')));
    else block.append(rows);
    if (lv) block.append(candidatePicker(lv, null));
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
      { label: t('routing.settings.levelDelete'), disabled: !lv || n < 2 || Object.entries(getData().settings.tiers)
        .filter(([id]) => id !== lv).flatMap(([, list]) => list).length < minCandidates, danger: true, onClick: () => {
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
    const tiers = { ...getData().settings.tiers, [lv.id]: [] };
    const efforts = { ...getData().settings.efforts, [lv.id]: { '*': getData().settings.efforts?.[last?.id]?.['*'] ?? '' } };
    ui.selLv = lv.id; ui.renLv = true; ui.delLv = null;
    saveLevels([...list, lv], { tiers: diffFromDefaults(tiers, getData().defaults.tiers), efforts: diffFromDefaults(efforts, getData().defaults.efforts) });
    announceOrder(t('routing.settings.levelAdded', { name: lv.name }));
  }
  function levelDeleteConfirm(lv) {
    const users = kinds().filter(k => (getData().settings.table[k.id] ?? []).includes(lv));
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
    const tiers = { ...getData().settings.tiers }; delete tiers[lv];
    const efforts = { ...getData().settings.efforts }; delete efforts[lv];
    const table = Object.fromEntries(Object.entries(getData().settings.table).map(([k, row]) => [k, row.map(x => x === lv ? to : x)]));
    ui.selLv = to ?? next[0]?.id ?? null; ui.delLv = null; ui.delTo = null;
    saveLevels(next, { tiers: diffFromDefaults(tiers, getData().defaults.tiers), efforts: diffFromDefaults(efforts, getData().defaults.efforts), table: diffFromDefaults(table, getData().defaults.table) });
    announceOrder(t('routing.settings.levelDeleted', { name }));
  }

  // ---- 思考の強さ（ADR 0164。決め方は web/delegation-effort.mjs・サーバーの decideEffort と同じ）
  const conversationOf = backend => getData().conversationEfforts?.[backend] ?? '';
  /** レベルの見出しの右の「レベルの既定」。レベルの中の候補は、上書きが無ければこの値で走る */
  function levelEffortSelect(lv, list) {
    const { value, changed } = tierEffort({ settings: getData().settings, defaults: getData().defaults, tier: lv });
    const shown = value === '' ? t('routing.effort.conversation') : value;
    const name = levelName(lv);
    // 会話の既定はエージェントごとに違うので、レベルの候補が同じ値のときだけ「今は X」と出す
    const nows = [...new Set(list.map(c => conversationOf(splitCandidate(c).backend) || t('routing.effort.unset')))];
    const recommended = getData().defaults.efforts?.[lv]?.['*'] ?? '';
    const pick = v => () => { sel.button.focus(); saveEfforts(withEffort(getData().settings.efforts, lv, '*', v)); };
    const sel = effortSelect({ focusKey: `${lv}|*`, changed, align: 'right',
      label: t('routing.effort.tierLabel', { tier: name, value: shown }), head: t('routing.effort.tierHead', { tier: name }),
      parts: [{ text: t('routing.effort.tierDefault') }, { text: shown, cls: 'ef-v' }],
      rows: [{ label: t('routing.effort.followConversation'), hint: nows.length === 1 ? t('routing.effort.now', { value: nows[0] }) : t('routing.effort.perAgent'), on: value === '', pick: pick('') },
        { sep: true },
        ...EFFORT_LEVELS.map(l => ({ label: l, hint: l === recommended ? t('routing.effort.recommended') : '', on: value === l, pick: pick(l) })),
        { foot: t('routing.effort.fitNote') }] });
    return sel.element;
  }
  function paintCandidateChip(chip, tier, candidate, position, { animate = false, capability = stateOf(candidate)?.effort, conversation } = {}) {
    const { backend, endpoint } = splitCandidate(candidate);
    const model = candidateName(candidate);
    const effort = candidateEffort({ settings: getData().settings, tier, candidate,
      capability, conversation: conversation ?? conversationOf(backend) }).value ?? '';
    // 互換の接続先の候補は ◇（入力欄のチップと同じ印。ADR 0361）
    paintWhoChip(chip, { backend, model, effort, endpoint: Boolean(endpoint) });
    const label = t('routing.settings.candidateChange', { tier: levelName(tier), position: position + 1,
      candidate: [labelOf(backend), model, effort].filter(Boolean).join(t('routing.line.join')) });
    chip.title = label;
    chip.setAttribute('aria-label', label);
    if (animate && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      chip.querySelector('.mn')?.animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
        { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }

  function candidatePicker(tier, candidate, position) {
    const adding = candidate === null;
    if (activePicker?.tier === tier && activePicker.candidate === candidate) {
      activePicker.position = position;
      return activePicker.chip;
    }
    const chip = button(adding ? t('routing.settings.addCandidate') : '', null, adding ? 'btn rt-add' : 'chip model rt-picker-chip');
    if (!adding) paintCandidateChip(chip, tier, candidate, position);
    chip.dataset.fk = adding ? `add|${tier}` : `picker|${tier}|${position}`;
    const pop = el('div', 'pop cpop rt-picker');
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    const picker = { tier, candidate, position, chip, panel: null, update };
    const list = () => getData().settings.tiers[tier] ?? [];
    const duplicate = id => id !== picker.candidate && list().includes(id);
    const duplicateText = () => t('routing.settings.candidateDuplicate');
    const catalog = new Map();
    const keyOf = (backend, account) => JSON.stringify([backend, account]);
    let draft = '', draftEffort, resolvedCapability, loading = false, request = 0;
    const capabilityOf = id => stateOf(id)?.effort ?? (resolvedCapability?.id === id ? resolvedCapability.value : undefined);
    const candidateArgs = id => {
      const { backend, account, model } = splitCandidate(id);
      return [backend, account ?? '', model];
    };
    const backendIds = () => [...new Set([...agents(), ...getData().candidates.map(c => c.backend)].filter(Boolean))];
    const accountRows = backend => accountsOf(backend) ?? [{ account: '' }];
    const modelsFor = (backend, account) => catalog.get(keyOf(backend, account)) ?? {};
    const modelIds = models => Object.keys(models).filter(id => id || allowDefault);
    const defaultEffort = (backend, account, model) => modelsFor(backend, account)[model]?.defaultEffort;
    const conversation = (backend, account, model) => conversationOf(backend)
      || defaultEffort(backend, account, model) || '';
    function alternatives(backend) {
      return accountRows(backend).flatMap(({ account }) => {
        const models = modelsFor(backend, account);
        const preferred = models['']?.resolvesTo;
        const ids = [preferred, ...Object.keys(models)].filter(Boolean);
        if (allowDefault) ids.unshift('');
        return [...new Set(ids)].map(model => candidateOf(backend, model, account));
      }).filter(id => !duplicate(id));
    }
    const usage = (backend, account, model) => {
      // 互換の接続先の候補は使用量を持たない（公式の枠の棒に混ぜない）
      const states = getData().candidates.filter(c => c.backend === backend && !c.endpoint && (account === undefined || (c.account ?? '') === account));
      const state = states.find(c => c.model === model) ?? states[0];
      const week = state?.windows?.find(w => w.minutes === 7 * 24 * 60);
      return Number.isFinite(week?.usedPercent) ? { used: week.usedPercent, high: week.usedPercent >= getData().settings.avoidPercent } : null;
    };
    // 互換の接続先のモデル（メイン → 一覧の順。同じレベルにある候補は飛ばす）と、公式へ戻すときのモデル
    const endpointModels = row => [...new Set([row?.roles?.main, ...(row?.models ?? [])].filter(Boolean))];
    const endpointFirst = (backend, endpoint) => endpointModels(endpointsOf(backend).find(e => e.id === endpoint))
      .map(m => endpointCandidate(backend, m, endpoint)).find(id => !duplicate(id)) ?? null;
    const officialFirst = (backend, account) => {
      const models = modelsFor(backend, account);
      return [...new Set([models['']?.resolvesTo, ...modelIds(models)].filter(Boolean))]
        .map(m => candidateOf(backend, m, account)).find(id => !duplicate(id)) ?? null;
    };
    async function loadCatalog() {
      const serial = ++request;
      loading = true;
      if (adding) {
        draft = backendIds()[0] ? candidateOf(backendIds()[0], '', '') : '';
        draftEffort = undefined;
      }
      render();
      await Promise.all(backendIds().flatMap(backend => accountRows(backend).map(async ({ account }) => {
        const models = await modelsOf(backend, account).catch(() => null);
        if (serial === request) catalog.set(keyOf(backend, account), models);
      })));
      if (serial !== request) return;
      loading = false;
      if (adding) {
        const first = backendIds().flatMap(alternatives)[0];
        if (first) { await change(first); return; }
      }
      update();
    }
    function saveCandidate(id, effort) {
      const before = picker.candidate;
      if (!id || duplicate(id) || (!adding && !list().includes(before))) return;
      const next = adding ? [...list(), id] : list().map(c => c === before ? id : c);
      let efforts = getData().settings.efforts;
      if (before && before !== id) efforts = withEffort(efforts, tier, before, undefined);
      efforts = withEffort(efforts, tier, id, effort);
      if (adding) picker.panel.hide(false);
      else picker.candidate = id;
      const animate = before !== id;
      save({ tiers: diffFromDefaults({ ...getData().settings.tiers, [tier]: next }, getData().defaults.tiers),
        efforts: diffFromDefaults(efforts, getData().defaults.efforts) });
      if (adding) {
        root.querySelector(`[data-fk="picker|${tier}|${next.length - 1}"]`)?.focus();
        announceOrder(t('routing.settings.candidateAdded', { tier: levelName(tier), candidate: candidateName(id) }));
      } else if (animate) {
        paintCandidateChip(chip, tier, id, picker.position, { animate: true, capability: capabilityOf(id), conversation: conversation(...candidateArgs(id)) });
        announceOrder(t('routing.settings.candidateChanged', { tier: levelName(tier), position: picker.position + 1, candidate: candidateName(id) }));
      }
    }
    function selectEffort(value) {
      if (adding) { draftEffort = value; update(); }
      else if (getData().settings.efforts?.[tier]?.[picker.candidate] !== value) {
        saveEfforts(withEffort(getData().settings.efforts, tier, picker.candidate, value));
      }
    }
    async function change(id) {
      if (!id) return;
      const { backend, account, model, endpoint } = splitCandidate(id);
      if (loading || (!model && !allowDefault) || duplicate(id)) return;
      const serial = ++request;
      const entry = endpoint ? null : modelsFor(backend, account ?? '')[model];
      // 段違いがモデル ID で分かれているときは、選んだ ID の段を使う。
      const fixed = entry?.family ? entry.level ?? null : null;
      const known = capabilityOf(id);
      // 互換の接続先の段は接続先が決める（efforts に endpoint を渡す）
      const options = known || fixed ? null
        : await cmd('efforts', endpoint ? { backend, model, endpoint } : { backend, model, account: account ?? '' }).catch(() => null);
      if (serial !== request || duplicate(id)) return;
      const capability = known ?? { levels: Object.keys(options ?? {}).filter(Boolean), fixed };
      const previous = adding ? draftEffort : getData().settings.efforts?.[tier]?.[picker.candidate];
      const keep = capability.levels.length && (previous === '' || capability.levels.includes(previous)) ? previous : undefined;
      resolvedCapability = { id, value: capability };
      if (adding) { draft = id; draftEffort = keep; update(); }
      else saveCandidate(id, keep);
    }
    function render() {
      pop.setAttribute('aria-label', chip.getAttribute('aria-label') ?? t('routing.settings.addCandidate'));
      const id = adding ? draft : picker.candidate;
      const { backend, account: rawAccount, model, endpoint = null } = splitCandidate(id || '');
      const account = rawAccount ?? '';
      const models = modelsFor(backend, account);
      const current = Object.fromEntries(Object.entries(models).map(([modelId, entry]) => [
        modelId, entry?.family && entry.level
          ? { ...entry, label: [entry.label ?? modelId, entry.level].join(t('routing.line.join')) } : entry,
      ]));
      for (const saved of [...list(), id].filter(Boolean).map(splitCandidate)) {
        if (saved.backend === backend && !saved.endpoint && (saved.account ?? '') === account && saved.model && !Object.hasOwn(current, saved.model)) {
          current[saved.model] = { label: names.model(backend, saved.model, account) };
        }
      }
      const settings = adding ? { efforts: withEffort(getData().settings.efforts, tier, id, draftEffort) } : getData().settings;
      const effort = candidateEffort({ settings, tier, candidate: id,
        capability: capabilityOf(id) ?? { levels: [] }, conversation: conversation(backend, account, model) });
      const adjustable = effort.kind === 'level';
      const from = document.activeElement;
      const focusKey = pop.contains(from) ? from.dataset.key : '';
      const blocked = (kind, value) => {
        if (loading) return t('composer.model.loading');
        if (kind === 'agent') {
          if (alternatives(value).length) return null;
          return accountRows(value).some(a => Object.keys(modelsFor(value, a.account)).some(Boolean))
            ? duplicateText() : t('routing.settings.noModels');
        }
        // 互換の接続先: 確認に失敗・キーを読めない接続先は選べない（理由を添える）。モデルが全部このレベルにあれば同じ候補
        if (kind === 'endpoint') {
          const row = endpointsOf(backend).find(e => e.id === value);
          return endpointProblem(row) ?? (endpointFirst(backend, value) ? null
            : endpointModels(row).length ? duplicateText() : t('routing.settings.noModels'));
        }
        // 互換から公式のアカウントへ戻す: そのアカウントのモデルが無い・全部このレベルにある
        if (kind === 'account' && endpoint) {
          if (!modelIds(modelsFor(backend, value)).length) return t('routing.settings.noModels');
          return officialFirst(backend, value) ? null : duplicateText();
        }
        const next = kind === 'model' ? (endpoint ? endpointCandidate(backend, value, endpoint) : candidateOf(backend, value, account)) : candidateOf(backend, model, value);
        return duplicate(next) ? duplicateText() : null;
      };
      // 接続先の一覧（CLI のログイン → 登録したアカウント → 互換の接続先 → 接続先を管理…。入力欄と同じ並び。ADR 0359・0361）
      const epRows = endpointsOf(backend);
      const epRow = endpoint ? epRows.find(e => e.id === endpoint) ?? null : null;
      const where = e => `${KIND_LABEL[e.kind ?? KIND[e.agent ?? backend]] ?? ''} · ${String(e.baseUrl ?? '').replace(/^https?:\/\//, '')}`;
      const endpointView = epRows.length || endpoint ? {
        selected: endpoint ?? '', row: epRow, lost: null,
        roleNames: (ROLES_BY_AGENT[backend] ?? []).map(r => [r.key, r.short]),
        options: [
          { value: '', label: accountText(backend, ''), usage: usage(backend, '', model) },
          // 使えない接続先の理由は、選べない行では選べない理由（blocked）として 1 回だけ出す。選んでいる行（1 段目の注記にも使う）だけ下の行に添える
          ...epRows.map(e => ({ value: e.id, label: e.name, title: `${e.name}（${e.baseUrl ?? ''}）`, warn: Boolean(endpointProblem(e)),
            sub: e.id === endpoint && endpointProblem(e) ? [endpointProblem(e), where(e)].join(t('routing.line.join')) : where(e) })),
          ...(endpoint && !epRow ? [{ value: endpoint, label: t('chat.endpoint.deleted'), sub: t('chat.account.chooseAgain'), gone: true }] : []),
        ],
        manage: openConns ? () => openConns(backend) : null,
      } : null;
      const officialAccount = a => {
        if (endpoint) { const next = officialFirst(backend, a); if (next) change(next); return; }
        if (!model && adding && !loading) { draft = candidateOf(backend, '', a); update(); }
        else change(candidateOf(backend, model, a));
      };
      renderModel({ pop, explicitModels: true, allowDefault, blocked,
        target: { backend, backendSwitchable: true, backends: backendIds().map(b => ({ id: b, label: labelOf(b) })),
          backendUsage: b => usage(b, undefined, model), backendHasAccounts: b => Boolean(accountsOf(b)),
          account, model, models: current, modelsPending: loading, endpoint: endpointView,
          accounts: scopedOf({ backend, account: rawAccount }) ? [...new Set([...accountRows(backend).map(a => a.account), account])].filter(value => {
            const available = modelsFor(backend, value);
            return endpoint || value === account || duplicate(candidateOf(backend, model, value))
              || !modelIds(available).length || Object.hasOwn(available, model)
              || !accountRows(backend).some(a => Object.hasOwn(modelsFor(backend, a.account), model));
          }).map(value => {
            const ready = accountRows(backend).find(a => a.account === value)?.ready;
            return { value, label: accountText(backend, value), usage: usage(backend, value, model),
              conn: ready === false || ready === undefined ? { text: t('routing.unavailable.no_token'), warn: true } : null };
          }) : null,
          effort: effort.value ?? '', efforts: adjustable ? Object.fromEntries([['', {
            resolvesTo: effort.tierDefault === '' ? effort.conversationValue : effort.tierValue,
          }], ...effort.options.map(value => [value, {}])]) : {} },
        effortControl: { label: t('routing.effort.candidateSlider'), follow: adjustable ? { label: t('routing.effort.followConversation'), selected: effort.own === '',
          pick: () => selectEffort('') } : null },
        footer: adding ? () => {
          const b = button(t('routing.settings.candidateConfirm'), () => saveCandidate(id, draftEffort), 'prow rt-picker-confirm');
          b.dataset.key = 'confirm';
          b.disabled = loading || !backend || (!model && !allowDefault) || duplicate(id);
          if (b.disabled) b.setAttribute('aria-disabled', 'true');
          return b;
        } : null,
        on: { backend: b => change(alternatives(b)[0]), account: officialAccount,
          conn: ({ account: a }) => officialAccount(a ?? ''),
          // 互換の接続先を選ぶと、そのメインのモデル（このレベルに無いもの）で候補を作る。モデルは接続先の ID をそのまま持つ
          endpoint: ep => { const next = endpointFirst(backend, ep); if (next) change(next); },
          model: m => change(endpoint ? endpointCandidate(backend, m || epRow?.roles?.main || model, endpoint) : candidateOf(backend, m, account)),
          effort: e => selectEffort(e || undefined) },
        hide: focus => picker.panel.hide(focus), afterRender: () => picker.panel.place() });
      if (focusKey) [...pop.querySelectorAll('[data-key]')].find(node => node.dataset.key === focusKey)?.focus({ preventScroll: true });
    }
    function update() {
      if (!adding) paintCandidateChip(chip, tier, picker.candidate, picker.position, { capability: capabilityOf(picker.candidate), conversation: conversation(...candidateArgs(picker.candidate)) });
      render();
    }
    picker.panel = panel(chip, pop, { render, flip: true, initialFocus: '[data-key="nav:agent"]',
      beforeShow: () => root.append(pop),
      onShow: () => { activePicker = picker; loadCatalog(); },
      onHide: () => { request++; activePicker = null; pop.remove(); } });
    return chip;
  }


  function replace(out) {
    const focused = orderFocus || (advancedBody.contains(document.activeElement) ? document.activeElement.dataset?.fk ?? '' : '');
    orderFocus = '';
    if (activePicker && !out.some(node => node.contains(activePicker.chip))) activePicker.panel.hide(false);
    advancedBody.replaceChildren(...out);
    activePicker?.update();
    if (focused) [...advancedBody.querySelectorAll('button')].find(b => b.dataset?.fk === focused)?.focus({ preventScroll: true });
    if (levelMenu) {
      advancedBody.querySelector('[data-fk="lvsel"]')?.setAttribute('aria-expanded', 'true');
      levelMenu(levelSelectItems());
    }
  }
  return { block: () => levelBlock(selLevel()), levels, levelAt, levelPos, levelName, pillMenu, replace, paintUsage,
    get busy() { return ordering.busy; }, focusNext: key => { orderFocus = key; } };
}
