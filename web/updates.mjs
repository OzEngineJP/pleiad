import { fmt, t } from './i18n.mjs';
import { createReleaseNotes } from './release-notes.mjs';

// i18n-dynamic: updates.phase.
const PHASES = ['idle', 'checking', 'current', 'available', 'downloading', 'downloaded', 'installing', 'error', 'unavailable'];

/**
 * 設定 › バージョンと更新の表示と操作（docs/design-system.md「アプリの更新」）。更新中の作業はサーバーの保持役が保つ。
 * 上の枠は版・状態の 1 行・主ボタン 1 つ。再起動の確認は同じ場所で文とボタンを入れ替える。
 */
export function setupUpdates({ page, open, lock, flush }) {
  const $ = id => document.getElementById(id), bridge = window.plyDesktop;
  let info, state, busy = false, installing = false, confirming = false, switchesLocked = false, shownNotice = null, failure = '';
  const deferred = new Set();
  const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const notes = createReleaseNotes($('releaseHistory'), { reduceMotion });
  /** 更新のページを開いているか。開いている間は、脇の更新の知らせ（同じ内容）を伏せる */
  const pageOpen = () => document.body.classList.contains('settings') && !$('updatesPanel').hidden;

  function paint(value) {
    // releases は変わったときだけ送られる（進みの通知では外れる）。外れていたら前の一覧を保つ
    state = value.releases === undefined && state ? { ...value, releases: state.releases } : value;
    const remote = Boolean(window.plyRemote && !bridge?.update);
    const applying = installing || state.phase === 'installing';
    const downloading = state.phase === 'downloading';
    const progressing = applying || downloading;
    const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, Math.round(state.progress))) : null;
    const stage = applying ? (state.phase === 'installing' ? t('updates.stage.installing') : t('updates.stage.saving'))
      : progress === null ? t('updates.stage.downloading') : t('updates.stage.downloadingPercent', { percent: progress });
    if (state.phase !== 'downloaded') confirming = false;
    const confirmView = confirming && !applying;
    lock(applying);

    // 上の枠: 状態の 1 行（status）と、その下の弱い 1 行（note）。失敗は状態の 1 行に出す
    const lastChecked = state.lastChecked ? t('updates.lastChecked', { when: fmt.dateTime(state.lastChecked) }) : '';
    const error = remote || state.store ? '' : failure || state.error || '';
    let status = '', note = '', strong = false, showLast = false, alert = false;
    if (remote) { status = t('remote.updateStatus'); note = t('remote.updateOnHost'); }
    else if (state.store) { status = t('updates.store.status'); note = t('updates.store.hint'); }
    else if (applying) { status = stage; note = t('updates.hint.applying'); }
    else if (confirmView) { status = t('settings.updates.confirmTitle'); strong = true; note = t('settings.updates.confirmBody'); }
    else if (downloading) status = stage;
    else if (error) { status = error; strong = alert = true; note = lastChecked; }
    else if (!state.enabled) status = bridge?.update ? t('updates.hint.noAutoUpdate') : t('updates.phase.unavailable');
    else {
      if (state.phase !== 'idle') status = t(`updates.phase.${PHASES.includes(state.phase) ? state.phase : 'idle'}`) + (state.target ? ` · ${state.target}` : '');
      strong = ['available', 'downloaded'].includes(state.phase);
      showLast = Boolean(lastChecked) && !state.target;
    }
    $('appVersion').textContent = `Pleiad ${state.version || info?.version || ''}`;
    $('updateStatus').textContent = status;
    $('updateStatusRow').hidden = !status;
    $('updateStatusRow').classList.toggle('strong', strong);
    // 失敗は assertive（alert）、ふだんは polite（status）。role と aria-live は一緒に替える
    $('updateStatusRow').setAttribute('role', alert ? 'alert' : 'status');
    $('updateStatusRow').setAttribute('aria-live', alert ? 'assertive' : 'polite');
    $('updateLastChecked').hidden = !showLast;
    $('updateLastChecked').textContent = showLast ? lastChecked : '';
    $('updateHint').hidden = !note;
    $('updateHint').textContent = note;
    const bar = $('updateProgress');
    bar.hidden = !progressing;
    bar.setAttribute('aria-label', stage);
    bar.classList.toggle('ind', applying || progress === null);
    if (downloading && !applying && progress !== null) { bar.setAttribute('aria-valuenow', String(progress)); bar.querySelector('i').style.width = `${progress}%`; }
    else { bar.removeAttribute('aria-valuenow'); bar.querySelector('i').style.width = ''; }
    $('updatePromptProgress').hidden = !progressing;
    $('updatePromptProgress').setAttribute('aria-label', stage);
    if (downloading && !applying && progress !== null) $('updatePromptProgress').value = progress;
    else $('updatePromptProgress').removeAttribute('value');

    // 更新の設定（スイッチ）。作業中・ダウンロード済みの間は変えられない。disabled にするとキーボードの居場所が押した
    // スイッチから外れるので、aria-disabled で見せ、押しは toggle の入口で無視する
    const working = busy || ['checking', 'downloading', 'installing'].includes(state.phase);
    const locked = switchesLocked = working || state.phase === 'downloaded';
    $('updatePreferences').hidden = !state.enabled;
    for (const [id, on] of [['updateCheckAutomatic', state.autoCheck !== false], ['updateAutomatic', state.autoDownload === true], ['updateBeta', state.channel === 'beta']]) {
      $(id).setAttribute('aria-checked', String(on));
      $(id).setAttribute('aria-disabled', String(locked));
      $(id).parentNode.classList.toggle('off', locked);
    }

    // 主ボタンは 1 つ: 更新を確認 → ダウンロード → 再起動して更新
    $('checkUpdate').hidden = !state.enabled || confirmView || ['available', 'downloading', 'installing'].includes(state.phase);
    $('checkUpdate').disabled = working;
    $('checkUpdate').classList.toggle('btn-quiet', state.phase !== 'downloaded');
    $('checkUpdate').textContent = state.phase === 'error' ? t('updates.retry') : t('settings.updates.check');
    $('downloadUpdate').hidden = state.phase !== 'available';
    $('downloadUpdate').disabled = working;
    $('installUpdate').hidden = state.phase !== 'downloaded' || confirmView || applying;
    $('installUpdate').disabled = working;
    $('updateConfirm').hidden = !confirmView;
    $('confirmInstallUpdate').disabled = $('cancelInstallUpdate').disabled = working;
    $('confirmInstallUpdate').textContent = t('settings.updates.confirmInstall');
    notes.update({ info, state });

    const hasUpdate = ['available', 'downloaded'].includes(state.phase);
    $('settings').classList.toggle('has-update', hasUpdate);
    $('settings').title = hasUpdate ? t('updates.settingsHasUpdate') : t('app.settings');
    let alreadyShown = false;
    try { alreadyShown = sessionStorage.getItem('ply-update-notice') === state.version; } catch {}
    const show = state.notice && (shownNotice === state.version || !alreadyShown);
    $('updateNotice').hidden = !show;
    if (show) { shownNotice = state.version; try { sessionStorage.setItem('ply-update-notice', state.version); } catch {} }
    $('updateNoticeText').textContent = t('updates.updated', { version: state.version });
    const key = `${state.target}:${state.phase}`;
    let postponed = deferred.has(key);
    try { postponed ||= sessionStorage.getItem(`ply-update-deferred:${key}`) === 'yes'; } catch {}
    const ready = state.phase === 'downloaded';
    $('updatePrompt').hidden = pageOpen() || !state.enabled || !state.target || (!progressing && (postponed || (!ready && !(state.phase === 'available' && !state.autoDownload))));
    $('updatePromptText').textContent = progressing ? `Pleiad ${state.target} · ${stage}`
      : ready ? t('updates.promptReady', { target: state.target }) : t('updates.promptAvailable', { target: state.target });
    $('viewAvailableUpdate').hidden = applying;
    $('deferUpdate').hidden = progressing;
  }

  async function action(name, value) {
    if (busy) return;
    busy = true; failure = ''; if (state) paint(state);
    try {
      if (name === 'install') { confirming = false; installing = true; paint(state); await flush(); }
      paint(await bridge.update(name, value));
    } catch (e) {
      failure = String(e.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    } finally { busy = false; installing = false; if (state) paint(state); }
  }

  $('updatesTab').onclick = () => page('updates');
  $('checkUpdate').onclick = () => action('check');
  $('downloadUpdate').onclick = () => action('download');
  $('installUpdate').onclick = () => { confirming = true; paint(state); $('confirmInstallUpdate').focus(); };
  $('confirmInstallUpdate').onclick = () => action('install');
  $('cancelInstallUpdate').onclick = () => { confirming = false; paint(state); $('installUpdate').focus(); };
  $('viewAvailableUpdate').onclick = () => { $('onboardingDialog').close(); open('updates'); };
  $('deferUpdate').onclick = () => {
    const key = `${state.target}:${state.phase}`; deferred.add(key);
    try { sessionStorage.setItem(`ply-update-deferred:${key}`, 'yes'); } catch {}
    paint(state); $('settings').focus();
  };
  const toggle = key => {
    if (switchesLocked) return;
    const next = { channel: state.channel === 'beta' ? 'beta' : 'stable', autoDownload: state.autoDownload === true, autoCheck: state.autoCheck !== false };
    if (key === 'channel') next.channel = next.channel === 'beta' ? 'stable' : 'beta'; else next[key] = !next[key];
    return action('preferences', next);
  };
  $('updateBeta').onclick = () => toggle('channel');
  $('updateAutomatic').onclick = () => toggle('autoDownload');
  $('updateCheckAutomatic').onclick = () => toggle('autoCheck');
  $('dismissUpdateNotice').onclick = () => action('dismiss');
  // 「変更内容を見る」: 今回の更新の見出しまで滑らせる（開くだけだと、長い一覧の先頭の枠しか見えない）
  $('viewUpdateNotes').onclick = () => {
    $('onboardingDialog').close(); open('updates');
    if (!notes.scrollToUpdate()) $('releaseHistory').scrollIntoView?.();
    action('dismiss');
  };
  bridge?.onUpdate?.(paint);
  // ページを開いている間は脇の知らせを伏せる。開け閉め（hidden・body.settings）を見て描き直す
  if (typeof MutationObserver === 'function') {
    let wasOpen = pageOpen();
    const watch = new MutationObserver(() => { const now = pageOpen(); if (now !== wasOpen && state) { wasOpen = now; paint(state); } wasOpen = now; });
    watch.observe($('updatesPanel'), { attributes: true, attributeFilter: ['hidden'] });
    watch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  (async () => {
    try {
      const response = await fetch('./release-info.json');
      if (!response.ok) throw new Error(t('updates.notesFailed'));
      info = await response.json();
    } catch (e) { failure = e.message; }
    let first;
    try { first = bridge?.update ? await bridge.update('status') : { version: info?.version ?? '', phase: 'unavailable', enabled: false }; }
    catch (e) { failure ||= e.message; first = { version: info?.version ?? '', phase: 'unavailable', enabled: false }; }
    paint(first);
  })();
  return { get applying() { return installing || state?.phase === 'installing'; } };
}
