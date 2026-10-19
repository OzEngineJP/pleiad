import { parse } from 'yaml';

// Check the actual remote feed after publication. Uploading a tag/draft alone is
// not success: the updater must be able to find the version and its manifests.
export function verifyPublished({ gh, repo, tag }) {
  const release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]));
  if (release.draft || release.tag_name !== tag) throw new Error('Release is not published');
  if (Boolean(release.prerelease) !== tag.includes('-beta.')) throw new Error('Release channel mismatch');
  if (!release.prerelease) {
    const latest = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]));
    if (latest.tag_name !== tag) throw new Error(`Latest has not switched to ${tag}`);
  }
  const names = release.assets.map(a => a.name);
  const manifests = release.assets.filter(a => ['latest.yml', 'latest-mac.yml'].includes(a.name));
  if (!manifests.some(a => a.name === 'latest.yml')) throw new Error('Windows update feed is missing');
  if (names.some(n => /\.(dmg|zip)$/.test(n)) && !manifests.some(a => a.name === 'latest-mac.yml')) throw new Error('macOS update feed is missing');
  for (const asset of manifests) {
    const feed = parse(gh(['api', `repos/${repo}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']));
    if (feed.version !== tag.slice(1) || !feed.files?.length || feed.files.some(f => !names.includes(f.url))) throw new Error(`Published update feed is inconsistent: ${asset.name}`);
  }
  return { tag, published: true, manifests: manifests.map(a => a.name) };
}
