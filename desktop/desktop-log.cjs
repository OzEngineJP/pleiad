// Electron main プロセスの出来事（renderer の終了・読み込み失敗・応答なし・子プロセスの終了）を時刻つきで追記し、
// 一定量（1 MB）を超えたら 1 世代前（.old）へ回して肥大を防ぐ同期ログ（docs/design.md、desktop/update-log.cjs と同じ置き場）。
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const SENSITIVE_PARAMS = [
  'token', 'access_token', 'access-token', 'id_token', 'id-token',
  'refresh_token', 'refresh-token', 'auth_token', 'session_token',
  'ticket', 'sig', 'signature', 'secret', 'client_secret', 'code',
  'api_key', 'api-key', 'apikey', 'key', 'jwt', 'auth',
  'password', 'passwd', 'pass', 'bearer', 'X-Amz-[^=&\\s"\'<>]+',
].join('|');

/** URL に含まれる userinfo・認証トークン・秘密パラメーターを [redacted] に伏せる。 */
function redactUrlTokens(rawUrl) {
  return String(rawUrl ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#<>"']+@/gi, '$1[redacted]@')
    .replace(new RegExp(`([?&#](?:${SENSITIVE_PARAMS})=)[^&#\\s"'<>]*`, 'gi'), '$1[redacted]')
    .replace(/\b(token|api_key|apikey|password|secret)=[^&\s"'<>#]+/gi, '$1=[redacted]');
}

/** ログ行からトークン・Authorization ヘッダー・GitHub PAT を伏せる。 */
function redactLogText(text) {
  return redactUrlTokens(String(text ?? ''))
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .replace(/\b(token|bearer)\s+[A-Za-z0-9_.~+/=-]{16,}/gi, '$1 [redacted]')
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^"',}\r\n]+/gi, '$1[redacted]');
}

function formatArgs(args) {
  return args.map(arg => (arg instanceof Error ? arg.stack || arg.message : typeof arg === 'string' ? arg : String(arg))).join(' ');
}

/** userData/logs/desktop.log へ同期追記し、上限を超えたら .old へ 1 世代だけ残して回す。 */
function createDesktopLog(file, { maxBytes = MAX_BYTES, now = () => new Date(), fsSync = fs } = {}) {
  let ensured = false;
  function rotateOrTruncate(buf) {
    let size = 0;
    try { size = fsSync.statSync(file).size; } catch { return false; }
    if (size <= 0 || size + buf.length <= maxBytes) return false;
    try {
      fsSync.renameSync(file, `${file}.old`);
      return false;
    } catch {
      // renameSync がロック等で失敗しても 1 MB を超えて肥大しないよう現行ファイルを切り詰めて書く。
      try {
        fsSync.writeFileSync(file, buf);
        return true;
      } catch {}
      return false;
    }
  }
  function write(level, args) {
    if (!file) return;
    const line = `${now().toISOString()} ${level} ${redactLogText(formatArgs(args))}\n`;
    const buf = Buffer.from(line, 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!ensured) {
          fsSync.mkdirSync(path.dirname(file), { recursive: true });
          ensured = true;
        }
        if (rotateOrTruncate(buf)) return;
        fsSync.appendFileSync(file, buf);
        return;
      } catch (error) {
        ensured = false;
        if (error?.code !== 'ENOENT') return;
      }
    }
  }
  return {
    file,
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

module.exports = { MAX_BYTES, createDesktopLog, redactUrlTokens, redactLogText };
