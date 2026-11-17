// Windows の標準の道具（whoami・icacls・taskkill・tasklist・powershell・cmd）を、System32 の絶対パスで呼ぶための名前の解決。
//
// 名前（'whoami.exe'・'taskkill'）だけで子を起こすと、PATH の先頭から探される。Git Bash・MSYS2 は PATH の先頭に自前の
// whoami.exe（GNU 版。/user を知らない）などを置くので、Windows の道具ではないものが動いて落ちる。
// 呼ぶ側は Windows の分岐の中で systemTool('whoami') のように使い、返ったパスをそのまま run()・runSync() の command に渡す。
//
// システムのフォルダー（System32 の親）は SystemRoot → windir（大文字小文字は問わない）の順に読み、どちらも無い・絶対パスでない
// ときは C:\Windows とみなす（core/main-away.mjs・core/os-open.mjs の explorer.exe と同じ規則）。名前だけの呼び出しには戻さない
// （戻すと、PATH の先頭にある別の同名の道具が動く元の不具合に戻る）。C:\Windows に道具が無ければ、起こせなかった（startError・ENOENT）として
// 呼ぶ側の失敗の扱いに乗る。
//
// このモジュールは node:path だけを読む（core/process.mjs・core/proc-track.mjs など、子を起こす口の側からも読むため）。
import path from 'node:path';

const DEFAULT_ROOT = 'C:\\Windows';
/** System32 の直下ではなく、サブフォルダーにある道具 */
const SUBDIR = Object.freeze({ powershell: 'WindowsPowerShell\\v1.0' });

/** Windows のシステムのフォルダー（普通は C:\Windows）。env の SystemRoot・windir（大文字小文字は問わない）のうち最初の絶対パス。無ければ C:\Windows */
export function windowsRoot(env = process.env) {
  const named = new Map(Object.entries(env ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of ['systemroot', 'windir']) {
    const value = named.get(key);
    if (typeof value === 'string' && value && path.win32.isAbsolute(value)) return value;
  }
  return DEFAULT_ROOT;
}

/**
 * System32 の道具の絶対パス（Windows の書き方。区切りは \）。name は 'whoami'・'whoami.exe' のどちらでもよい。
 * OS は見ない（呼ぶ側が Windows の分岐の中で呼ぶ。別の OS の試験が Windows の形を見る場合も同じ形を返す）
 */
export function systemTool(name, env = process.env) {
  const base = String(name).replace(/\.exe$/i, '').toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(base)) throw new Error(`Invalid system tool name: ${name}`);
  return path.win32.join(windowsRoot(env), 'System32', SUBDIR[base] ?? '', `${base}.exe`);
}
