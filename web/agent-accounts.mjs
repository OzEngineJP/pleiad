// Claude 以外のエージェントのアカウント（会話ごとに選ぶ。core/agent-accounts.mjs、ADR 0222）の設定。
// 一覧の追加・名前の変更・削除と、ログイン（エージェントの口 backend.accountLogin。ブラウザーで開く URL か、端末で打つコマンドを出す）。
// 資格情報は画面に出さない（サーバーも返さない。ログインしたか・アカウントの見出しだけ）。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）を使う。Claude のアカウントは web/claude-accounts.mjs。
import { el } from './dom.mjs';
import { t, applyDom } from './i18n.mjs';

// Invalidation also retires pending requests, including their error handlers.
export function createAccountRequestCache({ read, cache = new Map(), accept = () => true }) {
  const pending = new Map();
  return {
    cache,
    get(key, { force = false } = {}) {
      if (!force && cache.has(key)) return Promise.resolve(cache.get(key));
      if (!force && pending.has(key)) return pending.get(key).promise;
      const request = {};
      pending.set(key, request);
      const current = () => pending.get(key) === request;
      request.promise = Promise.resolve().then(() => read(key)).then(value => {
        if (!current()) return pending.get(key)?.promise ?? cache.get(key);
        if (accept(value)) cache.set(key, value);
        return value;
      }, error => {
        if (!current()) return pending.get(key)?.promise ?? cache.get(key);
        throw error;
      }).finally(() => { if (current()) pending.delete(key); });
      return request.promise;
    },
    invalidate(key) {
      if (key === undefined) { pending.clear(); cache.clear(); }
      else { pending.delete(key); cache.delete(key); }
    },
  };
}

export function composerAccount({ backend, session = null, draft = null, prefs = {}, kind, homeBot = null }) {
  if (homeBot || !kind) return '';
  if (draft?.account !== undefined) return draft.account;
  if (session) {
    if (draft?.backend && draft.backend !== (session.nextSettings?.backend ?? session.backend)) return '';
    if (session.nextSettings?.account !== undefined) return session.nextSettings.account;
    if (session.nextSettings?.backend && session.nextSettings.backend !== session.backend) return '';
    return session.claudeAccount ?? '';
  }
  return prefs.backends?.[backend]?.account ?? (kind === 'token' ? prefs.claudeAccount : null) ?? '';
}

export function setupAgentAccounts({ cmd, openSettings, labelOf = (id) => id, onChange = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const accountCmd = (operation, args) => cmd('invoke', { op: `accounts.${operation}`, args });
  const panel = document.createElement('section');
  panel.className = 'mp-panel'; panel.id = 'agentAccountsPanel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'aaTitle');
  panel.innerHTML = `<div class="mp-row"><h3 id="aaTitle"></h3><button type="button" class="btn" id="aaClose" data-i18n="agentAccounts.close"></button></div>
  <p class="mp-note" id="aaIntro"></p>
  <div id="aaList"></div><button type="button" class="btn" id="aaAdd" data-i18n="agentAccounts.add"></button>
  <section class="mp-card" id="aaFlow" hidden aria-live="polite"><h3 id="aaFlowTitle"></h3><div id="aaFlowBody"></div></section>
  <form id="aaForm" hidden><h3 id="aaFormTitle"></h3>
  <label class="mp-field"><span data-i18n="agentAccounts.form.name"></span><input id="aaName" required maxlength="60" data-i18n-placeholder="agentAccounts.form.namePlaceholder" autocomplete="off"></label>
  <div class="mp-actions"><button type="button" class="btn" id="aaCancel" data-i18n="agentAccounts.cancel"></button><button type="submit" class="btn btn-primary" id="aaSubmit"></button></div>
  <p class="mp-state" id="aaFormState" role="status"></p></form>
  <p class="mp-state" id="aaState" role="status"></p>`;
  applyDom(panel);
  $('agentControls').append(panel);

  const lists = createAccountRequestCache({ read: async id => (await accountCmd('list', { backend: id })).accounts ?? [] });
  const cache = lists.cache;
  let backend = null, editingId = '', confirming = '';
  let view = null, formVersion = 0, transition = Promise.resolve(), running = null;
  const showing = captured => view === captured && !panel.hidden;
  // Identity is immutable; presentation state belongs to this attempt alone.
  let flow = null;
  const desktop = () => Boolean(window.plyDesktop) && !window.plyRemote;

  async function load(id, force = false) {
    if (!id) return [];
    return (await lists.get(id, { force })) ?? [];
  }
  const button = (text, onclick, className = 'btn') => { const b = el('button', className, text); b.type = 'button'; b.onclick = onclick; return b; };
  const status = (a) => (a.hasCredential ? (a.label ? t('agentAccounts.status.signedInAs', { label: a.label }) : t('agentAccounts.status.signedIn')) : t('agentAccounts.status.signedOut'));

  function draw() {
    const drawnView = view;
    const accounts = cache.get(backend) ?? [];
    $('aaList').replaceChildren(...accounts.map((a) => {
      const card = el('div', 'mp-card');
      const top = el('div', 'mp-row'), info = el('div', 'mp-card-info');
      info.append(el('strong', null, a.name), el('small', null, status(a)));
      const actions = el('div', 'mp-card-actions');
      actions.hidden = confirming === a.id;
      actions.append(
        button(a.hasCredential ? t('agentAccounts.relogin') : t('agentAccounts.login'), () => startLogin(a, drawnView)),
        button(t('agentAccounts.edit'), () => edit(a, drawnView)), button(t('agentAccounts.delete'), () => { if (showing(drawnView)) { confirming = a.id; draw(); } }));
      top.append(info, actions); card.append(top);
      if (confirming === a.id) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, t('agentAccounts.confirmDelete', { name: a.name })));
        const row = el('div', 'mp-card-actions');
        row.append(button(t('agentAccounts.cancel'), () => { confirming = ''; draw(); }), button(t('agentAccounts.confirmDeleteButton'), () => remove(a, drawnView)));
        ask.append(row); card.append(ask);
      }
      return card;
    }));
    if (!accounts.length) $('aaList').replaceChildren(el('p', 'mp-note', t('agentAccounts.empty')));
  }

  // ---------------------------------------------------------------- ログインの進み具合
  function drawFlow() {
    const box = $('aaFlow');
    if (!flow || flow.attempt.backend !== backend || panel.hidden) { box.hidden = true; $('aaFlowBody').replaceChildren(); return; }
    const shown = flow;
    box.hidden = false;
    $('aaFlowTitle').textContent = t('agentAccounts.flow.title', { name: shown.attempt.name });
    const body = [];
    const actions = (...buttons) => { const row = el('div', 'mp-actions'); row.append(...buttons); return row; };
    const cancel = button(t('agentAccounts.cancel'), () => cancelFlow(shown));
    const close = () => { if (flow === shown) { flow = null; drawFlow(); } };
    switch (flow.phase) {
      case 'starting':
        body.push(el('p', null, t('agentAccounts.flow.starting')), actions(cancel));
        break;
      case 'url': {
        body.push(el('p', null, t('agentAccounts.flow.openBrowser')));
        if (/^https:\/\//.test(flow.url ?? '')) {
          const a = el('a', null, t('agentAccounts.flow.openLink'));
          a.href = flow.url; a.target = '_blank'; a.rel = 'noreferrer';
          const p = el('p', 'mp-note'); p.append(a); body.push(p);
        }
        if (flow.message) body.push(el('p', 'mp-note', flow.message));
        body.push(actions(cancel));
        break;
      }
      case 'command': {
        body.push(el('p', null, t('agentAccounts.flow.runCommand')));
        const line = el('p', 'mp-note'); line.append(el('code', null, flow.command ?? ''));
        body.push(line);
        const copy = button(t('agentAccounts.flow.copy'), () => navigator.clipboard?.writeText(shown.command ?? '').catch(() => {}));
        if (flow.message) body.push(el('p', 'mp-note', flow.message));
        body.push(actions(cancel, copy));
        break;
      }
      case 'done':
        body.push(el('p', null, flow.label ? t('agentAccounts.flow.doneAs', { label: flow.label }) : t('agentAccounts.flow.done')),
          actions(button(t('agentAccounts.close'), close)));
        break;
      case 'error':
        body.push(el('p', 'mp-state', flow.message || t('agentAccounts.flow.failed')),
          actions(button(t('agentAccounts.close'), close),
            button(t('agentAccounts.flow.retry'), () => startLogin({ id: shown.attempt.accountId, name: shown.attempt.name }))));
        break;
    }
    $('aaFlowBody').replaceChildren(...body);
  }

  const closePopup = record => { try { record?.popup?.close?.(); } catch {} if (record) record.popup = null; };
  async function cancelAttempt(record) {
    closePopup(record);
    if (record?.started && !record.settled) await accountCmd('cancel', { id: record.attempt.accountId, attempt: record.attempt.loginId });
    if (running === record) running = null;
  }
  function enqueue(action) {
    const next = transition.catch(() => {}).then(action);
    transition = next;
    return next;
  }
  function startLogin(a, capturedView = view) {
    if (!showing(capturedView)) return;
    const previous = flow;
    closePopup(previous);
    let popup = null;
    // ブラウザー版はクリックの中で窓を開けておく（URL が届いてから開くとポップアップとして止められる）
    if (!desktop()) { try { popup = window.open('', '_blank'); if (popup) popup.opener = null; } catch {} }
    const attempt = Object.freeze({ accountId: a.id, name: a.name, backend: capturedView.backend, loginId: crypto.randomUUID() });
    const record = { attempt, phase: 'starting', url: null, command: null, message: '', label: '', popup, started: false, settled: false };
    flow = record;
    $('aaForm').hidden = true; confirming = ''; draw(); drawFlow();
    $('aaFlow').scrollIntoView?.({ block: 'nearest' });
    const fail = e => { if (flow === record) { record.phase = 'error'; record.message = e.message; closePopup(record); drawFlow(); } };
    return enqueue(async () => {
      await cancelAttempt(running);
      if (flow !== record || panel.hidden || backend !== attempt.backend) { closePopup(record); return; }
      record.started = true;
      running = record;
      // Dispatch inside the transition queue, but keep the long login outside it.
      record.result = accountCmd('login', { id: attempt.accountId, open: desktop(), attempt: attempt.loginId });
      void record.result.then(async r => {
        record.settled = true;
        if (running === record) running = null;
        closePopup(record);
        if (flow === record) { record.phase = 'done'; record.label = r?.label ?? ''; drawFlow(); }
        lists.invalidate(attempt.backend); onChange(attempt.backend);
        await load(attempt.backend, true).catch(e => { if (!panel.hidden && backend === attempt.backend) $('aaState').textContent = e.message; });
        if (!panel.hidden && backend === attempt.backend) draw();
      }, e => { record.settled = true; if (running === record) running = null; fail(e); }).catch(fail);
    }).catch(fail);
  }
  function cancelFlow(record = flow) {
    if (flow === record) { flow = null; drawFlow(); }
    closePopup(record);
    return enqueue(() => cancelAttempt(record)).catch(e => { if (!panel.hidden && backend === record?.attempt.backend) $('aaState').textContent = e.message; });
  }
  /** サーバーの auth イベントのうち、アカウントのログインのもの（accountId 付き。web/client.mjs が渡す） */
  function authEvent(ev) {
    if (!flow || flow.settled || ev.backend !== flow.attempt.backend || ev.accountId !== flow.attempt.accountId || ev.loginId !== flow.attempt.loginId) return;
    if (ev.phase === 'url') {
      if (/^https:\/\//.test(ev.url ?? '')) {
        flow.phase = 'url'; flow.url = ev.url; flow.message = ev.message ?? '';
        if (flow.popup) { try { flow.popup.location.href = ev.url; } catch {} }
      } else { flow.phase = 'command'; flow.command = ev.url ?? ''; flow.message = ev.message ?? ''; closePopup(flow); }
    } else if (ev.phase === 'error') { flow.phase = 'error'; flow.message = ev.message ?? ''; closePopup(flow); }
    drawFlow();
  }

  // ---------------------------------------------------------------- 追加・名前の変更
  function resetForm() {
    formVersion += 1;
    $('aaSubmit').disabled = false;
    editingId = ''; $('aaFormTitle').textContent = t('agentAccounts.form.addTitle', { agent: labelOf(backend) });
    $('aaName').value = ''; $('aaFormState').textContent = ''; $('aaSubmit').textContent = t('agentAccounts.form.addAndLogin');
  }
  function edit(a, capturedView = view) {
    if (!showing(capturedView)) return;
    resetForm(); editingId = a.id; confirming = '';
    $('aaFormTitle').textContent = t('agentAccounts.form.editTitle', { name: a.name }); $('aaName').value = a.name;
    $('aaSubmit').textContent = t('agentAccounts.form.save');
    $('aaForm').hidden = false; draw(); $('aaName').focus();
  }
  async function remove(a, capturedView = view) {
    if (!showing(capturedView)) return;
    const id = capturedView.backend;
    const activeFlow = flow?.attempt.accountId === a.id && flow?.attempt.backend === id ? flow : null;
    $('aaState').textContent = '';
    try {
      await accountCmd('remove', { id: a.id });
      if (activeFlow && flow === activeFlow) { closePopup(activeFlow); flow = null; drawFlow(); }
      lists.invalidate(id); onChange(id);
      if (showing(capturedView)) { confirming = ''; if (editingId === a.id) { $('aaForm').hidden = true; resetForm(); } }
      await load(id, true);
      if (showing(capturedView)) draw();
    } catch (e) { if (showing(capturedView)) $('aaState').textContent = t('agentAccounts.deleteFailed', { error: e.message }); }
  }
  $('aaForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('aaName').value.trim();
    if (!name) { $('aaFormState').textContent = t('agentAccounts.form.nameRequired'); $('aaName').focus(); return; }
    $('aaSubmit').disabled = true;
    const capturedView = view, version = formVersion, editing = editingId, id = backend;
    const sameForm = () => showing(capturedView) && formVersion === version;
    try {
      const created = editing ? await accountCmd('rename', { id: editing, name }) : await accountCmd('create', { backend: id, name });
      const keepForm = sameForm();
      if (keepForm) { $('aaForm').hidden = true; resetForm(); }
      lists.invalidate(id); onChange(id);
      await load(id, true).catch(err => { if (showing(capturedView)) $('aaState').textContent = err.message; });
      if (showing(capturedView)) draw();
      if (!editing && keepForm && showing(capturedView) && formVersion === version + 1) startLogin({ id: created.id, name: created.name }, capturedView);
    } catch (err) { if (sameForm()) $('aaFormState').textContent = err.message; }
    finally { if (sameForm()) $('aaSubmit').disabled = false; }
  };
  $('aaClose').onclick = () => { panel.hidden = true; view = null; $('aaForm').hidden = true; resetForm(); void cancelFlow(); };
  $('aaAdd').onclick = () => { resetForm(); confirming = ''; $('aaForm').hidden = false; draw(); $('aaName').focus(); };
  $('aaCancel').onclick = () => { $('aaForm').hidden = true; resetForm(); };

  async function open(id) {
    if (flow && flow.attempt.backend !== id) void cancelFlow();
    const capturedView = Object.freeze({ backend: id });
    view = capturedView;
    openSettings(); backend = id; panel.hidden = false;
    $('aaForm').hidden = true; resetForm(); confirming = ''; draw(); drawFlow();
    $('aaTitle').textContent = t('agentAccounts.title', { agent: labelOf(id) });
    $('aaIntro').textContent = t('agentAccounts.intro', { agent: labelOf(id) });
    $('aaState').textContent = t('agentAccounts.loading');
    try { await load(id, true); if (!showing(capturedView)) return; draw(); drawFlow(); $('aaState').textContent = ''; panel.scrollIntoView({ block: 'nearest' }); }
    catch (e) { if (showing(capturedView)) $('aaState').textContent = e.message; }
  }
  return {
    open, load, authEvent,
    /** 取ってある一覧（同期。まだ取っていなければ空） */
    list: (id) => cache.get(id) ?? [],
    invalidate: () => {
      lists.invalidate();
      const capturedView = view;
      if (showing(capturedView) && backend) load(backend, true).then(() => { if (showing(capturedView)) draw(); }).catch(() => {});
    },
  };
}
