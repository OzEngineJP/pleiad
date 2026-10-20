// 設定 › アプリ情報・更新 › 常駐（docs/remote.md §6.3、ADR 0175・0239）。デスクトップ版だけ（RemoteStatus.resident.available）。
// ウィンドウを閉じても動かし続ける・サインイン時に起動する・スリープ（作業中だけ防ぐ / 防がない）。
// 常駐はリモートに限らずアプリ全体の動き方なので、設定 › リモートから移した。見え方は web/manage-panel.css の .rm-*。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { loginItemView } from './login-item-view.mjs';
import { groupHead, switchButton, segment, errorLine, paintInto } from './remote-parts.mjs';

export function setupResidentSettings({ cmd }) {
  const root = document.getElementById('residentSettings');
  /** RemoteStatus.resident と、サインイン時の起動（OS から読み直した状態）・操作中・失敗 */
  let resident = null, login = null, busy = false, message = '';
  // OS にサインインしたら起動する（desktop/login-item.cjs）。この窓（ローカルのデスクトップ版）だけ
  const loginBridge = window.plyDesktop?.loginItem && !window.plyRemote ? window.plyDesktop.loginItem : null;

  function paint() {
    root.hidden = !resident?.available;
    if (root.hidden) return;
    const view = loginBridge ? loginItemView(login) : { visible: false };
    paintInto(root, JSON.stringify([resident, view, busy, message]), () => {
      const out = [groupHead(t('settings.updates.resident.title'))];
      out.push(switchRow(t('settings.updates.resident.keepRunning'), resident.keepRunning === true, 'keepRunning', () => set({ keepRunning: !resident.keepRunning })));
      if (view.visible) {
        out.push(switchRow(t('settings.updates.resident.launchAtLogin'), view.checked, 'launchAtLogin', () => setLogin(!view.checked)));
        if (view.blocked) {
          const mac = window.plyDesktop.platform === 'darwin';
          out.push(el('p', 'rm-weak rm-note-row', mac ? t('settings.updates.resident.launchAtLoginBlockedMac') : t('settings.updates.resident.launchAtLoginBlockedWin')));
        }
      }
      const sleep = el('div', 'rm-mrow rm-wrap');
      const seg = segment(t('settings.updates.resident.sleep'),
        [['working', t('settings.updates.resident.sleepWorking')], ['off', t('settings.updates.resident.sleepOff')]],
        resident.sleep, value => { if (value !== resident.sleep) set({ sleep: value }); });
      for (const b of seg.querySelectorAll('button')) b.disabled = busy;
      sleep.append(el('span', 'rm-lbl', t('settings.updates.resident.sleep')), seg);
      out.push(sleep);
      if (message) out.push(errorLine(message));
      return out;
    });
  }
  function switchRow(label, on, key, onclick) {
    const row = el('div', 'rm-mrow');
    const sw = switchButton(label, onclick);
    sw.dataset.fk = key;
    sw.setAttribute('aria-checked', String(on));
    sw.disabled = busy;
    row.append(el('span', 'rm-lbl', label), sw);
    return row;
  }

  async function run(fn) {
    if (busy) return;
    busy = true; message = ''; paint();
    try { await fn(); } catch (e) { message = e.message; }
    finally { busy = false; paint(); }
  }
  const set = patch => run(async () => { resident = (await cmd('setRemoteResident', patch))?.resident ?? resident; });
  const setLogin = enabled => run(async () => { login = await loginBridge.set(enabled); });

  async function refresh() {
    try { resident = (await cmd('remoteStatus'))?.resident ?? null; } catch { resident = null; }
    if (loginBridge) { try { login = await loginBridge.get(); } catch { login = null; } }
    paint();
  }
  function event(ev) {
    if (ev.type !== 'remoteStatus' || !ev.status) return;
    resident = ev.status.resident ?? resident;
    paint();
  }

  // 開くたびに OS から読み直す（OS の設定で変えられていることがある）
  document.getElementById('updatesTab').addEventListener('click', () => refresh());
  return { refresh, event };
}
