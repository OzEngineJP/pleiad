// モバイルのリリースノート（scripts/mobile-release-notes.mjs、docs/android-releases.md・docs/ios.md、ADR 0271）。
// 偽の git リポジトリで、前の <os>-v* のタグからの範囲・paths の絞り込み・マージの除外・件数と文字数の上限・
// 前の版が無いときの空を確かめる。paths の一覧（スクリプトの RELEASE_PATHS）がワークフローの on.push.paths と
// ずれていないこと、タグの形がワークフローと合うことも突き合わせる。GitHub・Play・Apple は呼ばない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { RELEASE_PATHS } from '../../scripts/mobile-release-notes.mjs';

export const name = 'mobile-release-notes';
export const title = 'リリースノートは前の <os>-v* のタグからのその OS の変更の題を、GitHub Release・Play・TestFlight の形に収める';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts/mobile-release-notes.mjs');

/** 一時の git リポジトリ。commit({ ファイル: 中身 }, 題) で足す */
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-notes-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  g('init', '-qb', 'main');
  g('config', 'user.email', 'notes@example.com');
  g('config', 'user.name', 'notes');
  g('config', 'commit.gpgsign', 'false');
  const commit = (files, subject) => {
    for (const [p, content] of Object.entries(files)) {
      const f = path.join(dir, p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    g('add', '-A');
    g('commit', '-qm', subject);
  };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { dir, g, commit, run, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function (t) {
  // ===== paths の一覧がワークフローとずれていない =====
  const apkPaths = parse(read('.github/workflows/android-release.yml')).on.push.paths;
  const iosPaths = parse(read('.github/workflows/ios-testflight.yml')).on.push.paths;
  t.ok('android の paths はワークフローの on.push.paths と同じ', JSON.stringify(RELEASE_PATHS.android) === JSON.stringify(apkPaths), JSON.stringify(RELEASE_PATHS.android));
  t.ok('ios の paths はワークフローの on.push.paths と同じ', JSON.stringify(RELEASE_PATHS.ios) === JSON.stringify(iosPaths), JSON.stringify(RELEASE_PATHS.ios));

  // ===== 範囲・絞り込み・マージ・上限 =====
  const repo = mkRepo();
  try {
    repo.commit({ 'mobile/android/app/src/main/A.kt': '1', 'core/x.mjs': '1', 'mobile/ios/App/App/I.swift': '1' }, '最初の版');
    repo.g('tag', 'android-v0.1.0-1');
    repo.g('tag', 'ios-v0.1.0-1');
    repo.commit({ 'mobile/android/app/src/main/A.kt': '2' }, 'Android の画面を直す');
    repo.commit({ 'core/y.mjs': '2' }, 'サーバーだけの変更');
    repo.commit({ 'mobile/android/app/src/test/T.kt': '2' }, 'JVM テストだけ直す');
    repo.commit({ 'mobile/www/app.js': '2' }, 'スマホの画面を直す');
    repo.commit({ 'mobile/ios/App/App/I.swift': '2' }, 'iOS の殻を直す');
    repo.commit({ 'mobile/ios/App/AppTests/T.swift': '1' }, 'iOS の試験だけ直す');
    // 側のブランチで変更してマージする（マージのコミットは題に出さないが、連れてきた変更は数える）
    repo.g('checkout', '-qb', 'side', 'HEAD~2');
    repo.commit({ 'mobile/android/app/src/main/B.kt': '1' }, '別れで直した Android の不具合');
    repo.g('checkout', '-q', 'main');
    repo.commit({ 'core/z.mjs': '1' }, 'マージ前のサーバーの変更');
    repo.g('merge', '-qm', 'Merge side', 'side');
    const sha = repo.g('rev-parse', 'HEAD');

    const gh = repo.run(['android', '--format', 'github']);
    t.ok('Android の GitHub のノート: 変更の節とその OS に効く題を並べる（新しい順）',
      gh.status === 0 && gh.stdout === [
        '## 変更',
        '- 別れで直した Android の不具合',
        '- スマホの画面を直す',
        '- Android の画面を直す',
        '',
      ].join('\n'), JSON.stringify(gh));
    t.ok('マージのコミット・別 OS・試験だけ・サーバーだけの変更は出ない',
      !gh.stdout.includes('Merge side') && !gh.stdout.includes('iOS の殻') && !gh.stdout.includes('テストだけ') && !gh.stdout.includes('試験だけ') && !gh.stdout.includes('サーバーだけ'), gh.stdout);

    const ios = repo.run(['ios', '--format', 'testflight']);
    t.ok('iOS のノートは ios-v* のタグから、共有の変更と iOS の変更を並べる',
      ios.status === 0 && ios.stdout === ['今回の変更:', '・iOS の殻を直す', '・スマホの画面を直す', ''].join('\n'), JSON.stringify(ios));

    // 上げたコミットにタグが付いている実行（Play はリリースの後に動く）でも、1 つ前のタグを基点にする
    repo.g('tag', 'android-v0.2.0-9', sha);
    const again = repo.run(['android', '--format', 'github']);
    t.ok('今のコミットに android-v* のタグが付いていても 1 つ前のタグを基点にする',
      again.status === 0 && again.stdout === gh.stdout, JSON.stringify(again));

    const explicit = repo.run(['android', '--format', 'github', '--from', 'android-v0.1.0-1', '--to', 'HEAD~1']);
    t.ok('--from と --to で範囲を決められる', explicit.status === 0 && explicit.stdout.includes('- スマホの画面を直す'), JSON.stringify(explicit));
    const empty = repo.run(['android', '--format', 'github', '--from', 'HEAD']);
    t.ok('範囲が空なら空で返る', empty.status === 0 && empty.stdout === '', JSON.stringify(empty));

    const play = repo.run(['android', '--format', 'play', '--from', 'android-v0.1.0-1']);
    t.ok('Play の形は箇条書きだけ（500 文字まで）', play.status === 0 && [...play.stdout].length <= 500 && play.stdout.startsWith('・') && !play.stdout.includes('##'), JSON.stringify(play));
    const tf = repo.run(['ios', '--format', 'testflight', '--from', 'ios-v0.1.0-1']);
    t.ok('TestFlight の形は「今回の変更:」（4000 文字まで）', tf.status === 0 && [...tf.stdout].length <= 4000 && tf.stdout.startsWith('今回の変更:\n'), JSON.stringify(tf));

    const outFile = path.join(repo.dir, 'notes.md');
    const out = repo.run(['android', '--format', 'github', '--out', outFile]);
    t.ok('--out はファイルに書く', out.status === 0 && fs.readFileSync(outFile, 'utf8') === gh.stdout, JSON.stringify(out));
  } finally {
    repo.rm();
  }

  // ===== タグが無い・件数と文字数の上限 =====
  const bare = mkRepo();
  try {
    bare.commit({ 'mobile/www/app.js': '1' }, '初めての変更');
    const none = bare.run(['android', '--format', 'github']);
    t.ok('前の版（タグ）が無ければ空で返る（変更の欄を出さない）', none.status === 0 && none.stdout === '', JSON.stringify(none));
    bare.g('tag', 'android-v0.1.0-1');
    for (let i = 0; i < 25; i++) bare.commit({ 'mobile/www/app.js': `${i + 2}` }, `かえ ${i + 1}`);
    const many = bare.run(['android', '--format', 'github']);
    t.ok('件数は 20 件で切って「ほか N 件」',
      many.status === 0 && (many.stdout.match(/^- /gm) ?? []).length === 20 && many.stdout.includes('ほか 5 件'), JSON.stringify(many.stdout.slice(-80)));
    const tf = bare.run(['android', '--format', 'testflight']);
    t.ok('TestFlight は 30 件・4000 文字まで', tf.status === 0 && (tf.stdout.match(/^・/gm) ?? []).length === 25 && [...tf.stdout].length <= 4000, JSON.stringify(tf.stdout.slice(0, 60)));
  } finally {
    bare.rm();
  }

  const tight = mkRepo();
  try {
    tight.commit({ 'mobile/www/app.js': '0' }, '最初の版');
    tight.g('tag', 'android-v0.1.0-1');
    for (let i = 0; i < 5; i++) tight.commit({ 'mobile/www/app.js': `${i + 1}` }, `かえ ${'x'.repeat(200)}${i}`);
    const play = tight.run(['android', '--format', 'play']);
    const items = (play.stdout.match(/^・/gm) ?? []).length;
    t.ok('Play は 500 文字に収まる分だけ載せ、残りは「ほか N 件」',
      play.status === 0 && [...play.stdout].length <= 500 && items < 5 && play.stdout.includes(`ほか ${5 - items} 件`), JSON.stringify({ len: [...play.stdout].length, items, tail: play.stdout.slice(-30) }));
    tight.commit({ 'mobile/www/app.js': 'x' }, 'x'.repeat(600));
    const huge = tight.run(['android', '--format', 'play']);
    t.ok('1 件が上限を超えても切り詰めて収める', huge.status === 0 && [...huge.stdout].length <= 500 && huge.stdout.includes('…'), JSON.stringify([...huge.stdout].length));
  } finally {
    tight.rm();
  }

  // ===== タグの形がワークフローと合う =====
  const apkYml = read('.github/workflows/android-release.yml');
  t.ok('Android のタグは android-v<versionName>（スクリプトの android-v* と合う）', /tag="android-v\$\{name\}"/.test(apkYml), apkYml.match(/tag=.*name/)?.[0]);
  const iosYml = read('.github/workflows/ios-testflight.yml');
  t.ok('iOS のタグは ios-v<版>-<ビルド>（スクリプトの ios-v* と合う）', /TAG: ios-v\$\{\{ steps\.version\.outputs\.base \}\}-\$\{\{ steps\.version\.outputs\.code \}\}/.test(iosYml),
    iosYml.match(/TAG: ios-v.*/)?.[0]);
}
