'use strict';
// Chrome 自身の画面（リモート デバッグの確認・chrome://inspect のトグル）を UI Automation で押す（ADR 0218）。
// UI Automation は .NET の UIAutomationClient を Windows PowerShell 5.1 から呼ぶ（koffi から COM を組むより小さく、どの Windows にもある）。
// 中身は win32-uia.ps1。頼みは環境変数 PLEIAD_UIA（JSON）で渡し、答えは標準出力の最後の 1 行の JSON。マウス・キーボードの入力は使わない。
// 呼ぶのは確認の窓を見つけたとき・人が「オンにしてつなぐ」を押したときだけなので、1 回ごとに PowerShell を起こす（0.5〜2 秒）。
const { run } = require('../process.cjs');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, 'win32-uia.ps1');
const DEFAULT_TIMEOUT_MS = 20_000;
let encoded = null;

/** スクリプトを -EncodedCommand の形（UTF-16LE の base64）にする。読めなければ null */
function encodedScript(read = () => fs.readFileSync(SCRIPT_PATH, 'utf8')) {
  if (encoded) return encoded;
  try { encoded = Buffer.from(read(), 'utf16le').toString('base64'); } catch { return null; }
  return encoded;
}

/** 標準出力の最後の JSON の行。無ければ null */
function lastJson(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* 次の行 */ }
  }
  return null;
}

/**
 * @param {{ runFile?: (command: string, args: string[], options: object) => Promise<{ stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, startError?: string }>, env?: NodeJS.ProcessEnv, script?: string|null, log?: (line: string) => void }} deps
 * @returns {(request: object, options?: { timeoutMs?: number }) => Promise<{ ok: boolean, reason?: string, [key: string]: any }>}
 */
function createUiaRunner({ runFile = run, env = process.env, script = undefined, log = () => {} } = {}) {
  return async (request, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    const command = script === undefined ? encodedScript() : script;
    if (!command) return { ok: false, reason: 'no-script' };
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await runFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command],
      { env: { ...env, PLEIAD_UIA: JSON.stringify(request) }, windowsHide: true, timeoutMs, maxOutputChars: 64 * 1024 });
    const parsed = lastJson(result.stdout);
    if (parsed && typeof parsed.ok === 'boolean') return parsed;
    log(`chrome-os: uia ${request?.op} failed: ${result.timedOut ? 'timeout' : (result.startError ?? result.exitCode ?? 'no-result')}`);
    return { ok: false, reason: result.timedOut ? 'timeout' : 'no-result' };
  };
}

module.exports = { createUiaRunner, lastJson, encodedScript, SCRIPT_PATH };
