// 設定 › リモート（docs/remote.md §3.3・§6.1・§9、ADR 0239）。2 つのタブを持つ。
//
// - この PC へ（ホスト側）: 「ほかの端末からの操作を許可する」のスイッチ 1 つ。オンのときだけ、つないだ端末の行（自分の中継サーバー）と「＋ 端末を追加」
//   - 行を押すと詳しい画面（つなぎ方・中継サーバー・許可した端末・追加した日・最後の接続・取り消す）
//   - まとまりは「Pleiad Plus（公式の中継）」「もう一度の許可が要る端末」「自分の中継サーバー」「取り消した端末」。
//     見出しのすぐ下にそれぞれの状態の一行（docs/design-system.md）。取り消した端末の行からは「一覧から消す」（鍵は PC が覚えたまま）
//   - 端末の画面（リモートの窓）では、ホストの画面だけの操作（スイッチ・中継の編集・端末を追加・承認）を出さない。取り消しはできる（ADR 0245）
//   - ＋ の流れ: アプリを入れる › つなぎ方 › つなぐ（QR かコード・確認コードで許可）。中継の URL・秘密が無ければ つなぎ方 の段で入れる。
//     完了だけの段は無く、つなぐ の段がそのまま「つなぎました」と「閉じる」に替わる。Plus は待ちながら閉じられる（承認 2026-10-21）
// - ほかの PC へ（デスクトップ版のローカルの窓だけ）: web/remote-hosts.mjs
// - 承認のダイアログ: remotePairing の request で、ホストの画面ならどこにいても出す（＋ の流れで待っている間は流れの中で聞く）
//
// 状態はサーバーが持つ（remoteStatus コマンドと、変わるたびに届く remoteStatus イベント）。リモートの窓からも この PC へ は同じ画面が見える。
// 見え方は web/manage-panel.css の .rm-*。常駐の設定は 設定 › アプリ情報・更新（web/resident-settings.mjs）。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import qrcode from './vendor/qrcode-generator.mjs';
import {
  relayHost, deviceIcon, button, iconButton, groupHead, listRow, detailHead, keyValues, switchButton, segment,
  externalLink, waitLine, confirmCode, createWizard, setText, paintInto, field, textInput, qrFigure,
  INSTALL_URL, installPcBody, methodOptions, doneBody, errorLine, stateLine, todoList, liveRow,
} from './remote-parts.mjs';
import { setupRemoteHosts } from './remote-hosts.mjs';
import { openExternalLink } from './link-open.mjs';

const RELAY_GUIDE_URL = 'https://github.com/OzEngineJP/pleiad/blob/main/relay/README.md';

/** 確認コードを 3 桁ずつに分ける（「482 193」）。6 桁でなければそのまま */
export function formatCode(code) {
  const s = String(code ?? '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** 残り時間（m:ss）。過ぎていれば 0:00 */
export function remaining(expiresAt, now = Date.now()) {
  const sec = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000) || 0);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * QR の点を 1 本の path にする。{ size, d }。size は余白（4 マス）を含む一辺のマス数。
 * 誤り訂正は M（画面から読むので汚れには強くなくてよい。そのぶん点が大きい）
 */
export function qrPath(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount(), quiet = 4;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  return { size: n + quiet * 2, d };
}

/** 端末の種類の名前。知らない値はそのまま */
export function platformName(platform) {
  const key = String(platform ?? '').toLowerCase();
  // i18n-dynamic: settings.remote.platform.
  return ['desktop', 'ios', 'android'].includes(key) ? t(`settings.remote.platform.${key}`) : String(platform ?? '');
}

/** 中継の設定（URL と秘密）がそろっていて、つながらない（「サーバーへの接続に失敗しました」） */
export function connectionFailed(status) {
  const state = status?.connection?.state;
  return status?.enabled === true && status.configured !== false && (state === 'retrying' || state === 'error');
}

/**
 * 端末の一覧の 1 行。{ name, icon, offline }。
 * 「オフライン」は許可がオンで中継にもつながっているのに、端末がつながっていないときだけ（中継につながらないときは見出しの下の一行で伝える）
 */
export function deviceRow(device, status) {
  const reachable = status?.enabled === true && (device?.via === 'plus' ? status.plus?.link?.state === 'connected' : status.connection?.state === 'connected');
  return {
    name: device.name || t('settings.remote.devices.unnamed'),
    icon: deviceIcon(device),
    offline: device?.via === 'plus' ? !device.connected : reachable && !device.connected,
  };
}

/**
 * Pleiad Plus のまとまりの見出しの下に出す状態行（表の上から最初に当たるもの）。
 * kind: login・getPlus・settings=押せる行、text=注意（太字）、off・connecting・ok=点つきの状態の一行（stateLine）。
 * スイッチを切っているときも黙らない（自分の中継サーバーがあれば、スマホはそちらでつながることを添える）
 */
export function plusRemoteLine(plusStatus, remoteStatus) {
  const s = plusStatus ?? {}, plus = remoteStatus?.plus ?? {};
  if (s.needsUpdate) return { kind: 'text', text: t('settings.plus.needsUpdate') };
  if (s.state === 'maintenance') return { kind: 'text', text: t('settings.plus.maintenance') };
  if (!s.signedIn) return { kind: 'login', text: t('settings.remote.plus.login') };
  if (s.account?.status === 'free') return { kind: 'getPlus', text: t('settings.plus.getPlus') };
  if (s.account?.status === 'disabled' || plus.link?.error?.code === 'account' || s.error?.code === 'account') return { kind: 'text', text: t('settings.remote.plus.account') };
  if (plus.host?.state === 'taken') return { kind: 'settings', text: t('settings.plus.hostTaken') };
  if (plus.connect === false) return { kind: 'off', text: remoteStatus?.relayUrl ? t('settings.remote.state.plusOff') : t('settings.remote.state.off') };
  if (plus.host?.state === 'limit' || plus.link?.error?.code === 'limit' || s.error?.code === 'limit') return { kind: 'text', text: t('settings.plus.hostLimit') };
  if (s.reachable === false || plus.link?.state === 'retrying' || plus.link?.state === 'error') return { kind: 'text', text: t('settings.remote.failed') };
  if (plus.link?.state === 'connected') {
    const where = s.account?.email;
    return { kind: 'ok', text: where ? t('settings.remote.state.connected', { where }) : t('settings.remote.state.connectedPlain') };
  }
  return { kind: 'connecting', text: t('settings.remote.plus.connecting') };
}

/** 自分の中継サーバーのまとまりの見出しの下の状態行。つながらないとき（connectionFailed）は null で、.rm-warn の一行を出す */
export function ownRemoteLine(remoteStatus) {
  if (!remoteStatus?.enabled || connectionFailed(remoteStatus)) return null;
  if (remoteStatus.configured === false || !remoteStatus.relayUrl) return { kind: 'off', text: t('settings.remote.state.notSet') };
  if (remoteStatus.connection?.state === 'connected') return { kind: 'ok', text: t('settings.remote.state.connected', { where: relayHost(remoteStatus.relayUrl) }) };
  return { kind: 'connecting', text: t('settings.remote.plus.connecting') };
}

const STATE_KINDS = new Set(['ok', 'off', 'connecting']);

/**
 * null=status の初期化前、hide=条件行、disabled=状態表示、enabled=操作可。
 * 中継が 4401 account で閉じた（link の error account）だけなら、アカウントは plus と読めているので操作可のまま
 * （切って入れ直すと、止まりを解いてつなぎ直す。docs/plus.md「Plus のつながり」）
 */
export function plusRemoteToggleMode(plusStatus, remoteStatus) {
  if (!plusStatus) return 'hide';
  const s = plusStatus;
  if (s.needsUpdate || !s.signedIn || s.account?.status === 'free') return 'hide';
  if (s.state === 'maintenance' || s.account?.status === 'disabled' || s.error?.code === 'account'
    || remoteStatus?.plus?.host?.state === 'taken') return 'disabled';
  return 'enabled';
}

/** 端末をまとまりに分ける。もう一度の許可が要る端末（reapprove）は Plus のまとまりに入れない */
export function partitionRemoteDevices(devices = []) {
  return {
    plus: devices.filter(d => d.via === 'plus' && !d.reapprove),
    reapprove: devices.filter(d => d.reapprove),
    own: devices.filter(d => d.via !== 'plus' && !d.reapprove),
  };
}

/** 取り消すと一緒に取り消される端末（その端末が許可した端末と、その先） */
export function chainedDevices(id, devices = []) {
  const out = [], seen = new Set([id]);
  for (let i = 0, ids = [id]; i < ids.length; i++) {
    for (const d of devices) {
      if (d.approvedBy !== ids[i] || seen.has(d.id)) continue;
      seen.add(d.id); ids.push(d.id); out.push(d);
    }
  }
  return out;
}

/** 「許可した端末」「取り消した端末」の値。この PC・ほかの端末の名前・分からなければ空（行を出さない） */
export function approverName(approvedBy, approvedByName) {
  if (approvedBy === 'host') return t('settings.remote.detail.thisPc');
  if (!approvedBy) return '';
  return approvedByName || t('settings.remote.devices.unnamed');
}

export const plusRemoteAvailable = plusStatus => plusStatus?.available !== false;
export const initialRemoteMethod = plusStatus => plusStatus?.account?.status === 'plus' ? 'plus' : 'own';

/**
 * @param cmd  WS コマンド
 * @param page 設定のページを切り替える（onboarding.page）
 * @param open 設定を開く（onboarding.open）。ジャンプリストから ほかの PC へ を開くとき
 */
export function setupRemote({ cmd, page, open = () => {} }) {
  const $ = id => document.getElementById(id);
  const root = $('remotePanel');
  /** 最後に届いた RemoteStatus */
  let status = null;
  let plusStatus = null;
  /** 開いているタブ（'this' | 'other'）と、詳しい画面に出している端末の id */
  let tab = 'this', detailId = '';
  /** 取り消しの確かめ中か・操作中か・画面に出す失敗 */
  let confirming = false, busy = false, message = '';
  let reviewMode = false;
  /** この画面がホストの画面か（hostCapabilities の osActions）。端末の画面ではホストの画面だけの操作を出さない */
  let hostScreen = false;
  /** 詳しい画面に出している取り消した端末の鍵 */
  let revokedKey = '';
  /** 自分の中継サーバー の「編集」で出している欄（relayInputs）。出していなければ null */
  let editing = null;

  const hosts = setupRemoteHosts({ onChange: () => paint(), cmd, page });
  hosts.onOpen?.(() => { tab = 'other'; detailId = ''; open('remote'); hosts.startPolling?.(); refresh(); });

  // ---- 描く
  function paint() {
    const sig = JSON.stringify([tab, detailId, revokedKey, confirming, busy, message, reviewMode, hostScreen, Boolean(editing), statusSig(), tab ==='other' ? hosts.sig() : '']);
    paintInto(root, sig, () => {
      if (tab === 'other' && hosts.available) {
        const view = hosts.build();
        return hosts.inDetail ? view : [tabRow(), ...view];
      }
      const device = detailId && status?.devices?.find(d => d.id === detailId);
      if (detailId && !device) detailId = '';
      const revoked = revokedKey && status?.revoked?.find(k => k.key === revokedKey);
      if (revokedKey && !revoked) revokedKey = '';
      if (device) return deviceDetail(device);
      return revoked ? revokedDetail(revoked) : [tabRow(), ...thisTab()];
    });
    paintWizard();
    paintDialog();
  }
  /** 一覧の見え方に効く状態だけ（残り時間や中継の再試行の時刻が変わっても描き直さない） */
  function statusSig() {
    if (!status) return null;
    return [status.enabled, status.configured, connectionFailed(status), status.connection?.state === 'connected',
      status.relayUrl ?? '', status.relayUrlFromEnv, status.hasEnrollSecret, status.enrollSecretFromEnv, status.storage?.encrypted, status.connection?.state,
      status.plus?.connect, status.plus?.link?.state, status.plus?.link?.error?.code, status.plus?.host?.state, status.plus?.devices, plusSignature(),
      (status.devices ?? []).map(d => [d.id, d.name, d.platform, d.connected, d.via, d.createdAt, d.agent?.active ?? 0, d.approvedBy, d.approvedByName, d.reapprove]),
      (status.revoked ?? []).map(k => [k.key, k.name, k.platform, k.via, k.revokedAt, k.by, k.byName, k.approvedBy, k.approvedByName])];
  }
  function plusSignature() {
    const s = plusStatus ?? {}, account = s.account ?? {};
    return [s.available, s.state, s.needsUpdate, s.signedIn, s.login?.phase, account.status, account.email,
      s.reachable, s.error?.code, s.urls?.account, s.host?.state];
  }

  function tabRow() {
    const row = el('div', 'rm-tabrow');
    if (hosts.available) {
      row.append(segment(t('settings.remote.tabs.label'), [['this', t('settings.remote.tabs.this')], ['other', t('settings.remote.tabs.other')]], tab,
        value => {
          tab = value; detailId = ''; revokedKey = ''; confirming = false; editing = null;
          if (value === 'other') {
            hosts.refresh();
            hosts.startPolling?.();
          } else {
            hosts.stopPolling?.();
          }
          paint();
        }));
    }
    const allowed = status?.enabled === true;
    if (tab === 'other') row.append(iconButton('plus', t('settings.remote.addHost'), () => hosts.openAdd(), 'btn rm-add'));
    else if (allowed && !reviewMode && hostScreen) row.append(iconButton('plus', t('settings.remote.addDevice'), () => openWizard(), 'btn rm-add'));
    for (const b of row.querySelectorAll('.rm-add')) b.dataset.fk = 'add';
    return row;
  }

  function thisTab() {
    const on = status?.enabled === true;
    const label = el('span', 'rm-lbl', t('settings.remote.allow'));
    const sw = switchButton(t('settings.remote.allow'), () => toggle());
    sw.id = 'remoteEnable';
    sw.dataset.fk = 'allow';
    sw.setAttribute('aria-checked', String(on));
    sw.disabled = busy || !status || !hostScreen;
    const head = el('div', 'rm-mrow');
    head.append(label, sw);
    const out = [head];
    if (message) out.push(errorLine(message));
    if (!on) return out;
    const parts = partitionRemoteDevices(status.devices);
    if (plusRemoteAvailable(plusStatus)) out.push(plusGroup(parts.plus));
    if (parts.reapprove.length) out.push(deviceGroup(t('settings.remote.groups.reapprove'), parts.reapprove));
    // 「自分の中継サーバー」のまとまりには own の端末だけを並べる。設定が無くても出し、「未設定」の一行と「編集」で入れられるようにする
    const devices = parts.own;
    const failed = connectionFailed(status);
    const group = el('section', 'rm-group');
    const gh = groupHead(t('settings.remote.groups.own'));
    if (!editing && !reviewMode && hostScreen) {
      const edit = button(t('settings.remote.relay.edit'), () => openRelayEdit(), 'rm-gh-btn');
      edit.dataset.fk = 'relayEdit';
      edit.disabled = busy;
      gh.append(edit);
    }
    group.append(gh);
    const line = ownRemoteLine(status);
    if (failed) group.append(el('p', 'rm-warn', t('settings.remote.failed')));
    else if (line) group.append(stateLine(line.kind, line.text));
    if (editing) group.append(relayEdit());
    for (const d of devices) group.append(deviceListRow(d));
    out.push(group);
    const revoked = status.revoked ?? [];
    if (revoked.length) {
      const box = el('section', 'rm-group');
      box.append(groupHead(t('settings.remote.groups.revoked')));
      for (const k of revoked) {
        box.append(listRow({ icon: deviceIcon(k), name: k.name || t('settings.remote.devices.unnamed'), sub: k.revokedAt ? dateText(k.revokedAt) : '',
          key: `revoked-${k.key}`, onclick: () => { revokedKey = k.key; confirming = false; message = ''; paint(); } }));
      }
      out.push(box);
    }
    return out;
  }

  const dateText = when => fmt.dateTime(when, { year: 'numeric', month: 'long', day: 'numeric' });
  function deviceListRow(d) {
    const view = deviceRow(d, status);
    return listRow({ icon: view.icon, name: view.name, sub: view.offline && !d.reapprove ? t('settings.remote.offline') : '', key: `device-${d.id}`,
      onclick: () => { detailId = d.id; confirming = false; message = ''; paint(); } });
  }
  function deviceGroup(title, devices) {
    const group = el('section', 'rm-group');
    group.append(groupHead(title));
    for (const d of devices) group.append(deviceListRow(d));
    return group;
  }

  function plusGroup(devices) {
    const group = el('section', 'rm-group');
    const head = groupHead(t('settings.remote.groups.plusHead'));
    const toggleMode = plusRemoteToggleMode(plusStatus, status);
    if (toggleMode !== 'hide') {
      const sw = switchButton(t('settings.remote.plus.connect'), () => run(async () => {
        status = await cmd('setRemoteSettings', { plusConnect: !(status?.plus?.connect === true) });
      }));
      sw.classList.add('rm-gh-switch');
      sw.setAttribute('aria-checked', String(status?.plus?.connect === true));
      sw.disabled = busy || !status || toggleMode === 'disabled' || !hostScreen;
      sw.dataset.fk = 'plusConnect';
      head.append(sw);
    }
    group.append(head);

    const line = plusRemoteLine(plusStatus, status);
    if (line?.kind === 'login') {
      group.append(listRow({ icon: 'monitor', name: line.text, key: 'plusLogin', onclick: () => cmd('plusLogin').catch(() => {}) }));
    } else if (line?.kind === 'getPlus') {
      group.append(listRow({ icon: 'monitor', name: line.text, key: 'plusGet', onclick: () => openExternalLink(new URL('/plus', plusStatus?.urls?.account).href) }));
    } else if (line?.kind === 'settings') {
      const row = button(line.text, () => { page('plus'); open('plus'); }, 'rm-row rm-plus-settings');
      row.dataset.fk = 'plusSettings';
      group.append(row);
    } else if (line && STATE_KINDS.has(line.kind)) group.append(stateLine(line.kind, line.text));
    else if (line) group.append(el('p', 'rm-warn', line.text));

    for (const d of devices) group.append(deviceListRow(d));
    return group;
  }

  function deviceDetail(d) {
    const view = deviceRow(d, status);
    const out = detailHead({ icon: view.icon, name: view.name, onBack: () => { detailId = ''; confirming = false; message = ''; paint(); } });
    out.push(keyValues([
      [t('settings.remote.detail.method'), d.via === 'plus' ? t('settings.remote.groups.plus') : t('settings.remote.groups.own')],
      [t('settings.remote.detail.relay'), d.via === 'plus' ? '' : relayHost(status?.relayUrl)],
      [t('settings.remote.detail.approvedBy'), d.reapprove ? '' : approverName(d.approvedBy, d.approvedByName)],
      [t('settings.remote.detail.added'), d.createdAt ? dateText(d.createdAt) : ''],
      [t('settings.remote.detail.lastSeen'), d.lastSeenAt ? fmt.relative(d.lastSeenAt) : t('settings.remote.detail.never')],
    ]));
    const acts = el('div', 'rm-acts');
    if (confirming) {
      const tasks = d.agent?.active ? ` ${t('settings.remote.devices.revokeTasks', { count: d.agent.active })}` : '';
      const ask = el('div', 'rm-confirm');
      ask.append(el('p', null, t('settings.remote.devices.revokeConfirm', { name: view.name }) + tasks));
      const chained = chainedDevices(d.id, status?.devices);
      if (chained.length) {
        const names = fmt.list(chained.map(c => t('settings.remote.devices.quoted', { name: c.name || t('settings.remote.devices.unnamed') })));
        ask.append(el('p', null, t('settings.remote.devices.revokeChain', { names })));
      }
      const keep = button(t('settings.remote.devices.keep'), () => { confirming = false; paint(); }, 'btn btn-quiet');
      keep.dataset.fk = 'keep';
      const yes = button(t('settings.remote.devices.revokeConfirmButton'), () => revoke(d), 'btn btn-primary');
      yes.dataset.fk = 'revokeYes';
      for (const b of [keep, yes]) b.disabled = busy;
      const buttons = el('div', 'rm-acts');
      buttons.append(keep, yes);
      ask.append(buttons);
      out.push(ask);
      queueMicrotask(() => { if (!root.contains(document.activeElement)) keep.focus(); });
    } else {
      const revokeButton = button(t('settings.remote.detail.revoke'), () => { confirming = true; paint(); }, 'btn btn-quiet');
      revokeButton.dataset.fk = 'revoke';
      acts.append(revokeButton);
      out.push(acts);
    }
    if (message) out.push(errorLine(message));
    return out;
  }

  /** 取り消した端末の詳しい画面。できるのは「一覧から消す」だけ（鍵は PC が覚えたまま） */
  function revokedDetail(k) {
    const name = k.name || t('settings.remote.devices.unnamed');
    const out = detailHead({ icon: deviceIcon(k), name, onBack: () => { revokedKey = ''; message = ''; paint(); } });
    out.push(keyValues([
      [t('settings.remote.detail.method'), k.via === 'plus' ? t('settings.remote.groups.plus') : t('settings.remote.groups.own')],
      [t('settings.remote.detail.approvedBy'), approverName(k.approvedBy, k.approvedByName)],
      [t('settings.remote.detail.revokedAt'), k.revokedAt ? dateText(k.revokedAt) : ''],
      [t('settings.remote.detail.revokedBy'), approverName(k.by, k.byName)],
    ]));
    const acts = el('div', 'rm-acts');
    const hide = button(t('settings.remote.detail.hideRevoked'), () => run(async () => {
      status = await cmd('remoteRevokedHide', { key: k.key });
      revokedKey = '';
    }), 'btn btn-quiet');
    hide.dataset.fk = 'hideRevoked';
    hide.disabled = busy || reviewMode;
    acts.append(hide);
    out.push(acts);
    if (message) out.push(errorLine(message));
    return out;
  }

  // ---- ＋ の流れ（この PC へ: 端末を追加）
  /**
   * wz: { step, kind: 'phone'|'pc', inputs, error, busy, offer: { payload, expiresAt } | null, starting,
   *       offerEnd: null | 'connecting' | 'expired' | 'cancelled', request, ended, doneName }
   */
  let wz = null, tick = null;
  const wizard = createWizard({ id: 'remoteAddDevice', onCancel: () => cancelWizard(), steps: ['install', 'method', 'connect'] });

  function openWizard() {
    const inputs = relayInputs();
    for (const i of Object.values(inputs)) i.oninput = () => paintWizard();
    wz = { step: 0, kind: 'phone', method: initialRemoteMethod(plusStatus), plusDeviceIds: (status?.devices ?? []).filter(d => d.via === 'plus').map(d => d.id),
      inputs, error: '', busy: false, offer: null, starting: false, offerEnd: null, request: null, ended: '', doneName: '' };
    paintWizard();
  }

  /** 中継の 3 つの欄（URL・登録用の秘密・ホスト名）。今の値を入れておく（秘密は入れない） */
  function relayInputs() {
    const relayUrl = textInput({ type: 'url', placeholder: 'https://relay.example.com', key: 'relayUrl' });
    const secret = textInput({ type: 'password', autocomplete: 'new-password', key: 'secret' });
    const hostName = textInput({ key: 'hostName' });
    relayUrl.value = status?.relayUrlFromEnv ? '' : status?.relayUrl ?? '';
    hostName.value = status?.hostName ?? '';
    return { relayUrl, secret, hostName };
  }
  /** 中継の欄を並べる（＋ の流れの「つなぎ方」と、まとまりの「編集」で同じもの） */
  function relayFields({ relayUrl, secret, hostName }) {
    relayUrl.placeholder = status?.relayUrlFromEnv ? status.relayUrl : 'https://relay.example.com';
    secret.placeholder = status?.hasEnrollSecret && !status.enrollSecretFromEnv ? t('settings.remote.relay.secretSaved') : '';
    const note = text => text ? el('small', 'rm-note', text) : null;
    const fields = el('div', 'rm-fields');
    fields.append(
      field(t('settings.remote.relay.url'), relayUrl, note(status?.relayUrlFromEnv ? t('settings.remote.relay.urlFromEnv') : '')),
      field(t('settings.remote.relay.secret'), secret, note(status?.enrollSecretFromEnv ? t('settings.remote.relay.secretFromEnv') : '')),
      field(t('settings.remote.relay.hostName'), hostName));
    const out = [fields];
    if (status?.storage?.encrypted === false) out.push(el('p', 'rm-strong', `⚠ ${t('settings.remote.relay.notEncrypted')}`));
    return out;
  }

  // ---- 自分の中継サーバー の「編集」（つながっている間も中継の設定を変えられる）
  function openRelayEdit() {
    editing = relayInputs();
    message = '';
    paint();
    queueMicrotask(() => editing?.relayUrl.focus());
  }
  function relayEdit() {
    const box = el('div', 'rm-confirm rm-relay-edit');
    const cancel = () => { editing = null; message = ''; paint(); };
    const save = () => run(async () => {
      const patch = relayPatch(editing);
      if (Object.keys(patch).length) status = await cmd('setRemoteSettings', patch);
      editing = null;
    });
    for (const i of Object.values(editing)) {
      i.onkeydown = e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      };
    }
    const no = button(t('settings.remote.wizard.cancel'), cancel, 'btn btn-quiet');
    no.dataset.fk = 'relayCancel';
    const yes = button(t('settings.remote.relay.save'), save, 'btn btn-primary');
    yes.dataset.fk = 'relaySave';
    for (const b of [no, yes]) b.disabled = busy;
    const acts = el('div', 'rm-acts');
    acts.append(no, yes);
    box.append(...relayFields(editing), acts);
    return box;
  }

  /** 保存する欄の差分。変えていない欄は送らない（秘密は空なら今の値を残す） */
  function relayPatch({ relayUrl, secret, hostName }) {
    const patch = {};
    const url = relayUrl.value.trim(), host = hostName.value.trim();
    if (url !== (status?.relayUrlFromEnv ? '' : status?.relayUrl ?? '')) patch.relayUrl = url;
    if (host && host !== (status?.hostName ?? '')) patch.hostName = host;
    if (secret.value.trim() !== '') patch.enrollSecret = secret.value.trim();
    return patch;
  }
  /** 中継の欄を出すか（URL か秘密が無い・つながらない） */
  const needRelay = () => !status?.relayUrl || !status?.hasEnrollSecret || status?.configured === false || connectionFailed(status);
  const relayReady = () => Boolean((wz.inputs.relayUrl.value.trim() || status?.relayUrl) && (wz.inputs.secret.value.trim() || status?.hasEnrollSecret));

  function paintWizard() {
    if (!wz) { wizard.close(); stopTick(); return; }
    const connected = status?.enabled === true && status.connection?.state === 'connected';
    if (wz.method === 'own' && wz.step === 2 && connected && !wz.offer && !wz.offerEnd && !wz.request && !wz.ended && !wz.starting && !wz.error && !wz.doneName) startOffer();
    const o = { title: t('settings.remote.addDevice'), step: wz.step, back: () => back() };
    if (wz.step === 0) {
      o.body = [
        segment(t('settings.remote.wizard.kind'), [['phone', t('settings.remote.wizard.phone')], ['pc', t('settings.remote.wizard.pc')]], wz.kind,
          value => { wz.kind = value; paintWizard(); }),
        ...installBody(wz.kind),
      ];
      o.sig = [wz.kind, wz.method, plusRemoteAvailable(plusStatus)];
      o.next = { onclick: () => { wz.step = 1; wz.error = ''; paintWizard(); } };
    } else if (wz.step === 1) {
      const show = needRelay();
      o.body = methodBody(show);
      o.sig = [show, wz.method, plusStatus?.account?.email, plusStatus?.signedIn, status?.relayUrl ?? '', status?.relayUrlFromEnv, status?.hasEnrollSecret, status?.enrollSecretFromEnv, status?.storage?.encrypted, wz.error, wz.busy];
      o.next = { disabled: wz.busy || (wz.method === 'own' && !relayReady()), onclick: () => wz.method === 'plus' ? startPlusConnect() : saveRelayAndConnect() };
    } else if (wz.method === 'plus') {
      // Plus の接続は つなぎ方 の「次へ」で入れてあるので、ここは待ちながらすぐ閉じられる。スマホが現れたら同じ行が「つなぎました」に替わる
      const newPlusDevice = (status?.devices ?? []).find(d => d.via === 'plus' && !wz.plusDeviceIds.includes(d.id));
      o.body = plusConnectBody(newPlusDevice);
      o.sig = [wz.method, wz.kind, plusSignature(), status?.plus?.connect, status?.plus?.link?.state,
        status?.plus?.link?.error?.code, status?.plus?.host?.state, newPlusDevice?.id, newPlusDevice?.name];
      o.closing = true;
    } else if (wz.doneName) {
      // 自分の中継サーバー: 「許可する」の後は同じ段で「つなぎました」と「閉じる」（完了だけの段を挟まない）
      o.body = [doneBody(wz.doneName)];
      o.sig = ['done', wz.doneName];
      o.closing = true;
      o.back = null;
    } else {
      o.body = connectBody(connected);
      o.sig = [wz.method, wz.kind, connected, connectionFailed(status), wz.offer?.payload ?? '', wz.offerEnd, wz.request?.id ?? '', wz.ended, wz.error, wz.busy];
      o.next = wz.request
        ? { label: t('settings.remote.wizard.approve'), disabled: wz.busy, onclick: () => approve() }
        : { disabled: true };
    }
    wizard.render(o);
    paintLeft();
  }

  /** アプリを入れる。スマホなら入れ方の QR と、ペアリングの QR ではないことの一行（Plus のときは、この後 QR を使わないことも） */
  function installBody(kind) {
    if (kind !== 'phone') return [installPcBody()];
    const box = el('div', 'rm-inst');
    const stack = el('div', 'rm-stack');
    stack.append(el('p', 'rm-lead', t('settings.remote.wizard.installPhone')), el('p', 'rm-weak', t('settings.remote.wizard.stores')));
    box.append(qrFigure(qrPath(INSTALL_URL), 112, t('settings.remote.wizard.installQrLabel')), stack);
    const out = [box, el('p', 'rm-weak', t('settings.remote.wizard.installQrNote'))];
    if (wz.method === 'plus' && plusRemoteAvailable(plusStatus)) out.push(el('p', null, t('settings.remote.wizard.plusNext')));
    return out;
  }

  /** つなぎ方: Plus または自分の中継サーバー */
  function methodBody(showRelay) {
    const methods = [{ value: 'own', label: t('settings.remote.groups.own'), sub: status?.relayUrl ? relayHost(status.relayUrl) : externalLink(t('settings.remote.wizard.relayGuide'), RELAY_GUIDE_URL) }];
    if (plusRemoteAvailable(plusStatus)) methods.unshift({ value: 'plus', label: t('settings.remote.groups.plus'), sub: plusStatus?.signedIn && plusStatus.account?.email ? plusStatus.account.email : t('settings.plus.signedOut') });
    const out = [methodOptions(methods, wz.method, value => { wz.method = value; paintWizard(); })];
    if (wz.method === 'own' && showRelay) {
      if (connectionFailed(status)) out.push(el('p', 'rm-warn', t('settings.remote.failed')));
      out.push(...relayFields(wz.inputs));
    }
    if (wz.error) out.push(errorLine(wz.error));
    return out;
  }

  async function startPlusConnect() {
    wz.busy = true; wz.error = ''; paintWizard();
    try {
      status = await cmd('setRemoteSettings', { enabled: true, plusConnect: true });
      if (!wz) return;
      wz.step = 2;
    } catch (e) { if (wz) wz.error = e.message; }
    if (wz) wz.busy = false;
    paint();
  }

  /**
   * Plus の つなぐ の段: するべきことの並び（1 アプリを入れる＝済み、2 Plus にログイン＝新しい端末が現れたら済み）と、
   * 待っている行（回る印 → チェックと「{name} をつなぎました」）。ログイン前・使えないアカウント・つながらないときはその知らせ
   */
  function plusConnectBody(newDevice) {
    const line = plusRemoteLine(plusStatus, status);
    if (line?.kind === 'getPlus') return [listRow({ icon: 'monitor', name: line.text, key: 'plusGet', onclick: () => openExternalLink(new URL('/plus', plusStatus?.urls?.account).href) })];
    if (line && line.kind !== 'login' && !STATE_KINDS.has(line.kind)) return [el('p', 'rm-warn', line.text)];
    if (!plusStatus?.signedIn) {
      const acts = el('div', 'rm-acts');
      acts.append(button(t('settings.remote.plus.loginButton'), () => cmd('plusLogin').catch(() => {}), 'btn btn-primary'));
      return [el('p', 'rm-lead', t('settings.remote.plus.signingIn')), acts];
    }
    const who = wz.kind === 'phone' ? 'phone' : 'pc';
    const name = newDevice ? newDevice.name || t('settings.remote.devices.unnamed') : '';
    const todo = todoList([
      // i18n-dynamic: settings.remote.plus.todo.install.
      { text: t(`settings.remote.plus.todo.install.${who}`), done: true },
      // i18n-dynamic: settings.remote.plus.todo.login.
      { text: t(`settings.remote.plus.todo.login.${who}`), sub: plusStatus.account?.email ?? '', done: Boolean(newDevice) },
    ]);
    // i18n-dynamic: settings.remote.plus.waiting.
    return [todo, liveRow(newDevice ? { ok: true, text: t('settings.remote.wizard.done', { name }) } : { ok: false, text: t(`settings.remote.plus.waiting.${who}`) })];
  }

  function connectBody(connected) {
    if (wz.error) return [errorLine(wz.error), againButton()];
    if (wz.request) {
      const name = wz.request.name || t('settings.remote.devices.unnamed');
      return [el('p', 'rm-lead', t('settings.remote.wizard.confirm', { name })), confirmCode(formatCode(wz.request.code))];
    }
    if (wz.ended) return [el('p', null, wz.ended), againButton()];
    if (!connected) return [connectionFailed(status) ? el('p', 'rm-warn', t('settings.remote.failed')) : waitLine(t('settings.remote.wizard.connecting'))];
    if (wz.offerEnd === 'connecting') return [waitLine(t('settings.remote.pair.connecting'))];
    if (wz.offerEnd === 'expired' || wz.offerEnd === 'cancelled') return [el('p', null, t('settings.remote.pair.expired')), againButton()];
    if (!wz.offer) return [waitLine(t('settings.remote.wizard.connecting'))];
    const left = el('p', 'rm-weak rm-left');
    const warn = el('p', 'rm-strong', `⚠ ${t('settings.remote.fullAccess')}`);
    if (wz.kind === 'phone') {
      const box = el('div', 'rm-inst');
      const stack = el('div', 'rm-stack');
      stack.append(el('p', 'rm-lead', t('settings.remote.wizard.scan')), left);
      box.append(qrFigure(qrPath(wz.offer.payload), 152, t('settings.remote.pair.qrLabel')), stack);
      return [box, warn];
    }
    const code = el('div', 'rm-code');
    const value = el('span', 'rm-code-v', wz.offer.payload);
    const copy = iconButton('copy', t('settings.remote.wizard.copy'), () => copyPayload(copy, value), 'btn btn-quiet');
    copy.dataset.fk = 'copy';
    code.append(value, copy);
    return [el('p', 'rm-lead', t('settings.remote.wizard.paste')), code, left, warn];
  }
  function againButton() {
    const b = button(t('settings.remote.pair.again'), () => { wz.ended = ''; wz.error = ''; wz.offerEnd = null; wz.offer = null; paintWizard(); }, 'btn btn-quiet');
    b.dataset.fk = 'again';
    const row = el('div', 'rm-acts');
    row.append(b);
    return row;
  }

  function paintLeft() {
    if (!wz?.offer || wz.offerEnd || wz.step !== 2 || wz.doneName) { stopTick(); return; }
    if (!tick) tick = setInterval(paintLeft, 1000);
    if (Date.parse(wz.offer.expiresAt) <= Date.now()) { wz.offerEnd = 'expired'; stopTick(); paintWizard(); return; }
    setText(wizard.dialog, '.rm-left', t('settings.remote.wizard.left', { time: remaining(wz.offer.expiresAt) }));
  }
  function stopTick() { clearInterval(tick); tick = null; }

  async function saveRelayAndConnect() {
    const patch = relayPatch(wz.inputs);
    if (!Object.keys(patch).length && !connectionFailed(status)) { wz.step = 2; paintWizard(); return; }
    wz.busy = true; wz.error = ''; paintWizard();
    try {
      status = await cmd('setRemoteSettings', { ...patch, enabled: true });
      if (!wz) return;
      wz.inputs.secret.value = '';
      wz.step = 2;
    } catch (e) { if (wz) wz.error = e.message; }
    if (wz) wz.busy = false;
    paint();
  }
  async function startOffer() {
    wz.starting = true;
    const mine = wz;
    try {
      const r = await cmd('remotePairingStart');
      if (wz !== mine || wz.step !== 2) { cmd('remotePairingCancel').catch(() => {}); return; }
      wz.offer = { payload: r.payload, expiresAt: r.expiresAt };
      wz.offerEnd = null;
    } catch (e) { if (wz === mine) wz.error = e.message; }
    finally { mine.starting = false; }
    paintWizard();
  }
  function cancelOffer() {
    if (wz?.offer && !wz.offerEnd) cmd('remotePairingCancel').then(s => { status = s; paint(); }).catch(() => {});
    if (wz) { wz.offer = null; wz.offerEnd = null; }
  }
  function back() {
    if (!wz || wz.busy) return;
    if (wz.step === 2 && wz.request) {
      // 確かめの段から戻る: 断って、QR かコードの面に戻す（作り直す）
      deny(wz.request);
      wz.request = null;
      wz.offer = null; wz.offerEnd = null;
      paintWizard();
      return;
    }
    if (wz.step === 2) cancelOffer();
    wz.ended = ''; wz.error = '';
    wz.step = Math.max(0, wz.step - 1);
    paintWizard();
  }
  function cancelWizard() {
    if (!wz) return;
    if (wz.request && wz.step === 2) deny(wz.request);
    cancelOffer();
    wz = null;
    paint();
  }
  async function approve() {
    const request = wz.request;
    wz.busy = true; paintWizard();
    try {
      const device = await cmd('remotePairingApprove', { id: request.id });
      dropRequest(request.id);
      if (!wz) return;
      wz.doneName = device?.name || request.name || t('settings.remote.devices.unnamed');
      wz.request = null;
    } catch (e) { if (wz) wz.error = e.message; }
    if (wz) wz.busy = false;
    paint();
  }
  function deny(request) {
    dropRequest(request.id);
    cmd('remotePairingDeny', { id: request.id }).then(s => { if (s) status = s; paint(); }).catch(() => {});
  }
  function dropRequest(id) {
    if (status?.pairing) status = { ...status, pairing: { ...status.pairing, requests: status.pairing.requests.filter(r => r.id !== id) } };
  }
  async function copyPayload(b, value) {
    const label = b.lastChild;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(wz?.offer?.payload ?? '');
      label.textContent = t('settings.remote.pair.copied');
    } catch {
      // コピーできないときは文字列を選んでおく（手でコピーできる）
      const range = document.createRange(); range.selectNodeContents(value); getSelection().removeAllRanges(); getSelection().addRange(range);
      label.textContent = t('settings.remote.pair.copyFailed');
    }
    clearTimeout(b.resetTimer);
    b.resetTimer = setTimeout(() => { label.textContent = t('settings.remote.wizard.copy'); }, 1800);
  }

  // ---- 承認のダイアログ（どの画面にいても出す。＋ の流れで QR・コードを出している間は流れの中で聞く）
  const dialog = document.createElement('dialog');
  dialog.className = 'rm-dialog';
  dialog.id = 'remotePairDialog';
  dialog.setAttribute('aria-labelledby', 'remotePairTitle');
  document.body.append(dialog);
  /** ダイアログに出している承認待ちの id */
  let asking = '';
  dialog.addEventListener('cancel', e => e.preventDefault());   // Esc で黙って閉じない（決めるまで残す）

  function paintDialog() {
    // 承認はホストの画面だけ（端末の画面からの許可は host_only で断られる）
    const requests = hostScreen ? status?.pairing?.requests ?? [] : [];
    // ＋ の流れが入場券を出して待っているなら、届いた求めは流れの中で聞く
    if (wz?.step === 2 && !wz.request && !wz.doneName && (wz.offer || wz.offerEnd === 'connecting') && requests.length) {
      wz.request = requests.at(-1); wz.offer = null; wz.offerEnd = null;
      paintWizard();
    }
    const current = requests.find(r => r.id === asking && r.id !== wz?.request?.id) ?? requests.find(r => r.id !== wz?.request?.id);
    if (!current) {
      asking = '';
      if (dialog.open) dialog.close();
      return;
    }
    if (current.id === asking && dialog.open) return;
    asking = current.id;
    const name = current.name || t('settings.remote.devices.unnamed');
    const kind = el('p', 'rm-dialog-kind');
    kind.append(el('span', 'card-kind', `◆ ${t('settings.remote.approve.mark')}`));
    // もう一度の許可（移行で止めた Plus の端末）は題を変え、前に追加した日を添える
    // i18n-dynamic: settings.remote.approve.title
    const title = el('h2', null, t(current.again ? 'settings.remote.approve.titleAgain' : 'settings.remote.approve.title', { name }));
    title.id = 'remotePairTitle';
    const codeLabel = el('p', 'rm-dialog-label', t('settings.remote.approve.codeLabel'));
    const code = el('p', 'rm-dialog-code', formatCode(current.code));
    const meta = [platformName(current.platform), current.app, current.via === 'plus' ? t('settings.remote.groups.plus') : '',
      current.again && current.addedAt ? t('settings.remote.approve.addedOn', { date: dateText(current.addedAt) }) : ''].filter(Boolean).join(' · ');
    const state = el('p', 'mp-state rm-dialog-state');
    state.setAttribute('role', 'status');
    const deny = button(t('settings.remote.approve.deny'), () => decide(current, false, state), 'btn btn-quiet');
    const approve = button(t('settings.remote.approve.approve'), () => decide(current, true, state), 'btn btn-primary');
    const actions = el('div', 'rm-dialog-actions');
    actions.append(deny, approve);
    dialog.replaceChildren(kind, title, ...(meta ? [el('p', 'rm-dialog-meta', meta)] : []), codeLabel, code,
      el('p', 'rm-dialog-hint', t('settings.remote.approve.hint')), el('p', 'rm-dialog-hint', `⚠ ${t('settings.remote.fullAccess')}`), state, actions);
    if (!dialog.open) dialog.showModal();
    deny.focus();   // 既定の居場所は「拒否」（Enter の押し間違いで許可しない）
  }
  async function decide(request, yes, state) {
    for (const b of dialog.querySelectorAll('button')) b.disabled = true;
    try {
      await cmd(yes ? 'remotePairingApprove' : 'remotePairingDeny', { id: request.id });
      dropRequest(request.id);
      asking = '';
      paint();
    } catch (e) {
      state.textContent = e.message;
      for (const b of dialog.querySelectorAll('button')) b.disabled = false;
    }
  }

  // ---- 操作
  /** 操作を 1 つずつ。失敗の理由は画面の一行に出す */
  async function run(fn) {
    if (busy) return;
    // 操作の間は押したスイッチも disabled になってフォーカスが外れる。終わったら同じものへ戻す（キーボードで続けて操作できるように）
    const fk = root.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    busy = true; message = ''; paint();
    try { await fn(); }
    catch (e) { message = e.message; }
    finally {
      busy = false; paint();
      if (fk && !root.contains(document.activeElement)) root.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
    }
  }
  function toggle() {
    const next = !(status?.enabled === true);
    editing = null;
    return run(async () => { status = await cmd('setRemoteSettings', { enabled: next }); });
  }
  function revoke(device) {
    return run(async () => {
      status = await cmd('remoteRevoke', { id: device.id });
      confirming = false;
      detailId = '';
    });
  }

  // ---- サーバーから
  async function refresh() {
    // 開いたときに account も読み直す（30 秒に 1 回まで。中継の 4401 account の止まりは、読めて plus なら解ける）
    try { [status, plusStatus] = await Promise.all([cmd('remoteStatus'), cmd('plusStatus', { refresh: true })]); }
    catch (e) { message = e.message; }
    paint();
  }
  function event(ev) {
    if (ev.type === 'plusStatus') {
      plusStatus = ev.status ?? plusStatus;
      paint();
      return;
    }
    if (ev.type === 'remoteStatus') {
      status = ev.status ?? status;
      // 表示中の QR の入場券が無くなった。期限なら「作り直す」、ほかの画面で取り下げたなら同じく作り直せるようにする
      // （使われたときは先に remotePairing の connecting が届いている）
      if (wz?.offer && !wz.offerEnd && !status?.pairing?.offer) wz.offerEnd = Date.parse(wz.offer.expiresAt) <= Date.now() + 1000 ? 'expired' : 'cancelled';
      paint();
      return;
    }
    if (ev.type === 'remotePairing') {
      if (ev.phase === 'connecting' && wz?.offer) wz.offerEnd = 'connecting';
      if (ev.phase === 'request' && status && ev.request && !status.pairing.requests.some(r => r.id === ev.request.id)) {
        status = { ...status, pairing: { ...status.pairing, requests: [...status.pairing.requests, ev.request] } };
      }
      if (ev.phase === 'expired' && !ev.request && wz?.offer && !wz.offerEnd) wz.offerEnd = 'expired';
      // 流れの中で聞いていた求めが、許可する前に終わった（端末が切れた・期限）
      if (wz?.request && ev.request?.id === wz.request.id && (ev.phase === 'cancelled' || ev.phase === 'expired')) {
        wz.request = null;
        wz.ended = ev.phase === 'cancelled' ? t('settings.remote.approve.cancelled') : t('settings.remote.approve.expired');
      }
      if (ev.request && ev.phase !== 'request') dropRequest(ev.request.id);
      paint();
    }
  }

  $('remoteTab').onclick = () => { page('remote'); refresh(); };
  paint();
  return {
    refresh, event, get status() { return status; },
    setReviewMode(on) { reviewMode = on === true; paint(); },
    setHostScreen(on) { hostScreen = on === true; paint(); },
  };
}
