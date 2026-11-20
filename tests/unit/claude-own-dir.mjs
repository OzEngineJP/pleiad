import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backend, probeClaudeConnectors, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { createClaudeAccounts } from '../../core/claude-accounts.mjs';
import { claudeOwnDirEnv, createClaudeConnectorsWiring, VERIFIED_VERSIONS } from '../../core/claude-connectors-auth.mjs';
import { ensureClaudeOwnDirLinks, OWN_DIR, withClaudeUsageDir } from '../../core/claude-own-dir.mjs';

export const name = 'claude-own-dir';
export const title = 'コネクターの専用フォルダ方式';

const id = 'acct-abcdef012345';
const account = { id, name: 'Example' };
const put = (dir, file, text) => fs.writeFile(path.join(dir, file), text);
const read = (dir, file) => fs.readFile(path.join(dir, file), 'utf8');

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-own-dir-'));
  try {
    const shared = path.join(root, 'shared');
    const env = {
      CLAUDE_CONFIG_DIR: shared, CLAUDE_CODE_OAUTH_TOKEN: 'fake-token',
      CLAUDE_CODE_OAUTH_SCOPES: 'fake-scope', ANTHROPIC_API_KEY: 'fake-key', PATH: 'example',
    };
    const parentEnv = { ...env };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(dataDir);
    await put(dataDir, 'claude-accounts.json', JSON.stringify({ version: 1, accounts: [account] }));
    let secretReads = 0;
    const secrets = { get: async () => { secretReads++; return null; }, delete: async () => {} };
    const accounts = createClaudeAccounts({ dataDir, secrets, cliConfig: path.join(root, '.claude.json') });
    let versions = VERIFIED_VERSIONS[0];
    const unexpected = () => assert.fail('own-dir entered the b1 authentication path');
    const wiring = createClaudeConnectorsWiring({
      dataDir, accounts, env, home: root, managedFiles: [], versions: async () => versions,
      usage: { refresh: unexpected, guard: unexpected }, probe: unexpected,
    });
    const own = accounts.usageDir(id);
    await fs.mkdir(own, { recursive: true });

    await assert.rejects(wiring.resolve(id), { code: 'missing-token' });
    await wiring.settings.setEnabled(id, true, 'b1');
    await assert.rejects(wiring.resolve(id), { code: 'missing-token' });
    await wiring.settings.setEnabled(id, true, OWN_DIR);
    assert.deepEqual(await wiring.settings.read(id), { enabled: true, mode: OWN_DIR });
    await assert.rejects(wiring.resolve(id), { code: 'connectors-ownDirLogin' });
    await put(own, 'ply-usage-login.json', '{}');
    assert.equal((await wiring.inspect(account, { mode: OWN_DIR })).kind, 'ownDirLogin');
    await put(own, '.credentials.json', '{"claudeAiOauth":{"expiresAt":1,"refreshTokenExpiresAt":1}}');
    versions = { cli: '0.0.1', sdk: '0.0.1' };
    assert.equal((await wiring.inspect(account, { mode: OWN_DIR })).kind, 'version');
    versions = VERIFIED_VERSIONS[0];
    const runtime = await wiring.resolve(id);
    assert.equal(secretReads, 2);
    assert.equal(runtime.token, undefined);
    assert.equal(runtime.connectors.fresh, undefined);
    await assert.rejects(runtime.resolveCatalogAccount(), { code: 'missing-token' });
    assert.deepEqual(claudeOwnDirEnv(env, { CLAUDE_CONFIG_DIR: own }), { CLAUDE_CONFIG_DIR: own, PATH: 'example' });
    assert.deepEqual(env, parentEnv);
    t.ok('専用フォルダ方式だけ会話用トークン、持ち主照合、期限の検査が不要', true);

    // A wrong entry stops preparation before starting a CLI or overwriting the entry.
    await put(own, 'projects', 'keep');
    const blocked = await wiring.inspect(account, { mode: OWN_DIR, prepare: true });
    assert.equal(blocked.kind, 'ownDirLinks');
    assert.equal(await read(own, 'projects'), 'keep');
    await fs.unlink(path.join(own, 'projects'));
    t.ok('ログイン、版、リンクの失敗に理由がある', true);

    await put(root, 'link-target', '');
    try { await fs.symlink(path.join(root, 'link-target'), path.join(root, 'link-probe'), 'file'); }
    catch (err) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(err.code)) throw err;
      t.skip('ファイル用シンボリックリンクの作成権限がない Windows');
      return;
    }

    await fs.mkdir(path.join(own, 'projects'));
    await fs.mkdir(path.join(own, 'skills'));
    await fs.mkdir(path.join(shared, 'skills'));
    await put(own, 'skills/new', 'new data');
    await put(own, 'skills/same', 'account data');
    await put(shared, 'skills/same', 'shared data');
    await put(own, 'settings.json', '');
    await put(own, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'dedicated@example.invalid' } }));
    await put(shared, '.claude.json', JSON.stringify({
      oauthAccount: { emailAddress: 'shared@example.invalid' }, mcpServers: { example: { command: 'fake' } },
    }));
    const prepared = await wiring.inspect(account, { mode: OWN_DIR, prepare: true });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.moves.find(m => m.action === 'shared')?.entry, 'skills');
    const archive = prepared.moves.find(m => m.action === 'archived').name;
    assert.match(archive, /^same\.pleiad-moved-/);
    assert.equal(await read(path.dirname(own), archive), 'account data');
    assert.equal(await read(shared, 'skills/new'), 'new data');
    assert.equal(await read(own, 'skills/same'), 'shared data');
    for (const entry of ['projects', 'skills', 'plugins', 'settings.json']) {
      assert.equal((await fs.lstat(path.join(own, entry))).isSymbolicLink(), true);
      assert.equal(await fs.realpath(path.join(own, entry)), await fs.realpath(path.join(shared, entry)));
    }
    assert.deepEqual(await withClaudeUsageDir(own, () => ensureClaudeOwnDirLinks(own, shared)), []);
    assert.deepEqual(await Promise.all([runtime.connectors.prepare(), runtime.connectors.prepare()]), [
      { env: { CLAUDE_CONFIG_DIR: own } }, { env: { CLAUDE_CONFIG_DIR: own } },
    ]);
    const profile = JSON.parse(await read(own, '.claude.json'));
    assert.equal(profile.oauthAccount.emailAddress, 'dedicated@example.invalid');
    assert.deepEqual(profile.mcpServers, { example: { command: 'fake' } });
    t.ok('リンク作成と再検査、共有への移動、競合時の退避、設定の投影', true);

    const { connectors } = runtime;
    const seen = [];
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude', resolveSettings: async () => ({ sources: [] }),
      query: ({ options }) => {
        seen.push(options.env);
        return {
          initializationResult: async () => ({}),
          mcpServerStatus: async () => [{ name: 'claude.ai Example', status: 'connected' }],
          async *[Symbol.asyncIterator]() {
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } };
          },
        };
      },
    });
    try {
      connectors.fresh = unexpected;
      assert.equal((await backend.forAccount(runtime).internalTurn({ prompt: 'OK', cwd: root })).text, 'OK');
      assert.deepEqual(await probeClaudeConnectors({ connectors }), [{ name: 'Example', status: 'connected' }]);
      for (const child of seen) {
        assert.equal(child.CLAUDE_CONFIG_DIR, own);
        assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.equal(child.CLAUDE_CODE_OAUTH_SCOPES, undefined);
        assert.equal(child.ANTHROPIC_API_KEY, undefined);
      }
    } finally { restore(); }
    await accounts.remove(id);
    await assert.rejects(fs.lstat(own), { code: 'ENOENT' });
    assert.equal(await read(shared, 'skills/same'), 'shared data');
    assert.equal(await read(path.dirname(own), archive), 'account data');
    t.ok('起動とコネクター一覧の環境変数を分離し、アカウント削除後も共有と退避のデータが残る', true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
