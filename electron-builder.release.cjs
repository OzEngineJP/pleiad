const fs = require('node:fs');
const { parse } = require('yaml');
const config = parse(fs.readFileSync(require('node:path').join(__dirname, 'electron-builder.yml'), 'utf8'));
// 配布版に焼き込む更新フィード（利用者のアプリが見に行く Releases）。アップロード先（GH_REPO）とは分ける。
// GITHUB_REPOSITORY からは導かない。旧リポジトリの Actions で作った版も既定のフィードを見に行くようにするため。
const repository = process.env.PLY_RELEASE_REPOSITORY || 'OzEngineJP/pleiad';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('PLY_RELEASE_REPOSITORY must be owner/repo');
const [owner, repo] = repository.split('/');
// 署名の設定（scripts/release-signing.cjs）。PLY_WINDOWS_SIGNING=none（無署名。ADR 0209）では win.forceCodeSigning: false が
// 下の forceCodeSigning: true より優先され、Windows だけ署名せずに作る。macOS は今のまま、署名と公証が無ければ止まる
const { releaseSigning, macArchTargets } = require('./scripts/release-signing.cjs');
const signing = releaseSigning();
if (signing.win) config.win = { ...config.win, ...signing.win };
if (signing.mac) config.mac = { ...config.mac, ...signing.mac, target: macArchTargets(config.mac.target, process.env.PLY_MAC_ARCH) };
module.exports = { ...config, forceCodeSigning: true, extraMetadata: { plyRelease: true },
  // mac の公証は自前の afterSign（scripts/notarize-mac.cjs。長い間隔の再試行つき）で行う。mac 以外では何もしない
  afterSign: require.resolve('./scripts/notarize-mac.cjs'),
  // PrivateGitHubProvider reads latest*.yml even for prereleases. The GitHub
  // release's prerelease flag controls who receives the beta, not the filename.
  publish: [{ provider: 'github', owner, repo, private: true, channel: 'latest', releaseType: 'draft' }],
  generateUpdatesFilesForAllChannels: false,
};
