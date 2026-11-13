import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { number, usageWindow } from '../usage.mjs';
import { t } from '../i18n.mjs';

// Read-only print commands landed in 1.1.11. Older CLIs send /usage to the
// model as a prompt, so check the version before ever submitting the command.
export function supportsUsage(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

// agy は時刻の無いリセットを 1970-01-01（epoch 0）で返す（1.5.2）。過去の時刻として扱わず「不明」にする。数値の時刻も受ける
const resetTime = value => new Date(value).getTime();
const resetOf = value => (resetTime(value) > 0 ? value : null);
const fractionOf = bucket => {
  const fraction = number(bucket?.remaining_fraction);
  return fraction != null && fraction >= 0 && fraction <= 1 ? fraction : null;
};
// モデルの段（「Gemini 3.8 Flash (Low)」の「(Low)」、id の -low など）を外した系統。段の語のほかの括弧（「(Preview)」など）は系統の一部として残す。
// まとめる鍵は id から（名前のある段と id だけの段を 1 行にする）、表示は名前から取る
const TIER = 'minimal|low|medium|high|xhigh|max';
const familyName = bucket => String(bucket?.name ?? '').replace(new RegExp(`\\s*[（(]\\s*(?:${TIER})\\s*[）)]\\s*$`, 'i'), '').trim();
const familyKey = bucket => String(bucket?.id ?? '').replace(new RegExp(`-(?:${TIER})$`, 'i'), '') || familyName(bucket);
// 系統の行は、残りがいちばん少ない段の値とリセットを使う（別の段のリセットを使うと回復を早く見せる）。同じ残りなら有効な時刻のうちいちばん早いもの
function mergeTier(row, fraction, reset) {
  if (!row.seen || (fraction != null && (row.fraction == null || fraction < row.fraction))) return Object.assign(row, { seen: true, fraction, reset });
  if (fraction === row.fraction && reset && (!row.reset || resetTime(reset) < resetTime(row.reset))) row.reset = reset;
}

/**
 * agy の使用枠（`/usage --output-format json`）。形は 2 つある:
 *   期間ごとのバケット … グループ（'Gemini Models' など）ごとに window が 5h・weekly のバケット。1 バケット 1 行
 *   モデルごとのバケット（1.5.2）… 'All Models' の 1 グループに、モデルと段ごとのバケット（window が無く、id・name がある）。
 *     段を外した系統ごとに 1 行へまとめる（残りはいちばん少ない段の値、リセットはその段の時刻）。group も系統の名前にし、
 *     チップ（web/header-usage.mjs の windowsForModel）と振り分け（core/delegation-routing.mjs の windowsFor）がモデルの系統の行を選べるようにする
 */
export function antigravityQuota(result) {
  if (result?.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'usage'
    || !Array.isArray(result.command.data?.groups)) throw new Error(t('antigravity.usage.badResponse'));
  const windows = [], families = new Map();
  for (const group of result.command.data.groups) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const minutes = bucket?.window === '5h' ? 300 : bucket?.window === 'weekly' ? 10080 : null;
      const key = !bucket?.window && familyKey(bucket);
      if (key) {
        if (!families.has(key)) { families.set(key, { family: null, key, fraction: null, reset: null }); windows.push(families.get(key)); }
        const row = families.get(key);
        row.family ||= familyName(bucket);
        mergeTier(row, fractionOf(bucket), resetOf(bucket.reset_time));
        continue;
      }
      const fraction = fractionOf(bucket);
      const period = minutes === 300 ? t('antigravity.usage.fiveHours') : minutes === 10080 ? t('antigravity.usage.weekly') : bucket?.name || t('antigravity.usage.unknownPeriod');
      // group は画面（web/header-usage.mjs）がグループごとにまとめるための名前。label には同じ名前を頭に付けてある
      const name = group.name || t('antigravity.usage.model');
      windows.push({ ...usageWindow(`${name} · ${period}`, fraction == null ? null : (1 - fraction) * 100, resetOf(bucket?.reset_time), minutes), group: name });
    }
  }
  const list = windows.map(w => (w.key
    ? { ...usageWindow(w.family || w.key, w.fraction == null ? null : (1 - w.fraction) * 100, w.reset, null), group: w.family || w.key } : w));
  return { windows: list, message: !list.length ? t('antigravity.usage.none')
    : families.size ? t('antigravity.usage.perModel') : t('antigravity.usage.shared') };
}

// Never expose stderr: authentication errors can contain credentials/URLs.
// Bound both the lifetime and output, and only terminate our own child.
// stderr は分類のためだけに見る（未認証「authentication required」を拾って、呼び出し側が 'out' に戻せるように）。
// 本文は捨て、エラーにはコードだけを付ける（資格情報や URL を漏らさない）
function capture(argv, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawnCli(argv, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { proc.kill(); reject(error); } else resolve(output.trim());
    };
    const timer = setTimeout(() => finish(new Error(t('antigravity.usage.timeout'))), timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return finish(new Error(t('antigravity.usage.tooLarge')));
      output += chunk;
    });
    proc.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    proc.on('error', () => finish(new Error(t('antigravity.usage.cannotStart'))));
    proc.on('close', code => {
      if (code === 0) return finish(null);
      const error = new Error(t('antigravity.usage.cannotRead'));
      // 未認証は確定的（公式の headless 保証: 端末無しでは authentication required で終わる）。コードだけを伝える
      if (/authentication required|sign in|unauthorized/i.test(stderr)) error.code = 'AUTH_REQUIRED';
      finish(error);
    });
  });
}

// attempted: 実際に `--print /usage` を起こして読めたか（古い CLI の needsUpdate は false。呼び出し側が
// 認証の成否を確かめる目印にする。バージョン確認の `--version` は認証しないので含めない）
export async function readAntigravityUsage({ argv = cliCommand('antigravity'), timeoutMs = 25_000 } = {}) {
  const version = await capture(argv, ['--version'], timeoutMs);
  if (!supportsUsage(version)) return { windows: [], attempted: false, message: t('antigravity.usage.needsUpdate') };
  const output = await capture(argv, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s'], timeoutMs);
  return { ...antigravityQuota(JSON.parse(output)), attempted: true };
}
