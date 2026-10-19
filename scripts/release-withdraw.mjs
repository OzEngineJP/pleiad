// Immutable release assets cannot be edited. Remove the release, preserving its
// source tag. Never reuse a withdrawn version. A plan is read-only by default.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withdrawnReleases } from './release-policy.mjs';

export function createGitHub(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GH_REPO must be owner/repo');
  return (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_REPO: repo } });
}

export async function withdraw({ mode = 'plan', repo, backup, gh = createGitHub(repo) }) {
  if (!['plan', 'apply', 'verify'].includes(mode)) throw new Error('Expected plan, apply or verify');
  const denied = await withdrawnReleases();
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  const releases = pages.flat();
  const targets = releases.filter(r => denied.some(d => d.tag === r.tag_name));
  if (mode === 'verify') {
    if (targets.length) throw new Error(`Withdrawn releases remain downloadable: ${targets.map(r => r.tag_name).join(', ')}`);
    const latest = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]));
    if (denied.some(d => d.tag === latest.tag_name)) throw new Error('Latest still points to a withdrawn release');
    return { withdrawnAbsent: true, latest: latest.tag_name };
  }
  const plan = targets.map(r => ({ id: r.id, tag: r.tag_name, immutable: r.immutable, assets: r.assets.map(a => a.name) }));
  if (mode === 'plan') return { repo, targets: plan, action: 'Delete release objects and their downloads; preserve source tags. Already downloaded installers cannot be recalled.' };
  if (!backup) throw new Error('A metadata backup directory is required');
  await fs.mkdir(backup, { recursive: true });
  // Save the complete API responses before the first mutation; never overwrite an audit.
  await fs.writeFile(path.join(backup, 'withdrawal.json'), JSON.stringify({ repo, at: new Date().toISOString(), releases: targets }, null, 2), { flag: 'wx' });
  for (const release of targets) {
    // Re-read the exact ID before deletion to avoid acting on stale inventory.
    const current = JSON.parse(gh(['api', `repos/${repo}/releases/${release.id}`]));
    if (current.tag_name !== release.tag_name) throw new Error('Release changed since planning');
    gh(['api', '--method', 'DELETE', `repos/${repo}/releases/${release.id}`]);
  }
  return withdraw({ mode: 'verify', repo, gh });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode = 'plan', backup] = process.argv.slice(2);
  console.log(JSON.stringify(await withdraw({ mode, backup, repo: process.env.GH_REPO }), null, 2));
}
