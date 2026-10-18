// Browser settings and confirmation preferences (docs/inapp-browser.md, ADR 0042).
// External resources can be confirmed on every screen; agent access needs the desktop browser.
import { t } from './i18n.mjs';
import { el, svgEl } from './dom.mjs';
import { createCombo } from './combo.mjs';
import { LINK_OPEN_VALUES, linkOpenPref } from './browser-address.mjs';
import { modifierKey } from './link-open.mjs';
import { blockedPreviewOrigins, onBlockedPreviewOrigins } from './preview-confirm.mjs';
import { profileKey, noteOf, browserLabel, validProfileRef, profileLabel, NOTE_MAX } from './chrome-profile-model.mjs';
const AGENT_BROWSER_VERSION = '0.38.1';

// エージェントのブラウザー（PC の Chrome）への接続の案内で開いてもらうアドレス。chrome.exe に渡しても新しいタブになるので、コピーして貼り付けてもらう
// （OS の層がトグルを入れられるときは「オンにしてつなぐ」で Pleiad が入れる。ADR 0218）
const CHROME_INSPECT_ADDRESS = 'chrome://inspect/#remote-debugging';

/** Chrome の印（16px の線画。ブラウザーの固定タブと同じ形） */
function chromeMark() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 8, cy: 8, r: 6.5 }), svgEl('circle', { cx: 8, cy: 8, r: 2.6 }), svgEl('path', { d: 'M8 5.4h5.9M10.25 9.3l-2.98 5.16M5.75 9.3 2.77 4.14' }));
  const mark = el('span', 'browser-conn-mark'); mark.setAttribute('aria-hidden', 'true'); mark.append(svg);
  return mark;
}

/** product（Chrome/154.0.8037.97）から「Chrome 154」を作る。読めなければ「Chrome」 */
export const chromeLabel = product => { const m = /^(\w+)\/(\d+)/.exec(String(product ?? '')); return m ? `${m[1]} ${m[2]}` : 'Chrome'; };

export function setupBrowserSettings({ available, cmd, getPrefs, getAgentLabel = id => id, getHostCaps = () => null, getChromeWaiting = () => [] }) {
  const $ = id => document.getElementById(id);
  const tab = $('browserTab'), root = $('browserPanel');
  tab.hidden = false;
  const row = el('div', 'browser-setting');
  const label = el('strong', null, t('settings.browser.linkOpen.title')); label.id = 'browserLinkOpenLabel';
  const seg = el('div', 'seg sec browser-link-open'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-labelledby', label.id);
  const buttons = LINK_OPEN_VALUES.map(value => {
    // i18n-dynamic: settings.browser.linkOpen.
    const b = el('button', null, t(`settings.browser.linkOpen.${value}`)); b.type = 'button'; b.dataset.linkOpen = value;
    b.onclick = () => {
      if (value === linkOpenPref(getPrefs())) return;
      error.textContent = '';
      cmd('setPref', { key: 'linkOpen', value }).catch(e => { error.textContent = t('settings.browser.saveFailed', { error: e.message }); });
    };
    return b;
  });
  seg.append(...buttons);
  row.append(label, seg);
  const error = el('p', 'browser-setting-error'); error.setAttribute('role', 'status');
  const chromeSection = el('section', 'browser-confirm-settings browser-chrome-setting'); chromeSection.hidden = true;
  const profileSection = el('section', 'browser-confirm-settings browser-profile-setting'); profileSection.hidden = true;
  const agentSection = el('div', 'browser-agent-setting');
  agentSection.append(el('strong', null, t('settings.browser.agentOperation.title')), el('p', null, t('settings.browser.agentOperation.bundled', { version: AGENT_BROWSER_VERSION })));
  // 近道の説明。修飾キーの名前は <kbd> にする（辞書の {{key}} の所に入れる）
  const shortcuts = el('p', 'browser-setting-note');
  const [before, after = ''] = t('settings.browser.linkOpen.shortcuts', { key: '\u0000' }).split('\u0000');
  shortcuts.append(...[before && el('span', null, before), el('kbd', null, modifierKey()), after && el('span', null, after)].filter(Boolean));
  // どの画面でも効く範囲を書く。リンクの開き先はホストの画面だけなので、ほかの画面にはその理由を一言（docs/inapp-browser.md）
  root.replaceChildren(el('p', null, available ? t('settings.browser.description') : t('settings.browser.descriptionRemote')), row, el('p', 'browser-setting-note', t('settings.browser.linkOpen.note')), shortcuts, error);
  if (!available) { row.remove(); agentSection.remove(); root.querySelectorAll('.browser-setting-note').forEach(n => n.remove()); }
  const confirmation = el('section', 'browser-confirm-settings');
  error.remove(); root.append(confirmation); if (available) root.append(chromeSection, profileSection, agentSection); root.append(error);
  async function save(key, value) {
    error.textContent = '';
    try { await cmd('setPref', { key, value }); }
    catch (e) { error.textContent = t('settings.browser.saveFailed', { error: e.message }); }
  }
  function siteRow(key, site, pending = false) {
    const row = el('div', 'browser-setting browser-site');
    // エージェントの行はプロフィールごと。プロフィールの無い行は、どのプロフィールにも効く古い行
    const profileName = site.profile ? (profiles?.find(p => profileKey(p) === site.profile)?.name || site.profile.replace(/^\w+:/, '')) : null;
    row.append(el('span', 'browser-site-name', site.agent ? [getAgentLabel(site.agent), profileName, site.origin].filter(Boolean).join(' · ') : site.origin));
    const update = mode => {
      const rows = (getPrefs()[key] ?? []).filter(item => item.origin !== site.origin || item.agent !== site.agent || (item.profile ?? '') !== (site.profile ?? ''));
      if (mode) rows.push({ ...site, mode });
      return save(key, rows);
    };
    if (pending) {
      const allow = el('button', 'btn', t('settings.browser.confirm.permit'));
      allow.onclick = () => update('always'); row.append(allow);
    } else {
      const seg = el('div', 'seg sec'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', site.origin);
      for (const mode of ['always', 'ask']) {
        // i18n-dynamic: settings.browser.confirm.
        const button = el('button', null, t(`settings.browser.confirm.${mode}`)); button.type = 'button';
        button.setAttribute('aria-pressed', String(site.mode === mode)); button.classList.toggle('on', site.mode === mode);
        button.onclick = () => update(mode); seg.append(button);
      }
      const remove = el('button', 'btn btn-quiet', t('settings.browser.confirm.remove'));
      remove.onclick = () => update(null); row.append(seg, remove);
    }
    return row;
  }
  function paintConfirmation() {
    const prefs = getPrefs();
    confirmation.replaceChildren(el('h3', null, t('settings.browser.confirm.title')));
    for (const [key, labelKey] of [['confirmExternalLoads', 'external'], ...(available ? [['confirmAgentSites', 'agent']] : [])]) {
      if (key === 'confirmAgentSites') confirmation.append(el('h3', null, t('settings.browser.confirm.agentTitle')));
      const row = el('label', 'browser-setting');
      // i18n-dynamic: settings.browser.confirm.
      const label = el('span', null, t(`settings.browser.confirm.${labelKey}`));
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = prefs[key] === true;
      toggle.onchange = () => save(key, toggle.checked); row.append(label, toggle); confirmation.append(row);
      // 外部の読み込みの確認が効く範囲（プレビューと、内蔵ブラウザーで開いた PC のファイル）
      if (key === 'confirmExternalLoads') confirmation.append(el('p', 'browser-setting-note', available ? t('settings.browser.confirm.scope') : t('settings.browser.confirm.scopeRemote')));
    }
    if (!prefs.confirmExternalLoads && !(available && prefs.confirmAgentSites)) return;
    const allowed = el('h3', null, t('settings.browser.confirm.sites')); allowed.id = 'browserAllowedSites'; allowed.tabIndex = -1; confirmation.append(allowed);
    if (prefs.confirmExternalLoads) {
      const sites = prefs.externalSitePermissions ?? [];
      const pending = blockedPreviewOrigins().filter(origin => !sites.some(site => site.origin === origin && site.mode === 'always'));
      if (pending.length) {
        confirmation.append(el('h4', null, t('settings.browser.confirm.stopped')));
        for (const origin of pending) confirmation.append(siteRow('externalSitePermissions', { origin }, true));
      }
      // 一覧が空のときは小見出しも出さない（中身の無い見出しが「許可したサイト」の下に残らない）
      if (sites.length) confirmation.append(el('h4', null, t('settings.browser.confirm.externalList')));
      for (const site of sites) confirmation.append(siteRow('externalSitePermissions', site));
    }
    if (available && prefs.confirmAgentSites) {
      const agentSites = prefs.agentSitePermissions ?? [];
      if (agentSites.length) confirmation.append(el('h4', null, t('settings.browser.confirm.agentList')));
      for (const site of agentSites) confirmation.append(siteRow('agentSitePermissions', site));
    }
  }
  onBlockedPreviewOrigins(paintConfirmation);

  // ---- エージェントのブラウザー（PC の Chrome）への接続。状態はサーバーの chromeBrowser イベントで替わる（docs/inapp-browser.md「Chrome への接続」、ADR 0148・0153）
  let chrome = null;   // { state, reason, dialog, product, assist, enable } | null（まだ分からない）
  let copied = false, copyFailed = false, copyTimer = null;
  const chromeError = el('p', 'browser-setting-note browser-chrome-error'); chromeError.setAttribute('role', 'status');
  function chromeCommand(command) {
    chromeError.textContent = '';
    return cmd(command).catch(e => { chromeError.textContent = t('settings.browser.agentBrowser.failed', { error: e.message }); });
  }
  function chromeButton(label, command, cls = 'btn') {
    const b = el('button', cls, label); b.type = 'button';
    b.onclick = () => { void chromeCommand(command); };
    return b;
  }
  async function copyAddress() {
    copyFailed = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(CHROME_INSPECT_ADDRESS);
      copied = true; clearTimeout(copyTimer); copyTimer = setTimeout(() => { copied = false; paintChrome(); }, 2000);
    } catch { copyFailed = true; }
    paintChrome();
  }
  // i18n-dynamic: settings.browser.agentBrowser.
  function paintChrome() {
    if (!available || !chrome || getHostCaps()?.chromeBrowser === false) { chromeSection.hidden = true; return; }
    chromeSection.hidden = false;
    const k = 'settings.browser.agentBrowser.';
    const { state, reason, product } = chrome;
    const status = el('span', 'stt'); status.setAttribute('role', 'status');
    const actions = [];
    const details = [];
    const note = text => el('p', 'browser-setting-note', text);
    if (state === 'unsupported') {
      status.textContent = t(reason === 'platform' ? `${k}unsupportedOs` : `${k}unsupportedEnv`);
    } else if (state === 'setup' && chrome.assist === 'enabling') {
      status.textContent = t(`${k}enable.working`);
      actions.push(chromeButton(t(`${k}giveUp`), 'chromeDisconnect', 'btn btn-quiet'));
    } else if (state === 'setup') {
      // ファイルはあるのにつながらない（unreachable）ときは、Chrome が閉じているだけのこともある（ファイルは Chrome を閉じても残る）
      const unreachable = reason === 'unreachable';
      // Pleiad がトグルを入れられる（Windows）なら「オンにしてつなぐ」。押したときだけ入れる（ADR 0218）。手で入れる手順とコピーは残す
      const canEnable = chrome.enable === true && chrome.assist !== 'enable-failed';
      status.textContent = chrome.assist === 'enable-failed' ? t(`${k}enable.failed`) : t(unreachable ? `${k}setup.unreachable` : `${k}setup.status`);
      if (canEnable) details.push(note(t(`${k}enable.note`)));
      else if (unreachable) details.push(note(t(`${k}setup.unreachableNote`)));
      const steps = el('ol', 'browser-conn-steps');
      const one = el('li'); one.append(el('span', 'n', '1'), el('span', null, t(`${k}setup.step1`)), el('code', null, CHROME_INSPECT_ADDRESS));
      const two = el('li'); two.append(el('span', 'n', '2'), el('span', null, t(`${k}setup.step2`)));
      steps.append(one, two);
      if (canEnable) {
        const manual = el('details', 'browser-conn-manual');
        manual.append(el('summary', null, t(`${k}enable.manual`)), steps, note(t(`${k}setup.note`)));
        details.push(manual);
      } else details.push(steps, note(t(`${k}setup.note`)));
      const copy = el('button', canEnable ? 'btn' : 'btn btn-primary', copied ? t(`${k}setup.copied`) : t(`${k}setup.copy`)); copy.type = 'button'; copy.onclick = () => { void copyAddress(); };
      if (canEnable) actions.push(chromeButton(t(`${k}enable.connect`), 'chromeEnable', 'btn btn-primary'));
      else if (chrome.enable === true && chrome.assist === 'enable-failed') actions.push(chromeButton(t(`${k}denied.retry`), 'chromeEnable', 'btn btn-primary'), copy);
      else actions.push(copy);
      actions.push(chromeButton(t(`${k}giveUp`), 'chromeDisconnect', 'btn btn-quiet'));
      if (copyFailed) details.push(note(t(`${k}setup.copyFailed`)));
    } else if (state === 'consent') {
      // 会話のエージェントが接続を待っている（Pleiad の中の許可）。ここでの「許可」も同じ
      status.textContent = t(`${k}consent.status`);
      actions.push(chromeButton(t(`${k}consent.allow`), 'chromeConsent', 'btn btn-primary'), chromeButton(t(`${k}giveUp`), 'chromeDisconnect', 'btn btn-quiet'));
    } else if (state === 'permission' && chrome.assist === 'allowing') {
      status.textContent = t(`${k}permission.allowing`);
      actions.push(chromeButton(t(`${k}giveUp`), 'chromeDisconnect', 'btn btn-quiet'));
    } else if (state === 'permission') {
      status.textContent = t(`${k}permission.status`);
      actions.push(chromeButton(t(`${k}permission.raise`), 'chromeRaiseDialog', 'btn btn-primary'), chromeButton(t(`${k}giveUp`), 'chromeDisconnect', 'btn btn-quiet'));
      details.push(note(t(`${k}permission.note`)));
    } else if (state === 'denied') {
      status.textContent = t(`${k}denied.status`);
      actions.push(chromeButton(t(`${k}denied.retry`), 'chromeConnect', 'btn btn-primary'), chromeButton(t(`${k}giveUp`), 'chromeDisconnect', 'btn btn-quiet'));
    } else if (state === 'connected') {
      status.textContent = t(`${k}connected.status`, { browser: chromeLabel(product) }); status.classList.add('on');
      actions.push(chromeButton(t(`${k}connected.disconnect`), 'chromeDisconnect'));
      details.push(note(t(`${k}connected.note`)));
    } else {
      status.textContent = t(`${k}off.status`);
      actions.push(chromeButton(t(`${k}off.connect`), 'chromeConnect', 'btn btn-primary'));
      // 切れた理由（自分で切ったときは出さない）
      const why = { 'chrome-closed': 'chromeClosed', revoked: 'revoked', protocol: 'protocol' }[reason];
      if (why) details.push(note(t(`${k}off.${why}`)));
    }
    const row = el('div', 'browser-conn-row');
    // 会話が Chrome の準備・許可を待っている間は、「まだ内蔵ブラウザーを使います」と言わず、どの会話が待っているかを言う
    const waiting = ['setup', 'consent', 'permission', 'denied'].includes(state) ? getChromeWaiting() : [];
    const name = el('span', 'nm'); name.append(el('strong', null, t(`${k}name`)), el('small', null, waiting.length ? t(`${k}waiting`, { title: waiting.join(' · ') }) : t(`${k}description`)));
    row.append(chromeMark(), name, status, ...actions);
    // Chrome の確認に自動で答える（既定はオン。ADR 0218）。オフにすると、今までどおり Chrome の確認を人が押す
    const auto = [];
    if (state !== 'unsupported') {
      const autoRow = el('label', 'browser-setting');
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = getPrefs().chromeAutoAllow !== false;
      toggle.onchange = () => save('chromeAutoAllow', toggle.checked);
      autoRow.append(el('span', null, t(`${k}autoAllow.label`)), toggle);
      const autoNote = note(t(`${k}autoAllow.note`)); autoNote.classList.add('browser-auto-allow-note');
      auto.push(autoRow, autoNote);
    }
    chromeSection.replaceChildren(el('h3', null, t(`${k}title`)), row, ...details, ...auto, chromeError);
  }
  function loadChrome() {
    const caps = getHostCaps();
    if (!available || caps === null || caps?.chromeBrowser === false) { paintChrome(); return Promise.resolve(); }
    return cmd('chromeStatus').then(status => { chrome = status; paintChrome(); }).catch(() => {});
  }

  // ---- Chrome のプロフィール（docs/inapp-browser.md「プロフィール」）: 新しい会話の既定と、プロフィールごとのメモ（エージェントの一覧にも載る）。
  // 会話ごとの切り替えは会話の側（ops の browser.useProfile・web/chrome-profile-menu.mjs）。一覧は ops の browser.listProfiles（表示名・フォルダー名・メモ）
  let profiles = null;   // [{ browser, dir, name, note }] | null（まだ読んでいない・読めない）
  function loadProfiles() {
    const caps = getHostCaps();
    if (!available || caps === null || caps?.chromeBrowser !== 'available') { profiles = null; paintProfiles(); return Promise.resolve(); }
    return cmd('invoke', { op: 'browser.listProfiles', args: {} }).then(r => { profiles = r?.profiles ?? []; paintProfiles(); paintConfirmation(); }).catch(() => { profiles = null; paintProfiles(); });
  }
  function paintProfiles() {
    // i18n-dynamic: settings.browser.profiles.
    if (!profiles?.length) { profileSection.hidden = true; profileSection.replaceChildren(); return; }
    const prefs = getPrefs();
    const k = 'settings.browser.profiles.';
    const many = new Set(profiles.map(p => p.browser)).size > 1;
    const nameOf = p => many ? `${browserLabel(p.browser)} · ${profileLabel(p, profiles)}` : profileLabel(p, profiles);
    // 新しい会話の既定（選ばなければ Chrome の最後に使ったプロフィール）。プルダウンは共通の combo（web/combo.mjs）
    const want = validProfileRef(prefs.chromeNewProfile) ? profileKey(prefs.chromeNewProfile) : '';
    const pick = createCombo({ ariaLabel: t(`${k}newDefault`), strict: true, cls: 'browser-pick',
      value: profiles.some(p => profileKey(p) === want) ? want : '',
      options: () => [{ value: '', label: t(`${k}lastUsed`) }, ...profiles.map(p => ({ value: profileKey(p), label: nameOf(p) }))],
      onCommit: v => {
        const p = profiles.find(row => profileKey(row) === v);
        void save('chromeNewProfile', p ? { browser: p.browser, dir: p.dir } : null);
      } });
    pick.root.id = 'browserNewProfile';
    const pickRow = el('div', 'browser-setting');
    pickRow.append(el('span', null, t(`${k}newDefault`)), pick.root);
    const list = el('div', 'browser-profile-list');
    for (const p of profiles) {
      const row = el('div', 'browser-setting browser-profile');
      const name = el('span', 'browser-site-name'); name.append(el('strong', null, nameOf(p)), el('small', null, p.dir));
      const input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.maxLength = NOTE_MAX;
      input.placeholder = t(`${k}notePlaceholder`); input.setAttribute('aria-label', t(`${k}noteLabel`, { name: p.name || p.dir }));
      input.value = noteOf(prefs.chromeProfileNotes ?? [], p);
      input.onchange = () => {
        const note = input.value.trim().slice(0, NOTE_MAX);
        const rows = (getPrefs().chromeProfileNotes ?? []).filter(row => profileKey(row) !== profileKey(p));
        if (note) rows.push({ browser: p.browser, dir: p.dir, note });
        void save('chromeProfileNotes', rows);
      };
      row.append(name, input); list.append(row);
    }
    profileSection.hidden = false;
    profileSection.replaceChildren(el('h3', null, t(`${k}title`)), el('p', 'browser-setting-note', t(`${k}description`)), pickRow,
      el('h4', null, t(`${k}notesTitle`)), el('p', 'browser-setting-note', t(`${k}notesNote`)), list);
  }

  function paint() {
    const value = linkOpenPref(getPrefs());
    for (const b of buttons) { b.classList.toggle('on', b.dataset.linkOpen === value); b.setAttribute('aria-pressed', String(b.dataset.linkOpen === value)); }
    paintConfirmation();
    paintChrome();
    // 書いているメモの欄は描き直さない（打っている途中の字と位置を保つ）
    if (!profileSection.contains(document.activeElement)) paintProfiles();
  }
  paint();
  return {
    paint,
    /** 待っている会話の増減に合わせて、Chrome の行だけ描き直す */
    chromeRepaint: paintChrome,
    /** サーバーの chromeBrowser イベント（ホストの画面だけに届く） */
    chromeEvent(ev) {
      const was = chrome?.state;
      chrome = { state: ev.state, reason: ev.reason ?? null, dialog: ev.dialog === true, product: ev.product ?? null, assist: ev.assist ?? null, enable: ev.enable === true }; paintChrome();
      if (ev.state === 'connected' && was !== 'connected') void loadProfiles();   // つないだときに、増やした・名前を変えたプロフィールを読み直す
    },
    /** hostCapabilities が届いた（つなぎ直したときも）。使える環境なら今の状態を取り直す */
    hostCapsChanged: () => Promise.all([loadChrome(), loadProfiles()]),
  };
}
