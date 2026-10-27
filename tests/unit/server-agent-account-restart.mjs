import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { readSessions } from '../lib/data-store.mjs';
import { createAgentAccounts } from '../../core/agent-accounts.mjs';
import { createSecretStore } from '../../core/secret-store.mjs';
import { connectHolder, ensureHolder } from '../../core/holder/client.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');
export const name = 'server-agent-account-restart';
export const title = '登録アカウントの通常再起動: 2つの認証と実行中のターンを維持する';
async function until(check, label) {
  const end = Date.now() + 30_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(30);
  }
}

function holderCommandLine(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return '';
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if($p){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.CommandLine))}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) throw new Error(`could not check holder process ${pid}: ${result.stderr || result.error || result.status}`);
  return result.stdout.trim() ? Buffer.from(result.stdout.trim(), 'base64').toString('utf8') : '';
}

export default async function (t) {
  for (const backend of ['codex', 'opencode']) {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ply-account-restart-${backend}-`)));
    const dataDir = path.join(scratch, 'data'), root = path.join(scratch, 'runtime');
    const home = path.join(scratch, 'home'), state = path.join(scratch, 'state');
    await Promise.all([dataDir, home, state].map(dir => fs.mkdir(dir)));
    await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ composerSuggestions: false }));
    const registry = createAgentAccounts({ dataDir, secrets: createSecretStore({ file: path.join(dataDir, 'agent-account-secrets.json') }) });
    const accounts = [];
    for (const label of ['Work', 'Personal']) {
      const row = await registry.create({ backend, name: label });
      await registry.setCredential(row.id, { auth: { fake: backend === 'codex'
        ? { email: `${label}@example.invalid`, usedPercent: 12 }
        : { type: 'api', key: `fake-${label}` } } });
      accounts.push(await registry.get(row.id));
    }
    const gates = await createFakeGates(scratch);
    const env = { ...gates.env, AGENT_HOST_BACKENDS: backend, AGENT_HOST_HANDOVER: 'on', AGENT_HOST_CHROME_LINK: 'off',
      AGENT_HOST_RUNTIME_ROOT: root, AGENT_HOST_GRACE_MS: '600000', CODEX_HOME: home, CODEX_SQLITE_HOME: home,
      FAKE_CODEX_ACCOUNTS: '1', FAKE_CODEX_STATE_DIR: state, FAKE_CODEX_LOG: path.join(scratch, 'codex.log'),
      AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`,
      AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests/lib/fake-opencode.mjs')}"` };
    let a, b, ca, cb, link, nextLink, holderPid, failure;
    const holderChildPids = new Set();
    const ids = [];
    try {
      const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 120_000 });
      holderPid = found.pid; found.client.close();
      a = await startServer({ env, dataDir, timeoutMs: 60_000 });
      const info = await until(() => { const x = readLinkInfo(dataDir); return x?.pid === a.child.pid && x; }, 'main link');
      link = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
      link.on('message', m => { if (m.type === 'chrome-os-ready-request') link.postMessage({ type: 'chrome-os-ready', supported: false, reason: 'platform' }); if (m.type === 'secret') link.postMessage({ type:'secret', id:m.id, ok:true, value:{ available:false, backend:'none' } }); });
      await link.connect();
      ca = await open({ port: a.port, token: a.token, autoAllow: true });
      for (const account of accounts) {
        const { sessionId } = await ca.cmd('newSession', { backend, cwd: scratch });
        await ca.cmd('setTurnSettings', { sessionId, account: account.id });
        assert.equal((await ca.runTurn({ sessionId, prompt: 'hello', mode: 'full', ...(backend === 'opencode' ? { model: 'fake/echo' } : {}) })).outcome, 'ok', a.tail(20));
        ids.push(sessionId);
      }
      const mark = ca.mark();
      for (let i = 0; i < ids.length; i++) {
        void ca.cmd('sendMessage', { sessionId: ids[i], messageId: `account-restart-${i}`, prompt: `gate:account-${i}` }).catch(() => {});
        await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids[i], { from: mark, ms: 30_000 });
      }
      await until(async () => (await ca.cmd('running')).turns.filter(x => x.held).length === 2, 'two held account turns');
      await sleep(400);
      await a.stop();
      ca.close(); ca = null;
      b = await startServer({ env: { ...env, AGENT_HOST_TOKEN: a.token, AGENT_HOST_PORT: String(a.port) }, dataDir, timeoutMs: 60_000 });
      const nextInfo = await until(() => { const x = readLinkInfo(dataDir); return x?.pid === b.child.pid && x; }, 'new main link');
      nextLink = createServerLink({ pipe: nextInfo.pipe, secret: nextInfo.secret, appVersion: '0.0.1' });
      nextLink.on('message', m => { if (m.type === 'secret') nextLink.postMessage({ type:'secret', id:m.id, ok:true, value:{ available:false, backend:'none' } }); });
      await nextLink.connect();
      cb = await open({ port: b.port, token: a.token, autoAllow: true });
      for (let i = 0; i < ids.length; i++) await gates.open(`account-${i}`);
      for (let i = 0; i < ids.length; i++) {
        const end = await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[i], { ms: 30_000 });
        assert.equal(end.outcome, 'ok', b.tail(30));
        const history = await cb.cmd('loadSession', { sessionId: ids[i] });
        const expected = backend === 'codex' ? `end account-${i}` : `gate account-${i} done`;
        assert.equal(history.messages.filter(m => m.role === 'assistant' && m.text.includes(expected)).length, 1);
        assert.equal(readSessions(dataDir)[ids[i]].claudeAccount, accounts[i].id);
      }
      t.ok(`${backend}: 2アカウントの実行中ターンを同時に復元し、履歴と認証を維持する`, true);
      for (let i = 0; i < ids.length; i++) {
        const result = await cb.runTurn({ sessionId: ids[i], prompt: backend === 'opencode' ? 'account-env' : 'hello after restart' });
        assert.equal(result.outcome, 'ok', b.tail(20));
        if (backend === 'opencode') assert.equal(JSON.parse(result.events.filter(e => e.type === 'text.delta').map(e => e.text).join('')).accountId, accounts[i].id);
      }
      if (backend === 'codex') {
        const calls = (await fs.readFile(path.join(scratch, 'codex.log'), 'utf8')).trim().split('\n').map(JSON.parse);
        const homes = new Set();
        for (const account of accounts) {
          const starts = calls.filter(c => c.method === 'turn/start' && c.threadId && !c.ephemeral && path.resolve(c.home) === path.resolve(account.dir));
          assert.equal(starts.length, 3, 'initial, adopted and subsequent turn use the same account home');
          assert.equal(new Set(starts.map(c => c.pid)).size, 1, 'the original app-server survives restart');
          homes.add(starts[0].home);
        }
        assert.equal(homes.size, 2);
      }
      assert.doesNotMatch(b.tail(200), /\[unhandledRejection\]/);
      t.ok(`${backend}: 再起動後の続きのターンもそれぞれのアカウントで動く`, true);
    } catch (error) {
      error.message += `\n${(b ?? a)?.tail(40)}`;
      failure = error;
    } finally {
      const errors = [];
      const cleanup = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
      let stopped = !holderPid;
      ca?.close(); cb?.close(); try { link?.kill(); nextLink?.kill(); } catch { /* already closed */ }
      await cleanup(() => b?.stop()); await cleanup(() => a?.stop());
      await cleanup(async () => {
        const holder = await connectHolder({ dataDir, root }).catch(error => { if (error.code === 'HOLDER_NONE') return null; throw error; });
        if (holder) {
          for (const child of holder.welcome.children ?? []) if (child.pid && child.alive) holderChildPids.add(child.pid);
          if (!holder.shutdown()) throw new Error('holder shutdown could not be sent');
          await until(() => holder.byeReason === 'closing', 'holder acknowledged shutdown');
          await until(() => { try { process.kill(holderPid, 0); return false; } catch { return true; } }, 'holder shutdown');
          await sleep(250);
          const commandLine = holderCommandLine(holderPid);
          if (commandLine) {
            if (!commandLine.toLowerCase().includes('core\\holder\\main.mjs')) throw new Error(`holder pid ${holderPid} was reused by another process`);
            const killed = spawnSync('taskkill.exe', ['/PID', String(holderPid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (killed.status !== 0) throw new Error(`could not finish holder process tree ${holderPid}: ${killed.stderr || killed.error || killed.status}`);
            await until(() => holderCommandLine(holderPid) === '', 'holder process tree cleanup');
          }
          try {
            process.kill(holderPid, 0);
            process.kill(holderPid, 'SIGKILL');
            await until(() => { try { process.kill(holderPid, 0); return false; } catch { return true; } }, 'holder process tree cleanup');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
          holder.close();
          stopped = true;
        }
      });
      if (holderPid && !stopped) await cleanup(async () => { await until(() => { try { process.kill(holderPid, 0); return false; } catch { return true; } }, 'holder exit'); stopped = true; });
      for (const pid of holderChildPids) await cleanup(async () => {
        try { await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, `held child ${pid} exit`); }
        catch (error) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
          await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, `held child ${pid} cleanup`);
          if (!stopped) throw error;
        }
      });
      if (stopped) await cleanup(() => fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
      else errors.push(new Error(`Holder still running; retained ${scratch}`));
      if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], errors.map(e => e.message).join('\n'));
    }
    if (failure) throw failure;
  }
}
