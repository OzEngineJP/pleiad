// 設定 › エージェント設定の「CLI のログイン」のカードの［ログアウト］を出すかは、能力の印 logout で決める（エージェント名では決めない）。
// 外せないエージェント（OpenCode・Antigravity）は印が impossible で、画面には logout: false だけが届く。OpenCode は代わりに、端末で打つコマンドを案内する。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENTS, DEFAULT_AGENT_IDS } from '../../core/backends/agents.mjs';
import { CAPABILITY_STATES } from '../../core/backends/agent-marks.mjs';
import { CAPABILITIES, legacyCapabilities } from '../../core/backends/capability-marks.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'agent-logout-mark';
export const title = '［ログアウト］の出し分け: 能力の印 logout・外せないエージェントの案内コマンド';

// Pleiad から外せる（auth.logout() が本当に外す）エージェント / 端末で外すエージェント
const CAN = ['claude', 'codex', 'devin', 'grok'];
const CANNOT = { antigravity: null, opencode: 'opencode auth logout' };

export default async function (t) {
  t.ok('logout は能力の印の一覧にある', 'logout' in CAPABILITIES);
  t.ok('全エージェントを CAN か CANNOT に振っている（新しいエージェントを足したら、ここで決める）',
    [...DEFAULT_AGENT_IDS].sort().join() === [...CAN, ...Object.keys(CANNOT)].sort().join(), DEFAULT_AGENT_IDS.join());
  for (const id of CAN) {
    t.ok(`${id}: 外せる（印は true）`, CAPABILITY_STATES[id]?.logout === true, JSON.stringify(CAPABILITY_STATES[id]?.logout));
    t.ok(`${id}: 画面へは logout: true`, legacyCapabilities(CAPABILITY_STATES[id]).logout === true);
  }
  for (const id of Object.keys(CANNOT)) {
    const state = CAPABILITY_STATES[id]?.logout;
    t.ok(`${id}: 外せない（印は impossible と理由）`, state?.state === 'impossible' && typeof state.reason === 'string' && state.reason.length > 0, JSON.stringify(state));
    t.ok(`${id}: 画面へは logout: false`, legacyCapabilities(CAPABILITY_STATES[id]).logout === false);
  }

  // OpenCode: サーバーの auth.logout() は外さずに失敗し、外し方のコマンドを backend が持つ（画面のカードはこれを案内する）
  const { backend: opencode } = await import('../../core/backends/opencode.mjs');
  let message = null;
  try { await opencode.auth.logout(); } catch (e) { message = e.message; }
  t.ok('opencode: auth.logout() は外さずに失敗する（端末で外す案内）', typeof message === 'string' && message.includes('opencode auth logout'), message);
  // 外し方のコマンドは、ログインの案内と同じ書き方（見つけた CLI の場所 + auth ○○。CLI が無ければ名前だけ）
  const savedBin = process.env.AGENT_HOST_OPENCODE_BIN;
  try {
    process.env.AGENT_HOST_OPENCODE_BIN = `missing-pleiad-logout-mark-${process.pid}`;
    t.ok('opencode: CLI が無くても外し方は案内できる（opencode auth logout）', typeof opencode.auth.logoutCommand === 'function' && opencode.auth.logoutCommand() === 'opencode auth logout', String(opencode.auth.logoutCommand?.()));
    process.env.AGENT_HOST_OPENCODE_BIN = `"${process.execPath}" --no-warnings`;
    const command = opencode.auth.logoutCommand();
    t.ok('opencode: CLI が見つかれば、その場所で書く（空白を含む場所は引用符。ログインの案内と同じ）',
      command === `${/\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath} --no-warnings auth logout`, command);
  } finally {
    if (savedBin === undefined) delete process.env.AGENT_HOST_OPENCODE_BIN; else process.env.AGENT_HOST_OPENCODE_BIN = savedBin;
  }

  // 画面が読む記述（describeBackends）: 印・メソッドの有無・案内のコマンドがそろって届く。実際の CLI は起動しない
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-logout-mark-'));
  try {
    const index = pathToFileURL(path.join(ROOT, 'core/backends/index.mjs')).href;
    const source = `const r = await import(${JSON.stringify(index)}); console.log(JSON.stringify(r.describeBackends().map(b => ({ id: b.id, logout: b.capabilities.logout, logoutCommand: b.logoutCommand }))));`;
    const rows = await new Promise((resolve, reject) => {
      const env = { ...process.env, AGENT_HOST_DATA: path.join(scratch, 'data') };
      delete env.AGENT_HOST_BACKENDS;
      for (const a of Object.values(AGENTS)) if (a.cli) env[a.cli.binEnv] = `missing-pleiad-contract-${process.pid}`;
      execFile(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, env, timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`)); else {
          try { resolve(JSON.parse(stdout.trim())); } catch (e) { reject(e); }
        }
      });
    });
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    for (const id of CAN) t.ok(`${id}: 画面の記述は logout: true（案内のコマンドは無し）`, by[id]?.logout === true && !by[id].logoutCommand, JSON.stringify(by[id]));
    for (const [id, command] of Object.entries(CANNOT)) {
      t.ok(`${id}: 画面の記述は logout: false${command ? `・案内は ${command}` : '（案内のコマンドは無し）'}`,
        by[id]?.logout === false && (by[id].logoutCommand ?? null) === command, JSON.stringify(by[id]));
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
