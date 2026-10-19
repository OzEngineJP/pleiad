import fs from 'node:fs/promises';

export async function withdrawnReleases() {
  const { releases } = JSON.parse(await fs.readFile(new URL('./release-withdrawn.json', import.meta.url), 'utf8'));
  if (!Array.isArray(releases) || releases.some(r => !/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag) || !r.reason)) throw new Error('Invalid withdrawal registry');
  return releases;
}

export async function assertReleaseAllowed(tag) {
  const withdrawn = (await withdrawnReleases()).find(r => r.tag === tag);
  if (withdrawn) throw new Error(`Withdrawn release ${tag}: ${withdrawn.reason}`);
}
