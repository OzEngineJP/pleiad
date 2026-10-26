#!/usr/bin/env node
// モバイル版（Android・iOS）のリリースノートを作る。前に出した版から今のコミットまでの、
// その OS に効く変更（ワークフローの paths と同じ範囲）のコミットの題を並べる。
// GitHub Release（android-release.yml）・Google Play（android-play.yml）・TestFlight（ios-testflight.yml）の
// 3 か所から使う。依存なし（Node の組み込みだけ）。docs/android-releases.md・docs/ios.md、ADR 0272。
//
//   node scripts/mobile-release-notes.mjs <android|ios> --format <github|play|testflight> [--from <ref>] [--to <ref>] [--out <file>]
//
// --from を省くと、<os>-v* のタグのうち --to から届く最新のものを前の版とする（Android は
// android-release.yml が作るタグ。iOS は ios-testflight.yml が上げたコミットに付けるタグ）。
// そのタグが --to のコミットそのものに付いていれば（Play のようにリリースの後に動く側）、1 つ前のタグを使う。
// 前の版が見つからない・その範囲に変更が無いときは、空で返る（呼び出し側は変更の欄を出さない）。
// ノートの失敗でリリースを止めないため、git の実行に失敗しても警告だけ出して終了コード 0 で空を返す。
// 引数の誤りだけ終了コード 1。--out は中身が空でもファイルを作る。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// ワークフローの on.push.paths と同じ一覧（tests/unit/mobile-release-notes.mjs が両者を突き合わせる）。
// 「その OS に効く変更」の正本。順序もワークフローと同じにする。
export const RELEASE_PATHS = {
  android: [
    'mobile/android/**',
    'mobile/www/**',
    'mobile/capacitor.config.json',
    'mobile/package.json',
    'mobile/package-lock.json',
    '.github/workflows/android-release.yml',
    '!mobile/android/**/src/test/**',
    '!mobile/android/**/src/androidTest/**',
  ],
  ios: [
    'mobile/ios/**',
    'mobile/www/**',
    'mobile/capacitor.config.json',
    'mobile/package.json',
    'mobile/package-lock.json',
    'mobile/scripts/ios-testflight.sh',
    'mobile/scripts/asc-build.mjs',
    '.github/workflows/ios-testflight.yml',
    '!mobile/ios/App/AppTests/**',
    '!mobile/ios/remote-core/Tests/**',
  ],
};

// GitHub の paths の記法を git の pathspec に写す。glob magic は ** が深さをまたぎ、
// **/ が 0 段以上のディレクトリに当たる（mobile/android/src/test も mobile/android/app/src/test も除ける）
export function toPathspecs(patterns) {
  return patterns.map((p) => (p.startsWith('!') ? `:(exclude,glob)${p.slice(1)}` : `:(glob)${p}`));
}

const FORMATS = {
  // GitHub Release の本文（markdown）に足す変更の節。上限は件数だけ（文字数の制約は無い）
  github: { bullet: '- ', header: '## 変更\n', footer: (n) => `ほか ${n} 件`, limit: Infinity, maxItems: 20 },
  // Play の「新機能」。言語ごとに 500 文字まで（超えると Play が拒む）
  play: { bullet: '・', header: '', footer: (n) => `ほか ${n} 件`, limit: 500, maxItems: 20 },
  // TestFlight の「テスト内容（What to Test）」。4000 文字まで
  testflight: { bullet: '・', header: '今回の変更:\n', footer: (n) => `ほか ${n} 件`, limit: 4000, maxItems: 30 },
};

const chars = (s) => [...s].length;

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** --to から届く最新の <os>-v* タグ。それが --to 自身なら 1 つ前のタグ。無ければ null */
export function previousTag(os, to, cwd = process.cwd()) {
  const describe = (rev) => {
    const r = git(['describe', '--tags', '--abbrev=0', '--match', `${os}-v[0-9]*`, rev], cwd);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const sha = (rev) => {
    const r = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const tag = describe(to);
  if (!tag) return null;
  if (sha(tag) === sha(to)) return describe(`${tag}^`);
  return tag;
}

/** from..to の、paths に当たるコミットの題（新しい順）。マージは除くが、連れてきた変更は数える */
export function changedSubjects(os, from, to, cwd = process.cwd()) {
  const r = git(['log', '--full-history', '--no-merges', '--topo-order', '--format=%s', `${from}..${to}`, '--', ...toPathspecs(RELEASE_PATHS[os])], cwd);
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((s) => s.length > 0);
}

/** 題の一覧を format 向けの本文にする。上限を超えるときは後ろの件を落として「ほか N 件」にする */
export function render(format, subjects) {
  const f = FORMATS[format];
  for (let k = Math.min(subjects.length, f.maxItems); k >= 1; k--) {
    const rest = subjects.length - k;
    const lines = subjects.slice(0, k).map((s) => `${f.bullet}${s}`);
    if (rest > 0) lines.push(f.footer(rest));
    const text = f.header + lines.join('\n') + '\n';
    if (chars(text) <= f.limit) return text;
  }
  // 1 件でも上限を超える（題だけで 500 文字を超えるなど）ときは、末尾を削って収める
  const text = f.header + f.bullet + subjects[0];
  return [...text].slice(0, Math.max(0, f.limit - 2)).join('') + '…\n';
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? '' : '';
}

function warn(message) {
  console.error(`::warning::${message}`);
}

function main() {
  const os = process.argv[2] ?? '';
  const format = arg('--format');
  const to = arg('--to') || 'HEAD';
  const out = arg('--out');
  if (!RELEASE_PATHS[os] || !FORMATS[format]) {
    console.error('usage: node scripts/mobile-release-notes.mjs <android|ios> --format <github|play|testflight> [--from <ref>] [--to <ref>] [--out <file>]');
    process.exit(1);
  }
  const from = arg('--from') || previousTag(os, to);
  let subjects = [];
  if (from) {
    const r = changedSubjects(os, from, to);
    if (r === null) warn(`could not list changes in ${from}..${to}`);
    else subjects = r;
  }
  const text = subjects.length ? render(format, subjects) : '';
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
