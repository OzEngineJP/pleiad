// macOS のパッケージを作る前に、同梱する Swift ヘルパーを作る（ADR 0173）。
// 既定は両 CPU 向け（universal）。リリースの CPU ごとのジョブは PLY_MAC_ARCH（x64・arm64）でその CPU の分だけ作る（ビルドが半分で済む）。
// Windows のパッケージでは Swift を呼ばない。開発時はこのファイルを node で直接実行する。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ARCHS = { x64: ['x86_64'], arm64: ['arm64'] };

function build({ root = path.resolve(__dirname, '..'), run = execFileSync, macArch = process.env.PLY_MAC_ARCH } = {}) {
  const cwd = path.join(root, 'desktop', 'computer', 'mac');
  const options = { cwd, stdio: 'inherit' };
  const archs = ARCHS[macArch] ?? ['arm64', 'x86_64'];
  const archFlags = archs.flatMap(arch => ['--arch', arch]);
  run('swift', ['build', '-c', 'release', ...archFlags], options);
  const bin = run('swift', ['build', '-c', 'release', ...archFlags, '--show-bin-path'], { cwd, encoding: 'utf8' }).trim();
  const source = path.join(bin, 'pleiad-computer-helper');
  run('lipo', [source, '-verify_arch', ...archs], options);
  const dist = path.join(cwd, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(source, path.join(dist, 'pleiad-computer-helper'));
  fs.chmodSync(path.join(dist, 'pleiad-computer-helper'), 0o755);
}

let built = false;
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin' || built) return;
  build({ root: context.packager.projectDir });
  built = true;
};
module.exports.build = build;
if (require.main === module) build();
