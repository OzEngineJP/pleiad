const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { t } = require('./i18n.cjs');

/**
 * Microsoft Store の版か。Store 用の設定（electron-builder.store.cjs）が package.json に plyStore: true を焼き込む。
 * MSIX のパッケージとして動いていれば Electron の process.windowsStore も立つ（docs/microsoft-store.md「自動更新」）
 */
function isStoreBuild({ pkg, windowsStore }) { return pkg?.plyStore === true || windowsStore === true; }
/**
 * electron-updater で自動更新するか。release 設定の配布版（plyRelease と更新フィードの app-update.yml）だけ。
 * Store の版は Store が更新するので、フィードがあっても使わない（MSIX の入れ先は読み取り専用で、electron-updater では更新できない）
 */
function updaterEnabled({ packaged, pkg, windowsStore, feed }) {
  return Boolean(packaged && !isStoreBuild({ pkg, windowsStore }) && pkg?.plyRelease === true && feed);
}

// No Electron dependency: the state machine is tested with a fake updater.
class Updates extends EventEmitter {
  constructor({ updater, version, file, enabled, install, prepareCheck = async () => {}, store = false }) {
    super();
    enabled = enabled && !store;
    Object.assign(this, { updater, version, file, enabled, install, prepareCheck });
    this.authenticated = false;
    this.state = { version, enabled, store, phase: enabled ? 'idle' : 'unavailable', channel: version.includes('-') ? 'beta' : 'stable', autoCheck: true, autoDownload: true, notice: false, lastChecked: null, previousVersion: null, releases: [] };
    this.busy = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    // 準備済みの更新があるときの確認（recheck）では、同じ版なら準備済みのまま置き、より新しい版だけを知らせる
    updater.on('update-available', info => this.recheck === info.version ? undefined : this.patch({ phase: 'available', target: info.version, notes: notesText(info.releaseNotes), releases: releaseList(info.plyReleases), progress: null, error: null }));
    updater.on('update-not-available', () => this.recheck ? undefined : this.patch({ phase: 'current', target: null, notes: '', releases: [], error: null }));
    updater.on('download-progress', p => this.patch({ phase: 'downloading', progress: Math.round(p.percent) }));
    updater.on('update-downloaded', () => this.patch({ phase: 'downloaded', progress: 100, error: null }));
    updater.on('error', e => {
      // The install lifecycle restores the downloaded state and releases its lock.
      if (this.state.phase !== 'installing' && !this.recheck) this.patch({ phase: 'error', error: updateError(e, this.authenticated) });
    });
  }
  snapshot() { return { ...this.state }; }
  patch(value) { Object.assign(this.state, value); this.emit('state', this.broadcast()); }
  /**
   * 画面へ送る状態。途中の版のノート（releases。本文で数百 KB になりうる）は、前に送ったものと同じなら外す。
   * ダウンロードの進みは何度も通知するので、毎回は送らない。画面は外れていたら前に受けた一覧を保つ（web/updates.mjs の paint）
   */
  broadcast() {
    const snapshot = this.snapshot();
    if (this.sentReleases === snapshot.releases) delete snapshot.releases;
    else this.sentReleases = snapshot.releases;
    return snapshot;
  }
  async init() {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(t('update.settingsReadFailed')); }
    this.state.channel = ['stable', 'beta'].includes(saved.channel) ? saved.channel : this.state.channel;
    this.state.autoDownload = saved.autoDownload !== false;
    this.state.autoCheck = saved.autoCheck !== false;
    this.state.notice = Boolean(saved.lastVersion && saved.lastVersion !== this.version);
    // 更新した直後の画面が「前の版からの変更」を出すために、前に入っていた版を次の更新まで覚えておく。
    // lastVersion は毎回の起動で今の版に書き換わるので、別の欄に写す。同じ版のまま再起動したときは前の記録を保つ
    const previous = saved.lastVersion && saved.lastVersion !== this.version ? saved.lastVersion : saved.previousVersion;
    this.state.previousVersion = typeof previous === 'string' && previous !== this.version ? previous : null;
    this.applyChannel();
    await this.save();
    return this.snapshot();
  }
  applyChannel() {
    this.updater.channel = this.state.channel === 'beta' ? 'beta' : 'latest';
    this.updater.allowPrerelease = this.state.channel === 'beta';
    // Setting channel enables downgrade in electron-updater: always override it.
    this.updater.allowDowngrade = false;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file + '.tmp', JSON.stringify({ channel: this.state.channel, autoCheck: this.state.autoCheck, autoDownload: this.state.autoDownload, lastVersion: this.version, previousVersion: this.state.previousVersion }));
    await fs.rename(this.file + '.tmp', this.file);
  }
  /**
   * 自動の確認。前回の確認（手動も含む）から minGap ミリ秒たっていなければ何もしない。
   * 失敗は state.error に出るので、ここでは投げない
   */
  async auto(minGap = 0) {
    // 見つけた版を利用者の操作待ちで出している間は確認し直さない（案内が一瞬消える）
    if (!this.enabled || !this.state.autoCheck || this.busy || this.state.phase === 'available') return false;
    if (this.lastAttempt && Date.now() - this.lastAttempt < minGap) return false;
    try { await this.command('check'); } catch { /* state に出ている */ }
    return true;
  }
  async command(action, value) {
    if (action === 'status') return this.snapshot();
    if (this.busy) throw new Error(t('update.busy'));
    this.busy = true;
    try {
      if (action === 'dismiss') { this.patch({ notice: false }); return this.snapshot(); }
      if (action === 'preferences') {
        if (!['stable', 'beta'].includes(value?.channel) || typeof value.autoDownload !== 'boolean' || typeof value.autoCheck !== 'boolean') throw new Error(t('update.invalidSettings'));
        if (['downloaded', 'downloading', 'installing'].includes(this.state.phase)) throw new Error(t('update.applyDownloadedFirst'));
        const previous = this.snapshot();
        Object.assign(this.state, { channel: value.channel, autoCheck: value.autoCheck, autoDownload: value.autoDownload });
        try { await this.save(); } catch (e) { this.state = previous; throw e; }
        this.applyChannel();
        this.patch({ phase: this.enabled ? 'idle' : 'unavailable', target: null, notes: '', releases: [], error: null });
      } else {
        if (!this.enabled) throw new Error(t('update.unavailable'));
        if (action === 'check') {
          // ダウンロード済みでも確認は続ける。その後に出た新しい版を見逃さないため。
          // 確認に失敗しても、準備済みの更新はそのまま適用できる
          const ready = this.state.phase === 'downloaded' ? this.state.target : null;
          this.lastAttempt = Date.now();
          if (!ready) this.patch({ phase: 'checking', error: null });
          this.recheck = ready;
          try {
            this.authenticated = (await this.prepareCheck())?.authenticated === true;
            await this.updater.checkForUpdates();
          } catch (e) {
            if (ready && this.state.phase === 'downloaded') return this.snapshot();
            throw e;
          } finally { this.recheck = null; }
          this.patch({ lastChecked: new Date().toISOString() });
          if (this.state.phase === 'available' && this.state.autoDownload) await this.download();
        } else if (action === 'download') {
          if (this.state.phase !== 'available') throw new Error(t('update.checkFirst'));
          await this.download();
        } else if (action === 'install') {
          if (this.state.phase !== 'downloaded') throw new Error(t('update.notDownloaded'));
          this.patch({ phase: 'installing', error: null });
          try { await this.install(); }
          catch (e) { this.patch({ phase: 'downloaded', error: e.message }); throw e; }
        } else throw new Error(t('update.unknownAction'));
      }
      return this.snapshot();
    } catch (e) {
      if (['checking', 'downloading', 'error'].includes(this.state.phase)) this.patch({ phase: 'error', error: updateError(e, this.authenticated) });
      throw e;
    } finally { this.busy = false; }
  }
  async download() { this.patch({ phase: 'downloading', progress: 0 }); await this.updater.downloadUpdate(); }
}
// authenticated: この確認でトークンを付けたか。認証なしの 403/429 はレート制限（1 IP で 1 時間 60 回）
function updateError(error, authenticated = false) {
  const status = error?.statusCode;
  if (authenticated && [401, 403].includes(status)) return t('update.authFailed');
  if (status === 429 || (!authenticated && status === 403)) return authenticated ? t('update.rateLimitedAuth') : t('update.rateLimited');
  if (['ERR_UPDATER_INVALID_SIGNATURE', 'ERR_CHECKSUM_MISMATCH', 'ERR_UPDATER_NO_CHECKSUM'].includes(error?.code)) return t('update.verifyFailed');
  return t('update.networkFailed');
}
// 途中の版のノート（update-auth.cjs の notesBetween）。形の合うものだけを通し、件数・題・本文の長さを切る（一覧の 1 ページ = 100 件）
const RELEASES_LIMIT = 100, VERSION_LIMIT = 64, DATE_LIMIT = 32, TITLE_LIMIT = 200, BODY_LIMIT = 4000, BODIES_LIMIT = 100000;
function releaseList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let total = 0;
  for (const r of list) {
    if (!r || typeof r.version !== 'string' || typeof r.body !== 'string') continue;
    if (out.length >= RELEASES_LIMIT) break;
    const body = r.body.slice(0, BODY_LIMIT);
    total += body.length;
    if (total > BODIES_LIMIT) break;
    out.push({ version: r.version.slice(0, VERSION_LIMIT), date: String(r.date ?? '').slice(0, DATE_LIMIT), title: String(r.title ?? '').slice(0, TITLE_LIMIT), body });
  }
  return out;
}
function notesText(notes) {
  return (typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.map(n => `${n.version}\n${n.note || ''}`).join('\n\n') : '').slice(0, 30000);
}
module.exports = { Updates, notesText, isStoreBuild, updaterEnabled, releaseList };
