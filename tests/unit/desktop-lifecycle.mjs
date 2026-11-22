import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { createDesktopLifecycleClient } from '../../core/desktop-lifecycle.mjs';
import { appOps } from '../../core/ops/app.mjs';
import { createRegistry } from '../../core/ops/registry.mjs';
import { createUpdateGate } from '../../core/update-gate.mjs';

const require = createRequire(import.meta.url);
const { createLifecycle } = require('../../desktop/lifecycle.cjs');
const { Updates } = require('../../desktop/updates.cjs');

export const name = 'desktop-lifecycle';
export const title = 'Desktop lifecycle authorization, preflight and durable results';

class Updater extends EventEmitter {
  checks = 0;
  downloads = 0;
  async checkForUpdates() {
    this.checks++;
    this.emit('update-available', { version: '1.1.0' });
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit('update-downloaded');
  }
}

export default async function (t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-lifecycle-'));
  try {
    const dir = path.join(temp, 'receipts');
    const updater = new Updater();
    const updates = new Updates({ updater, enabled: true, version: '1.0.0', file: path.join(temp, 'updates.json') });
    await updates.init();
    const events = [];
    let unsafeDraft, blocked, unsupported, failingStop, dropReply;
    let boot = { main: 'first', server: { pid: 11, startedAt: 1 }, version: '1.0.0', serverVersion: '1.0.0' };
    const options = {
      dir, updates, boot: () => boot, unsupported: () => unsupported,
      flush: async () => {
        events.push('flush');
        if (unsafeDraft) throw new Error('draft save failed');
        return () => events.push('unfreeze');
      },
      lock: async () => {
        events.push('lock');
        if (blocked) throw new Error('running work cannot resume');
      },
      unlock: () => events.push('unlock'),
      stop: async action => {
        events.push(action);
        if (failingStop) throw new Error('installer failed');
      },
      log: error => { throw error; },
    };
    let desktop = createLifecycle(options);
    const connect = () => {
      const port = new EventEmitter();
      port.hosted = true;
      port.postMessage = ({ type, id, action, args, owner }) => {
        void desktop.request(action, args, owner).then(
          result => {
            if (dropReply && action === 'restart') { dropReply = false; port.emit('disconnect'); }
            else port.emit('message', { data: { type, id, ok: true, result } });
          },
          error => port.emit('message', { data: { type, id, ok: false, error: error.message } }),
        );
        return true;
      };
      return createDesktopLifecycleClient({ port, version: boot.serverVersion });
    };
    const registry = createRegistry({ ops: appOps });
    let lifecycle = connect();
    const invoke = (op, args, sessionId = 'origin', via = 'mcp', approve) => registry.invoke(
      { by: 'agent', via, sessionId }, op, args, {
        locale: 'en', app: { lifecycle }, approve,
        modeOf: async id => ({
          scope: id === 'plan' ? 'readonly' : 'full', autonomy: id === 'ask' ? 'ask' : 'never',
        }),
      },
    );
    const status = (requestId, owner) => invoke('app.updateStatus', requestId ? { requestId } : {}, owner);
    const restart = { requestId: randomUUID(), targetVersion: '1.0.0' };
    const looked = await status();
    t.ok('Status reports the current version and causes no writes or downloads', looked.ok &&
      looked.result.version === '1.0.0' && looked.result.restart.supported &&
      updater.checks === 0 && updater.downloads === 0 && (await fs.readdir(temp)).join() === 'updates.json');
    await updates.command('preferences', { channel: 'beta', autoCheck: false, autoDownload: false });
    const prepared = await invoke('app.updatePrepare', {}, 'origin', 'cli');
    t.ok('Prepare downloads on the configured channel without applying', prepared.ok &&
      prepared.result.phase === 'downloaded' && prepared.result.target === '1.1.0' &&
      prepared.result.channel === 'beta' && updater.channel === 'beta' && updates.state.autoDownload === false &&
      updater.checks === 1 && updater.downloads === 1 && !events.length);
    const apply = { requestId: randomUUID(), targetVersion: '1.1.0' };
    for (const [op, args] of [['app.restart', restart], ['app.updateApply', apply]]) {
      t.ok(`${op} follows read-only, approval and unbound-agent rules`,
        (await invoke(op, args, 'plan')).code === 'READ_ONLY_MODE' &&
        (await invoke(op, args, 'ask')).code === 'NEEDS_APPROVAL' &&
        (await invoke(op, args, null, 'cli')).code === 'NEEDS_UI' && !events.length);
    }

    for (const reason of ['Microsoft Store build', 'independent server required']) {
      unsupported = reason;
      const unavailable = (await status()).result;
      t.ok(`Status explains unsupported operations for ${reason}`, ['restart', 'prepare', 'apply'].every(
        key => unavailable[key].supported === false && unavailable[key].reason === reason,
      ));
      t.ok('An unsupported action returns its reason before saving drafts', (await invoke('app.restart', restart)).error === reason && !events.length);
    }
    unsupported = null;
    const standalone = createDesktopLifecycleClient({ port: Object.assign(new EventEmitter(), { hosted: false }), version: '1.0.0' });
    const serverStatus = await standalone('status', {});
    t.ok('A standalone server returns a reason for unavailable desktop actions', !serverStatus.restart.supported && Boolean(serverStatus.restart.reason));

    unsafeDraft = true;
    t.ok('Failed draft saves refuse to stop or acquire the gate', (await invoke('app.restart', restart)).error === 'draft save failed' &&
      events.join(',') === 'flush' && (await status(restart.requestId)).result.result === null);
    unsafeDraft = false;
    events.length = 0;
    blocked = true;
    t.ok('Work without a recovery path prevents shutdown and releases the renderer', (await invoke('app.restart', restart)).error === 'running work cannot resume' &&
      events.join(',') === 'flush,lock,unlock,unfreeze');
    blocked = false;
    events.length = 0;

    const gate = createUpdateGate();
    const doneOrigin = gate.enter({ turn: true }), doneOther = gate.enter({ turn: true });
    const doneWrite = gate.enter();
    t.ok('Two resumable turns do not allow shutdown while a separate write is active', !gate.acquire(false, { preservedTurns: 2 }));
    doneWrite();
    t.ok('The shutdown gate allows both verified turns and protects the lease', !gate.acquire(false, { preservedTurns: 1 }) &&
      gate.acquire(false, { preservedTurns: 2, owner: restart.requestId }));
    gate.release('another-operation');
    t.ok('A different operation cannot release the active shutdown lease', gate.locked);
    gate.release(restart.requestId);
    doneOrigin();
    doneOther();

    let proceed;
    const pending = await invoke('app.restart', restart, 'ask', 'mcp', approval => {
      proceed = approval.proceed;
      return { pending: true, requestId: 'approval-id' };
    });
    t.ok('The ask mode waits for approval before saving drafts or stopping', pending.pending && typeof proceed === 'function' && !events.length);
    dropReply = true;
    const first = await proceed();
    t.ok('The caller can lose its connection after acceptance and before receiving the reply', first.code === 'DESKTOP_UNAVAILABLE');
    lifecycle = connect();
    const accepted = await status(restart.requestId, 'ask');
    t.ok('The receipt is readable after a lost reply', accepted.result.result?.state === 'accepted');
    const duplicate = await proceed();
    await setImmediate();
    t.ok('Accepted is durable before stop and a duplicate dispatches only once',
      duplicate.ok && duplicate.result.state === 'accepted' && events.join(',') === 'flush,lock,restart');
    t.ok('A different conversation cannot read or reuse the receipt', (await status(restart.requestId, 'other')).result.result === null &&
      !(await invoke('app.restart', restart, 'other')).ok);
    desktop = createLifecycle(options);
    lifecycle = connect();
    boot = { ...boot, main: 'second', server: { pid: 11, startedAt: 2 }, restartRequest: restart.requestId };
    await desktop.reconcile();
    const after = (await status(restart.requestId, 'ask')).result.result;
    t.ok('The original conversation recovers success using the same request ID on a new connection', after?.state === 'succeeded' &&
      after.version === '1.0.0' && after.serverVersion === '1.0.0' && (await proceed()).result.state === 'succeeded' &&
      events.join(',') === 'flush,lock,restart');

    events.length = 0;
    await desktop.request('install', apply, null, { screen: true });
    t.ok('Settings uses the same draft, gate and stop sequence', events.join(',') === 'flush,lock,install');
    boot = { ...boot, main: 'third', server: { pid: 12 }, version: '1.1.0', updateRequest: apply.requestId };
    await desktop.reconcile();
    t.ok('The wrong server version records a durable failure', (await desktop.request('status', { requestId: apply.requestId })).result.state === 'failed');

    failingStop = true;
    const failed = { requestId: randomUUID(), targetVersion: '1.1.0' };
    events.length = 0;
    await invoke('app.updateApply', failed);
    let failedReceipt;
    for (let attempt = 0; attempt < 100 && !events.includes('unfreeze'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      failedReceipt = (await status(failed.requestId)).result.result;
    }
    t.ok('A failed application records the reason and releases the gate and renderer', failedReceipt?.state === 'failed' &&
      failedReceipt.error === 'installer failed' && events.join(',') === 'flush,lock,install,unlock,unfreeze');

    const receipts = path.join(temp, 'retention');
    await fs.mkdir(receipts);
    const clock = Date.now(), day = 86_400_000;
    const previous = { main: 'old', server: { pid: 10 }, version: '1.0.0' };
    const file = id => path.join(receipts, `${id}.json`);
    const put = async (id, fields = {}) => fs.writeFile(file(id), JSON.stringify({
      requestId: id, action: 'restart', targetVersion: '1.0.0', owner: null, state: 'accepted', previous, ...fields,
    }));
    const damaged = '00000000-0000-0000-0000-000000000001';
    const invalidShape = randomUUID(), laterDamaged = randomUUID(), valid = randomUUID(), wrongLaunch = randomUUID(), fresh = randomUUID();
    await fs.writeFile(file(damaged), '{');
    await fs.writeFile(file(invalidShape), '{}');
    await put(valid);
    await put(wrongLaunch);
    await put(fresh, { state: 'failed' });
    for (let i = 0; i < 150; i++) {
      const id = randomUUID(), old = new Date(clock - 31 * day);
      await put(id, { state: i % 2 ? 'succeeded' : 'failed' });
      await fs.utimes(file(id), old, old);
    }
    const errors = [];
    desktop = createLifecycle({ ...options, dir: receipts, now: () => clock, log: error => errors.push(error) });
    boot = { main: 'new', server: { pid: 20 }, version: '1.0.0', serverVersion: '1.0.0', restartRequest: valid };
    await desktop.reconcile();
    const result = async requestId => (await desktop.request('status', { requestId })).result;
    t.ok('Damaged receipts are isolated without blocking reconciliation; quarantined IDs cannot run again',
      errors.length === 2 && (await fs.stat(file(damaged) + '.invalid')).isFile() &&
      (await fs.stat(file(invalidShape) + '.invalid')).isFile() && (await result(valid)).state === 'succeeded' &&
      await desktop.request('restart', { requestId: damaged, targetVersion: '1.0.0' }).then(() => false, () => true));
    t.ok('A new unrelated boot cannot turn an unfinished same-version receipt into success', (await result(wrongLaunch)).state === 'failed');
    t.ok('Expired final results are pruned and recent results are readable', (await fs.readdir(receipts)).length === 5 && (await result(fresh)).state === 'failed');
    await fs.writeFile(file(laterDamaged), '{');
    await desktop.reconcile();
    t.ok('A reconnect processes pending requests without sweeping final receipts again', errors.length === 2 && (await fs.stat(file(laterDamaged))).isFile());

    const installId = randomUUID(), otherInstall = randomUUID();
    await put(installId, { action: 'install', targetVersion: '1.1.0' });
    await put(otherInstall, { action: 'install', targetVersion: '1.1.0' });
    boot = { ...boot, version: '1.1.0', serverVersion: '1.1.0', updateRequest: installId };
    desktop = createLifecycle({ ...options, dir: receipts, now: () => clock, log: error => errors.push(error) });
    await desktop.reconcile();
    t.ok('Only the installer dispatch for this request can succeed on the new version',
      (await result(installId)).state === 'succeeded' && (await result(otherInstall)).state === 'failed');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
