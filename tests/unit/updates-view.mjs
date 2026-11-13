// 設定 › バージョンと更新の画面（web/updates.mjs）: スイッチは操作中も disabled にせず（キーボードの居場所を保つ）押しだけ無視する・
// 状態の 1 行は role と aria-live を一緒に替える・進みの通知で一覧が外れても前の一覧を保つ（DOM の代役）
import { N } from '../lib/dom-stub.mjs';
import { setupUpdates } from '../../web/updates.mjs';

export const name = 'updates-view';
export const title = '設定 › バージョンと更新の画面: スイッチは操作中も disabled にしない・押しは無視する・role と aria-live を揃える・進みの通知で一覧を保つ';

const SWITCHES = ['updateCheckAutomatic', 'updateAutomatic', 'updateBeta'];
const base = { version: '1.0.0', enabled: true, phase: 'current', autoCheck: true, autoDownload: false, channel: 'stable', lastChecked: null, releases: [] };
const walk = (n, fn) => { fn(n); for (const c of n.children ?? []) walk(c, fn); };
const found = (root, sel) => { const out = []; walk(root, n => { if (n.matches?.(sel)) out.push(n); }); return out; };

export default async function (t) {
  const nodes = {};
  const make = (id, tag = 'div') => (nodes[id] = new N(tag));
  for (const id of ['updatesPanel', 'releaseHistory', 'appVersion', 'updateStatus', 'updateLastChecked', 'updateHint', 'updatePreferences', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'updateConfirm',
    'confirmInstallUpdate', 'cancelInstallUpdate', 'settings', 'updateNotice', 'updateNoticeText', 'updatePrompt', 'updatePromptText', 'viewAvailableUpdate', 'deferUpdate', 'onboardingDialog',
    'dismissUpdateNotice', 'viewUpdateNotes', 'updatesTab', 'updatePromptProgress']) make(id);
  make('updateStatusRow', 'p'); make('updateProgress').append(new N('i'));
  for (const id of SWITCHES) { make(id, 'button'); const row = new N('div'); row.append(nodes[id]); }
  nodes.updatesPanel.hidden = true;
  const oldGet = document.getElementById, oldBody = document.body;
  const had = { window: 'window' in globalThis, fetch: 'fetch' in globalThis };
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  document.getElementById = id => nodes[id];
  document.body = new N('body');
  let push = null, release = null, calls = [], next = base;
  globalThis.window = { plyDesktop: {
    onUpdate: fn => { push = fn; },
    update: (name, value) => { calls.push([name, value]); return name === 'status' ? Promise.resolve(base) : new Promise(resolve => { release = () => resolve(next); }); },
  } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '1.0.0', releases: [] }) });
  try {
    setupUpdates({ page() {}, open() {}, lock() {}, flush: async () => {} });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    t.ok('The first status is painted', nodes.appVersion.textContent === 'Pleiad 1.0.0' && calls[0]?.[0] === 'status');

    // ---- スイッチ: 押している間は止まって見えるが、disabled にはしない（居場所が外れない）
    const beta = nodes.updateBeta;
    t.ok('Idle switches are enabled', SWITCHES.every(id => nodes[id].getAttribute('aria-disabled') === 'false' && !nodes[id].disabled));
    next = { ...base, channel: 'beta' };
    beta.onclick();
    t.ok('A switch pressed shows the busy state with aria-disabled and stays focusable', SWITCHES.every(id => nodes[id].getAttribute('aria-disabled') === 'true' && !nodes[id].disabled));
    t.ok('The rows are dimmed while it saves', nodes.updateBeta.parent.classList.contains('off'));
    nodes.updateAutomatic.onclick(); nodes.updateBeta.onclick();
    t.ok('Presses during the round trip are ignored', calls.filter(c => c[0] === 'preferences').length === 1);
    release();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    t.ok('After the save the switches are usable again and show the new value', SWITCHES.every(id => nodes[id].getAttribute('aria-disabled') === 'false') && beta.getAttribute('aria-checked') === 'true');
    t.ok('The saved preferences carry the toggled channel', calls.find(c => c[0] === 'preferences')?.[1]?.channel === 'beta');

    // ダウンロード済みの間は変えられない（disabled ではなく押しを無視）
    push({ ...base, phase: 'downloaded', target: '1.1.0' });
    const before = calls.length;
    t.ok('Downloaded: switches are marked unavailable but not disabled', SWITCHES.every(id => nodes[id].getAttribute('aria-disabled') === 'true' && !nodes[id].disabled));
    nodes.updateAutomatic.onclick();
    t.ok('Downloaded: a press does nothing', calls.length === before);
    push(base);
    nodes.updateAutomatic.onclick();
    t.ok('Back to idle: a press saves again', calls.length === before + 1);
    release?.();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));

    // ---- 状態の 1 行: 失敗は alert + assertive、ふだんは status + polite
    const row = nodes.updateStatusRow;
    push({ ...base, phase: 'error', error: '確認できませんでした' });
    t.ok('A failure is an alert with assertive live region', row.getAttribute('role') === 'alert' && row.getAttribute('aria-live') === 'assertive');
    push({ ...base, phase: 'current' });
    t.ok('Back to normal it is a status with a polite live region', row.getAttribute('role') === 'status' && row.getAttribute('aria-live') === 'polite');

    // ---- 進みの通知で一覧が外れても、前の一覧を保つ
    const rel = { version: '1.1.0', date: '2026-11-01', title: '新しい版', body: '本文' };
    push({ ...base, phase: 'available', target: '1.1.0', releases: [rel] });
    const heads = () => found(nodes.releaseHistory, '.rn-head').length;
    t.ok('An offered update lists its notes', heads() >= 1 && found(nodes.releaseHistory, '.rn-gh').length >= 1);
    const progress = { ...base, phase: 'downloading', target: '1.1.0', progress: 40 };
    delete progress.releases;
    push(progress);
    t.ok('A progress notification without the list keeps the previous list', found(nodes.releaseHistory, '.rn-gh').length >= 1 && found(nodes.releaseHistory, '.rn-title').some(n => n.textContent === '新しい版'));
    push({ ...base, phase: 'current', releases: [] });
    t.ok('An explicit empty list drops it', found(nodes.releaseHistory, '.rn-title').every(n => n.textContent !== '新しい版'));
  } finally {
    document.getElementById = oldGet;
    document.body = oldBody;
    if (had.window) globalThis.window = oldWindow; else delete globalThis.window;
    if (had.fetch) globalThis.fetch = oldFetch; else delete globalThis.fetch;
  }
}
