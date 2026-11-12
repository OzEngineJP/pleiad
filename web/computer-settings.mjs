// 設定 › コンピューターの操作（docs/computer-use.md「設定と会話のデータ」、docs/design-system.md「設定 › コンピューターの操作」）。
// 全体のスイッチ・すべてのアプリを許可・常に許可したアプリ（消せる）・操作できないアプリ（読み取りのみ）。
// 保存は setPref { key: 'computerUse', value } に全体を渡す。使えない起動（Electron でない・対象外の OS）ではスイッチを止めて理由を書く。
// wait_until の問い（決定モデル pplx-decider。ADR 0165）に使う口は、Pleiad Plus / OpenRouter のキー / 使わない の 3 択のラジオ（setApiKeyUse の computer:decider。2026-11-13）。選ぶまで画面は送らない。
import { t } from './i18n.mjs';
import { el, svgEl } from './dom.mjs';
import { computerUsePrefs } from './computer-prefs.mjs';
import { apiKeyList, keySelect, registerForm, statusLine, manageLink } from './api-key-ui.mjs';
import { keyRadioRow, keyRadioGroup, plusKeyRow, plusRowVisible } from './plus-key-row.mjs';
import { openExternalLink } from './link-open.mjs';
import { button } from './remote-parts.mjs';

// 操作できないアプリの分類（core/computer-use/apps.mjs の固定の一覧の見出し。画面は読み取りのみ）
const FORBIDDEN = ['terminal', 'password', 'security', 'system', 'agent'];

function appIcon() {
  const svg = svgEl('svg', { class: 'cu-appic', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(svgEl('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), svgEl('path', { d: 'M1.5 5.5h13' }));
  return svg;
}

/** 行に出す所在。パッケージアプリは AUMID（パスが無い）。macOS は .app のパスかバンドル ID */
export function appLocation(row) {
  return row.path || row.id.replace(/^(exe|aumid|bundle):/, '');
}

function switchRow(id, label) {
  const sw = el('button', 'cx-sw'); sw.type = 'button'; sw.id = id; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', label);
  const head = el('div', 'rm-switch cu-switch'); const text = el('label', 'rm-switch-label', label); text.htmlFor = id;
  head.append(text, sw);
  return { head, sw };
}

export function setupComputerSettings({ cmd, getPrefs, getHostCaps = () => null, openPage = () => {} }) {
  const $ = id => document.getElementById(id);
  const root = $('computerPanel');

  const main = switchRow('computerEnabled', t('settings.computer.enable'));
  const mainNote = el('p', 'rm-state', t('settings.computer.enableNote'));
  const unsupported = el('p', 'rm-state rm-strong cu-unsupported'); unsupported.setAttribute('role', 'status');
  const all = switchRow('computerAllowAll', t('settings.computer.allowAll'));
  const allNote = el('p', 'rm-state', t('settings.computer.allowAllNote'));
  const agyNote = el('p', 'rm-state', t('settings.computer.antigravity'));
  const listHead = el('h4', 'cu-h'); listHead.id = 'computerAllowedTitle';
  const listTitle = el('span', null, t('settings.computer.allowedTitle'));
  const tag = el('span', 'cu-tag', t('settings.computer.allowedAll')); tag.hidden = true;
  listHead.append(listTitle, tag);
  const list = el('div', 'cu-apps'); list.setAttribute('role', 'list'); list.setAttribute('aria-labelledby', listHead.id);
  const deny = el('details', 'cu-deny'); deny.id = 'computerForbidden';
  deny.append(el('summary', null, t('settings.computer.forbiddenTitle')));
  const table = el('div', 'cu-deny-rows'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', t('settings.computer.forbiddenTitle'));
  for (const kind of FORBIDDEN) {
    const row = el('div', 'cu-deny-row'); row.setAttribute('role', 'row');
    // i18n-dynamic: settings.computer.forbidden.
    const name = el('span', 'cu-deny-name', t(`settings.computer.forbidden.${kind}.name`)); name.setAttribute('role', 'rowheader');
    // i18n-dynamic: settings.computer.forbidden.
    const apps = el('span', 'cu-deny-apps', t(`settings.computer.forbidden.${kind}.apps`)); apps.setAttribute('role', 'cell');
    row.append(name, apps); table.append(row);
  }
  deny.append(table);
  const keyBox = el('div');
  const body = el('div', 'cu-body');
  body.append(all.head, allNote, agyNote, listHead, list, deny, keyBox);
  const error = el('p', 'rm-state rm-strong'); error.setAttribute('role', 'status');
  root.replaceChildren(main.head, mainNote, unsupported, body, error);

  let saving = Promise.resolve();
  function save(patch) {
    error.textContent = '';
    // 続けて押しても順に保存し、そのたびに最新の保存済みの値へ重ねる（旧い一覧で上書きしない）
    saving = saving.then(() => cmd('setPref', { key: 'computerUse', value: { ...computerUsePrefs(getPrefs()), ...patch } }))
      .catch(e => { error.textContent = t('settings.computer.saveFailed', { error: e.message }); paint(); });
    return saving;
  }
  const toggle = (sw, key) => { sw.onclick = () => { if (!sw.disabled) save({ [key]: sw.getAttribute('aria-checked') !== 'true' }); }; };
  toggle(main.sw, 'enabled');
  toggle(all.sw, 'allowAllApps');

  // wait_until の問いに使うキー。取れなければ選ぶ欄だけ出さない（ほかの設定は見せる）
  let keys = null, keyBusy = false, registering = false, keyMessage = '', focusKey = null;
  async function loadKeys() {
    keys = await apiKeyList(cmd).catch(() => null);
    paintKeys();
  }
  async function keyCommand(run, done, focus = 'sel:decider') {
    if (keyBusy) return;
    keyBusy = true; focusKey = focus;
    try { await run(); keyMessage = done; }
    catch (e) { keyMessage = t('settings.computer.saveFailed', { error: e?.message ?? String(e) }); }
    keyBusy = false;
    await loadKeys();
  }
  const chooseKey = id => keyCommand(() => cmd('setApiKeyUse', { use: 'computer:decider', id }), id ? t('apiKeys.computer.chosen') : t('apiKeys.computer.unchosen'));
  const choosePlus = () => keyCommand(() => cmd('setApiKeyUse', { use: 'computer:decider', id: 'plus' }), t('apiKeys.computer.plusChosen'), 'plus');
  const chooseNone = () => keyCommand(() => cmd('setApiKeyUse', { use: 'computer:decider', id: null }), t('apiKeys.computer.unchosen'), 'row:none');
  /** その場で登録して、wait_until の問いに使う（登録先は API キー）。登録の直後に確かめる（キーそのもの。料金はかからない） */
  const registerKey = value => keyCommand(async () => {
    const { id } = await cmd('setApiKey', { provider: 'openrouter', label: '', key: value });
    await cmd('setApiKeyUse', { use: 'computer:decider', id });
    registering = false;
    await cmd('invoke', { op: 'apiKeys.check', args: { id } }).catch(() => null);
  }, t('apiKeys.computer.registered'));

  /** 設定 › コンピューターの操作 の「wait_until の問いに使うキー」。Pleiad Plus / OpenRouter / 使わない の 3 択（承認 2026-11-13） */
  function paintKeys() {
    const focused = keyBox.contains(document.activeElement) ? document.activeElement : null;
    const keepFk = focusKey ?? focused?.dataset?.fk ?? null;
    focusKey = null;
    const sec = el('section', 'nf-section');
    sec.append(el('h4', null, t('apiKeys.computer.title')));
    const card = el('div', 'nf-card');
    const openrouter = (keys?.keys ?? []).filter(k => k.provider === 'openrouter');
    const use = keys?.uses?.['computer:decider'] ?? null;
    const viaPlus = use === 'plus';
    const current = viaPlus ? null : openrouter.find(k => k.id === use) ?? null;
    const deferred = keys?.migration?.state === 'deferred';
    const rows = [];
    // 1. Pleiad Plus（state: off・AGENT_HOST_PLUS=0 なら行ごと出さない。メンテナンス中は出して選べなくする）
    let plusUnusable = false;
    if (keys && plusRowVisible(keys.plus)) {
      const { row, selectable } = plusKeyRow({ info: keys.plus, checked: viaPlus, onChoose: choosePlus, onLogin: () => cmd('plusLogin').catch(() => {}) });
      rows.push(row);
      plusUnusable = viaPlus && (!selectable || keys.plus?.limitReached === true);
    }
    // 2. OpenRouter（キーの状態は 2 行目）。移行を保留している間は選べない（問いは使わない）
    if (deferred) {
      rows.push(keyRadioRow({ name: 'OpenRouter', checked: false, disabled: true, sub: t('apiKeys.deferredShort') }));
    } else {
      const sub = el('span');
      if (current) { sub.append(statusLine(current)); sub.append(' · ', manageLink(openPage)); }
      const sel = keys ? keySelect({ keys: openrouter, current: current?.id ?? null, noneLabel: t('apiKeys.delegation.selectKey'), noNone: true,
        label: t('apiKeys.computer.selectLabel'), focusKey: 'sel:decider', provider: 'openrouter', choose: chooseKey,
        register: () => { registering = true; focusKey = 'regin:decider'; paintKeys(); } }) : null;
      if (sel) sel.element.addEventListener('click', e => e.stopPropagation());
      rows.push(keyRadioRow({ name: 'OpenRouter', checked: !!current, disabled: !keys, sub: current ? sub : null, end: sel?.element ?? null,
        onChoose: () => sel?.open(), focusKey: 'row:decider' }));
    }
    // 3. 使わない
    rows.push(keyRadioRow({ name: t('apiKeys.computer.none'), sub: t('apiKeys.computer.noneSub'), checked: !viaPlus && !current, disabled: !keys, onChoose: chooseNone, focusKey: 'row:none' }));
    card.append(keyRadioGroup(t('apiKeys.computer.selectLabel'), rows));
    if (registering && keys && !deferred) card.append(registerForm({ provider: 'openrouter', label: t('apiKeys.computer.title'), storage: keys.storage, focusKey: 'regin:decider', onSubmit: registerKey,
      onCancel: () => { registering = false; focusKey = 'sel:decider'; paintKeys(); } }));
    sec.append(card);
    // 選んだ口が使えないとき: 1 文と、直す操作（アカウントを管理）
    if (plusUnusable) {
      const warn = el('p', 'rm-err', keys.plus?.limitReached && keys.plus?.signedIn && keys.plus?.status === 'plus' && keys.plus?.state !== 'maintenance' ? t('apiKeys.computer.plusLimit') : t('apiKeys.computer.plusUnusable'));
      warn.setAttribute('role', 'alert');
      sec.append(warn);
      if (keys.plus?.profileUrl && keys.plus?.signedIn) {
        const acts = el('div', 'rm-acts');
        acts.append(button(t('settings.plus.manage'), () => openExternalLink(keys.plus.profileUrl), 'btn btn-quiet'));
        sec.append(acts);
      }
    }
    sec.append(el('p', 'mp-note', t('apiKeys.computer.note')));
    const line = el('p', 'rm-state', keyMessage); line.setAttribute('role', 'status');
    sec.append(line);
    keyBox.replaceChildren(sec);
    if (keepFk) keyBox.querySelector(`[data-fk="${CSS.escape(keepFk)}"]`)?.focus({ preventScroll: true });
  }
  $('computerTab')?.addEventListener('click', () => { keyMessage = ''; loadKeys(); });

  function paint() {
    const prefs = computerUsePrefs(getPrefs());
    const caps = getHostCaps();
    // 使えるかは hostCapabilities が届くまで分からない。届く前は使えるものとして描き、届いたら描き直す
    const supported = caps?.computerUse ? caps.computerUse.supported !== false : true;
    main.sw.setAttribute('aria-checked', String(prefs.enabled));
    main.sw.disabled = !supported;
    unsupported.hidden = supported;
    // i18n-dynamic: settings.computer.unsupported.
    unsupported.textContent = supported ? '' : t(`settings.computer.unsupported.${caps.computerUse.reason ?? 'desktop'}`);
    mainNote.hidden = !supported;
    body.hidden = !supported || !prefs.enabled;
    all.sw.setAttribute('aria-checked', String(prefs.allowAllApps));
    tag.hidden = !prefs.allowAllApps;
    list.classList.toggle('dim', prefs.allowAllApps);
    list.setAttribute('aria-disabled', String(prefs.allowAllApps));
    const rows = prefs.alwaysAllowed;
    if (!rows.length) { const empty = el('div', 'cu-empty', t('settings.computer.empty')); list.replaceChildren(empty); return; }
    list.replaceChildren(...rows.map(row => {
      const line = el('div', 'cu-app'); line.setAttribute('role', 'listitem');
      const where = el('span', 'cu-app-path', appLocation(row)); where.title = appLocation(row);
      const remove = el('button', 'btn', t('settings.computer.remove')); remove.type = 'button';
      remove.setAttribute('aria-label', t('settings.computer.removeApp', { name: row.name }));
      remove.disabled = prefs.allowAllApps;
      remove.onclick = () => save({ alwaysAllowed: computerUsePrefs(getPrefs()).alwaysAllowed.filter(r => r.id !== row.id) });
      line.append(appIcon(), el('span', 'cu-app-name', row.name), where, remove);
      return line;
    }));
  }
  paint();
  paintKeys();
  return {
    paint,
    /** apiKeysChanged が届いたとき。開いているときだけ取り直す */
    event(ev) { if (!root.hidden && ev?.type === 'apiKeysChanged') loadKeys(); },
  };
}
