// サイドバーと bot ページで共有する削除確認。
export function createBotDelete(host) {
  const { t } = host;
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const dialog = el('dialog');
  dialog.className = 'bot-delete';
  dialog.setAttribute('aria-labelledby', 'botDeleteTitle');
  dialog.setAttribute('aria-describedby', 'botDeleteLead');
  const title = el('h2'); title.id = 'botDeleteTitle';
  const lead = el('p', t('channels:botDelete.irreversible')); lead.id = 'botDeleteLead'; lead.className = 'lead';
  const list = el('ul');
  const why = el('p'); why.className = 'why'; why.setAttribute('role', 'status');
  const error = el('p'); error.className = 'err'; error.setAttribute('role', 'alert');
  const actions = el('div'); actions.className = 'actions';
  const cancel = el('button', t('channels:botDelete.cancel')); cancel.className = 'btn'; cancel.type = 'button'; cancel.autofocus = true;
  const confirm = el('button', t('channels:botDelete.confirm')); confirm.className = 'btn danger'; confirm.type = 'button';
  actions.append(cancel, confirm); dialog.append(title, lead, list, why, error, actions); document.body.append(dialog);
  let target = null, opener = null, submitting = false, sequence = 0;
  const focusBack = () => {
    if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus();
    else {
      const sameBot = target && document.querySelector('.bt[data-id="' + CSS.escape(target.id) + '"]');
      if (sameBot && !sameBot.closest('[hidden]')) { sameBot.focus(); return; }
      const notice = document.querySelector('#botView:not([hidden]) .bp-gone:not([hidden])');
      (notice ?? document.querySelector('.bot-strip .bt, .bt'))?.focus();
    }
  };
  const close = () => { if (!submitting) { sequence++; dialog.close(); focusBack(); target = null; } };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  cancel.addEventListener('click', close);
  async function refresh() {
    const current = ++sequence;
    confirm.disabled = true;
    try {
      const bot = await host.invoke('bots.get', { botId: target.id });
      if (current !== sequence || submitting || !dialog.open) return;
      const info = bot.deletion;
      title.textContent = t('channels:botDelete.title', { name: bot.name });
      list.replaceChildren(el('li', t('channels:botDelete.remove')), el('li', t('channels:botDelete.shared')));
      if (info?.conversations) list.append(el('li', t('channels:botDelete.conversations', { count: info.conversations })));
      if (info?.routines) list.append(el('li', t('channels:botDelete.routines', { count: info.routines })));
      why.textContent = info?.blockedReason ?? '';
      confirm.disabled = Boolean(info?.blockedReason || bot.plain);
    } catch (e) { if (current === sequence) error.textContent = e.message; }
  }
  host.deleteBot = (bot, from = document.activeElement) => {
    if (dialog.open || bot.plain) return;
    target = bot; opener = from; submitting = false;
    title.textContent = t('channels:botDelete.title', { name: bot.name });
    list.replaceChildren(); why.textContent = ''; error.textContent = ''; cancel.disabled = false; confirm.disabled = true;
    dialog.showModal(); cancel.focus(); void refresh();
  };
  confirm.addEventListener('click', async () => {
    if (submitting || confirm.disabled || !target) return;
    submitting = true; sequence++; cancel.disabled = true; confirm.disabled = true;
    confirm.textContent = t('channels:botDelete.deleting'); error.textContent = '';
    try {
      await host.invoke('bots.delete', { botId: target.id });
      submitting = false; close();
    } catch (e) {
      submitting = false; cancel.disabled = false;
      error.textContent = t('channels:botDelete.failed', { error: e.message });
      await refresh();
    } finally { confirm.textContent = t('channels:botDelete.confirm'); }
  });
  return { onEvent(event) { if (dialog.open && !submitting && ['botsChanged', 'running', 'waiting', 'outbox', 'routinesChanged'].includes(event.type)) void refresh(); } };
}
