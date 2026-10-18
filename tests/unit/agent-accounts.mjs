import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentAccounts, MAX_ACCOUNTS } from '../../core/agent-accounts.mjs';
import { createAgentAccountManager } from '../../core/agent-account-manager.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'agent-accounts';
export const title = '登録アカウント: 資格情報の隔離・削除・取消とログインの競合・操作の権限';
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-accounts-'));
  const values = new Map();
  const secrets = { keys: async () => [...values.keys()], get: async (k) => values.get(k), set: async (k, v) => values.set(k, v), delete: async (k) => values.delete(k) };
  const accounts = createAgentAccounts({ dataDir, secrets });
  const events = [];
  const b = { id: 'example', capabilities: { accounts: 'agent' },
    accountStatus: async ({ account }) => ({ hasCredential: Boolean(account.credential), label: 'Work' }),
    accountLogin: async ({ emit, signal }) => {
      emit({ type: 'auth', phase: 'url', url: 'https://example.com/login', credential: 'never-show' });
      signal.throwIfAborted();
      return { credential: { token: 'secret-example' }, label: 'Work' };
    } };
  const manager = createAgentAccountManager({ accounts, getBackend: (id) => id === b.id ? b : null, emit: (e) => events.push(e) });
  try {
    const first = await manager.create({ backend: b.id, name: '  Work  account ' });
    const second = await manager.create({ backend: b.id, name: 'Personal' });
    t.ok('追加の応答は置き場・資格情報を含まない', first.id && first.name === 'Work account' && !('dir' in first) && !('credential' in first));
    t.ok('未ログインのアカウントは黙って既定へ戻さない', await rejects(() => accounts.resolve(b.id, first.id)));
    t.ok('未対応のエージェントには追加できない', await rejects(() => manager.create({ backend: 'missing', name: 'x' })));
    await manager.login({ id: first.id });
    const listed = await manager.list({ backend: b.id });
    t.ok('ログインの資格情報は選んだ行だけに保存する', (await accounts.resolve(b.id, first.id)).credential.token === 'secret-example' && !(await accounts.credential(second.id)));
    t.ok('一覧・イベントに秘密を返さない', !JSON.stringify([listed, events]).includes('secret-example') && !JSON.stringify(events).includes('never-show'));
    t.ok('ログインのURLの出来事は対象アカウント付き', events.some((e) => e.type === 'auth' && e.accountId === first.id && e.backend === b.id));
    t.ok('別のエージェントの行をそのまま使わない', await accounts.resolve('another', first.id) === null);
    await manager.rename({ id: first.id, name: 'New name' });
    t.ok('名前を変えても資格情報を保つ', (await accounts.get(first.id)).name === 'New name' && (await accounts.credential(first.id)).token === 'secret-example');

    let started;
    const ready = new Promise((r) => { started = r; });
    b.accountLogin = ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ credential: { token: 'late-result' } }), { once: true });
      started();
    });
    const pending = manager.login({ id: second.id });
    const failed = pending.catch(() => 'cancelled');
    await ready;
    t.ok('同じアカウントのログインを重ねない', await rejects(() => manager.login({ id: second.id })));
    await manager.remove({ id: second.id });
    t.ok('削除は進行中のログインを取り消し、遅い結果を保存しない', await failed === 'cancelled' && !(await accounts.get(second.id)) && !(await accounts.credential(second.id)));
    t.ok('削除済みの行を選ぶと失敗する', await rejects(() => accounts.resolve(b.id, second.id)));

    const external = path.join(dataDir, 'shared');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'keep.txt'), 'shared history');
    await fs.symlink(external, path.join((await accounts.get(first.id)).dir, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    await manager.remove({ id: first.id });
    t.ok('アカウント削除で共有した会話の記録を消さない', await fs.readFile(path.join(external, 'keep.txt'), 'utf8') === 'shared history');
    t.ok('削除で資格情報も消える', values.size === 0);

    const committing = await manager.create({ backend: b.id, name: 'Commit boundary' });
    let enterCommit, finishCommit;
    const entered = new Promise(resolve => { enterCommit = resolve; });
    const finish = new Promise(resolve => { finishCommit = resolve; });
    const originalSet = secrets.set;
    secrets.set = async (...args) => { enterCommit(); await finish; return originalSet(...args); };
    b.accountLogin = async () => ({ credential: { token: 'committed' } });
    const completing = manager.login({ id: committing.id, attempt: 'attempt-current' });
    await entered;
    t.ok('古い試行の取消で新しいログインを止めない', (await manager.cancel({ id: committing.id, attempt: 'attempt-old' })).cancelled === false);
    let cancelReturned = false;
    const duringCommit = manager.cancel({ id: committing.id, attempt: 'attempt-current' }).then(result => { cancelReturned = true; return result; });
    await Promise.resolve();
    t.ok('資格情報の保存開始後の取消は保存の完了を待つ', !cancelReturned);
    finishCommit();
    await completing;
    t.ok('保存開始後は完了として返し、取消の成功を誤報しない', (await duringCommit).cancelled === false && (await accounts.credential(committing.id)).token === 'committed');
    secrets.set = originalSet;
    await manager.remove({ id: committing.id });

    const definitions = registry.ops.filter((op) => op.id.startsWith('accounts.'));
    t.ok('アカウント操作は6つとも画面の人にだけ出す', definitions.length === 6 && definitions.every((op) => op.risk === 'human-only' && op.surfaces.ui && !op.surfaces.mcp && !op.surfaces.cli));
    t.ok('エージェントの操作の一覧にアカウント管理を出さない', !registry.describe({ by: 'agent' }, 'en').some((op) => op.id.startsWith('accounts.')));
    const rows = Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({ id: `acct-${i.toString(16).padStart(12, '0')}`, backend: b.id, name: 'x' }));
    await fs.writeFile(accounts.file, JSON.stringify({ version: 1, accounts: rows }));
    t.ok('台帳の件数には上限がある', await rejects(() => accounts.create({ backend: b.id, name: 'overflow' })));
  } finally { manager.cancelAll(); await fs.rm(dataDir, { recursive: true, force: true }); }
}
