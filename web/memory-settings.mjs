import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { botIcon } from './channels/bot-icon.mjs';
import { createMemoryList } from './channels/memory-list.mjs';
import { learnEnabledOf, authOutOf } from './memory-model.mjs';

const POLL_MS = 2000;

export function setupMemorySettings({ cmd, invoke, botEnablement, getPrefs, getAuth, learnBackend, onLogin, openBot, openSource, memoryDirectory }) {
  const $ = (id) => document.getElementById(id);
  const autoSw = $('memoryAutoLearn');
  const botSw = $('botEnabled');
  const memoryHeading = $('memoryHeading');
  const memoryOptions = $('memoryOptions');
  const enableSaved = $('botEnableSaved');
  const timeIn = $('memoryLearnAt');
  const deps = [...$('memoryPanel').querySelectorAll('.learn-dep')];   // 毎晩の整理が OFF の間は薄くして押せなくする行（時刻）
  const statusBox = $('memoryLearnStatus');
  const actionsBox = $('memoryLearnActions');
  const changesPanel = $('memoryLastChanges');
  const changesList = $('memoryChangeList');
  let changesLimit = 20;
  let changesRead = 0;
  changesPanel.ontoggle = () => { if (changesPanel.open) void refreshChanges(); };
  const saved = $('memoryLearnSaved');
  const botsBox = $('memoryBots');
  const botsList = $('memoryBotsList');
  let status = null;       // memory.learnStatus の返り（読めていなければ null）
  let bots = [];           // 記憶を持つ bot（plain は除く）。bot のページへの入口
  let seq = 0;             // 読み直しの番号（遅い返事を捨てる）
  let timer = null;        // 走っている間の読み直し
  let busy = false;        // 再試行を動かしている間
  let enabled;
  let settingBusy = false;
  let settingsSeq = 0;
  let retry;
  let common;
  let commonView;

  const paintEnablement = () => {
    if (typeof enabled === 'boolean') botSw.setAttribute('aria-checked', String(enabled));
    botSw.disabled = settingBusy || typeof enabled !== 'boolean';
    memoryOptions.hidden = enabled !== true;
    memoryHeading.hidden = enabled !== true && botsBox.hidden;
  };

  botSw.onclick = async () => {
    settingBusy = true;
    paintEnablement();
    enableSaved.textContent = '';
    try {
      enabled = await botEnablement.write(!enabled);
      await refresh();
    } catch {
      enableSaved.textContent = t('settings.memory.act.saveFailed');
    } finally {
      settingBusy = false;
      paintEnablement();
    }
  };

  const note = (text) => { saved.textContent = text; };

  /** スイッチ・欄 → prefs の写し（毎晩の整理の実効は memoryAutoLearn && !memoryLearnPaused。旧 memoryLearnPaused も OFF 扱い） */
  function paintSwitches() {
    const p = getPrefs() ?? {};
    const on = p.memoryAutoLearn === true && p.memoryLearnPaused !== true;
    autoSw.setAttribute('aria-checked', String(on));
    // OFF の間は、時刻は押せない（保存値は残る）
    for (const row of deps) row.classList.toggle('off-part', !on);
    timeIn.disabled = !on;
    if (document.activeElement !== timeIn) timeIn.value = typeof p.memoryLearnAt === 'string' ? p.memoryLearnAt : '02:00';
  }

  function paintStatus(loadFailed = false) {
    clearTimeout(timer);
    const enabled = learnEnabledOf(status, getPrefs());
    const backend = learnBackend();
    const authOut = backend && authOutOf(getAuth(backend.id));
    const failed = enabled && !status?.running && (loadFailed || status?.failure || status?.halted || authOut);
    statusBox.textContent = failed ? t('settings.memory.status.organizeFailed') : '';
    statusBox.hidden = !failed;
    actionsBox.replaceChildren();
    actionsBox.hidden = !failed;
    if (failed) {
      const retry = el('button', 'btn', t('settings.memory.act.retry'));
      retry.type = 'button';
      retry.disabled = busy;
      retry.onclick = async () => {
        busy = true;
        retry.disabled = true;
        note('');
        try {
          if (loadFailed) await refreshState();
          else await invoke('memory.learnNow', {});
        } catch {
          note(t('settings.memory.status.organizeFailed'));
        } finally {
          busy = false;
          await refreshState();
        }
      };
      actionsBox.append(retry);
      if (authOut) {
        const login = el('button', 'btn', t('settings.memory.act.login'));
        login.type = 'button';
        login.onclick = () => onLogin?.(backend);
        actionsBox.append(login);
      }
    }
    if (status?.running) timer = setTimeout(refreshState, POLL_MS);
  }

  /** スイッチの入切の書き込み（settings.set と同じ setPref 経路。失敗したら見た目を戻して文を出す） */
  async function flip(key, next) {
    note('');
    try {
      await cmd('setPref', { key, value: next });
      await refresh();
    } catch {
      paintSwitches();
      note(t('settings.memory.act.saveFailed'));
    }
  }

  const flipSwitch = (sw, key) => { const next = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(next)); flip(key, next); };
  autoSw.onclick = () => flipSwitch(autoSw, 'memoryAutoLearn');
  timeIn.onchange = () => flip('memoryLearnAt', timeIn.value);

  /** 記憶を持つ bot への入口（押すと、その bot のページの記憶の欄へ）。bot が 1 つも無ければ出さない */
  function paintBots() {
    const showCommon = common && (!enabled || !bots.length);
    botsBox.hidden = bots.length === 0 && !showCommon;
    const buttons = bots.map((bot) => {
      const chip = el('button', 'mem-bot');
      chip.type = 'button';
      chip.append(botIcon(bot, 'bot-row-icon'), el('span', null, `${bot.name} ›`));
      chip.onclick = () => openBot?.(bot.id);
      return chip;
    });
    if (showCommon) {
      const chip = el('button', 'mem-bot', t('channels:memory.scopeUser'));
      chip.type = 'button';
      chip.onclick = () => {
        if (!commonView) {
          commonView = createMemoryList({ invoke }, { userOnly: true, lookup: memoryDirectory, openSource });
          botsBox.after(commonView.el);
        } else {
          commonView.el.hidden = !commonView.el.hidden;
          if (!commonView.el.hidden) commonView.refresh('user');
        }
      };
      buttons.push(chip);
    } else if (commonView) commonView.el.hidden = true;
    botsList.replaceChildren(...buttons);
    paintEnablement();
  }

  // i18n-dynamic: settings.memory.changes.reason.
  // i18n-dynamic: settings.memory.changes.status.
  // i18n-dynamic: channels:memory.tier.
  function changeText(entry) {
    if (!entry) return t('settings.memory.changes.absent');
    const state = entry.tier ? t(`channels:memory.tier.${entry.tier}`)
      : entry.status ? t(`settings.memory.changes.status.${entry.status}`) : '';
    return [entry.text, state, entry.workspace, entry.why].filter(Boolean).join(' · ');
  }

  async function refreshChanges(feedback = '') {
    const read = ++changesRead;
    try {
      const all = await invoke('memory.lastChanges', {});
      if (read !== changesRead) return;
      const rows = all.slice(0, changesLimit).map(change => {
        const row = el('details', 'mem-status');
        const before = el('p', null, t('settings.memory.changes.before', { text: changeText(change.before) }));
        const after = el('p', null, t('settings.memory.changes.after', { text: changeText(change.after) }));
        const knownReason = ['legacyPromise', 'unconfirmedImportance', 'organizer', 'deadlineElapsed', 'trackingElapsed', 'resolvedByPerson', 'cancelledByPerson'].includes(change.reason);
        const reason = el('p', null, t('settings.memory.changes.reasonLabel', {
          text: knownReason ? t(`settings.memory.changes.reason.${change.reason}`) : change.reason,
        }));
        const undo = el('button', 'btn', t('settings.memory.changes.undo'));
        undo.type = 'button';
        undo.disabled = !change.canUndo || Boolean(status?.running);
        undo.onclick = async () => {
          undo.disabled = true;
          const { id, rev, runId, type } = change;
          try {
            const result = await invoke('memory.sortUndo', { change: { id, rev, runId, type } });
            await refreshChanges(t(result?.restored ? 'settings.memory.changes.restored' : 'settings.memory.changes.unavailable'));
          } catch {
            await refreshChanges(t('settings.memory.changes.unavailable'));
          }
        };
        row.append(el('summary', null, change.after?.text ?? change.before?.text), before, after, reason, undo);
        return row;
      });
      const more = el('button', 'btn', t('settings.memory.changes.more'));
      more.type = 'button';
      more.onclick = () => { changesLimit += 20; void refreshChanges(); };
      changesList.replaceChildren(...(feedback ? [el('p', null, feedback)] : []),
        ...(rows.length ? rows : [el('p', null, t('settings.memory.changes.empty'))]),
        ...(all.length > rows.length ? [more] : []));
    } catch {
      if (read === changesRead) changesList.textContent = t('settings.memory.changes.unavailable');
    }
  }

  async function refreshState() {
    const mine = ++seq;
    const current = await invoke('memory.learnStatus', {}).catch(() => null);
    if (mine !== seq) return;
    const finished = status?.running && !current?.running;
    status = current;
    paintStatus(!current);
    if (finished && changesPanel.open) void refreshChanges();
  }

  async function refresh() {
    clearTimeout(retry);
    const mine = ++settingsSeq;
    paintSwitches();
    try {
      const on = await botEnablement.read();
      if (mine !== settingsSeq) return;
      enabled = on;
      paintEnablement();
      if (enabled) void refreshState();
      else { clearTimeout(timer); seq++; }
      const directory = await invoke('bots.list', {});
      const all = (directory?.bots ?? []).filter((bot) => !bot.plain);
      const [hasCommon, displayed] = await Promise.all([
        invoke('memory.list', { layer: 'user' }).then(entries => entries.length > 0),
        on ? all : Promise.all(all.map(bot => invoke('memory.list', { layer: bot.id }).then(entries =>
          entries.length > 0 ? bot : null))).then(values => values.filter(Boolean)),
      ]);
      if (mine !== settingsSeq) return;
      common = hasCommon;
      bots = hasCommon && all.length && displayed.length === 0 ? all : displayed;
      paintBots();
    } catch {
      if (mine === settingsSeq && !$('memoryPanel').hidden) retry = setTimeout(refresh, POLL_MS);
    }
  }

  return { refresh };
}
