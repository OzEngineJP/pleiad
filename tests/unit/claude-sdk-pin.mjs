// Claude Agent SDK の固定の版（core/claude-sdk-pin.json）と、配布物に SDK を入れない設定（ADR 0206）。
//   - pin は package-lock の版・integrity・tarball の URL と同じ（npm install で版を上げたら pin も上げる。ずれたら取得が integrity で必ず落ちる）
//   - SDK は devDependencies（版は固定）。dependencies などには無く、package-lock でも SDK と同梱の CLI の包みは dev だけ
//   - electron-builder.yml の files が SDK と CLI の包みを外す。release・store の設定は yml の files をそのまま使い、OS ごとの files で足さない
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CLAUDE_SDK_PIN, SDK_NAME } from '../../core/claude-sdk.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export const name = 'claude-sdk-pin';
export const title = 'Claude Agent SDK の固定の版: package-lock と同じ・devDependencies だけ・配布の設定（yml・release・store）が外す';

export default async function (t) {
  const pin = JSON.parse(read('core/claude-sdk-pin.json'));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const locked = lock.packages?.[`node_modules/${SDK_NAME}`];

  t.ok('pin: core/claude-sdk.mjs が読む pin は core/claude-sdk-pin.json', JSON.stringify(CLAUDE_SDK_PIN) === JSON.stringify(pin));
  t.ok('pin: 版・integrity・tarball が package-lock と同じ',
    locked && pin.version === locked.version && pin.integrity === locked.integrity && pin.tarball === locked.resolved,
    JSON.stringify({ pin, locked: locked && { version: locked.version, integrity: locked.integrity, resolved: locked.resolved } }));
  t.ok('pin: tarball は registry.npmjs.org の https', new URL(pin.tarball).origin === 'https://registry.npmjs.org' && pin.integrity.startsWith('sha512-'));
  t.ok('package.json: SDK は devDependencies に固定の版で（^ や ~ を付けない）', pkg.devDependencies?.[SDK_NAME] === pin.version, pkg.devDependencies?.[SDK_NAME]);
  const elsewhere = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'].filter((k) => {
    const v = pkg[k];
    return Array.isArray(v) ? v.includes(SDK_NAME) : Boolean(v?.[SDK_NAME]);
  });
  t.ok('package.json: SDK は dependencies などに無い（electron-builder が入れない）', elsewhere.length === 0, elsewhere.join());
  const notDev = Object.entries(lock.packages ?? {})
    .filter(([key]) => /(^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk(-[^/]+)?$/.test(key))
    .filter(([, v]) => v.dev !== true)
    .map(([key]) => key);
  const sdkEntries = Object.keys(lock.packages ?? {}).filter((key) => key.includes('@anthropic-ai/claude-agent-sdk'));
  t.ok('package-lock: SDK と CLI の包み（claude-agent-sdk-<os>-<arch>）は dev だけ（本番の依存から辿れない）', sdkEntries.length >= 1 && notDev.length === 0, notDev.join(', '));

  const yml = parse(read('electron-builder.yml'));
  const files = yml.files ?? [];
  t.ok('electron-builder.yml: files が SDK 本体を外す', files.includes(`!node_modules/${SDK_NAME}/**`), JSON.stringify(files));
  t.ok('electron-builder.yml: files が CLI の包みを外す', files.includes(`!node_modules/${SDK_NAME}-*/**`));
  const platformFiles = Object.entries(yml).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && ('files' in v || 'extraResources' in v)).map(([k]) => k);
  t.ok('electron-builder.yml: OS ごとの files・extraResources で SDK を足し直さない', platformFiles.length === 0, platformFiles.join());
  const extra = JSON.stringify([yml.extraResources ?? [], yml.extraFiles ?? [], yml.mac?.extraFiles ?? [], yml.asarUnpack ?? []]);
  t.ok('electron-builder.yml: extraResources・extraFiles・asarUnpack に SDK が無い', !extra.includes('claude-agent-sdk'), extra);

  // release は署名の設定を読む（環境変数が無い手元でも読める形かは分からない）ので、files を上書きしていないことを本文で確かめる
  const release = read('electron-builder.release.cjs');
  t.ok('electron-builder.release.cjs: yml を読んで files を上書きしない', /electron-builder\.yml/.test(release) && /\.\.\.config\b/.test(release) && !/\bfiles\s*:/.test(release) && !/claude-agent-sdk/.test(release));
  const storeFile = path.join(ROOT, 'electron-builder.store.cjs');
  delete require.cache[require.resolve(storeFile)];
  const store = require(storeFile);
  t.ok('electron-builder.store.cjs（MSIX）: files は yml と同じ（SDK を外す）', JSON.stringify(store.files) === JSON.stringify(files) && !('files' in (store.appx ?? {})) && !('files' in (store.win ?? {})));
}
