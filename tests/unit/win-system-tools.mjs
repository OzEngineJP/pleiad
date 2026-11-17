// Windows の標準の道具（whoami・icacls・taskkill・tasklist・powershell・cmd）を System32 の絶対パスで呼ぶ（core/win-system.mjs）。
//   - 名前だけで呼ぶと、PATH の先頭の同名の道具が動く（Git Bash は GNU 版の whoami.exe を先頭に置き、whoami /user が落ちる）
//   - システムのフォルダーは SystemRoot → windir の順。どちらも無い・絶対パスでないなら C:\Windows
//   - core/ に、名前だけで System32 の道具を呼ぶ箇所を残さない（新しく足した呼び出しも、同じ規則で通す）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemTool, windowsRoot } from '../../core/win-system.mjs';
import { runSync } from '../../core/process.mjs';
import { ROOT, listFiles, stripComments } from '../lint-child-process.mjs';

export const name = 'win-system-tools';
export const title = 'System32 の道具は絶対パスで呼ぶ: システムのフォルダーの決め方・PATH の先頭の同名の道具に当たらない・core/ に名前だけの呼び出しを残さない';

/** 名前だけ（'whoami.exe'・'taskkill'・'powershell'・'cmd.exe'）で、子を起こす関数の第 1 引数に書かれた System32 の道具 */
const TOOLS = 'taskkill|tasklist|whoami|icacls|powershell|cmd|where|reg|wmic';
const BARE_CALL = new RegExp(`\\b(?:run|runSync|exec|spawn|spawnSync|spawnChild|spawnChildImpl|execFile|execFileSync|runProcess|runCommand)\\(\\s*['"\`](?:${TOOLS})(?:\\.exe)?['"\`]`, 'g');
/** [command, args] の組で書くもの（['tasklist', [...]]） */
const BARE_PAIR = new RegExp(`\\[\\s*['"](?:${TOOLS})(?:\\.exe)?['"]\\s*,\\s*\\[`, 'g');
/** ComSpec が無いときの控えを名前だけにするもの（process.env.ComSpec || 'cmd.exe'） */
const BARE_FALLBACK = /\|\|\s*['"]cmd(?:\.exe)?['"]/g;

export default async function (t) {
  // ---- システムのフォルダー
  t.ok('SystemRoot があればそれを使う', windowsRoot({ SystemRoot: 'D:\\Win' }) === 'D:\\Win', windowsRoot({ SystemRoot: 'D:\\Win' }));
  t.ok('SystemRoot が無ければ windir', windowsRoot({ windir: 'E:\\W' }) === 'E:\\W', windowsRoot({ windir: 'E:\\W' }));
  t.ok('どちらが先でも、SystemRoot を windir より優先する', windowsRoot({ windir: 'E:\\W', SystemRoot: 'D:\\Win' }) === 'D:\\Win');
  t.ok('大文字小文字は問わない（コピーした env は元の綴りのまま）', windowsRoot({ SYSTEMROOT: 'D:\\Win' }) === 'D:\\Win' && windowsRoot({ WINDIR: 'E:\\W' }) === 'E:\\W');
  t.ok('どちらも無ければ C:\\Windows', windowsRoot({}) === 'C:\\Windows' && windowsRoot(null) === 'C:\\Windows');
  t.ok('空・相対パスの SystemRoot は使わない（次の候補か C:\\Windows）', windowsRoot({ SystemRoot: '', windir: 'E:\\W' }) === 'E:\\W' && windowsRoot({ SystemRoot: 'Windows' }) === 'C:\\Windows' && windowsRoot({ SystemRoot: '.\\evil', windir: '..\\x' }) === 'C:\\Windows');

  // ---- 道具の絶対パス
  const env = { SystemRoot: 'D:\\Win' };
  t.ok('whoami・icacls・taskkill・tasklist・cmd は System32 の直下', ['whoami', 'icacls', 'taskkill', 'tasklist', 'cmd'].every(n => systemTool(n, env) === `D:\\Win\\System32\\${n}.exe`),
    ['whoami', 'icacls', 'taskkill', 'tasklist', 'cmd'].map(n => systemTool(n, env)).join(' | '));
  t.ok('powershell は WindowsPowerShell\\v1.0 の下', systemTool('powershell', env) === 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', systemTool('powershell', env));
  t.ok('.exe を付けても付けなくても同じ', systemTool('whoami.exe', env) === systemTool('whoami', env) && systemTool('PowerShell.EXE', env) === systemTool('powershell', env));
  t.ok('SystemRoot が無ければ C:\\Windows\\System32（名前だけには戻さない）', systemTool('taskkill', {}) === 'C:\\Windows\\System32\\taskkill.exe', systemTool('taskkill', {}));
  t.ok('SystemRoot の末尾の区切りがあっても、区切りは 1 つ', systemTool('whoami', { SystemRoot: 'D:\\Win\\' }) === 'D:\\Win\\System32\\whoami.exe', systemTool('whoami', { SystemRoot: 'D:\\Win\\' }));
  const bad = n => { try { systemTool(n, env); return null; } catch (e) { return e.message; } };
  t.ok('名前にパスの区切り・空白・空は受けない（別の場所の実行ファイルにならない）', ['..\\evil', 'a/b', 'who ami', '', 'a.exe.exe'].every(n => bad(n) !== null), ['..\\evil', 'a/b', 'who ami', '', 'a.exe.exe'].map(bad).join(' | '));

  // ---- 実機（Windows）: PATH の先頭に同名の別の道具があっても、System32 の本物が動く
  if (process.platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-wst-'));
    try {
      const real = systemTool('whoami');
      const args = ['/user', '/fo', 'csv', '/nh'];
      const SID = /S-1-\d+(?:-\d+)+/;
      const own = runSync(real, args, { timeoutMs: 15_000 });
      t.ok('実機: System32 の whoami.exe は SID を返す', own.exitCode === 0 && SID.test(own.stdout), JSON.stringify({ exit: own.exitCode, out: own.stdout.slice(0, 80), err: own.startError }));
      // 偽の whoami.exe（別の道具の実行ファイルを同じ名前で複写。Git Bash の GNU 版 whoami.exe の代わり）を PATH の先頭に置く
      fs.copyFileSync(systemTool('hostname'), path.join(dir, 'whoami.exe'));
      const hijacked = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
      const byName = runSync('whoami.exe', args, { env: hijacked, timeoutMs: 15_000 });
      t.ok('実機: 名前だけで呼ぶと PATH の先頭の偽物が動く（この試験の前提。動かなければ下の判定は何も確かめていない）', !SID.test(byName.stdout), JSON.stringify({ exit: byName.exitCode, out: byName.stdout.slice(0, 80), err: byName.startError }));
      const byPath = runSync(real, args, { env: hijacked, timeoutMs: 15_000 });
      t.ok('実機: 絶対パスで呼ぶと、PATH の先頭に偽物があっても本物の whoami.exe が動く', byPath.exitCode === 0 && SID.test(byPath.stdout), JSON.stringify({ exit: byPath.exitCode, out: byPath.stdout.slice(0, 80), err: byPath.startError }));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- core/ に名前だけの呼び出しを残さない
  const found = [];
  for (const file of listFiles(ROOT).filter(f => f.startsWith('core/') && f !== 'core/win-system.mjs')) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const re of [BARE_CALL, BARE_PAIR, BARE_FALLBACK]) {
      for (const m of code.matchAll(re)) found.push(`${file}:${code.slice(0, m.index).split('\n').length} ${m[0]}`);
    }
  }
  t.ok('core/ に、System32 の道具を名前だけで呼ぶ箇所が無い（systemTool() を通す）', found.length === 0, found.join('\n'));

  // この検査が空振りしていないこと: 既知の悪い形を見つけられる
  const sample = ["await run('whoami.exe', ['/user']);", "spawnSync('taskkill', ['/pid', '1']);", "const [c, a] = win ? ['tasklist', ['/FO']] : ['ps', []];", "file: process.env.ComSpec || 'cmd.exe'"];
  t.ok('検査の自己診断: 名前だけの呼び出しの 4 つの書き方を見つける', sample.every(s => [BARE_CALL, BARE_PAIR, BARE_FALLBACK].some(re => [...s.matchAll(re)].length > 0)), sample.map(s => [BARE_CALL, BARE_PAIR, BARE_FALLBACK].map(re => [...s.matchAll(re)].length).join('')).join(' | '));
  const okSample = ["await run(systemTool('whoami'), ['/user']);", "spawnSync(systemTool('taskkill'), []);", "process.env.ComSpec || systemTool('cmd')", "const SHELLS = ['default', 'bash', 'powershell', 'cmd'];"];
  t.ok('検査の自己診断: systemTool() を通した呼び出しと、道具名を並べただけのものは見つけない', okSample.every(s => [BARE_CALL, BARE_PAIR, BARE_FALLBACK].every(re => [...s.matchAll(re)].length === 0)));
}
