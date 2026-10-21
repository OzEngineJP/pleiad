// 設定 › リモート › ほかの PC へ（docs/remote.md §4、ADR 0239）。デスクトップ版のローカルの窓だけに出す（plyDesktop.hosts。desktop/remote-windows.cjs）。
//
// - 一覧: Pleiad Plus のホスト（上）とペアリングしたホスト（下・自分の中継サーバー）。
//   - Plus の行を押すとその PC の窓を開く。同じ hostId の窓は 1 枚で前面化。まだ許可されていない（もう一度の許可が要る）PC は、
//     確認コードを出して相手の PC の画面の承認を待つ（QR のときと同じ待ちの画面。やめるで中断）
//   - 自分の中継の行を押すと詳しい画面（つなぎ方・中継サーバー・最後の接続・開く・名前を変える・削除）
// - ＋ の流れ（PC を追加）: アプリを入れる › つなぎ方（Plus / 自分の中継）› つなぐ（待つ/コード貼り付け）› 完了
//
// ホストの一覧と資格情報は desktop 側が持つ（サーバーの設定・AI の操作の一覧には置かない。ADR 0146）。見え方は web/manage-panel.css の .rm-*。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import {
  button, groupHead, listRow, detailHead, keyValues, waitLine, confirmCode, createWizard, field, textInput,
  installPcBody, methodOptions, doneBody, errorLine, switchButton, rmIcon, deviceIcon,
} from './remote-parts.mjs';
import { openExternalLink } from './link-open.mjs';

const STATES = ['connected', 'connecting', 'offline', 'host-offline', 'revoked', 'reapprove', 'unpaired', 'closed', 'stopped', 'blocked', 'limit', 'paused', 'readmit'];

/**
 * 一覧の 1 行に出すもの。host は desktop/remote-windows.cjs の hostRow。
 * 2 行目は、つながらない（中継かホストがオフライン）ときの「オフライン」と、取り消されたとき、Plus の拒否/制限理由
 */
export function hostLine(host, { plusState = null } = {}) {
  const state = STATES.includes(host?.state) ? host.state : (host?.state || 'closed');
  const revoked = state === 'revoked';
  const isPlus = host?.via === 'plus';
  let sub = '';
  if (revoked) {
    sub = t('settings.remote.hosts.revoked');
  } else if (isPlus) {
    if (state === 'reapprove') {
      sub = t('settings.remote.hosts.reapprove');
    } else if (state === 'blocked') {
      sub = t('settings.remote.groups.plusBlocked');
    } else if (state === 'limit') {
      sub = t('settings.remote.groups.plusLimit');
    } else if (state === 'paused') {
      if (plusState === 'maintenance') sub = t('settings.remote.groups.plusMaintenance');
      else sub = t('settings.remote.groups.plusUnavailable');
    } else if (state === 'connecting' || state === 'readmit') {
      sub = t('settings.remote.wizard.connecting');
    } else if (state === 'offline' || state === 'host-offline' || host?.plusOnline === false) {
      sub = t('settings.remote.offline');
    }
  } else {
    if (state === 'offline' || state === 'host-offline') {
      sub = t('settings.remote.offline');
    }
  }
  return {
    name: host?.name || host?.hostId || '',
    sub,
    canOpen: !revoked && state !== 'blocked' && state !== 'limit',
    revoked,
    /** 開く前に相手の PC の承認が要る（Plus のまだ許可されていない・もう一度の許可が要る PC） */
    needsApproval: isPlus && (state === 'unpaired' || state === 'reapprove'),
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
export function setupRemoteHosts({ onChange, cmd, page }) {
  const bridge = typeof window !== 'undefined' && !window.plyRemote ? window.plyDesktop?.hosts : null;
  /** ホストの一覧・この PC の資格情報を暗号化できるか・読めなかった理由 */
  let hosts = [], encrypted = true, loadError = '', inited = null;
  /** Pleiad Plus の状態 */
  let plus = {
    use: true,
    ok: false,
    state: 'on',
    status: null,
    email: null,
    error: false,
    reason: null,
    urls: null,
    available: true,
    needsUpdate: false,
    hosts: [],
  };
  /** 詳しい画面のホスト・名前を変えている・削除の確かめ中・操作中（開く）・失敗 */
  let detailId = '', renaming = false, removing = false, message = '';
  const busy = new Set();
  let pollTimer = null;

  if (bridge) {
    bridge.onChange(data => {
      if (Array.isArray(data)) {
        hosts = data;
      } else if (data && typeof data === 'object') {
        if (Array.isArray(data.hosts)) hosts = data.hosts;
        if (data.plus) plus = { ...plus, ...data.plus };
      }
      if (wz && wz.step === 2 && wz.method === 'plus') {
        const currentPlusHosts = plus?.hosts || [];
        const newOnline = currentPlusHosts.find(h => !wz.initialHostIds.has(h.hostId) && h.online === true);
        if (newOnline && (!wz.foundHost || wz.foundHost.hostId !== newOnline.hostId)) {
          wz.foundHost = newOnline;
          paintWizard();
        }
      }
      onChange();
    });
    bridge.onCode(code => { if (wz?.pairing || wz?.admitting) { wz.code = code; paintWizard(); } });
  }

  function init() {
    if (!bridge) return Promise.resolve();
    inited ??= bridge.init().then(r => {
      if (r.ok) {
        hosts = r.hosts || [];
        if (r.plus) plus = { ...plus, ...r.plus };
        encrypted = r.encrypted !== false;
        loadError = '';
      } else {
        loadError = t('settings.remote.hosts.loadFailed', { error: r.message });
        inited = null;
      }
      onChange();
    });
    return inited;
  }

  async function refresh({ fresh = false } = {}) {
    if (!bridge) return;
    if (!inited) return init();
    const r = await bridge.list({ fresh });
    if (r.ok) {
      hosts = r.hosts || [];
      if (r.plus) plus = { ...plus, ...r.plus };
      loadError = '';
    } else {
      loadError = t('settings.remote.hosts.loadFailed', { error: r.message });
    }
    onChange();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      refresh();
    }, 30_000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function sig() {
    return JSON.stringify([hosts, encrypted, loadError, detailId, renaming, removing, message, [...busy], plus]);
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

    // ---- まとまり 1: Pleiad Plus
    if (plus.needsUpdate) {
      out.push(el('p', 'rm-warn', t('settings.remote.groups.plusNeedsUpdate')));
    } else if (plus.available !== false) {
      const plusSec = el('section', 'rm-group');

      if (!plus.status || plus.status === 'signedOut') {
        plusSec.append(groupHead(t('settings.remote.groups.plus')));
        plusSec.append(listRow({
          icon: 'user',
          name: t('settings.remote.groups.plusLogin'),
          key: 'plus-login',
          onclick: () => {
            if (page) page('plus');
            if (cmd) cmd('plusLogin');
          },
        }));
        out.push(plusSec);
      } else if (plus.status === 'free') {
        plusSec.append(groupHead(t('settings.remote.groups.plus')));
        plusSec.append(listRow({
          icon: 'user',
          name: t('settings.remote.groups.plusUpgrade'),
          key: 'plus-upgrade',
          onclick: () => {
            const u = plus.urls?.account ? new URL('/plus', plus.urls.account).href : 'https://pleiad.dev/plus';
            openExternalLink(u);
          },
        }));
        out.push(plusSec);
      } else if (plus.status === 'disabled') {
        plusSec.append(groupHead(t('settings.remote.groups.plus')));
        plusSec.append(el('p', 'rm-warn', t('settings.remote.groups.plusBlocked')));
        out.push(plusSec);
      } else if (plus.state === 'maintenance') {
        const sw = switchButton(t('settings.remote.groups.plusConnect'), async () => {
          const next = !plus.use;
          plus.use = next;
          await bridge?.setPlusUse?.(next);
          onChange();
        });
        sw.setAttribute('aria-checked', String(plus.use));
        sw.dataset.fk = 'plusConnect';
        plusSec.append(groupHead(t('settings.remote.groups.plus'), sw));
        plusSec.append(el('p', 'rm-warn', t('settings.remote.groups.plusMaintenance')));
        out.push(plusSec);
      } else {
        // status === 'plus'
        const sw = switchButton(t('settings.remote.groups.plusConnect'), async () => {
          const next = !plus.use;
          plus.use = next;
          await bridge?.setPlusUse?.(next);
          onChange();
        });
        sw.setAttribute('aria-checked', String(plus.use));
        sw.dataset.fk = 'plusConnect';
        plusSec.append(groupHead(t('settings.remote.groups.plus'), sw));

        if (plus.use) {
          if (plus.error) {
            plusSec.append(el('p', 'rm-warn', t('settings.remote.failed')));
          }
          const plusHosts = hosts.filter(h => h.via === 'plus');
          if (plusHosts.length === 0 && !plus.error) {
            plusSec.append(el('p', 'rm-weak', t('settings.remote.groups.plusEmpty')));
          } else {
            for (const h of plusHosts) {
              const line = hostLine(h, { plusState: plus.state });
              plusSec.append(listRow({
                icon: deviceIcon(h),
                name: line.name,
                sub: line.sub,
                key: `host-${h.hostId}`,
                onclick: () => {
                  if (line.needsApproval) startPlusPair(h);
                  else if (line.canOpen) openHost(h.hostId, { via: 'plus' });
                },
              }));
            }
          }
        }
        out.push(plusSec);
      }
    }

    // ---- まとまり 2: 自分の中継サーバー
    const ownHosts = hosts.filter(h => (h.via ?? 'own') === 'own');
    if (ownHosts.length) {
      const ownSec = el('section', 'rm-group');
      ownSec.append(groupHead(t('settings.remote.groups.own')));
      for (const h of ownHosts) {
        const line = hostLine(h);
        ownSec.append(listRow({
          icon: deviceIcon(h),
          name: line.name,
          sub: line.sub,
          key: `host-${h.hostId}`,
          onclick: () => {
            detailId = h.hostId;
            renaming = false;
            removing = false;
            message = '';
            onChange();
          },
        }));
      }
      out.push(ownSec);
    }
    return out;
  }

  function detail(host) {
    const line = hostLine(host, { plusState: plus.state });
    const out = detailHead({
      icon: deviceIcon(host),
      name: line.name,
      onBack: () => { detailId = ''; renaming = false; removing = false; message = ''; onChange(); },
    });
    out.push(keyValues([
      [t('settings.remote.detail.method'), host.via === 'plus' ? t('settings.remote.groups.plus') : t('settings.remote.groups.own')],
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
      const open = button(opening ? t('settings.remote.hosts.opening') : t('settings.remote.hosts.open'), () => openHost(host.hostId, { via: host.via }), 'btn btn-primary');
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
      const r = await bridge.rename(host.hostId, input.value.trim(), host.via);
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
      const r = await bridge.remove(host.hostId, host.via);
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

  async function openHost(hostId, opts = {}) {
    busy.add(hostId); onChange();
    const r = await bridge.open(hostId, opts);
    busy.delete(hostId);
    message = r.ok ? '' : r.message;
    await refresh();
  }

  // ---- ＋ の流れ（ほかの PC へ: PC を追加）
  let wz = null;
  const wizard = createWizard({ id: 'remoteAddHost', onCancel: () => cancelWizard() });

  /** 一覧の Plus の PC から直に: 確認コードを出して相手の PC の承認を待ち、許可されたら窓を開く */
  function startPlusPair(h) {
    if (!bridge || wz) return;
    wz = { step: 2, method: 'plus', direct: true, initialHostIds: new Set(), foundHost: h, pollTimer: null, admitting: false, pairing: false, code: '', error: '', doneName: '' };
    pairPlus();
  }

  function openAdd() {
    if (!bridge) return;
    const payload = textInput({ placeholder: 'pleiad://pair?…', key: 'payload', mono: true });
    payload.oninput = () => paintWizard();
    payload.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && payload.value.trim()) { e.preventDefault(); pairOwn(); } };

    const initialHostIds = new Set((plus.hosts || hosts.filter(h => h.via === 'plus') || []).map(h => h.hostId));
    const defaultMethod = (plus.status === 'plus' && plus.use !== false) ? 'plus' : 'own';

    wz = {
      step: 0,
      method: defaultMethod,
      initialHostIds,
      foundHost: null,
      pollTimer: null,
      admitting: false,
      payload,
      pairing: false,
      code: '',
      error: '',
      doneName: '',
    };
    paintWizard();
  }

  function paintWizard() {
    if (!wz) { wizard.close(); return; }
    const o = { title: t('settings.remote.addHost'), step: wz.step, back: () => back() };

    if (wz.step === 0) {
      o.body = [installPcBody()];
      o.next = { onclick: () => { wz.step = 1; paintWizard(); } };
    } else if (wz.step === 1) {
      const plusSub = plus.status === 'plus'
        ? (plus.email || t('settings.remote.groups.plus'))
        : (!plus.status || plus.status === 'signedOut')
          ? t('settings.remote.wizard.plusSignedOut')
          : t('settings.remote.wizard.plusNotUsing');

      const ownHost = hosts.find(h => (h.via ?? 'own') === 'own');
      const ownSub = ownHost?.relay || 'relay.example.net';

      const items = [
        {
          key: 'plus',
          name: t('settings.remote.groups.plus'),
          sub: plusSub,
          disabled: plus.status !== 'plus',
        },
        {
          key: 'own',
          name: t('settings.remote.groups.own'),
          sub: ownSub,
          disabled: false,
        },
      ];

      const opts = methodOptions({
        current: wz.method,
        onPick: k => { wz.method = k; paintWizard(); },
        items,
      });

      o.body = [opts];
      o.next = { onclick: () => { wz.step = 2; startStep2(); paintWizard(); } };
    } else if (wz.step === 2) {
      if (wz.method === 'plus') {
        if (wz.admitting) {
          // 相手の PC の画面の承認を待つ（QR のときと同じ）
          o.body = wz.code ? [confirmCode(wz.code), waitLine(t('settings.remote.wizard.hostWait'))] : [waitLine(t('settings.remote.wizard.hostConnecting'))];
          o.next = { disabled: true };
          o.sig = [wz.method, 'admitting', wz.code];
          wizard.render(o);
          return;
        }
        const lead = el('p', 'rm-lead', t('settings.remote.wizard.plusHostWait', { switch: t('settings.remote.allow') }));
        const acctKv = keyValues([[t('settings.remote.wizard.account'), plus.email || '']]);
        const body = wz.direct ? [] : [lead, acctKv];

        if (wz.foundHost) {
          const row = el('div', 'rm-row');
          const rt = el('span', 'rm-rt');
          rt.append(el('span', 'rm-nm', wz.foundHost.name || wz.foundHost.hostId));
          const end = el('span', 'rm-end rm-ok');
          end.append(rmIcon('check'));
          row.append(rmIcon(deviceIcon(wz.foundHost)), rt, end);
          body.push(row);
        } else {
          body.push(waitLine(t('settings.remote.wizard.waitingHost')));
        }
        if (wz.error) body.push(errorLine(wz.error));
        o.body = body;
        o.next = {
          disabled: !wz.foundHost || wz.admitting,
          onclick: () => pairPlus(),
        };
        o.sig = [wz.method, Boolean(wz.foundHost), wz.foundHost?.hostId, wz.admitting, wz.error];
      } else {
        // own
        if (wz.pairing) {
          o.body = wz.code ? [confirmCode(wz.code), waitLine(t('settings.remote.wizard.hostWait'))] : [waitLine(t('settings.remote.wizard.hostConnecting'))];
          o.next = { disabled: true };
        } else {
          o.body = [field(t('settings.remote.wizard.hostCode'), wz.payload), ...(wz.error ? [errorLine(wz.error)] : [])];
          o.next = { disabled: !wz.payload.value.trim(), onclick: () => pairOwn() };
        }
        o.sig = [wz.method, wz.pairing, wz.code, wz.error];
      }
    } else {
      // step 3: 完了
      o.body = [doneBody(wz.doneName)];
      o.sig = wz.doneName;
      o.next = { label: t('settings.remote.wizard.close'), onclick: () => cancelWizard() };
    }
    wizard.render(o);
  }

  function startStep2() {
    if (wz.method === 'plus') {
      startPlusPoll();
    }
  }

  function startPlusPoll() {
    stopPlusPoll();
    const check = async () => {
      if (!wz || wz.step !== 2 || wz.method !== 'plus') return;
      const r = await bridge?.list?.({ fresh: true });
      if (!wz || wz.step !== 2) return;
      if (r?.ok && r.plus) plus = { ...plus, ...r.plus };
      const currentPlusHosts = r?.plus?.hosts || [];
      const newOnline = currentPlusHosts.find(h => !wz.initialHostIds.has(h.hostId) && h.online === true);
      if (newOnline && (!wz.foundHost || wz.foundHost.hostId !== newOnline.hostId)) {
        wz.foundHost = newOnline;
        paintWizard();
      }
    };
    check();
    if (wz) {
      wz.pollTimer = setInterval(check, 5000);
    }
  }

  function stopPlusPoll() {
    if (wz?.pollTimer) {
      clearInterval(wz.pollTimer);
      wz.pollTimer = null;
    }
  }

  async function pairPlus() {
    if (!wz || !wz.foundHost || wz.admitting) return;
    const mine = wz;
    mine.admitting = true;
    mine.code = '';
    mine.error = '';
    paintWizard();
    const r = await bridge.admit(mine.foundHost.hostId);
    mine.admitting = false;
    if (wz !== mine) return;
    if (r.ok) {
      stopPlusPoll();
      if (mine.direct) {
        wz = null;
        paintWizard();
        await openHost(mine.foundHost.hostId, { via: 'plus' });
        return;
      }
      wz.doneName = wz.foundHost.name || r.host?.name || '';
      wz.step = 3;
      await refresh();
    } else if (r.code === 'aborted') {
      if (mine.direct) { wz = null; paintWizard(); return; }
    } else {
      let msg = r.message || t('settings.remote.failed');
      if (r.code === 'blocked') msg = t('settings.remote.groups.plusBlocked');
      else if (r.code === 'limit') msg = t('settings.remote.groups.plusLimit');
      wz.error = msg;
    }
    paintWizard();
  }

  async function pairOwn() {
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
    stopPlusPoll();
    if (wz.step === 2 && wz.method === 'own' && wz.pairing) { bridge.cancelPair(); return; }
    if (wz.step === 2 && wz.method === 'plus' && wz.admitting) { bridge.cancelPair(); return; }
    if (wz.direct) { cancelWizard(); return; }
    wz.error = '';
    wz.step = Math.max(0, wz.step - 1);
    paintWizard();
  }

  function cancelWizard() {
    if (!wz) return;
    stopPlusPoll();
    if ((wz.method === 'own' && wz.pairing) || (wz.method === 'plus' && wz.admitting)) bridge.cancelPair();
    wz = null;
    paintWizard();
  }

  return {
    available: Boolean(bridge),
    sig, build, refresh, openAdd,
    startPolling, stopPolling,
    onOpen: fn => bridge?.onOpen?.(fn),
    get inDetail() { return Boolean(detailId); },
  };
}
