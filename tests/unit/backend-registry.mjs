// 登録・CLI の発見・画面の記述を、エージェントの一覧から全件確かめる。実際の CLI は起動しない。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENTS, DEFAULT_AGENT_IDS, agentPresentation } from '../../core/backends/agents.mjs';
import { cliCommand, installation, INSTALL_URLS, findExecutable } from '../../core/cli-installation.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'backend-registry';
export const title = '全エージェントの登録・CLI 差し替え・インストール案内・既定と指定順の記述';

export default async function (t) {
  for (const [id, agent] of Object.entries(AGENTS)) {
    if (!agent.cli) continue;
    const { binEnv, installUrl } = agent.cli;
    const saved = process.env[binEnv];
    try {
      process.env[binEnv] = `missing-pleiad-contract-${id}-${process.pid}`;
      t.ok(`${id}: CLI が無ければインストールの案内を返す`, cliCommand(id) === null && !installation(id).installed && INSTALL_URLS[id] === installUrl);
      process.env[binEnv] = `"${process.execPath}" --no-warnings`;
      const argv = cliCommand(id);
      t.ok(`${id}: 個別の環境変数で CLI と引数を差し替えられる`, argv?.[0] === process.execPath && argv?.[1] === '--no-warnings', JSON.stringify(argv));
    } finally {
      if (saved === undefined) delete process.env[binEnv]; else process.env[binEnv] = saved;
    }
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-registry-'));
  try {
    const winBin = path.join(scratch, 'devin', 'cli', 'bin');
    await fs.mkdir(winBin, { recursive: true });
    await fs.writeFile(path.join(winBin, 'devin.exe'), '');
    t.ok('Windows の公式インストール先は PATH の更新前にも見つかる',
      findExecutable('devin', { LOCALAPPDATA: scratch }, 'win32') === path.join(winBin, 'devin.exe'));
    const index = pathToFileURL(path.join(ROOT, 'core/backends/index.mjs')).href;
    const source = `const r = await import(${JSON.stringify(index)}); console.log(JSON.stringify(r.describeBackends()));`;
    const readRegistry = (ids) => new Promise((resolve, reject) => {
      const env = { ...process.env, AGENT_HOST_DATA: path.join(scratch, 'data') };
      if (ids === null) delete env.AGENT_HOST_BACKENDS; else env.AGENT_HOST_BACKENDS = ids.join(',');
      for (const a of Object.values(AGENTS)) if (a.cli) env[a.cli.binEnv] = `missing-pleiad-contract-${process.pid}`;
      execFile(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, env, timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`)); else {
          try { resolve(JSON.parse(stdout.trim())); } catch (e) { reject(e); }
        }
      });
    });
    const defaults = await readRegistry(null);
    t.ok('既定のレジストリは試験用以外を記述順に含む（CLI を起動せず読める）', defaults.map((b) => b.id).join() === DEFAULT_AGENT_IDS.join(), defaults.map((b) => b.id).join());
    for (const b of defaults) {
      const a = agentPresentation(b.id);
      t.ok(`${b.id}: 画面の記述はエージェントの記述から来る`, b.shortLabel === a.shortLabel && JSON.stringify(b.brand) === JSON.stringify(a.brand) && b.idleCompaction === a.idleCompaction);
    }
    const reverse = [...Object.keys(AGENTS)].reverse();
    const selected = await readRegistry(['unknown-contract-backend', ...reverse, 'unknown-contract-backend']);
    t.ok('指定順の全エージェントを含み、未知の id は除く', selected.map((b) => b.id).join() === reverse.join(), selected.map((b) => b.id).join());
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
