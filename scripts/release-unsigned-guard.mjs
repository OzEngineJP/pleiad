// 無署名の版を出す前の確かめ（ADR 0207・docs/desktop-releases.md「無署名への移り方」）。
// 利用者の手元の版が無署名の更新を受け入れられるのは、方針（desktop/update-trust.json）で unsigned を accept にした版から。
// 正式の利用者が取る最新（Latest）と、先行版の利用者が取る一番新しい版の両方が、BUILD-INFO.json に updateAcceptsUnsigned: true を
// 持つ（= 受け入れる版が届いている）ことを確かめ、無ければ止める。版が 1 つも無ければ（利用者がいない）通す。
//   node scripts/release-unsigned-guard.mjs   （env: GH_REPO・GH_TOKEN・RELEASE_TAG。publish-evaluation.ps1 が無署名のときに呼ぶ）
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

/** v1.2.3 / v1.2.3-beta.4 を比べる（正式は同じ版の beta より新しい）。形の違うタグは null */
export function compareTags(a, b) {
  const [x, y] = [TAG.exec(a), TAG.exec(b)];
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  const [bx, by] = [x[4] == null ? Infinity : Number(x[4]), y[4] == null ? Infinity : Number(y[4])];
  return bx === by ? 0 : bx > by ? 1 : -1;
}

/**
 * 確かめる版を選ぶ。list は GitHub の releases の一覧、latestTag は Latest の版（無ければ null）、releaseTag は今から出す版（除く）。
 * 戻り値 [{ tag, channel }]（同じ版は 1 つにまとめる）
 */
export function releasesToCheck(list, latestTag, releaseTag) {
  const published = list.filter(r => !r.draft && TAG.test(r.tag_name ?? '') && r.tag_name !== releaseTag).map(r => r.tag_name);
  const newest = published.sort((a, b) => compareTags(b, a))[0] ?? null;
  const checks = [];
  if (latestTag && latestTag !== releaseTag) checks.push({ tag: latestTag, channel: 'stable' });
  if (newest && newest !== latestTag) checks.push({ tag: newest, channel: 'beta' });
  return checks;
}

/** 止める理由の一覧（空なら出してよい）。buildInfos は tag → BUILD-INFO.json の中身（無ければ null） */
export function unsignedBlockers(checks, buildInfos) {
  return checks.filter(c => buildInfos.get(c.tag)?.updateAcceptsUnsigned !== true)
    .map(c => `${c.tag} (${c.channel} channel) does not accept unsigned updates. Publish a signed release whose desktop/update-trust.json accepts unsigned updates first`);
}

async function main() {
  const repo = process.env.GH_REPO, releaseTag = process.env.RELEASE_TAG;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !TAG.test(releaseTag || '') || !process.env.GH_TOKEN) throw new Error('Release tag, repository and token required');
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let latestTag = null;
  try { latestTag = JSON.parse(gh(['api', `repos/${repo}/releases/latest`])).tag_name ?? null; }
  catch (error) { if (!/Not Found|HTTP 404/.test(String(error.stderr))) throw error; }
  const list = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]));
  const checks = releasesToCheck(list, latestTag, releaseTag);
  const buildInfos = new Map();
  for (const { tag } of checks) {
    try { buildInfos.set(tag, JSON.parse(gh(['release', 'download', tag, '--repo', repo, '--pattern', 'BUILD-INFO.json', '--output', '-']).replace(/^\uFEFF/, ''))); }
    catch { buildInfos.set(tag, null); }
  }
  const blockers = unsignedBlockers(checks, buildInfos);
  if (blockers.length) throw new Error(`Unsigned release blocked:\n${blockers.join('\n')}`);
  console.log(`Unsigned release allowed: ${checks.map(c => `${c.tag} (${c.channel})`).join(', ') || 'no published release'} accepts unsigned updates`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
