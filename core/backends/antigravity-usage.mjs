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

// agy は時刻の無いリセットを 1970-01-01（epoch 0）で返す（1.5.2）。過去の時刻として扱わず「不明」にする
const resetOf = value => (Date.parse(value) > 0 ? value : null);
const fractionOf = bucket => {
  const fraction = number(bucket?.remaining_fraction);
  return fraction != null && fraction >= 0 && fraction <= 1 ? fraction : null;
};
// モデルの段（「Gemini 3.8 Flash (Low)」の「(Low)」、id の -low など）を外した系統の名前
const familyOf = bucket => String(bucket?.name ?? '').replace(/\s*[（(][^（）()]*[）)]\s*$/, '')
  || String(bucket?.id ?? '').replace(/-(?:minimal|low|medium|high|max)$/i, '');

/**
 * agy の使用枠（`/usage --output-format json`）。形は 2 つある:
 *   期間ごとのバケット … グループ（'Gemini Models' など）ごとに window が 5h・weekly のバケット。1 バケット 1 行
 *   モデルごとのバケット（1.5.2）… 'All Models' の 1 グループに、モデルと段ごとのバケット（window が無く、id・name がある）。
 *     段を外した系統ごとに 1 行へまとめる（残りはいちばん少ないもの、リセットはいちばん早いもの）。group も系統の名前にし、
 *     チップ（web/header-usage.mjs の windowsForModel）と振り分け（core/delegation-routing.mjs の windowsFor）がモデルの系統の行を選べるようにする
 */
export function antigravityQuota(result) {
  if (result?.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'usage'
    || !Array.isArray(result.command.data?.groups)) throw new Error(t('antigravity.usage.badResponse'));
  const windows = [], families = new Map();
  for (const group of result.command.data.groups) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const minutes = bucket?.window === '5h' ? 300 : bucket?.window === 'weekly' ? 10080 : null;
      const family = !bucket?.window && familyOf(bucket);
      if (family) {
        if (!families.has(family)) { families.set(family, { family, fraction: null, reset: null }); windows.push(families.get(family)); }
        const row = families.get(family), fraction = fractionOf(bucket), reset = resetOf(bucket.reset_time);
        if (fraction != null && (row.fraction == null || fraction < row.fraction)) row.fraction = fraction;
        if (reset && (!row.reset || Date.parse(reset) < Date.parse(row.reset))) row.reset = reset;
        continue;
      }
      const fraction = fractionOf(bucket);
      const period = minutes === 300 ? t('antigravity.usage.fiveHours') : minutes === 10080 ? t('antigravity.usage.weekly') : bucket?.name || t('antigravity.usage.unknownPeriod');
      // group は画面（web/header-usage.mjs）がグループごとにまとめるための名前。label には同じ名前を頭に付けてある
      const name = group.name || t('antigravity.usage.model');
      windows.push({ ...usageWindow(`${name} · ${period}`, fraction == null ? null : (1 - fraction) * 100, resetOf(bucket?.reset_time), minutes), group: name });
    }
  }
  const list = windows.map(w => (w.family
    ? { ...usageWindow(w.family, w.fraction == null ? null : (1 - w.fraction) * 100, w.reset, null), group: w.family } : w));
  return { windows: list, message: !list.length ? t('antigravity.usage.none')
    : families.size ? t('antigravity.usage.perModel') : t('antigravity.usage.shared') };
}

// Never expose stderr: authentication errors can contain credentials/URLs.
// Bound both the lifetime and output, and only terminate our own child.
function capture(argv, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawnCli(argv, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
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
    proc.stderr.on('data', () => {});
    proc.on('error', () => finish(new Error(t('antigravity.usage.cannotStart'))));
    proc.on('close', code => finish(code === 0 ? null : new Error(t('antigravity.usage.cannotRead'))));
  });
}

export async function readAntigravityUsage({ argv = cliCommand('antigravity'), timeoutMs = 25_000 } = {}) {
  const version = await capture(argv, ['--version'], timeoutMs);
  if (!supportsUsage(version)) return { windows: [], message: t('antigravity.usage.needsUpdate') };
  const output = await capture(argv, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s'], timeoutMs);
  return antigravityQuota(JSON.parse(output));
}
