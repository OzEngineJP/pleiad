// Keep the npm package's pinned checksums on both official download routes.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function officialReleaseDownloader(repo, tag, { fetchImpl = fetch, warn = console.log } = {}) {
  if (!['electron/electron', 'electron-userland/electron-builder-binaries'].includes(repo)) throw new Error('Unsupported download repository');
  return { async download(url, target) {
    const filename = path.basename(new URL(url).pathname);
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) }); }
    catch (error) { if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error; }
    if (!response || response.status >= 500) {
      // Only the selected official release may switch to the official API.
      const source = new URL(url);
      if (source.origin !== 'https://github.com' || !source.pathname.startsWith(`/${repo}/releases/download/${tag}/`)) throw new Error('Unsupported release download URL');
      warn('Release download unavailable; using the official GitHub release API with pinned checksums.');
      const release = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { signal: AbortSignal.timeout(30_000) });
      if (!release.ok) throw new Error(`Release API: HTTP ${release.status}`);
      const asset = (await release.json()).assets?.find(item => item.name === filename);
      if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error('Release asset not found');
      response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
        headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(120_000),
      });
    }
    if (!response.ok || !response.body) throw new Error(`Release download: HTTP ${response.status}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  } };
}

export const electronDownloader = (version, options) => officialReleaseDownloader('electron/electron', `v${version}`, options);

// Read the exact legacy tool versions and hashes selected by the installed builder.
export function windowsInstallerTools(source) {
  return ['nsis', 'nsis-resources'].map(name => {
    const match = source.match(new RegExp(`getBinFromUrl\\)\\("(${name}-[\\d.]+)", "([^"]+)", "([a-f0-9]{64})"\\)`));
    if (!match || match[2] !== `${match[1]}.7z`) throw new Error(`Missing pinned ${name} checksum`);
    return { name, tag: match[1], filename: match[2], checksum: match[3] };
  });
}

export async function prepareElectron({ release = false } = {}) {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve('electron/package.json');
  const electronRequire = createRequire(packageFile);
  const { version } = electronRequire('./package.json');
  const checksums = electronRequire('./checksums.json');
  const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href);
  const directory = path.dirname(packageFile);
  const archives = path.join(directory, 'verified-archives');
  await fs.mkdir(archives, { recursive: true });
  const architectures = release && process.platform === 'win32' ? ['x64', 'arm64'] : [process.arch];
  let nativeZip;
  for (const arch of architectures) {
    const filename = `electron-v${version}-${process.platform}-${arch}.zip`;
    if (!/^[a-f0-9]{64}$/i.test(checksums[filename] ?? '')) throw new Error('Missing pinned Electron checksum');
    const zip = await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch,
      checksums, downloader: electronDownloader(version) });
    await fs.copyFile(zip, path.join(archives, filename));
    if (arch === process.arch) nativeZip = zip;
  }
  const { extract } = electronRequire('@electron-internal/extract-zip');
  await extract(nativeZip, { dir: path.join(directory, 'dist') });
  const executable = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  await fs.access(path.join(directory, 'dist', executable));
  await fs.writeFile(path.join(directory, 'path.txt'), executable);
  const environment = { PLY_ELECTRON_DIST: archives };
  if (release && process.platform === 'win32') {
    const builder = createRequire(require.resolve('app-builder-lib/package.json'));
    const source = await fs.readFile(builder.resolve('./out/toolsets/windows.js'), 'utf8');
    const { extractArchive } = builder('./out/util/electronGet.js');
    for (const tool of windowsInstallerTools(source)) {
      const repo = 'electron-userland/electron-builder-binaries';
      const url = `https://github.com/${repo}/releases/download/${tool.tag}/${tool.filename}`;
      const zip = await downloadArtifact({ version: '9.9.9', artifactName: tool.filename, isGeneric: true,
        checksums: { [tool.filename]: tool.checksum }, mirrorOptions: { resolveAssetURL: async () => url },
        downloader: officialReleaseDownloader(repo, tool.tag) });
      const target = path.join(directory, 'verified-tools', tool.tag);
      await extractArchive(zip, target);
      environment[tool.name === 'nsis' ? 'ELECTRON_BUILDER_NSIS_DIR' : 'ELECTRON_BUILDER_NSIS_RESOURCES_DIR'] = target;
    }
  }
  // The directory lets electron-builder select the archive for each target CPU.
  if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(`Prepared Electron ${version} (${process.platform}/${process.arch}); checksum verified.`);
  return environment;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareElectron({ release: process.argv.includes('--release') });
}
