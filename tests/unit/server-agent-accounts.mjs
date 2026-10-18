import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createAgentAccounts } from '../../core/agent-accounts.mjs';
import { createSecretStore } from '../../core/secret-store.mjs';

export const name = 'server-agent-accounts';
export const title = '登録アカウントの通し: 設定・会話・履歴・分岐・認証切替と削除後の保存分';

export default async function (t) {
  for (const backend of ['codex', 'opencode']) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `ply-server-accounts-${backend}-`));
    const home = path.join(scratch, 'default-home');
    await fs.mkdir(home);
    await fs.mkdir(path.join(scratch, 'fake-state'));
    await fs.writeFile(path.join(scratch, 'prefs.json'), JSON.stringify({ composerSuggestions: false }));
    const registry = createAgentAccounts({ dataDir: scratch, secrets: createSecretStore({ file: path.join(scratch, 'agent-account-secrets.json') }) });
    const a = await registry.create({ backend, name: 'Work' });
    const b = await registry.create({ backend, name: 'Personal' });
    const credential = (id) => backend === 'codex' ? { auth: { fake: { email: `${id}@example.invalid`, usedPercent: 12 } } } : { auth: { fake: { type: 'api', key: `fake-${id}` } } };
    await registry.setCredential(a.id, credential('work'));
    await registry.setCredential(b.id, credential('personal'));
    const env = { AGENT_HOST_BACKENDS: backend, AGENT_HOST_LOCALE: 'en', CODEX_HOME: home, CODEX_SQLITE_HOME: home,
      FAKE_CODEX_ACCOUNTS: '1', FAKE_CODEX_STATE_DIR: path.join(scratch, 'fake-state'),
      AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`,
      AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests/lib/fake-opencode.mjs')}"`,
      AGENT_HOST_CODEX_HOLDER: 'off', AGENT_HOST_OPENCODE_HOLDER: 'off' };
    const server = await startServer({ env, dataDir: scratch });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    const invoke = (op, args) => c.cmd('invoke', { op: `accounts.${op}`, args });
    try {
      const rows = await invoke('list', { backend });
      t.ok(`${backend}: 画面の操作は2つの登録を読み、資格情報を返さない`, rows.accounts.length === 2 && rows.accounts.every(x => x.hasCredential) && !JSON.stringify(rows).includes('fake-work'));
      const fresh = await invoke('create', { backend, name: 'New' });
      await invoke('rename', { id: fresh.id, name: 'Renamed' });
      await invoke('remove', { id: fresh.id });
      t.ok(`${backend}: invokeで追加・名前変更・削除できる`, !(await invoke('list', { backend })).accounts.some(x => x.id === fresh.id));
      const { sessionId } = await c.cmd('newSession', { backend, cwd: ROOT });
      await c.cmd('setTurnSettings', { sessionId, account: a.id });
      const first = await c.runTurn({ sessionId, prompt: 'account alpha' });
      t.ok(`${backend}: 登録したアカウントの最初のターンが成功する`, first.outcome === 'ok', JSON.stringify(first.events.filter(e => e.type === 'turnResult')));
      const history = await c.cmd('loadSession', { sessionId });
      t.ok(`${backend}: 束縛した認証で会話の履歴を読める`, history.messages.some(m => m.role === 'user' && m.text.includes('account alpha')));
      await c.cmd('setTitle', { sessionId, title: 'Account test' });
      const fork = await c.cmd('fork', { sessionId, title: 'Fork' });
      const copied = await c.cmd('loadSession', { sessionId: fork.sessionId });
      t.ok(`${backend}: 分岐は履歴と選択アカウントを継ぐ`, copied.messages.length > 0 && (await c.cmd('listSessions')).find(s => s.id === fork.sessionId)?.claudeAccount === a.id);
      await c.cmd('setTurnSettings', { sessionId, account: b.id });
      const second = await c.runTurn({ sessionId, prompt: 'account beta' });
      t.ok(`${backend}: 同じ会話の次のターンから別アカウントに替えられる`, second.outcome === 'ok' && (await c.cmd('listSessions')).find(s => s.id === sessionId)?.claudeAccount === b.id);
      const quota = await c.cmd('providerUsage', { backend });
      t.ok(`${backend}: 使用量の行は登録アカウントごと`, quota.quota?.accounts?.some(x => x.accountId === a.id) && quota.quota?.accounts?.some(x => x.accountId === b.id), JSON.stringify(Object.keys(quota)));
      const deadline = Date.now() + 8000;
      for (;;) {
        try { await invoke('remove', { id: b.id }); break; }
        catch (error) {
          if (!/in use/.test(error.message) || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      const saved = await c.cmd('loadSession', { sessionId });
      t.ok(`${backend}: 認証を削除しても保存した履歴を読める`, saved.messages.some(m => m.role === 'user' && m.text.includes('account beta')));
      let failed = false;
      try { await c.cmd('runTurn', { sessionId, prompt: 'must not fall back' }); } catch { failed = true; }
      t.ok(`${backend}: 削除した認証から既定へ黙って戻さない`, failed);
    } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
  }
}
