import { t } from './i18n.mjs';

export function createBotEnablement(invoke) {
  const key = 'botEnabled';
  const read = async () => (await invoke('settings.get', { key })).value;
  const write = async (value) => (await invoke('settings.set', { key, value })).value;
  let checking;

  async function confirm(anchor) {
    const dialog = document.getElementById('botEnableDialog');
    const cancel = document.getElementById('botEnableCancel');
    const enable = document.getElementById('botEnableConfirm');
    const feedback = document.getElementById('botEnableError');
    feedback.textContent = '';
    dialog.returnValue = '';
    const decision = new Promise(resolve => {
      dialog.addEventListener('close', () => {
        const activated = dialog.returnValue === 'enable';
        if (!activated) anchor?.focus();
        resolve(activated);
      }, { once: true });
    });
    enable.onclick = async () => {
      enable.disabled = true;
      cancel.disabled = true;
      feedback.textContent = '';
      try {
        await write(true);
        dialog.close('enable');
      } catch {
        feedback.textContent = t('settings.memory.act.saveFailed');
      } finally {
        enable.disabled = false;
        cancel.disabled = false;
        if (dialog.open) enable.focus();
      }
    };
    const onCancel = (event) => { if (enable.disabled) event.preventDefault(); };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!enable.disabled) dialog.close('cancel');
        return;
      }
      if (event.key !== 'Tab' || enable.disabled) return;
      if ((event.shiftKey && document.activeElement === cancel) || (!event.shiftKey && document.activeElement === enable)) {
        event.preventDefault();
        (event.shiftKey ? enable : cancel).focus();
      }
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('keydown', onKey);
    dialog.showModal();
    cancel.focus();
    try { return await decision; }
    finally {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('keydown', onKey);
      enable.onclick = null;
    }
  }

  return {
    read, write,
    request(anchor = document.activeElement) {
      checking ??= read().catch(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return read();
      }).then(async on => on === true ? 'on' : on === false && await confirm(anchor) ? 'enabled' : false)
        .catch(() => false).finally(() => { checking = null; });
      return checking;
    },
  };
}
