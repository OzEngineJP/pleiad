import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { electronDownloader, officialReleaseDownloader, windowsInstallerTools } from '../../scripts/prepare-electron.mjs';
import { verifyWindowsArchitectures } from '../../scripts/verify-windows-architectures.mjs';

export const name = 'prepare-electron';
export const title = 'Electronの代替取得でも固定したチェックサムを検証する';

export default async function (t) {
  const require = createRequire(createRequire(import.meta.url).resolve('electron/package.json'));
  const { downloadArtifact } = await import(pathToFileURL(require.resolve('@electron/get')).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-download-test-'));
  try {
    const filename = 'electron-v44.9.3-win32-x64.zip';
    const payload = 'verified test archive';
    const calls = [];
    const downloader = electronDownloader('44.9.3', { warn: () => {}, fetchImpl: async (url, options) => {
      calls.push([url, options?.headers?.Accept]);
      if (url.includes('/releases/download/')) return new Response('', { status: 504 });
      if (url.includes('/releases/tags/')) return Response.json({ assets: [{ name: filename, id: 123 }] });
      if (url === 'https://api.github.com/repos/electron/electron/releases/assets/123') return new Response(payload);
      throw new Error('unexpected request');
    } });
    const options = { version: '44.9.3', artifactName: 'electron', platform: 'win32', arch: 'x64', cacheRoot: root, downloader,
      checksums: { [filename]: createHash('sha256').update(payload).digest('hex') } };
    const downloaded = await downloadArtifact(options);
    assert.equal(await fs.readFile(downloaded, 'utf8'), payload);
    assert.equal(calls.length, 3);
    assert.equal(calls[2][1], 'application/octet-stream');
    t.ok('通常URLの504だけを公式APIへ切り替え固定チェックサムで検証する', true);
    await assert.rejects(downloadArtifact({ ...options, force: true, checksums: { [filename]: '0'.repeat(64) } }), /checksum|Checksum/i);
    t.ok('API経由のファイルもチェックサムが違えば拒否する', true);

    const failure = electronDownloader('44.9.3', { fetchImpl: async () => new Response('', { status: 404 }) });
    await assert.rejects(failure.download(`https://github.com/electron/electron/releases/download/v44.9.3/${filename}`, path.join(root, 'missing')), /HTTP 404/);
    const foreign = electronDownloader('44.9.3', { fetchImpl: async () => new Response('', { status: 504 }) });
    await assert.rejects(foreign.download(`https://example.invalid/${filename}`, path.join(root, 'foreign')), /Unsupported/);
    t.ok('404や公式以外の取得先をAPIへ置き換えない', true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }

  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const workflow = parse(await fs.readFile(path.join(repo, '.github/workflows/evaluation-release.yml'), 'utf8'));
  const pin = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
  for (const jobName of ['mac', 'windows']) {
    const steps = workflow.jobs[jobName].steps;
    const product = steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@') && step.with?.path !== 'release-prep');
    const npm = steps.findIndex((step) => step.run === 'npm ci');
    const helper = steps.findIndex((step) => step.with?.path === 'release-prep');
    const warm = steps.findIndex((step) => step.name === 'Prepare verified Electron');
    assert.equal(product.length, 1);
    assert.equal(product[0].uses, pin);
    assert.equal(product[0].with.ref, '${{ inputs.tag || github.ref_name }}');
    assert.equal(product[0].with['persist-credentials'], false);
    assert.equal(steps[helper].uses, pin);
    assert.equal(steps[helper].with.ref, '${{ github.workflow_sha }}');
    assert.equal(steps[helper].with['sparse-checkout'], 'scripts');
    assert.equal(steps[helper].with['persist-credentials'], false);
    assert.equal(steps[warm].run, 'node release-prep/scripts/prepare-electron.mjs --release');
    assert.ok(npm >= 0 && npm < helper && helper < warm);
    t.ok(`${jobName}: 準備は workflow の commit から取り、製品 checkout はタグのまま、npm ci の後に温める`, true);
  }
  const helperFile = path.join(repo, 'release-prep', 'scripts', 'prepare-electron.mjs');
  const resolved = createRequire(helperFile).resolve('electron/package.json');
  assert.equal(await fs.realpath(resolved), await fs.realpath(path.join(repo, 'node_modules', 'electron', 'package.json')));
  assert.equal(resolved.includes(`${path.sep}release-prep${path.sep}`), false);
  t.ok('第二 checkout の位置から、製品の node_modules にある electron へ解決する', true);

  const toolSource = await fs.readFile(createRequire(import.meta.url).resolve('app-builder-lib/out/toolsets/windows.js'), 'utf8');
  const tools = windowsInstallerTools(toolSource);
  assert.deepEqual(tools.map(tool => tool.name), ['nsis', 'nsis-resources']);
  for (const tool of tools) assert.match(tool.checksum, /^[a-f0-9]{64}$/);
  assert.throws(() => windowsInstallerTools(''), /Missing pinned/);
  const requests = [];
  const binary = officialReleaseDownloader('electron-userland/electron-builder-binaries', 'nsis-resources-3.4.1', {
    warn: () => {}, fetchImpl: async url => {
      requests.push(url);
      if (url.includes('/releases/download/')) return new Response('', { status: 504 });
      if (url.includes('/releases/tags/')) return Response.json({ assets: [{ name: 'nsis-resources-3.4.1.7z', id: 321 }] });
      return new Response('builder tool');
    },
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-download-test-'));
  try {
    await binary.download('https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z', path.join(temp, 'tool.7z'));
    assert.equal(requests[2], 'https://api.github.com/repos/electron-userland/electron-builder-binaries/releases/assets/321');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  assert.throws(() => officialReleaseDownloader('foreign/repo', 'v1'), /Unsupported/);
  t.ok('インストーラー部品も依存パッケージのハッシュを使い、公式の同じ配布元へ切り替える', true);

  const builds = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-arch-test-'));
  const executable = machine => {
    const buffer = Buffer.alloc(134);
    buffer.writeUInt16LE(0x5a4d, 0); buffer.writeUInt32LE(128, 0x3c);
    buffer.writeUInt32LE(0x4550, 128); buffer.writeUInt16LE(machine, 132);
    return buffer;
  };
  const x64 = path.join(builds, 'win-unpacked', 'Ply.exe');
  const arm64 = path.join(builds, 'win-arm64-unpacked', 'Ply.exe');
  try {
    for (const file of [x64, arm64]) await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(x64, executable(0x8664)); await fs.writeFile(arm64, executable(0xaa64));
    await verifyWindowsArchitectures(builds);
    await fs.writeFile(arm64, executable(0x8664));
    await assert.rejects(verifyWindowsArchitectures(builds), /Wrong executable architecture: win-arm64/);
    await fs.writeFile(arm64, Buffer.alloc(12));
    await assert.rejects(verifyWindowsArchitectures(builds), /Invalid executable/);
    const invalid = executable(0xaa64); invalid.writeUInt32LE(0xffffff, 0x3c);
    await fs.writeFile(arm64, invalid);
    await assert.rejects(verifyWindowsArchitectures(builds), /Invalid PE header/);
    t.ok('Arm64配布物へのx64実行ファイル混入と破損した実行ファイルを公開前に拒否する', true);
  } finally { await fs.rm(builds, { recursive: true, force: true }); }
  const winSteps = workflow.jobs.windows.steps;
  const archCheck = winSteps.findIndex(step => step.name === 'Verify Windows executable architectures');
  assert.equal(winSteps[archCheck].run, 'node release-prep/scripts/verify-windows-architectures.mjs dist-desktop');
  assert.ok(archCheck > winSteps.findIndex(step => step.name === 'Verify and build unsigned'));
  assert.ok(archCheck < winSteps.findIndex(step => step.name === 'Packaged UI startup smoke'));
  t.ok('Windows実行ファイルのCPU検証をビルドの後、配布物の起動と公開の前に行う', true);
}
