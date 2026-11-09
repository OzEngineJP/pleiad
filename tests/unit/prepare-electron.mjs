import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { electronDownloader } from '../../scripts/prepare-electron.mjs';

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
    assert.equal(steps[warm].run, 'node release-prep/scripts/prepare-electron.mjs');
    assert.ok(npm >= 0 && npm < helper && helper < warm);
    t.ok(`${jobName}: 準備は workflow の commit から取り、製品 checkout はタグのまま、npm ci の後に温める`, true);
  }
  const helperFile = path.join(repo, 'release-prep', 'scripts', 'prepare-electron.mjs');
  const resolved = createRequire(helperFile).resolve('electron/package.json');
  assert.equal(await fs.realpath(resolved), await fs.realpath(path.join(repo, 'node_modules', 'electron', 'package.json')));
  assert.equal(resolved.includes(`${path.sep}release-prep${path.sep}`), false);
  t.ok('第二 checkout の位置から、製品の node_modules にある electron へ解決する', true);
}
