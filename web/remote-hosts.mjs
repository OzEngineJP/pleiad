// 設定 › リモート › ほかの PC へ（docs/remote.md §4、ADR 0239）。デスクトップ版のローカルの窓だけに出す（plyDesktop.hosts。desktop/remote-windows.cjs）。
//
// - 一覧: ペアリングしたホストの行（自分の中継サーバー）。行を押すと詳しい画面（つなぎ方・中継サーバー・最後の接続・開く・名前を変える・削除。古いホストには更新を勧める 1 行）
// - ＋ の流れ（PC を追加）: アプリを入れる › つなぎ方 › つなぐ（相手の PC に出ているコードを貼り付け、確認コードを見せて相手の PC の許可を待つ）› 完了
//
// ホストの一覧と資格情報は desktop 側が持つ（サーバーの設定・AI の操作の一覧には置かない。ADR 0146）。見え方は web/manage-panel.css の .rm-*。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import {
  button, groupHead, listRow, detailHead, keyValues, waitLine, confirmCode, createWizard, field, textInput,
  installPcBody, methodOptions, doneBody, errorLine,
} from './remote-parts.mjs';

const STATES = ['connected', 'connecting', 'offline', 'host-offline', 'revoked', 'closed', 'stopped'];

/**
 * 一覧の 1 行に出すもの。host は desktop/remote-windows.cjs の hostRow。
 * 2 行目は、つながらない（中継かホストがオフライン）ときの「オフライン」と、取り消されたときだけ
 */
export function hostLine(host) {
  const state = STATES.includes(host?.state) ? host.state : 'closed';
  const revoked = state === 'revoked';
  return {
    name: host?.name || host?.hostId || '',
    sub: revoked ? t('settings.remote.hosts.revoked') : state === 'offline' || state === 'host-offline' ? t('settings.remote.offline') : '',
    canOpen: !revoked,
    revoked,
  };
}

/**
 * 詳しい画面の弱い字の 1 行（docs/remote.md §7.4）。この PC の AI から任せられるのは、ホストが許可を入れていればすべて（ADR 0239）。
 * つながっているのに受けないのは、ホストの Pleiad が古い（/agent の口が無い・端末ごとの許可があった版）ときだけ。ほかは何も出さない
 */
export function agentLine(host) {
  const old = host?.agentState === 'unsupported' || (host?.agentState === 'ready' && !host.agentAllowed);
  return old ? t('settings.remote.hosts.agent.notAllowed', { host: host.name || host.hostId }) : '';
}

/** @param onChange 見え方が変わった（設定 › リモートが描き直す） */
export function setupRemoteHosts({ onChange }) {
  const bridge = typeof window !== 'undefined' && !window.plyRemote ? window.plyDesktop?.hosts : null;
  /** ホストの一覧・この PC の資格情報を暗号化できるか・読めなかった理由 */
  let hosts = [], encrypted = true, loadError = '', inited = null;
  /** 詳しい画面のホスト・名前を変えている・削除の確かめ中・操作中（開く）・失敗 */
  let detailId = '', renaming = false, removing = false, message = '';
  const busy = new Set();

  if (bridge) {
    bridge.onChange(list => { hosts = Array.isArray(list) ? list : hosts; onChange(); });
    bridge.onCode(code => { if (wz?.pairing) { wz.code = code; paintWizard(); } });
  }

  function init() {
    if (!bridge) return Promise.resolve();
    inited ??= bridge.init().then(r => {
      if (r.ok) { hosts = r.hosts; encrypted = r.encrypted !== false; loadError = ''; }
      else { loadError = t('settings.remote.hosts.loadFailed', { error: r.message }); inited = null; }
      onChange();
    });
    return inited;
  }
  async function refresh() {
    if (!bridge) return;
    if (!inited) return init();
    const r = await bridge.list();
    if (r.ok) { hosts = r.hosts; loadError = ''; } else loadError = t('settings.remote.hosts.loadFailed', { error: r.message });
    onChange();
  }

  function sig() {
    return JSON.stringify([hosts, encrypted, loadError, detailId, renaming, removing, message, [...busy]]);
  }

  // ---- 描く
  function build() {
    if (!inited) init();
    const host = detailId && hosts.find(h => h.hostId === detailId);
    if (detailId && !host) { detailId = ''; renaming = false; removing = false; }
    return host ? detail(host) : list();
  }

  function list() {
    const out = [];
    if (loadError) out.push(errorLine(loadError));
    if (hosts.length) {
      const group = el('section', 'rm-group');
      group.append(groupHead(t('settings.remote.groups.own')));
      for (const h of hosts) {
        const line = hostLine(h);
        group.append(listRow({ icon: 'monitor', name: line.name, sub: line.sub, key: `host-${h.hostId}`,
          onclick: () => { detailId = h.hostId; renaming = false; removing = false; message = ''; onChange(); } }));
      }
      out.push(group);
    }
    return out;
  }

  function detail(host) {
    const line = hostLine(host);
    const out = detailHead({ icon: 'monitor', name: line.name, onBack: () => { detailId = ''; renaming = false; removing = false; message = ''; onChange(); } });
    out.push(keyValues([
      [t('settings.remote.detail.method'), t('settings.remote.groups.own')],
      [t('settings.remote.detail.relay'), host.relay],
      [t('settings.remote.detail.added'), host.pairedAt ? fmt.dateTime(host.pairedAt, { year: 'numeric', month: 'long', day: 'numeric' }) : ''],
      [t('settings.remote.detail.lastSeen'), host.lastConnectedAt ? fmt.relative(host.lastConnectedAt) : t('settings.remote.detail.never')],
    ]));
    if (line.revoked) out.push(el('p', 'rm-weak', t('settings.remote.hosts.revokedHint')));
    else {
      const text = agentLine(host);
      if (text) { const note = el('p', 'rm-weak rm-agent', text); note.setAttribute('role', 'status'); out.push(note); }
    }
    if (renaming) out.push(renameLine(host, line.name));
    else if (removing) out.push(removeLine(host, line.name));
    else {
      const acts = el('div', 'rm-acts');
      const opening = busy.has(host.hostId);
      const open = button(opening ? t('settings.remote.hosts.opening') : t('settings.remote.hosts.open'), () => openHost(host.hostId), 'btn btn-primary');
      open.dataset.fk = 'open';
      open.disabled = !line.canOpen || opening;
      const rename = button(t('settings.remote.hosts.rename'), () => { renaming = true; message = ''; onChange(); }, 'btn btn-quiet');
      rename.dataset.fk = 'rename';
      const remove = button(t('settings.remote.hosts.remove'), () => { removing = true; message = ''; onChange(); }, 'btn btn-quiet');
      remove.dataset.fk = 'remove';
      if (line.canOpen) acts.append(open);
      acts.append(rename, remove);
      out.push(acts);
    }
    if (!encrypted) out.push(el('p', 'rm-weak', t('settings.remote.hosts.storagePlain')));
    if (message) out.push(errorLine(message));
    return out;
  }

  function renameLine(host, name) {
    const box = el('div', 'rm-confirm');
    const input = textInput({ key: 'renameInput' });
    input.value = host.label || name;
    input.maxLength = 80;
    input.setAttribute('aria-label', t('settings.remote.hosts.renameLabel'));
    const save = async () => {
      const r = await bridge.rename(host.hostId, input.value.trim());
      message = r.ok ? '' : r.message;
      renaming = false;
      await refresh();
    };
    const cancel = () => { renaming = false; onChange(); };
    input.onkeydown = e => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    const acts = el('div', 'rm-acts');
    acts.append(button(t('settings.remote.wizard.cancel'), cancel, 'btn btn-quiet'), button(t('settings.remote.hosts.renameSave'), save, 'btn btn-primary'));
    box.append(field(t('settings.remote.hosts.renameLabel'), input), acts);
    queueMicrotask(() => { input.focus(); input.select(); });
    return box;
  }

  function removeLine(host, name) {
    const box = el('div', 'rm-confirm');
    const keep = button(t('settings.remote.wizard.cancel'), () => { removing = false; onChange(); }, 'btn btn-quiet');
    keep.dataset.fk = 'keep';
    const yes = button(t('settings.remote.hosts.removeYes'), async () => {
      const r = await bridge.remove(host.hostId);
      message = r.ok ? '' : r.message;
      removing = false;
      if (r.ok) detailId = '';
      await refresh();
    }, 'btn btn-primary');
    const acts = el('div', 'rm-acts');
    acts.append(keep, yes);
    box.append(el('p', null, t('settings.remote.hosts.removeConfirm', { host: name })), acts);
    queueMicrotask(() => keep.focus());
    return box;
  }

  async function openHost(hostId) {
    busy.add(hostId); onChange();
    const r = await bridge.open(hostId);
    busy.delete(hostId);
    message = r.ok ? '' : r.message;
    await refresh();
  }

  // ---- ＋ の流れ（ほかの PC へ: PC を追加）
  /** wz: { step, payload（入力欄）, pairing, code, error, doneName } */
  let wz = null;
  const wizard = createWizard({ id: 'remoteAddHost', onCancel: () => cancelWizard() });

  function openAdd() {
    if (!bridge) return;
    const payload = textInput({ placeholder: 'pleiad://pair?…', key: 'payload', mono: true });
    payload.oninput = () => paintWizard();
    payload.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && payload.value.trim()) { e.preventDefault(); pair(); } };
    wz = { step: 0, payload, pairing: false, code: '', error: '', doneName: '' };
    paintWizard();
  }

  function paintWizard() {
    if (!wz) { wizard.close(); return; }
    const o = { title: t('settings.remote.addHost'), step: wz.step, back: () => back() };
    if (wz.step === 0) {
      o.body = [installPcBody()];
      o.next = { onclick: () => { wz.step = 1; paintWizard(); } };
    } else if (wz.step === 1) {
      o.body = [methodOptions()];
      o.next = { onclick: () => { wz.step = 2; paintWizard(); } };
    } else if (wz.step === 2) {
      if (wz.pairing) {
        o.body = wz.code ? [confirmCode(wz.code), waitLine(t('settings.remote.wizard.hostWait'))] : [waitLine(t('settings.remote.wizard.hostConnecting'))];
        o.next = { disabled: true };
      } else {
        o.body = [field(t('settings.remote.wizard.hostCode'), wz.payload), ...(wz.error ? [errorLine(wz.error)] : [])];
        o.next = { disabled: !wz.payload.value.trim(), onclick: () => pair() };
      }
      o.sig = [wz.pairing, wz.code, wz.error];
    } else {
      o.body = [doneBody(wz.doneName)];
      o.sig = wz.doneName;
    }
    wizard.render(o);
  }

  async function pair() {
    if (!wz || wz.pairing) return;
    const mine = wz;
    mine.pairing = true; mine.code = ''; mine.error = '';
    paintWizard();
    const r = await bridge.pair(mine.payload.value.trim());
    mine.pairing = false;
    if (wz !== mine) return;
    if (r.ok) {
      wz.doneName = r.host?.name || '';
      wz.step = 3;
      refresh();
    } else if (r.code !== 'aborted') wz.error = r.message;
    paintWizard();
  }
  function back() {
    if (!wz) return;
    if (wz.step === 2 && wz.pairing) { bridge.cancelPair(); return; }   // 貼り付けの面に戻る（pair が aborted で返る）
    wz.error = '';
    wz.step = Math.max(0, wz.step - 1);
    paintWizard();
  }
  function cancelWizard() {
    if (!wz) return;
    if (wz.pairing) bridge.cancelPair();
    wz = null;
    paintWizard();
  }

  return {
    available: Boolean(bridge),
    sig, build, refresh, openAdd,
    onOpen: fn => bridge?.onOpen?.(fn),
    get inDetail() { return Boolean(detailId); },
  };
}
