// 互換の接続先の設定（設定 › エージェント設定 › Claude Code / Codex の「接続先」。docs/design-system.md「互換の接続先の管理」）。
//
// 一覧（登録した互換の接続先のカード。既定にする・接続を確認・編集・削除。公式・CLI のログインと［＋ 接続先を追加］は
// web/client.mjs の接続先の面が持つ。ADR 0357）と、追加・編集の 5 段の流れ
//   ① 種類（プリセット）→ ② 接続情報 → ③ 接続を確認 → ④ モデル → ⑤ 保存
// 確認が通るまで保存は出さない（サーバーの受領証。URL・キー・認証を変えたら確認し直し。モデルの欄は変えても確認し直さない）。
// キーは伏せ字で受け、保存後は表示しない（サーバーも返さない。hasKey と keyRef だけ）。
// キーの欄は設定 › API キー（承認済み 2026-10-07。docs/design-system.md「設定 › API キー」）に登録済みのキーから選ぶか、「別のキーを入れる」（入れたキーも API キーに並ぶ）。
// 説明文は最小限（docs/design-system.md「説明文」）。見出し・ラベル・状態で伝わることは書かず、事故になることと失敗の理由だけを短く。
// 面と部品は Claude のアカウントの設定（web/claude-accounts.mjs）と同じ .mp-*（web/manage-panel.css）。
// 入力欄のモデルの面（web/composer-controls.mjs）は list() の値を読むだけ。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { createCombo } from './combo.mjs';
import { modelCandidates, comboModelOptions, SHOW_LIMIT } from './compat-models.mjs';
import { PRESETS, CLAUDE_ROLES, CONTEXT_CANDIDATES, AUTH_LABEL, COMPAT_AGENTS, KIND, KIND_LABEL, presetOf, urlCandidates, urlHelp } from './compat-presets.mjs';
import { connCard, connConfirm } from './conn-card.mjs';
import { keyFitsEndpoint, keyMatchesEndpoint } from './api-keys-model.mjs';
import { apiKeyList, keySelect, notEncryptedNote, checkParts, manageLink } from './api-key-ui.mjs';

const STEPS = [t('compat.step.kind'), t('compat.step.connection'), t('compat.step.check'), t('compat.step.model'), t('compat.step.save')];

// 月/日 時:分（ja は「9/23 14:05」）
const when = (iso) => fmt.dateTime(iso, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// onAddEnd: 追加の欄を閉じた（フォーカスを一覧の［＋ 接続先を追加］へ戻す。web/client.mjs）
export function setupCompatEndpoints({ cmd, openSettings, openPage = () => {}, onChange = () => {}, onAddEnd = () => {} }) {
  const panel = document.createElement('section');
  panel.className = 'mp-panel'; panel.id = 'compatEndpointsPanel'; panel.hidden = true;
  document.getElementById('agentControls').append(panel);

  let endpoints = [], defaults = Object.fromEntries(COMPAT_AGENTS.map((a) => [a, ''])), loaded = null;
  /** 設定 › API キーの一覧（キーの欄で選ぶ）。取れなければ null（古い置き場の入力欄にする） */
  let keyData = null;
  let agent = 'claude', view = 'list', confirming = '', checking = '', message = '';
  /** 追加・編集の途中の値。{ id, preset, name, baseUrl, authMode, key, show, phase, result, roles, context, sendThinking, saved, stale } */
  let form = null;

  async function load(force = false) {
    if (!loaded || force) loaded = Promise.all([cmd('compatEndpoints'), apiKeyList(cmd).catch(() => null)])
      .then(([r, keys]) => { endpoints = r.endpoints ?? []; defaults = r.defaults ?? defaults; keyData = keys; return endpoints; })
      .catch(e => { loaded = null; throw e; });
    return loaded;
  }
  const button = (text, onclick, className = 'btn') => { const b = el('button', className, text); b.type = 'button'; b.onclick = onclick; return b; };
  const line = (text, cls = 'mp-ln') => el('span', cls, text);

  // 状態の 1 行の文字（種類 · ホスト · 確認の結果）。失敗は ⚠ で強める
  function checkText(e) {
    if (checking === e.id) return { text: t('compat.checking'), warn: false };
    const c = e.lastCheck;
    if (!c) return { text: t('compat.check.never'), warn: false };
    if (c.ok) return { text: t('compat.check.ok', { when: when(c.at) }), warn: false };
    return { text: t('compat.check.failed', { error: c.error, when: when(c.at) }), warn: true };
  }
  const hostOf = (url) => { try { return new URL(url).host; } catch { return url ?? ''; } };

  // ---------------------------------------------------------------- 一覧（互換のカードだけ。公式・見出し・［＋ 追加］は接続先の一覧の面が持つ。ADR 0357）
  // 1 枚 = 名前（· 新しい会話の既定）・「種類 · ホスト · 確認」の 1 行 |［接続を確認］（確かめていない・失敗のときだけ）［既定にする］［編集］［削除］
  function listCards() {
    return endpoints.filter(x => x.agent === agent).map((e) => {
      const asking = confirming === e.id, c = checkText(e);
      const unchecked = !e.lastCheck || !e.lastCheck.ok || checking === e.id;
      return connCard({
        name: e.name, isDefault: e.isDefault, warn: c.warn, dataset: { endpoint: e.id }, confirming: asking,
        status: t('conn.compatLine', { kind: KIND_LABEL[e.kind ?? KIND[agent]] ?? '', host: hostOf(e.baseUrl), check: c.text }),
        actions: asking ? [] : [
          unchecked && { label: checking === e.id ? t('compat.checking') : t('conn.check'), quiet: true, onClick: () => recheck(e), disabled: checking === e.id },
          !e.isDefault && { label: t('conn.makeDefault'), onClick: () => setDefault(e.id) },
          { label: t('conn.edit'), onClick: () => startForm(e) },
          { label: t('conn.delete'), onClick: () => { confirming = e.id; draw(); } },
        ],
        extra: [asking && connConfirm({ name: e.name, withKey: e.hasKey && !e.keyRef, onNo: () => { confirming = ''; draw(); }, onYes: () => remove(e) })],
      });
    });
  }
  function drawList() {
    const state = el('p', 'mp-state', message); state.setAttribute('role', 'status');
    panel.replaceChildren(...listCards(), state);
  }

  async function setDefault(id) {
    message = '';
    try { await cmd('compatEndpointDefault', { agent, id }); await load(true); onChange(); }
    catch (e) { message = e.message; }
    draw();
  }
  async function recheck(e) {
    checking = e.id; message = ''; draw();
    try {
      const r = await cmd('compatEndpointRecheck', { id: e.id });
      message = r.ok ? t('compat.list.recheckOk', { name: e.name }) : t('compat.list.recheckFailed', { name: e.name, error: r.error });
      await load(true); onChange();
    } catch (err) { message = err.message; }
    checking = ''; draw();
  }
  async function remove(e) {
    message = '';
    try { await cmd('compatEndpointDelete', { id: e.id }); confirming = ''; await load(true); onChange(); }
    catch (err) { message = t('compat.list.deleteFailed', { error: err.message }); }
    draw();
  }

  // ---------------------------------------------------------------- 追加・編集（画面 3）
  function blankForm(presetId) {
    const p = presetOf(agent, presetId);
    return { id: '', preset: p.id, name: p.id === 'custom' ? '' : p.name, baseUrl: p.urls[0]?.value ?? '',
      authMode: agent === 'claude' ? (['bearer', 'x-api-key'].includes(p.auth) ? p.auth : 'auto') : (p.auth === 'api-key' ? 'api-key' : 'bearer'),
      key: '', keyRef: '', keyMode: 'registered', show: false, hasKey: false, phase: 'edit', result: null, models: [], modelInfo: {}, roles: { ...p.roles }, context: p.context ?? '',
      sendThinking: Boolean(p.thinking), saved: false, stale: false, error: '' };
  }
  function startForm(e, presetId = null) {
    confirming = ''; message = ''; view = 'form';
    if (!e) form = blankForm(presetId ?? PRESETS[agent][0].id);
    else form = { id: e.id, preset: e.preset, name: e.name, baseUrl: e.baseUrl, authMode: e.authMode, key: '', keyRef: e.keyRef ?? '', keyMode: 'registered', show: false, hasKey: e.hasKey,
      phase: 'edit', result: null, models: e.models ?? [], modelInfo: e.modelInfo ?? {}, roles: { ...e.roles }, context: e.options?.contextTokens ? String(e.options.contextTokens) : '',
      sendThinking: Boolean(e.options?.sendThinking), saved: false, stale: false, error: '' };
    draw();
    panel.scrollIntoView({ block: 'nearest' });
  }
  /**
   * 接続情報（URL・キー・認証）が変わった。確認済みなら確認前に戻す。
   * キーを打ち始めた 1 文字目で描き直すので、打っていた欄へフォーカスと字の位置を戻す（戻さないと 2 文字目から欄の外に打つことになる）
   */
  function invalidate() {
    if (form.phase !== 'ok' && form.phase !== 'fail') return;
    form.stale = form.phase === 'ok'; form.phase = 'edit'; form.result = null;
    const active = panel.contains(document.activeElement) ? document.activeElement : null;
    const field = active?.dataset?.field ?? null;
    const at = field ? [active.selectionStart, active.selectionEnd] : null;
    draw();
    if (!field) return;
    const again = panel.querySelector(`[data-field="${field}"]`);
    again?.focus();
    if (at?.[0] != null) again?.setSelectionRange?.(at[0], at[1]);
  }
  const field = (label, control, help) => { const f = el('label', 'mp-field'); f.append(el('span', null, label), control); if (help) f.append(help); return f; };
  function input() {
    const registered = pickedKey();
    return { agent, name: form.name, preset: form.preset, baseUrl: form.baseUrl, authMode: form.authMode,
      // 登録済みのキーを選んだときは keyRef（値は画面を通らない）。別のキーを入れるときは key（保存すると API キーに登録される）
      ...(registered ? { keyRef: registered.id } : { key: form.key }),
      roles: form.roles, options: { contextTokens: form.context, sendThinking: form.sendThinking }, probeModel: form.roles.main || '' };
  }
  function modelCombo(value, onCommit, label, placeholder = t('compat.form.modelId')) {
    // 候補は取れた一覧（数百件でもよい）。割り当て済みで一覧に無い ID も後ろに足し、表示名で出す。描くのは先頭の SHOW_LIMIT 件
    const c = createCombo({ ariaLabel: label, placeholder, cls: 'mono', value, limit: SHOW_LIMIT, emptyText: t('compat.form.modelNotListed'),
      options: () => comboModelOptions(modelCandidates([...form.models, ...Object.values(form.roles).filter(Boolean)], form.modelInfo)), onCommit });
    c.root.querySelector('input').spellcheck = false;
    return c.root;
  }
  /**
   * キーの欄で選べる登録済みのキー（この接続先のプロバイダー・URL のホスト用のものだけ。別のホスト用のキーは出さない）。
   * null は古い置き場の入力欄（移行を保留中・API キーを読めない・キーの要らないプリセット・合うキーが無い）
   */
  function candidateKeys(P) {
    if (!keyData || keyData.migration?.state === 'deferred' || P.nokey) return null;
    const endpoint = { preset: form.preset, baseUrl: form.baseUrl };
    const list = keyData.keys.filter(k => keyFitsEndpoint(k, endpoint));
    return list.length ? list : null;
  }
  /**
   * 「登録済みのキー」を選んでいるときの、選んでいるキー（そうでなければ null）。選んでいるキーが候補から外れた（URL を替えた）ときは、
   * ホストが確かに合うキーだけを既定にし、無ければ「別のキーを入れる」にする（まだどのホストにも結び付いていないキーは選べるが、既定にしない）
   */
  function pickedKey() {
    const P = presetOf(agent, form.preset);
    const list = candidateKeys(P);
    if (!list || form.keyMode !== 'registered') return null;
    if (!list.some(k => k.id === form.keyRef)) {
      const endpoint = { preset: form.preset, baseUrl: form.baseUrl };
      // 人が「登録済みのキー」を選び直したときは、まだ結び付いていないキーも選べる（結び付くのは保存のとき）
      const sure = list.filter(k => keyMatchesEndpoint(k, endpoint));
      const pool = sure.length ? sure : form.keyChosen ? list : [];
      if (!pool.length) { form.keyMode = 'own'; form.keyRef = ''; return null; }
      form.keyRef = (pool.find(k => k.uses.length) ?? pool[0]).id;
    }
    return list.find(k => k.id === form.keyRef);
  }
  function keyField(P, editing) {
    const list = candidateKeys(P);
    if (list) return registeredKeyField(list);
    const key = el('input'); key.type = form.show ? 'text' : 'password'; key.value = form.key; key.autocomplete = 'new-password'; key.spellcheck = false;
    key.placeholder = editing && form.hasKey ? t('compat.form.keyKeep') : P.nokey ? t('compat.auth.none') : t('compat.form.apiKey');
    key.dataset.field = 'key';
    key.oninput = () => { form.key = key.value; invalidate(); };
    const kr = el('div', 'mp-keyrow'); kr.append(key, button(form.show ? t('compat.form.hide') : t('compat.form.show'), () => { form.show = !form.show; draw(); }));
    // 登録先は API キー（移行を保留している間は古い置き場なので、その一文は出さない）
    const home = keyData && keyData.migration?.state !== 'deferred' && !P.nokey
      ? el('small', null, form.preset === 'openrouter' ? t('apiKeys.endpoint.registersOpenrouter') : t('apiKeys.endpoint.registersNamed'))
      : P.nokey ? null : el('small', null, t('compat.form.keyStored'));
    const f = field(t('compat.form.apiKey'), kr, home);
    const warn = keyData ? notEncryptedNote(keyData.storage) : null;
    if (warn) f.append(warn);
    return f;
  }
  /** 登録済みのキーを選ぶ／別のキーを入れる（ラジオ）。登録済みがあれば既定で選ばれ、貼り直しは要らない */
  function registeredKeyField(list) {
    const picked = pickedKey();
    const own = form.keyMode === 'own';
    const fs = el('fieldset', 'mp-field ak-pick');
    fs.append(el('legend', null, t('compat.form.apiKey')));
    const radio = (mode, label, extra = []) => {
      const row = el('div', 'ak-radio'); const id = `epkey-${mode}`;
      const input = el('input'); input.type = 'radio'; input.name = 'epkey'; input.id = id; input.checked = form.keyMode === mode; input.dataset.fk = `rad:${mode}`;
      input.onchange = () => { form.keyMode = mode; if (mode === 'registered') form.keyChosen = true; focusAfterDraw = `rad:${mode}`; invalidate(); draw(); };
      const text = el('span', 't'); const lab = el('label'); lab.htmlFor = id; lab.append(label); text.append(lab, ...extra);
      row.append(input, text); return row;
    };
    const uses = picked?.uses.length ?? 0;
    const one = list.length === 1;
    const registeredLabel = one ? el('b', null, t('apiKeys.endpoint.registeredOne', { name: picked?.label ?? '' })) : el('b', null, t('apiKeys.endpoint.registered'));
    const extra = [];
    if (!one) extra.push(' ', keySelect({ keys: list, current: picked?.id ?? null, label: t('apiKeys.endpoint.selectLabel'), focusKey: 'sel:ep', align: 'left',
      choose: id => { if (id) form.keyRef = id; form.keyMode = 'registered'; form.keyChosen = true; focusAfterDraw = 'sel:ep'; invalidate(); draw(); } }).element);
    if (picked) {
      // 「登録済みのキー」と言った後ろなので、確認の結果（確かめていれば）・使っている数・管理へのリンクだけ続ける
      const small = el('small'); const check = checkParts(picked);
      if (check) small.append(check.failed ? el('span', 'mp-warn', check.text) : check.text, ' · ');
      small.append(`${uses ? t('apiKeys.endpoint.usedBy', { count: uses }) : t('apiKeys.endpoint.unused')} · `, manageLink(openPage));
      extra.push(small);
    }
    fs.append(radio('registered', registeredLabel, extra), radio('own', t('apiKeys.endpoint.own')));
    if (own) {
      const key = el('input'); key.type = form.show ? 'text' : 'password'; key.value = form.key; key.autocomplete = 'new-password'; key.spellcheck = false;
      key.setAttribute('aria-label', t('apiKeys.endpoint.ownAria')); key.dataset.field = 'key'; key.dataset.fk = 'epin';
      key.oninput = () => { form.key = key.value; invalidate(); };
      const kr = el('div', 'mp-keyrow'); kr.append(key, button(form.show ? t('compat.form.hide') : t('compat.form.show'), () => { form.show = !form.show; focusAfterDraw = 'epin'; draw(); }));
      fs.append(kr, el('small', 'ak-cap', t('apiKeys.endpoint.ownCaption')));
      const warn = notEncryptedNote(keyData.storage); if (warn) fs.append(warn);
    }
    return fs;
  }
  let focusAfterDraw = null;
  function drawForm() {
    const claude = agent === 'claude'; const P = presetOf(agent, form.preset); const editing = Boolean(form.id);
    const out = [];
    // 追加は一覧の末尾の白いカード（段の並び「✓ 種類 · 接続情報 · …」から。種類は一覧の「接続先の種類」で選んだもの）。
    // 編集はそのカードの中で開く（段の並びは出さない）。見出しと［閉じる］は持たない（［やめる］が閉じる）
    if (!editing) {
      const cur = form.phase === 'ok' ? 4 : form.phase === 'checking' || form.phase === 'fail' ? 3 : 2;
      const steps = el('div', 'mp-steps');
      STEPS.forEach((label, i) => steps.append(el('span', i + 1 < cur ? 'done' : i + 1 === cur ? 'cur' : '', (i + 1 < cur ? '✓ ' : `${i + 1}. `) + (i ? label : `${label}（${P.name}）`))));
      out.push(steps);
    }
    // ② 接続情報
    const g = el('div', 'mp-grid');
    const name = el('input'); name.value = form.name; name.placeholder = t('compat.form.namePlaceholder'); name.maxLength = 60; name.autocomplete = 'off';
    name.oninput = () => { form.name = name.value; };
    g.append(field(t('compat.form.name'), name));
    // URL の一文は間違い（/v1 の付けすぎ・<リソース名> の置き忘れ）のときだけ出す
    const help = el('small', 'mp-warn', urlHelp(agent, form.baseUrl));
    const url = createCombo({ ariaLabel: 'URL', placeholder: claude ? t('compat.form.urlPlaceholder') : 'https://example.com/v1', cls: 'mono', value: form.baseUrl,
      options: () => urlCandidates(agent, form.preset),
      onCommit: v => { if (form.baseUrl !== v) { form.baseUrl = v; help.textContent = urlHelp(agent, v); if (form.phase === 'edit') draw(); else invalidate(); } } });
    url.root.querySelector('input').spellcheck = false;
    url.root.querySelector('input').addEventListener('input', e => { help.textContent = urlHelp(agent, e.target.value); });
    g.append(field('URL', url.root, help));
    out.push(g);
    const authField = el('div', 'mp-field');
    authField.append(el('span', null, t('compat.form.auth')));
    const seg = el('div', 'seg mp-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('compat.form.auth'));
    for (const v of claude ? ['auto', 'bearer', 'x-api-key'] : ['bearer', 'api-key']) {
      const b = el('button', v === form.authMode ? 'on' : '', AUTH_LABEL[v]); b.type = 'button'; b.setAttribute('aria-pressed', String(v === form.authMode));
      b.onclick = () => { if (form.authMode === v) return; form.authMode = v; invalidate(); draw(); };
      seg.append(b);
    }
    authField.append(seg);
    out.push(keyField(P, editing));
    // 認証の送り方は既定（プリセットの値。Claude のカスタムは自動）のまま使うことが多いので、畳んでおく
    const authDefault = blankForm(form.preset).authMode;
    const ad = el('details'); ad.open = form.authMode !== authDefault;
    ad.append(el('summary', null, t('compat.form.advanced')), authField);
    out.push(ad);
    // ③ 確認（段の見出しは置かない。上の段の並びが今どこかを示す）
    if (form.stale && form.phase === 'edit') out.push(el('p', 'mp-note mp-warn', t('compat.form.stale')));
    if (form.phase === 'checking') out.push(Object.assign(el('div', 'mp-result'), { textContent: t('compat.checking') }));
    if (form.result) {
      const r = el('div', 'mp-result'); r.setAttribute('role', 'status');
      const n = form.result.models?.length ?? 0;
      r.append(el('strong', form.result.ok ? '' : 'mp-warn', form.result.ok ? (n ? t('compat.form.connectedModels', { count: n }) : t('compat.form.connected')) : `✕ ${form.result.error}`));
      for (const l of form.result.lines ?? []) r.append(line(l));
      out.push(r);
    }
    // ④ モデル（確認が通ったあと。編集では保存済みの割り当てを最初から見せる）
    if (form.phase === 'ok' || editing) {
      if (claude) {
        const rg = el('div', 'mp-grid');
        for (const r of CLAUDE_ROLES) rg.append(field(r.label, modelCombo(form.roles[r.key] ?? '', v => { form.roles[r.key] = v; }, r.label)));
        out.push(rg);
        const d = el('details'); d.open = Boolean(form.context || form.sendThinking !== Boolean(P.thinking));
        d.append(el('summary', null, t('compat.form.advanced')));
        const ctx = createCombo({ ariaLabel: t('compat.form.context'), placeholder: t('compat.form.contextEmptyClaude'), cls: 'mono', value: form.context,
          options: () => CONTEXT_CANDIDATES.map(([value, hint]) => ({ value, hint })), onCommit: v => { form.context = v; } });
        d.append(field(t('compat.form.contextTokens'), ctx.root));
        const think = el('label', 'mp-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = form.sendThinking;
        cb.onchange = () => { form.sendThinking = cb.checked; };
        think.append(cb, el('span', null, t('compat.form.sendThinking')));
        d.append(think, el('small', 'mp-note', t('compat.form.sendThinkingNote')));
        out.push(d);
      } else {
        const rg = el('div', 'mp-grid');
        const azure = form.preset === 'azure';
        rg.append(field(azure ? t('compat.form.defaultModelAzure') : t('compat.form.defaultModel'), modelCombo(form.roles.main ?? '', v => { form.roles.main = v; }, t('compat.form.defaultModel'), azure ? t('compat.form.deployment') : t('compat.form.modelId'))));
        const ctx = createCombo({ ariaLabel: t('compat.form.context'), placeholder: t('compat.form.contextEmptyCodex'), cls: 'mono', value: form.context,
          options: () => CONTEXT_CANDIDATES.map(([value, hint]) => ({ value, hint })), onCommit: v => { form.context = v; } });
        rg.append(field(t('compat.form.contextTokens'), ctx.root));
        out.push(rg);
      }
    }
    const err = el('p', 'mp-state mp-warn', form.error); err.setAttribute('role', 'alert'); out.push(err);
    const a = el('div', 'mp-actions');
    // 確認は本物の生成を 1 回送る。料金のことはここに 1 回だけ
    if (form.phase !== 'ok') a.append(el('small', null, t('compat.form.checkCost')));
    a.append(button(t('compat.action.cancel'), backToList));
    if (form.phase === 'ok') a.append(button(t('compat.form.checkAgain'), check), button(t('compat.step.save'), save, 'btn btn-primary'));
    else {
      const c = button(form.phase === 'checking' ? t('compat.checking') : t('compat.step.check'), check, 'btn btn-primary'); c.disabled = form.phase === 'checking'; a.append(c);
    }
    out.push(a);
    panel.replaceChildren(...compose(out));
  }
  /** 一覧のカードに、追加・編集の欄を差し込む（編集はそのカードの中、追加は末尾の白いカード） */
  function compose(body) {
    const cards = listCards();
    const mine = form?.id ? cards.find(c => c.dataset.endpoint === form.id) : null;
    if (mine) {
      mine.classList.add('is-open');
      mine.querySelector('.mp-card-actions').hidden = true;
      mine.append(...body);
    } else {
      const stage = el('div', 'mp-card mp-acct cc is-open conn-stage');
      stage.append(...body);
      cards.push(stage);
    }
    const state = el('p', 'mp-state', message); state.setAttribute('role', 'status');
    return [...cards, state];
  }
  async function check() {
    // フォーカス中の combo の値を確定させてから読む（blur で確定する）
    document.activeElement?.blur?.();
    form.error = '';
    if (!form.baseUrl.trim()) { form.error = t('compat.form.urlRequired'); draw(); return; }
    // 「別のキーを入れる」を選んだのに空のまま確認しない（保存済みのキーのまま確かめて、入れたつもりになるのを避ける）
    if (form.keyMode === 'own' && candidateKeys(presetOf(agent, form.preset)) && !form.key.trim()) { form.error = t('apiKeys.endpoint.keyRequired'); draw(); return; }
    form.phase = 'checking'; form.result = null; form.stale = false; draw();
    const mine = form;
    try {
      const r = await cmd('compatEndpointCheck', { input: input(), ...(form.id ? { id: form.id } : {}) });
      if (form !== mine) return;
      form.phase = r.ok ? 'ok' : 'fail';
      form.result = r;
      if (r.ok) { form.receipt = r.receipt; if (r.models?.length) { form.models = r.models; form.modelInfo = r.modelInfo ?? {}; } }
    } catch (e) { if (form !== mine) return; form.phase = 'fail'; form.result = { ok: false, error: e.message, lines: [] }; }
    draw();
  }
  async function save() {
    document.activeElement?.blur?.();
    form.error = '';
    if (!form.name.trim()) { form.error = t('compat.form.nameRequired'); draw(); return; }
    try {
      await cmd('compatEndpointSave', { input: input(), receipt: form.receipt, ...(form.id ? { id: form.id } : {}) });
      // 保存したら一覧へ戻る（足したカードが一覧に並ぶ。済んだことは状態の行に 1 行）
      const adding = !form.id, name = form.name;
      form.key = ''; view = 'list'; form = null;
      await load(true).catch(() => {}); onChange();
      message = t('compat.form.saved', { name });
      draw();
      if (adding) onAddEnd();
      return;
    } catch (e) { form.error = e.message; }
    draw();
  }
  function backToList() { const adding = Boolean(form && !form.id); view = 'list'; form = null; message = ''; draw(); if (adding) onAddEnd(); }

  function draw() {
    if (view === 'form' && form) drawForm(); else drawList();
    // 選び方を変えた直後は、押した部品へフォーカスを戻す（描き直しで外れるので）
    if (focusAfterDraw) { panel.querySelector(`[data-fk="${CSS.escape(focusAfterDraw)}"]`)?.focus({ preventScroll: true }); focusAfterDraw = null; }
  }
  function close() { panel.hidden = true; view = 'list'; form = null; onOpen(''); }
  let onOpen = () => {};

  return {
    load,
    /** 管理の面（web/client.mjs がカードの枠へ移し、描き直しの前に元の置き場へ戻す） */
    panel,
    /** 読み込み済みの一覧（入力欄の面が読む）。まだなら空 */
    list: (a) => endpoints.filter(e => !a || e.agent === a),
    defaults: () => ({ ...defaults }),
    get: (id) => endpoints.find(e => e.id === id) ?? null,
    invalidate() { loaded = null; if (!panel.hidden && view === 'list') load(true).then(draw).catch(() => {}); },
    /** API キーの登録・差し替え・削除が届いたとき。キーの欄の選べるキーを取り直す（入力の途中の値は変えない） */
    keysChanged() {
      if (panel.hidden || view !== 'form' || !form) return;
      apiKeyList(cmd).then(keys => { keyData = keys; if (view === 'form' && form && !panel.contains(document.activeElement)) draw(); }).catch(() => {});
    },
    /** 面を閉じる（エージェントのカードの「接続」を畳むとき） */
    close,
    /** 接続先の一覧を開いたとき、そのエージェントの互換のカードを出す（開く・閉じるは web/client.mjs の接続先の面が決める） */
    async open(which, { add = null } = {}) {
      openSettings(); agent = which; view = 'list'; form = null; confirming = ''; message = t('compat.loading');
      panel.hidden = false; onOpen(agent); drawList();
      try { await load(true); message = ''; if (add) startForm(null, add); else draw(); }
      catch (e) { message = e.message; draw(); }
    },
    /** 一覧の「接続先の種類」で互換の種類（プリセット）を選んだ。② 接続情報から始める */
    async startAdd(which, presetId) {
      if (panel.hidden || agent !== which) { await this.open(which, { add: presetId }); return; }
      await load().catch(() => {});
      startForm(null, presetId);
      panel.querySelector('.mp-grid input')?.focus();
    },
    /** 追加の欄が開いている */
    get adding() { return !panel.hidden && view === 'form' && Boolean(form) && !form.id; },
    /** 描き直す（既定が変わったとき） */
    repaint() { if (!panel.hidden && !(view === 'form' && panel.contains(document.activeElement))) draw(); },
    /** どのエージェントの面が開いているか（設定の行のボタンの aria-expanded に使う） */
    onOpen(fn) { onOpen = fn; },
    get openAgent() { return panel.hidden ? '' : agent; },
  };
}
