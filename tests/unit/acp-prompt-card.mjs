import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevinBackend } from '../../core/backends/devin.mjs';
import { createGrokBackend } from '../../core/backends/grok.mjs';
import { holderLink } from '../../core/holder/link.mjs';

export const name = 'acp-prompt-card';
export const title = 'ACP の再起動用の記録は、最初の保存から応答を待つ要求の id を持つ';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-acp-prompt-card-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const cwd = path.join(scratch, 'work');
  await fs.mkdir(cwd, { recursive: true });
  const names = ['AGENT_HOST_RUNTIME_ROOT', 'AGENT_HOST_DEVIN_HOLDER', 'AGENT_HOST_GROK_HOLDER'];
  const before = new Map(names.map(name => [name, process.env[name]]));
  process.env.AGENT_HOST_RUNTIME_ROOT = root;
  process.env.AGENT_HOST_DEVIN_HOLDER = 'on';
  process.env.AGENT_HOST_GROK_HOLDER = 'on';
  let holder = null;
  try {
    holder = await holderLink({ dataDir, root, idleMs: 1000 });
    for (const [backendId, factory, model] of [
      ['devin', createDevinBackend, 'swe-2-high'],
      ['grok', createGrokBackend, 'grok-4.6'],
    ]) {
      const command = [process.execPath, fileURLToPath(new URL(`../lib/fake-${backendId}.mjs`, import.meta.url))];
      const backend = factory({ command: () => command, dataDir });
      const snapshots = [];
      const control = { touch: () => snapshots.push(structuredClone(control.backendCard())) };
      await backend.runTurn({ cwd, prompt: 'prompt-card', model, control, emit: () => {} });
      const initial = snapshots[0]?.[backendId];
      t.ok(`${backendId}: 最初に保存する要求 id が確定している`,
        typeof initial?.promptId === 'string' || typeof initial?.promptId === 'number', JSON.stringify(initial));
    }
  } finally {
    if (holder) {
      const holderPid = holder.pid;
      holder.shutdown();
      holder.close();
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        try { process.kill(holderPid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
