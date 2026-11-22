const fs = require('node:fs/promises');
const path = require('node:path');
const { t } = require('./i18n.cjs');

// Each accepted request keeps its own receipt across both process lifetimes.
// Request IDs are supplied before the call so a lost reply can be recovered.
function createLifecycle({ dir, updates, unsupported, flush, lock, unlock, stop, boot, log }) {
  let operation = null;
  const file = id => path.join(dir, id.toLowerCase() + '.json');
  const validId = id => typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id);
  async function read(id) {
    try { return JSON.parse(await fs.readFile(file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function save(receipt) {
    const { writeAtomic } = await import('../core/atomic-file.mjs');
    await writeAtomic(file(receipt.requestId), JSON.stringify(receipt), { mode: 0o600 });
  }
  const publicResult = ({ owner, previous, ...result }) => result;
  const capability = reason => ({ supported: !reason, reason: reason || null });
  function status(result = null) {
    const { version, channel, target, phase, progress, error, enabled } = updates.snapshot();
    const reason = unsupported();
    return { version, channel, target: target ?? null, phase, progress: progress ?? null, error: error ?? null,
      prepare: capability(reason || (!enabled && t('update.unavailable'))),
      apply: capability(reason || (!enabled && t('update.unavailable'))),
      restart: capability(reason), result };
  }
  async function request(action, { requestId, targetVersion } = {}, owner = null, { screen = false } = {}) {
    if (requestId !== undefined && !validId(requestId)) throw new Error(t('lifecycle.invalidRequest'));
    if (!['status', 'prepare', 'install', 'restart'].includes(action)) throw new Error(t('update.unknownAction'));
    if (action === 'status') {
      const receipt = requestId && await read(requestId);
      return status(receipt?.owner === owner ? publicResult(receipt) : null);
    }
    if (action === 'install' || action === 'restart') {
      if (!validId(requestId)) throw new Error(t('lifecycle.invalidRequest'));
      const receipt = await read(requestId);
      if (receipt) {
        if (receipt.owner !== owner || receipt.action !== action || receipt.targetVersion !== targetVersion)
          throw new Error(t('lifecycle.requestConflict'));
        return publicResult(receipt);
      }
    }
    const current = status();
    const availability = current[action === 'install' ? 'apply' : action];
    if (!availability.supported && !(screen && action === 'install' && updates.enabled))
      throw new Error(availability.reason);
    if (operation || updates.busy) throw new Error(t('update.busy'));
    operation = action;
    if (action === 'prepare') {
      try { await updates.command('prepare'); return status(); }
      finally { operation = null; }
    }
    let releaseDrafts, lockId;
    try {
      if (action === 'install' && current.phase !== 'downloaded') throw new Error(t('update.notDownloaded'));
      if (targetVersion !== (action === 'install' ? current.target : current.version))
        throw new Error(t('lifecycle.versionChanged'));
      releaseDrafts = await flush();
      lockId = requestId;
      await lock(lockId);
      const receipt = { requestId: requestId.toLowerCase(), action, targetVersion, owner, previous: boot(), state: 'accepted' };
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await save(receipt);
      async function finish() {
        try { await stop(action); }
        catch (error) {
          try { await save({ ...receipt, state: 'failed', error: String(error.message ?? error).slice(0, 500) }); }
          catch (writeError) { log(writeError); }
          return error;
        } finally { operation = null; }
        return null;
      }
      if (screen) {
        const error = await finish();
        if (error) throw error;
      } else {
        // Let the IPC reply go out before the server closes its connections.
        setImmediate(async () => {
          const error = await finish();
          if (error) { unlock(lockId); releaseDrafts(); }
        });
      }
      return publicResult(receipt);
    } catch (error) {
      if (lockId) unlock(lockId);
      releaseDrafts?.();
      operation = null;
      throw error;
    }
  }
  async function reconcile() {
    const current = boot();
    const files = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of files) {
      const id = path.basename(name, '.json');
      if (!name.endsWith('.json') || !validId(id)) continue;
      const receipt = await read(id);
      if (receipt?.state !== 'accepted' || receipt.previous.main === current.main || !current.server?.pid) continue;
      // A fresh main may briefly reattach to the older server before switching.
      if (current.switching && current.version === receipt.targetVersion) continue;
      const previousServer = receipt.previous.server;
      const restarted = current.server.pid !== previousServer?.pid ||
        (current.server.startedAt && previousServer?.startedAt && current.server.startedAt !== previousServer.startedAt);
      const succeeded = restarted &&
        current.version === receipt.targetVersion && current.serverVersion === receipt.targetVersion;
      await save({ ...receipt, state: succeeded ? 'succeeded' : 'failed', version: current.version,
        serverVersion: current.serverVersion, ...(succeeded ? {} : { error: t('lifecycle.bootMismatch') }) });
    }
  }
  return { request, reconcile,
    get busy() { return operation !== null; },
    get stopping() { return operation === 'install' || operation === 'restart'; },
  };
}

module.exports = { createLifecycle };
