// Keep the npm package's pinned checksums on both official download routes.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function electronDownloader(version, { fetchImpl = fetch, warn = console.log } = {}) {
  return { async download(url, target) {
    const filename = path.basename(new URL(url).pathname);
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) }); }
    catch (error) { if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error; }
    if (!response || response.status >= 500) {
      // Only official Electron URLs may switch to the official API.
      const source = new URL(url);
      if (source.origin !== 'https://github.com' || !source.pathname.startsWith(`/electron/electron/releases/download/v${version}/`)) throw new Error('Unsupported Electron download URL');
      warn('Electron download unavailable; using the official GitHub release API with pinned checksums.');
      const release = await fetchImpl(`https://api.github.com/repos/electron/electron/releases/tags/v${version}`, { signal: AbortSignal.timeout(30_000) });
      if (!release.ok) throw new Error(`Electron release API: HTTP ${release.status}`);
      const asset = (await release.json()).assets?.find(item => item.name === filename);
      if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error('Electron release asset not found');
      response = await fetchImpl(`https://api.github.com/repos/electron/electron/releases/assets/${asset.id}`, {
        headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(120_000),
      });
    }
    if (!response.ok || !response.body) throw new Error(`Electron download: HTTP ${response.status}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  } };
}

export async function prepareElectron() {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve('electron/package.json');
  const electronRequire = createRequire(packageFile);
  const { version } = electronRequire('./package.json');
  const checksums = electronRequire('./checksums.json');
  const filename = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  if (!/^[a-f0-9]{64}$/i.test(checksums[filename] ?? '')) throw new Error('Missing pinned Electron checksum');
  const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href);
  const zip = await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch: process.arch,
    checksums, downloader: electronDownloader(version) });
  const { extract } = electronRequire('@electron-internal/extract-zip');
  const directory = path.dirname(packageFile);
  await extract(zip, { dir: path.join(directory, 'dist') });
  const executable = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  await fs.access(path.join(directory, 'dist', executable));
  await fs.writeFile(path.join(directory, 'path.txt'), executable);
  // electron-builder must use this verified archive, rather than download it again.
  if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `PLY_ELECTRON_DIST=${zip}\n`);
  console.log(`Prepared Electron ${version} (${process.platform}/${process.arch}); checksum verified.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareElectron();
}
