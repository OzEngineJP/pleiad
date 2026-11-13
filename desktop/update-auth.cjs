const fs = require('node:fs/promises');
const path = require('node:path');
const { run } = require('./process.cjs');
const { parse } = require('yaml');

/** execFile の形（失敗は投げる）。中は core/process.mjs の run()（ADR 0270 の規則 ①） */
async function runFile(command, args, options) {
  const result = await run(command, args, options);
  if (result.startError) throw Object.assign(new Error(result.startError), { code: result.startCode ?? 'SPAWN', stdout: result.stdout, stderr: result.stderr });
  if (result.timedOut) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stdout: result.stdout, stderr: result.stderr });
  if (result.exitCode !== 0) throw Object.assign(new Error(`${command} exited ${result.exitCode}`), { code: result.exitCode ?? 'EXIT', stdout: result.stdout, stderr: result.stderr });
  return { stdout: result.stdout, stderr: result.stderr };
}

// 配布先は public なので、トークンが無くても更新は取れる（認証なしは 1 IP で 1 時間 60 回まで）。
// トークンがあればレート制限を避けるために使う。取れなければ null を返す。
async function resolveGitHubToken({ env = process.env, run = runFile, platform = process.platform } = {}) {
  // Credentials stay in Electron main memory: never save them in update
  // preferences, the renderer, package metadata, or the server environment.
  const existing = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (existing?.trim()) return existing.trim();
  const commands = ['gh'];
  if (platform === 'win32') {
    if (env.ProgramFiles) commands.push(path.join(env.ProgramFiles, 'GitHub CLI', 'gh.exe'));
    if (env.LOCALAPPDATA) commands.push(path.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'));
  }
  for (const command of commands) {
    try {
      const { stdout } = await run(command, ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true, env,
      });
      if (stdout.trim()) return stdout.trim();
    } catch { /* CLI errors can contain credentials; never forward them. */ }
  }
  return null;
}

// electron-updater は /releases の先頭のプレリリースをそのまま最新とみなす。GitHub はこの一覧を
// タグ名の文字列順で返すため v0.1.0-beta.9 が beta.11 より前に来て、beta.10 以降が見えなくなる。
// プレリリースも含めて探すときは、版番号を semver で比べて一番新しいものを選ぶ。
function newestReleaseProvider() {
  const updaterDir = path.dirname(require.resolve('electron-updater/package.json'));
  const semver = require(require.resolve('semver', { paths: [updaterDir] }));
  const { PrivateGitHubProvider } = require('electron-updater/out/providers/PrivateGitHubProvider');
  return class NewestReleaseProvider extends PrivateGitHubProvider {
    constructor(options, updater, runtimeOptions) { super(options, updater, options.token || null, runtimeOptions); }
    // トークンが無いときは authorization を付けない（`token undefined` を送ると 401 になる）。
    configureHeaders(accept) {
      return this.token ? super.configureHeaders(accept) : { accept };
    }
    // インストーラーと blockmap は API の資産の URL（/releases/assets/<番号>）ではなく、公開の配布の URL
    // （/releases/download/v<版>/<名前>）から取る。資産の URL は名前を含まないので、electron-updater が
    // CPU に合う Pleiad-<版>-win-x64.exe を選べず一覧の先頭の両方入り（2 倍の大きさ）を取り、blockmap の URL も
    // 作れずに差分の取得が毎回失敗して全体を取っていた（0.8.0）。配布の URL は API の回数の上限にも数えられない
    resolveFiles(updateInfo) {
      const files = super.resolveFiles(updateInfo).map(file => {
        const name = path.posix.basename(file.info.url).replace(/ /g, '-');
        const asset = updateInfo.assets.find(it => it?.name === name);
        return asset?.browser_download_url ? { ...file, url: new URL(asset.browser_download_url) } : file;
      });
      this.fileSizes = new Map(files.map(file => [file.url.href, file.info.size]));
      return files;
    }
    // 差分の元は、前回の更新で取って手元に残したインストーラー（installer.exe）。0.8.0 までの版は両方入りを取っていたので、
    // それが残っていれば、前の版の blockmap も両方入りのものを使う（中の x64 の部分がそのまま使え、取る量は変わらない）。
    // 違う blockmap と組むと、組み上げた後の検査で落ちて全体を取り直す
    async getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl = null) {
      const [oldUrl, newUrl] = await super.getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl);
      const archName = `-${process.arch}.exe.blockmap`;
      const cacheDir = this.updater.downloadedUpdateHelper?.cacheDir;
      // electron-updater は、落とした版の blockmap を cacheDir/current.blockmap に写し、次の差分で「前の版の blockmap」に使う。
      // だが installer.exe（差分の元）は、更新を入れて初めて入っている版に替わる。入れないまま次の版が出ると、
      // 最後に落とした版の blockmap と入っている版のインストーラーという食い違った組になり、組み上げた後の検査で落ちて
      // 全体を取り直していた。写しは使わせず（消すと取り直す）、入っている版の blockmap を配布の URL から取らせる（約 0.17 MB）。
      // Mac の zip（update.zip）の差分も同じ仕組みなので、この早期 return より前で消す
      if (cacheDir) await fs.rm(path.join(cacheDir, 'current.blockmap'), { force: true }).catch(() => {});
      if (!oldUrl.pathname.endsWith(archName) || !cacheDir) return [oldUrl, newUrl];
      // 両方入りは片方だけの約 2 倍の大きさなので、新しいインストーラーとの大きさの比で見分ける
      const newSize = this.fileSizes?.get(baseUrl.href);
      const cachedSize = await fs.stat(path.join(cacheDir, 'installer.exe')).then(s => s.size, () => 0);
      if (!newSize || cachedSize < newSize * 1.5) return [oldUrl, newUrl];
      const combined = new URL(oldUrl);
      combined.pathname = oldUrl.pathname.slice(0, -archName.length) + '.exe.blockmap';
      return [combined, newUrl];
    }
    // 配布先は public なので、取るときにトークンは送らない
    get fileExtraDownloadHeaders() {
      return { accept: 'application/octet-stream' };
    }
    // GitHub の配信は複数の範囲をまとめた要求に 501 を返す。差分は範囲を 1 つずつ取る（標準の GitHubProvider と同じ）
    get isUseMultipleRangeRequest() {
      return false;
    }
    // 見つけた版に、入っている版からの途中の版のノートを添える（画面の「新しいバージョン」の一覧）。
    // 一覧が取れなかったときは何も添えず、画面は見つけた版のノートだけを出す（確認は失敗させない）
    async getLatestVersion() {
      this.releaseList = null;
      const result = await super.getLatestVersion();
      const current = this.updater.currentVersion?.version;
      const releases = current ? notesBetween(this.releaseList, current, result.version, semver) : [];
      if (releases.length) result.plyReleases = releases;
      return result;
    }
    async getLatestVersionInfo(cancellationToken) {
      const json = 'application/vnd.github.v3+json';
      const listUrl = new URL(`${this.basePath}?per_page=100`, this.baseUrl);
      // 標準の実装は失敗を包み直して HTTP の状態コードを落とすので、状態コードでエラー文を分けられるよう自前で取る
      if (!this.updater.allowPrerelease) {
        const url = new URL(`${this.basePath}/latest`, this.baseUrl);
        const latest = JSON.parse(await this.httpRequest(url, this.configureHeaders(json), cancellationToken));
        // 正式な版だけを受ける利用者にも、途中の先行版のノートを見せるので、一覧も取る。失敗しても更新の確認は続ける
        try { this.releaseList = JSON.parse(await this.httpRequest(listUrl, this.configureHeaders(json), cancellationToken)); } catch { this.releaseList = null; }
        return latest;
      }
      const list = JSON.parse(await this.httpRequest(listUrl, this.configureHeaders(json), cancellationToken));
      this.releaseList = list;
      return newestRelease(list, semver);
    }
  };
}

const NOTE_LIMIT = 4000, NOTES_LIMIT = 100000;
/**
 * GitHub の Releases の一覧から、from < 版 ≤ to の版のノートを新しい順で作る。
 * 本文は配布時に作った「# Pleiad 版 / 日付 · 題 / 見出しと箇条書き」の形（scripts/release-info.mjs）。先頭の 2 つを題と日付に分ける。
 * 本文は信用できない入力なので、ここでは文字数を切るだけで、画面が renderMarkdown を通して出す
 */
function notesBetween(list, from, to, semver) {
  if (!Array.isArray(list) || !semver.valid(from) || !semver.valid(to)) return [];
  const out = [];
  let total = 0;
  const entries = list.filter(release => release && !release.draft && semver.valid(String(release.tag_name ?? '').replace(/^v/, '')))
    .map(release => ({ release, version: semver.valid(String(release.tag_name).replace(/^v/, '')) }))
    .filter(({ version }) => semver.gt(version, from) && semver.lte(version, to))
    .sort((a, b) => semver.rcompare(a.version, b.version));
  for (const { release, version } of entries) {
    let body = typeof release.body === 'string' ? release.body.replace(/\r\n/g, '\n').trim() : '';
    let date = typeof release.published_at === 'string' ? release.published_at.slice(0, 10) : '';
    let title = typeof release.name === 'string' ? release.name : '';
    const head = /^# [^\n]*\n+(\d{4}-\d{2}-\d{2}) · ([^\n]*)(?:\n+|$)/.exec(body);
    if (head) { date = head[1]; title = head[2]; body = body.slice(head[0].length); }
    body = body.slice(0, NOTE_LIMIT);
    total += body.length;
    if (total > NOTES_LIMIT) break;
    out.push({ version, date, title, body });
  }
  return out;
}

function newestRelease(list, semver) {
  const version = release => semver.valid(String(release.tag_name ?? '').replace(/^v/, ''));
  const newest = list.filter(release => !release.draft && version(release))
    .sort((a, b) => semver.rcompare(version(a), version(b)))[0];
  if (newest) return newest;
  const error = new Error('No release found');
  error.code = 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND';
  throw error;
}

async function prepareUpdateCheck(updater, configFile, authOptions) {
  const config = parse(await fs.readFile(configFile, 'utf8'));
  if (config.provider !== 'github' || config.private !== true) return;
  // Only the GitHub host for which we resolve authentication may receive it.
  if (config.host && config.host !== 'github.com') throw new Error('Unsupported private update host');
  const token = await resolveGitHubToken(authOptions);
  updater.setFeedURL({ ...config, token, provider: 'custom', updateProvider: newestReleaseProvider() });
  // 呼び出し側がエラー文を分けるための印。トークンそのものは返さない。
  return { authenticated: Boolean(token) };
}

module.exports = { resolveGitHubToken, prepareUpdateCheck, newestRelease, notesBetween };
