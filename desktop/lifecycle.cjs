const fs = require('node:fs/promises');
const path = require('node:path');
const { t } = require('./i18n.cjs');
const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_RECEIPT = Symbol('future receipt format');
const validId = id => typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id);
const receiptFile = (dir, id) => path.join(dir, id.toLowerCase() + '.json');

async function readReceipt(file, id) {
  try {
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number.isInteger(receipt?.schemaVersion) && receipt.schemaVersion > 1) return FUTURE_RECEIPT;
    if (receipt?.requestId !== id.toLowerCase() || !['install', 'restart'].includes(receipt?.action) ||
        !['accepted', 'succeeded', 'failed'].includes(receipt?.state) || typeof receipt.targetVersion !== 'string' ||
        typeof receipt.previous?.main !== 'string') throw new SyntaxError(t('lifecycle.failed'));
    return receipt;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeReceipt(file, receipt) {
  const { writeAtomic } = await import('../core/atomic-file.mjs');
  await writeAtomic(file, JSON.stringify({ ...receipt, schemaVersion: 1 }), { mode: 0o600 });
}

// Only the matching desktop relaunch can consume an accepted receipt for queue recovery.
async function claimQueuedResume({ dir, requestId, action, version, isAlive }) {
  if (!validId(requestId)) return false;
  const file = receiptFile(dir, requestId);
  try {
    const receipt = await readReceipt(file, requestId);
    const pid = receipt?.previous?.server?.pid;
    if (receipt?.state !== 'accepted' || receipt.action !== action || receipt.targetVersion !== version ||
        (receipt.schemaVersion !== undefined && receipt.schemaVersion !== 1) || !receipt.previous.main ||
        receipt.queuedResumeClaimed !== undefined || !Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) return false;
    await writeReceipt(file, { ...receipt, queuedResumeClaimed: true });
    return true;
  } catch { return false; }
}

// Each accepted request keeps its own receipt across both process lifetimes.
// Request IDs are supplied before the call so a lost reply can be recovered.
function createLifecycle({ dir, updates, unsupported, flush, lock, unlock, stop, boot, log, now = Date.now }) {
  let operation = null;
  let nextSweep = 0;
  const pending = new Set();
  const file = id => receiptFile(dir, id);
  const invalidFile = id => `${file(id)}.invalid`;
  const read = id => readReceipt(file(id), id);
  async function save(receipt) {
    await writeReceipt(file(receipt.requestId), receipt);
    if (receipt.state === 'accepted') pending.add(receipt.requestId);
    else pending.delete(receipt.requestId);
  }
  const publicResult = ({ owner, previous, schemaVersion, queuedResumeClaimed, ...result }) => result;
  async function quarantined(id) {
    return Boolean(await fs.stat(invalidFile(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  }
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
      if (!requestId) return status();
      const receipt = await read(requestId).catch(error => { if (!(error instanceof SyntaxError)) throw error; return null; });
      if (receipt?.owner === owner) return status(publicResult(receipt));
      if (!receipt && await quarantined(requestId))
        return status({ requestId: requestId.toLowerCase(), state: 'unknown', error: t('lifecycle.damagedReceipt') });
      return status();
    }
    if (action === 'install' || action === 'restart') {
      if (!validId(requestId)) throw new Error(t('lifecycle.invalidRequest'));
      const receipt = await read(requestId);
      if (receipt === FUTURE_RECEIPT) throw new Error(t('lifecycle.requestConflict'));
      if (receipt) {
        if (receipt.owner !== owner || receipt.action !== action || receipt.targetVersion !== targetVersion)
          throw new Error(t('lifecycle.requestConflict'));
        return publicResult(receipt);
      }
      if (await quarantined(requestId)) throw new Error(t('lifecycle.requestConflict'));
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
        try { await stop(action, receipt.requestId); }
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
  async function isolateDamagedReceipt(id, error) {
    log(error);
    if (!(error instanceof SyntaxError)) return;
    // Keep this ID reserved while its damaged record is quarantined.
    try {
      const isolatedAt = new Date(now());
      await fs.utimes(file(id), isolatedAt, isolatedAt);
      await fs.rename(file(id), invalidFile(id));
      pending.delete(id);
    }
    catch (moveError) { log(moveError); }
  }
  async function sweep() {
    const time = now();
    if (time < nextSweep) return;
    const files = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    nextSweep = time + DAY_MS;
    for (const name of files) {
      const match = /^(.+)\.json(\.invalid)?$/.exec(name);
      if (!match || !validId(match[1])) continue;
      const [, id, invalid] = match;
      try {
        const entry = invalid ? null : await read(id);
        if (entry === FUTURE_RECEIPT) continue;
        if (entry?.state === 'accepted') pending.add(id);
        else if (entry || invalid) {
          const target = path.join(dir, name);
          if ((await fs.stat(target)).mtimeMs < time - 30 * DAY_MS) await fs.unlink(target);
        }
      } catch (error) { await isolateDamagedReceipt(id, error); }
    }
  }
  async function reconcile() {
    await sweep();
    const current = boot();
    for (const id of pending) {
      try {
        const receipt = await read(id);
        if (receipt?.state !== 'accepted') { pending.delete(id); continue; }
        if (receipt.previous.main === current.main || !current.server?.pid) continue;
        // A fresh main may briefly reattach to the older server before switching.
        if (current.switching && current.version === receipt.targetVersion) continue;
        const previousServer = receipt.previous.server;
        const restarted = current.server.pid !== previousServer?.pid ||
          (current.server.startedAt && previousServer?.startedAt && current.server.startedAt !== previousServer.startedAt);
        const expectedLaunch = receipt.action === 'restart' ? current.restartRequest === id : current.updateRequest === id;
        const succeeded = expectedLaunch && restarted &&
          current.version === receipt.targetVersion && current.serverVersion === receipt.targetVersion;
        await save({ ...receipt, state: succeeded ? 'succeeded' : 'failed', version: current.version,
          serverVersion: current.serverVersion, ...(succeeded ? {} : { error: t('lifecycle.bootMismatch') }) });
      } catch (error) { await isolateDamagedReceipt(id, error); }
    }
  }
  return { request, reconcile,
    get busy() { return operation !== null; },
    get stopping() { return operation === 'install' || operation === 'restart'; },
  };
}

module.exports = { createLifecycle, claimQueuedResume };
