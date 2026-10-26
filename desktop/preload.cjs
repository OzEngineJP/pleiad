const { contextBridge, ipcRenderer } = require('electron');
// 設定 › リモート › ほかの PC へ を開く合図（ジャンプリスト・Dock・2 つ目の起動）。読み込みの直後に来ることがあるので、画面が聞く前の分も覚えておく
let hostsTabPending = false, hostsTabListener = null;
ipcRenderer.on('ply:open-remote-hosts-tab', () => { if (hostsTabListener) hostsTabListener(); else hostsTabPending = true; });
contextBridge.exposeInMainWorld('plyDesktop', {
  // 窓の上端を画面が描くので、OS ごとの違い（macOS は左に信号、ほかは右に閉じるボタン）を画面が知る
  platform: process.platform,
  setTitleBar: colors => ipcRenderer.send('ply:title-bar', colors),
  notifyCompletion: notice => ipcRenderer.invoke('ply:notify-completion', notice),
  onNotificationClick: listener => {
    const handler = (_event, sessionId) => listener(sessionId);
    ipcRenderer.on('ply:notification-click', handler);
    return () => ipcRenderer.removeListener('ply:notification-click', handler);
  },
  chooseFolder: () => ipcRenderer.invoke('ply:choose-folder'),
  // 設定 › リモート › ほかの PC へ を開かせる（前の版の名前。今は main が hosts.onOpen に合図を返すだけ）。この窓（ローカル）にだけ出す
  openRemoteHosts: () => ipcRenderer.invoke('ply:open-remote-hosts'),
  // ほかの PC へ（web/remote-hosts.mjs）: ペアリングしたホストの一覧と、貼り付けでのペアリング。手元のアプリの機能なので、この窓（ローカル）にだけ出す。
  // ローカルのサーバーの設定・操作の一覧には置かない（端末の AI が set_setting で入れられないように。ADR 0146・0239）
  hosts: {
    init: () => ipcRenderer.invoke('ply:hosts-init'),
    list: opts => ipcRenderer.invoke('ply:hosts-list', opts),
    setPlusUse: use => ipcRenderer.invoke('ply:hosts-set-plus-use', use),
    admit: hostId => ipcRenderer.invoke('ply:hosts-admit', hostId),
    pair: payload => ipcRenderer.invoke('ply:hosts-pair', payload),
    cancelPair: () => ipcRenderer.invoke('ply:hosts-pair-cancel'),
    open: (hostId, opts) => ipcRenderer.invoke('ply:hosts-open', hostId, opts),
    rename: (hostId, label, via) => ipcRenderer.invoke('ply:hosts-rename', hostId, label, via),
    remove: (hostId, via) => ipcRenderer.invoke('ply:hosts-remove', hostId, via),
    onCode: listener => {
      const handler = (_event, code) => listener(code);
      ipcRenderer.on('ply:hosts-code', handler);
      return () => ipcRenderer.removeListener('ply:hosts-code', handler);
    },
    onChange: listener => {
      const handler = (_event, hosts) => listener(hosts);
      ipcRenderer.on('ply:hosts-changed', handler);
      return () => ipcRenderer.removeListener('ply:hosts-changed', handler);
    },
    onOpen: listener => {
      hostsTabListener = () => listener();
      if (hostsTabPending) { hostsTabPending = false; listener(); }
      return () => { hostsTabListener = null; };
    },
  },
  // ホストの子の会話を、そのホストのリモートの窓で開く（承認の中継のカードの「子の会話を見る」）。この窓（ローカル）にだけ出す
  openRemoteSession: (hostId, sessionId) => ipcRenderer.invoke('ply:open-remote-session', hostId, sessionId),
  update: (action, value) => ipcRenderer.invoke('ply:update', action, value),
  // OS にサインインしたら起動する設定（desktop/login-item.cjs）。get は OS の登録を読み直した { supported, reason?, enabled, blocked }、set は登録して同じ形の状態を返す。この窓（ローカル）にだけ出す
  loginItem: {
    get: () => ipcRenderer.invoke('ply:login-item', 'get'),
    set: enabled => ipcRenderer.invoke('ply:login-item', 'set', enabled),
  },
  onUpdate: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('ply:update-state', handler);
    return () => ipcRenderer.removeListener('ply:update-state', handler);
  },
  // 内蔵ブラウザー（desktop/browser-panel.cjs、web/browser-panel.mjs）。この窓（ローカル）にだけ出す。
  // command は open・newTab・select・close・back・forward・reload・stop・devtools・external・detach・clearSiteData・freeze・unfreeze・context・state
  browser: {
    command: (action, args) => ipcRenderer.invoke('ply:browser', action, args),
    // 右パネルの本文の枠（CSS の px。窓の左上から）と、見せるかどうか
    layout: message => ipcRenderer.send('ply:browser-layout', message),
    onState: listener => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on('ply:browser-state', handler);
      return () => ipcRenderer.removeListener('ply:browser-state', handler);
    },
    // ページにフォーカスがあるときに押された開閉の近道（Ctrl+Shift+B。main の before-input-event が拾う）
    onShortcut: listener => {
      const handler = () => listener();
      ipcRenderer.on('ply:browser-shortcut', handler);
      return () => ipcRenderer.removeListener('ply:browser-shortcut', handler);
    },
  },
});
