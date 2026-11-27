import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { botIcon } from './channels/bot-icon.mjs';
import { learnEnabledOf, authOutOf } from './memory-model.mjs';

const POLL_MS = 2000;

export function setupMemorySettings({ cmd, invoke, getPrefs, getAuth, learnBackend, onLogin, openBot }) {
  const $ = (id) => document.getElementById(id);
  const autoSw = $('memoryAutoLearn');
  const timeIn = $('memoryLearnAt');
  const deps = [...$('memoryPanel').querySelectorAll('.learn-dep')];   // 毎晩の整理が OFF の間は薄くして押せなくする行（時刻）
  const statusBox = $('memoryLearnStatus');
  const actionsBox = $('memoryLearnActions');
  const saved = $('memoryLearnSaved');
  const botsBox = $('memoryBots');
  const botsList = $('memoryBotsList');
  let status = null;       // memory.learnStatus の返り（読めていなければ null）
  let bots = [];           // 記憶を持つ bot（plain は除く）。bot のページへの入口
  let seq = 0;             // 読み直しの番号（遅い返事を捨てる）
  let timer = null;        // 走っている間の読み直し
  let busy = false;        // 再試行を動かしている間

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
    botsBox.hidden = bots.length === 0;
    botsList.replaceChildren(...bots.map((bot) => {
      const chip = el('button', 'mem-bot');
      chip.type = 'button';
      chip.append(botIcon(bot, 'bot-row-icon'), el('span', null, `${bot.name} ›`));
      chip.onclick = () => openBot?.(bot.id);
      return chip;
    }));
  }

  async function refreshState() {
    const mine = ++seq;
    const current = await invoke('memory.learnStatus', {}).catch(() => null);
    if (mine !== seq) return;
    status = current;
    paintStatus(!current);
  }

  async function refresh() {
    paintSwitches();
    invoke('bots.list', {}).then((list) => { bots = (list?.bots ?? []).filter((b) => !b.plain); paintBots(); }, () => {});
    await refreshState();
  }

  return { refresh };
}
