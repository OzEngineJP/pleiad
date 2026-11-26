// 設定 › bot: 毎晩の整理（会話から覚え直す）の入切・時刻・スレッドの話の引き継ぎの入切と、状態の 2 かたまり（前回の整理・渡す場面が決まっていない記憶）・操作・
// bot ごとの記憶への入口（docs/design-system.md「設定 › bot」）。ページの内部名は memory のまま（札 id・panel id）。
// 「会話の区切りで、記録から組み立て直す」は記憶とは関係なく全会話の設定なので、ここには無い（自動圧縮のページ。client.mjs の paintAutoCompactionOff）。
//
// 状態は memory.learnStatus・memory.sortStatus と、整理に使うエージェントの受動のログイン状態を合わせる（learnBackend → state.auth。
// authStatus は probe なし = agy のような CLI を確かめに起こさない。［接続を確認］の明示操作だけ probe:true を付ける）。
// ［今すぐ整理］［もう一度］は memory.learnNow（止まりを解いて 1 回走る。OFF では何もしない。その回の最後に、渡す場面の振り分けも 1 晩分進む）。
// ［決めた分を取り消す］は memory.sortUndo（今もこの走りが付けたままのものだけ戻す。人が後で変えたものは残す）。振り分けを始める・止める操作は無い（止め方は毎晩のスイッチ）。
// ［ログイン］はエージェント設定のログインへ。記憶の本文・失敗の文・OAuth の URL・スタックは画面に出さない（raw の message は使わない）。
// i18n-dynamic: settings.memory.status.
// i18n-dynamic: settings.memory.act.
// i18n-dynamic: settings.memory.sort.
// i18n-dynamic: channels:memory.learn.
// i18n-dynamic: channels:memory.learn.reason.
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { learnStatusView, shortTime } from './channels/bot-model.mjs';
import { botIcon } from './channels/bot-icon.mjs';
import { learnEnabledOf, authOutOf, authUnconfirmedOf, learnPanelView, sortPanelView } from './memory-model.mjs';

const POLL_MS = 2000;

export function setupMemorySettings({ cmd, invoke, getPrefs, getAuth, setAuth, learnBackend, onLogin, openBot }) {
  const $ = (id) => document.getElementById(id);
  const autoSw = $('memoryAutoLearn');
  const timeIn = $('memoryLearnAt');
  const epSw = $('memoryEpisodeSummary');
  const deps = [...$('memoryPanel').querySelectorAll('.learn-dep')];   // 毎晩の整理が OFF の間は薄くして押せなくする行（時刻・引き継ぎ）
  const statusBox = $('memoryLearnStatus');
  const actionsBox = $('memoryLearnActions');
  const saved = $('memoryLearnSaved');
  const botsBox = $('memoryBots');
  const botsList = $('memoryBotsList');
  let status = null;       // memory.learnStatus の返り（読めていなければ null）
  let sort = null;         // memory.sortStatus の返り（読めていなければ null。出さないだけで失敗にはしない）
  let bots = [];           // 記憶を持つ bot（plain は除く）。bot のページへの入口
  let seq = 0;             // 読み直しの番号（遅い返事を捨てる）
  let timer = null;        // 走っている間の読み直し
  let busy = false;        // learnNow・取り消し・接続の確認を動かしている間
  let busyKind = null;     // 動かしている操作の種類（接続の確認中に「整理しています」と出さないため）

  const note = (text) => { saved.textContent = text; };
  const num = (n) => Number(n).toLocaleString();

  /** スイッチ・欄 → prefs の写し（毎晩の整理の実効は memoryAutoLearn && !memoryLearnPaused。旧 memoryLearnPaused も OFF 扱い） */
  function paintSwitches() {
    const p = getPrefs() ?? {};
    const on = p.memoryAutoLearn === true && p.memoryLearnPaused !== true;
    autoSw.setAttribute('aria-checked', String(on));
    // OFF の間は、時刻と引き継ぎは押せない（引き継ぎの保存値は残る。OFF でも動かないのは core が保証する）
    for (const row of deps) row.classList.toggle('off-part', !on);
    timeIn.disabled = !on;
    epSw.disabled = !on;
    epSw.setAttribute('aria-checked', String(p.memoryEpisodeSummary === true));
    if (document.activeElement !== timeIn) timeIn.value = typeof p.memoryLearnAt === 'string' ? p.memoryLearnAt : '02:00';
  }

  /** 前回の整理の様子の文（learnStatusView の部品から。raw のエラー文は出さない。failed・paused・skipped はパネル側の状態が担うのでここでは抜く。
      skipped の運用カウンタは OFF 期間の古い印が ON の補足に残り誤解を生むので出さない。履歴は API（learnStatus.skip）に残る） */
  function lastRun() {
    const lv = status ? learnStatusView(status) : null;
    const KEEP = new Set(['ran', 'ranNone', 'never', 'more', 'deferred']);
    const keyed = new Map((lv?.parts ?? []).filter((p) => KEEP.has(p.key)).map((p) => [p.key, p.params ?? {}]));
    const lastKey = ['ran', 'ranNone', 'never'].find((k) => keyed.has(k));
    const last = lastKey ? t(`channels:memory.learn.${lastKey}`, keyed.get(lastKey)) : '';
    // 読みきれなかった発言と、作業中だった会話は 1 つの文にまとめる
    const carry = keyed.has('more') && keyed.has('deferred') ? [t('settings.memory.status.moreDeferred', { n: keyed.get('deferred').n })]
      : [...(keyed.has('more') ? [t('channels:memory.learn.more')] : []), ...(keyed.has('deferred') ? [t('channels:memory.learn.deferred', keyed.get('deferred'))] : [])];
    return { last, carry };
  }

  /** 状態の 1 かたまり目（毎晩の整理）: 太字の状態と、脇の注記 */
  function learnLine(view, mode, sv) {
    if (mode === 'off') {
      return { strong: t('settings.memory.status.off'), sub: sv?.untiered ? t('settings.memory.status.offSubUntiered', { n: num(sv.untiered) }) : t('settings.memory.status.offSub') };
    }
    const { last, carry } = lastRun();
    const backend = learnBackend();
    const agent = backend?.label ?? '';
    // 待っているときは、前回の整理そのものが太字（「前回 11/8 15:51 · 59 件書き足しました」）。止まっている・走っているときは状態が太字で、前回は脇へ
    const waiting = mode === 'waiting';
    const parts = waiting ? [...carry] : [...(last ? [last] : []), ...carry];
    if (view.mode === 'failed' && status?.failure?.retryAt) parts.push(t('settings.memory.status.retryAt', { when: shortTime(status.failure.retryAt) }));
    else if (view.mode === 'halted') parts.push(t('settings.memory.status.haltedSub'));
    else if (waiting && status?.nextAt) parts.push(t('channels:memory.learn.next', { when: shortTime(status.nextAt) }));
    // 認証の未確定は補助（authWait・unconfirmed が本体の状態のときも同じ注記を出す）
    const authNote = view.authNote ?? (view.mode === 'authWait' || view.mode === 'unconfirmed' ? view.mode : null);
    // 止まった状態の脇の注記は「もう一度」が要る旨（停止はログインだけでは戻らない）。本体がログイン待ちのときはログインで再開する
    if (authNote === 'authWait') parts.push(t(view.mode === 'halted' || view.mode === 'failed' ? 'settings.memory.status.authWaitStoppedSub' : 'settings.memory.status.authWaitSub', { agent }));
    else if (authNote === 'unconfirmed') parts.push(t('settings.memory.status.unconfirmedSub', { agent }));
    return { strong: waiting && last ? last : t(`settings.memory.status.${mode}`), sub: parts.join(' · ') };
  }

  /** 状態の 2 かたまり目（渡す場面が決まっていない記憶）。毎晩の整理が入っている間だけ出す */
  function sortLine(sv) {
    const parts = [];
    if (sv.mode === 'undone' && sv.undone) parts.push(t('settings.memory.sort.undone', sv.undone));
    else {
      if (sv.mode === 'running') parts.push(t('settings.memory.sort.running'));
      if (sv.untiered > 0) parts.push(t('settings.memory.sort.nightly', { perNight: num(sv.perNight), nights: sv.nights }));
      if (sv.placed > 0) parts.push(t('settings.memory.sort.placed', { n: num(sv.placed), ...sv.tiers }));
      if (sv.mode === 'failed') parts.push(t('settings.memory.sort.failed'));
    }
    return { strong: sv.untiered > 0 ? t('settings.memory.sort.untiered', { n: num(sv.untiered) }) : t('settings.memory.sort.none'), sub: parts.join(' · ') };
  }

  function actionButton(kind, backend) {
    const b = el('button', kind === 'now' ? 'btn btn-quiet' : 'btn', t(`settings.memory.act.${kind}`));
    b.type = 'button';
    b.onclick = async () => {
      if (kind === 'login') { onLogin?.(backend); return; }
      await run(kind, async () => {
        if (kind === 'check') {
          // 明示操作だけ probe:true（受動では分からなかった接続を確かめる。agy を起こしてよいのはこの場面だけ）
          const st = await invoke('agents.authStatus', { backend: backend?.id, probe: true });
          if (st) setAuth?.(backend?.id, st);
        } else if (kind === 'undo') {
          await invoke('memory.sortUndo', {});
        } else {
          const r = await invoke('memory.learnNow', {});
          if (r?.skipped) note(t(r.skipped === 'running' ? 'settings.memory.act.skippedRunning' : 'settings.memory.act.skipped'));
        }
      });
    };
    return b;
  }

  /** 操作を 1 つ動かす（動かしている間は操作を隠す。失敗の詳細は出さず、固定の文＋再取得した状態で示す） */
  async function run(kind, fn) {
    busy = true;
    busyKind = kind;
    note('');
    paintStatus();
    try {
      await fn();
    } catch {
      note(t('settings.memory.act.failed'));
    } finally {
      busy = false;
      busyKind = null;
      await refresh();
    }
  }

  function paintStatus() {
    clearTimeout(timer);
    const p = getPrefs() ?? {};
    const backend = learnBackend();
    const st = backend ? getAuth(backend.id) : null;
    const view = learnPanelView(status, {
      enabled: learnEnabledOf(status, p),
      authOut: authOutOf(st),
      unconfirmed: authUnconfirmedOf(st),
    });
    // 整理の操作（now/retry）の間だけ「整理しています」に見せる。接続の確認・取り消しは整理と読み違えないよう、今の状態のままボタンだけ抑止する
    const mode = busy && busyKind !== 'check' && busyKind !== 'undo' && view.mode !== 'off' ? 'running' : view.mode;
    const sv = sortPanelView(sort);
    const lines = [learnLine(view, mode, sv), ...(mode !== 'off' && sv?.show ? [sortLine(sv)] : [])];
    statusBox.classList.toggle('warn', Boolean(view.warn));
    statusBox.replaceChildren(...lines.flatMap((l) => [el('strong', null, l.strong), ...(l.sub ? [el('span', 'mp-note', l.sub)] : [])]));
    const buttons = view.actions.map((a) => actionButton(a, backend));
    if (sv?.undo) buttons.push(actionButton('undo', backend));   // OFF にしても、決めた分は取り消せる
    actionsBox.replaceChildren(...(busy ? [] : buttons));
    // 走っている間（［今すぐ整理］の途中・夜の整理の最中）だけ、状態を読み直す（止まったら timer も止まる）
    if (busy || view.mode === 'running' || sv?.mode === 'running') timer = setTimeout(refreshState, POLL_MS);
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

  /** 状態（前回の整理・渡す場面の振り分け）を読み直して描く。読めなければ「読み込めませんでした」 */
  async function refreshState() {
    const mine = ++seq;
    const [s, srt] = await Promise.all([
      invoke('memory.learnStatus', {}).catch(() => null),
      invoke('memory.sortStatus', {}).catch(() => null),   // 読めないときは振り分けの欄だけ出さない（毎晩の整理の行は別に出る）
    ]);
    if (mine !== seq) return;
    sort = srt;
    if (!s) {
      status = null;
      clearTimeout(timer);
      statusBox.classList.remove('warn');
      statusBox.replaceChildren(el('span', 'mp-note', t('settings.memory.status.loadFailed')));
      actionsBox.replaceChildren();
      return;
    }
    status = s;
    paintStatus();
  }

  async function refresh() {
    paintSwitches();
    invoke('bots.list', {}).then((list) => { bots = (list?.bots ?? []).filter((b) => !b.plain); paintBots(); }, () => {});
    await refreshState();
  }

  return { refresh };
}
