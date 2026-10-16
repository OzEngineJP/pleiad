// Evaluation release の macOS は CPU ごとのジョブ（mac (x64)・mac (arm64)）で作るので、latest-mac.yml が 2 つできる。
// 公開のジョブが、両方の配布物を 1 つの場所に写し、latest-mac.yml を 1 つにまとめる（docs/desktop-releases.md「macOS の配布」）。
// electron-updater（MacUpdater）は files から CPU に合う zip を選ぶので、両方の files を並べればよい。
//   node scripts/release-mac-merge.mjs <写し先> <版> <CPU ごとの artifact の場所>...
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';
import { fileURLToPath } from 'node:url';

const ARCHS = ['x64', 'arm64'];
const ASSET = /\.(dmg|zip|blockmap)$/;

export async function mergeMacReleases(output, version, directories) {
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw new Error('Invalid version');
  const builds = new Map();
  for (const directory of directories) {
    const names = await fs.readdir(directory);
    if (!names.includes('latest-mac.yml')) throw new Error(`Missing latest-mac.yml in ${directory}`);
    const data = parse(await fs.readFile(path.join(directory, 'latest-mac.yml'), 'utf8'));
    if (data?.version !== version || !data.files?.length) throw new Error(`Invalid latest-mac.yml in ${directory}`);
    // 1 つのジョブは 1 つの CPU だけを作る。名前は Pleiad-<版>-mac-<CPU>.<拡張子>（electron-builder.yml の artifactName）
    const archs = new Set(data.files.map(file => ARCHS.find(arch => file.url === `Pleiad-${version}-mac-${arch}${path.extname(file.url)}`)));
    if (archs.size !== 1 || archs.has(undefined)) throw new Error(`latest-mac.yml in ${directory} must describe one CPU architecture`);
    const [arch] = archs;
    if (builds.has(arch)) throw new Error(`Duplicate macOS ${arch} build`);
    for (const file of data.files) {
      if (!names.includes(file.url)) throw new Error(`Missing asset: ${file.url}`);
      if (crypto.createHash('sha512').update(await fs.readFile(path.join(directory, file.url))).digest('base64') !== file.sha512) throw new Error(`Checksum mismatch: ${file.url}`);
    }
    if (!data.files.some(file => file.url.endsWith('.zip'))) throw new Error(`Missing macOS ${arch} ZIP`);
    const extra = names.filter(name => ASSET.test(name) && !name.startsWith(`Pleiad-${version}-mac-${arch}.`));
    if (extra.length) throw new Error(`Unexpected assets in the ${arch} build: ${extra.join(', ')}`);
    builds.set(arch, { directory, data, names: names.filter(name => ASSET.test(name)) });
  }
  for (const arch of ARCHS) if (!builds.has(arch)) throw new Error(`Missing macOS ${arch} build`);
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error('Merge output must be empty');
  for (const { directory, names } of builds.values()) {
    for (const name of names) await fs.copyFile(path.join(directory, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
  }
  // 1 つのジョブで両方を作ったときと同じく x64 を先に置く。path・sha512 は古い更新の仕掛けのための欄で、先頭の zip を指す
  const files = ARCHS.flatMap(arch => builds.get(arch).data.files);
  const first = builds.get('x64').data;
  const releaseDate = ARCHS.map(arch => builds.get(arch).data.releaseDate).filter(Boolean).sort().at(-1);
  await fs.writeFile(path.join(output, 'latest-mac.yml'), stringify({ version, files, path: first.path, sha512: first.sha512, ...(releaseDate ? { releaseDate } : {}) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, version, ...directories] = process.argv.slice(2);
  await mergeMacReleases(output, version, directories);
}
