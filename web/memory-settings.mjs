// 設定 › 記憶 › bot: 記憶の自動整理の入切・時刻・要約の入切と、状態の 1 行（docs/design-system.md「設定 › 記憶」）。
// 「全般」の［会話の区切りで、記録から組み立て直す］は「試験的な機能」から移したもので、ここでは触らない（client.mjs の paintMemoryGeneral）。
//
// 状態は memory.learnStatus と、整理に使うエージェントの受動のログイン状態を合わせる（learnBackend → state.auth。
// authStatus は probe なし = agy のような CLI を確かめに起こさない。［接続を確認］の明示操作だけ probe:true を付ける）。
// ［今すぐ整理］［もう一度］は memory.learnNow（止まりを解いて 1 回走る。OFF では何もしない）。［ログイン］はエージェント設定のログインへ。
// 失敗の文・OAuth の URL・スタックは画面に出さない（raw の message は使わない）。
// i18n-dynamic: settings.memory.status.
// i18n-dynamic: settings.memory.act.
// i18n-dynamic: channels:memory.learn.
// i18n-dynamic: channels:memory.learn.reason.
// server:antigravity.auth.unconfirmed は core が受動の確認で返す文言（core 側の変更と一緒に使われる）
// i18n-dynamic: server:antigravity.auth.unconfirmed
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { learnStatusView, shortTime } from './channels/bot-model.mjs';
import { learnEnabledOf, authOutOf, authUnconfirmedOf, learnPanelView } from './memory-model.mjs';

export function setupMemorySettings({ cmd, invoke, getPrefs, getAuth, setAuth, learnBackend, onLogin }) {
  const $ = (id) => document.getElementById(id);
  const autoSw = $('memoryAutoLearn');
  const dep = $('memoryLearnDependent');
  const timeIn = $('memoryLearnAt');
  const epSw = $('memoryEpisodeSummary');
  const statusText = $('memoryLearnStatusText');
  const statusSub = $('memoryLearnStatusSub');
  const actionsBox = $('memoryLearnActions');
  const saved = $('memoryLearnSaved');
  let status = null;        // memory.learnStatus の返り（読めていなければ null）
  let seq = 0;              // 読み直しの番号（遅い返事を捨てる）
  let busy = false;         // learnNow・接続の確認を動かしている間
  let busyKind = null;      // 動かしている操作の種類（接続の確認中に「整理しています」と出さないため）

  const note = (text) => { saved.textContent = text; };

  /** スイッチ・欄 → prefs の写し（自動整理の実効は memoryAutoLearn && !memoryLearnPaused。旧 memoryLearnPaused も OFF 扱い） */
  function paintSwitches() {
    const p = getPrefs() ?? {};
    const on = p.memoryAutoLearn === true && p.memoryLearnPaused !== true;
    autoSw.setAttribute('aria-checked', String(on));
    // 自動整理が OFF の間は、時刻と要約は押せない（要約の保存値は残る。OFF でも動かないのは core が保証する）
    dep.classList.toggle('off-part', !on);
    timeIn.disabled = !on;
    epSw.disabled = !on;
    epSw.setAttribute('aria-checked', String(p.memoryEpisodeSummary === true));
    if (document.activeElement !== timeIn) timeIn.value = typeof p.memoryLearnAt === 'string' ? p.memoryLearnAt : '02:00';
  }

  /** 最後に走った様子の短い文（raw のエラー文は出さない。failed・paused・next はパネル側の状態が担うのでここでは抜く） */
  function subParts(view) {
    const parts = [];
    const lv = status ? learnStatusView(status) : null;
    if (lv) {
      const KEEP = new Set(['ran', 'ranNone', 'never', 'more', 'deferred', 'skipped']);
      for (const { key, params = {} } of lv.parts) {
        if (!KEEP.has(key)) continue;
        parts.push(t(`channels:memory.learn.${key}`, { ...params, ...(params.reasonKey ? { reason: t(`channels:memory.learn.reason.${params.reasonKey}`) } : {}) }));
      }
    }
    const backend = learnBackend();
    const agent = backend?.label ?? '';
    if (view.mode === 'failed' && status?.failure?.retryAt) parts.push(t('settings.memory.status.retryAt', { when: shortTime(status.failure.retryAt) }));
    else if (view.mode === 'halted') parts.push(t('settings.memory.status.haltedSub'));
    else if (view.mode === 'waiting' && status?.nextAt) parts.push(t('channels:memory.learn.next', { when: shortTime(status.nextAt) }));
    // 認証の未確定は補助（authWait・unconfirmed が本体の状態のときも同じ注記を出す）
    const authNote = view.authNote ?? (view.mode === 'authWait' || view.mode === 'unconfirmed' ? view.mode : null);
    // 止まった状態の脇の注記は「もう一度」が要る旨（停止はログインだけでは戻らない）。本体がログイン待ちのときはログインで再開する
    if (authNote === 'authWait') parts.push(t(view.mode === 'halted' || view.mode === 'failed' ? 'settings.memory.status.authWaitStoppedSub' : 'settings.memory.status.authWaitSub', { agent }));
    else if (authNote === 'unconfirmed') parts.push(t('settings.memory.status.unconfirmedSub', { agent }));
    return parts;
  }

  function actionButton(kind, backend) {
    const b = el('button', 'btn', t(`settings.memory.act.${kind}`));
    b.type = 'button';
    b.onclick = async () => {
      if (kind === 'login') { onLogin?.(backend); return; }
      busy = true;
      busyKind = kind;
      note('');
      paintStatus();
      try {
        if (kind === 'check') {
          // 明示操作だけ probe:true（受動では分からなかった接続を確かめる。agy を起こしてよいのはこの場面だけ）
          const st = await invoke('agents.authStatus', { backend: backend?.id, probe: true });
          if (st) setAuth?.(backend?.id, st);
        } else {
          const r = await invoke('memory.learnNow', {});
          if (r?.skipped) note(t(r.skipped === 'running' ? 'settings.memory.act.skippedRunning' : 'settings.memory.act.skipped'));
        }
      } catch {
        // 失敗の詳細（CLI・認証の生の文・URL・スタック）は画面に出さない。固定の文＋再取得した状態の操作で示す
        note(t('settings.memory.act.failed'));
      } finally {
        busy = false;
        busyKind = null;
        await refresh();
      }
    };
    return b;
  }

  function paintStatus() {
    const p = getPrefs() ?? {};
    const backend = learnBackend();
    const st = backend ? getAuth(backend.id) : null;
    const view = learnPanelView(status, {
      enabled: learnEnabledOf(status, p),
      authOut: authOutOf(st),
      unconfirmed: authUnconfirmedOf(st),
    });
    // 整理の操作（now/retry）の間だけ「整理しています」に見せる。接続の確認は整理と読み違えないよう、今の状態のままボタンだけ抑止する
    const mode = busy && busyKind !== 'check' && view.mode !== 'off' ? 'running' : view.mode;
    statusText.textContent = t(`settings.memory.status.${mode}`);
    statusText.parentElement.classList.toggle('warn', Boolean(view.warn));
    statusSub.textContent = subParts(view).join(' · ');
    actionsBox.replaceChildren(...(busy ? [] : view.actions.map((a) => actionButton(a, backend))));
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
  epSw.onclick = () => flipSwitch(epSw, 'memoryEpisodeSummary');
  timeIn.onchange = () => flip('memoryLearnAt', timeIn.value);

  async function refresh() {
    paintSwitches();
    const mine = ++seq;
    try {
      const s = await invoke('memory.learnStatus', {});
      if (mine !== seq) return;
      status = s;
      paintStatus();
    } catch {
      if (mine !== seq) return;
      status = null;
      statusText.textContent = '';
      statusSub.textContent = t('settings.memory.status.loadFailed');
      actionsBox.replaceChildren();
    }
  }

  return { refresh };
}
