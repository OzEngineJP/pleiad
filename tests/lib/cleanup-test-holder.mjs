import { setTimeout as delay } from 'node:timers/promises';
import { connectHolder } from '../../core/holder/client.mjs';
import { defaultHolderRoot } from '../../core/process.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Stop only the holder and children owned by this test's isolated data directory. */
export async function cleanupTestHolder(dataDir, root = defaultHolderRoot(dataDir)) {
  if (!dataDir) return;
  const client = await connectHolder({ dataDir, root }).catch(error => {
    if (error.code === 'HOLDER_NONE') return null;
    throw error;
  });
  if (!client) return;
  const pids = [...new Set([client.pid, ...(client.welcome.children ?? []).filter(child => child.alive).map(child => child.pid)].filter(Number.isInteger))];
  client.shutdown();
  client.close();
  const deadline = Date.now() + 15_000;
  while (pids.some(alive) && Date.now() < deadline) await delay(50);
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  const killDeadline = Date.now() + 5_000;
  while (pids.some(alive) && Date.now() < killDeadline) await delay(50);
  if (pids.some(alive)) throw new Error(`test holder processes did not exit: ${pids.filter(alive).join(', ')}`);
}
