// 外部 MCP の接続の鍵（ADR 0270 段 3）: サーバーの起動ごとに変わる値では変わらず、利用者が変えうる
// ${env:…} の参照先（秘密・変数）を変えたら変わること。段 2c で env を丸ごと鍵から外した退行を直した分。
import assert from 'node:assert/strict';
import { createContextConnections } from '../../core/context-connections.mjs';

export const name = 'context-key';
export const title = '外部 MCP の接続の鍵: 起動ごとに変わる値では変わらず、${env:…} の参照先を変えたら変わる';

export default async function (t) {
  const connections = createContextConnections({ connect: async () => { throw new Error('connect は使わない'); } });
  const stdioItem = {
    id: 'srv',
    definition: {
      command: 'node',
      args: ['${env:MCP_SCRIPT}'],
      env: { TOKEN: '${env:MCP_TOKEN}', BOOT: '${env:AGENT_HOST_TOKEN}', LITERAL: 'v1' },
      env_vars: ['MCP_VAR'],
    },
  };
  const stdioConfig = env => ({ type: 'stdio', command: 'node', args: ['script.js'], cwd: '/work', env, timeout: 1000 });
  const baseEnv = { MCP_SCRIPT: 'script.js', MCP_TOKEN: 'token-a', MCP_VAR: 'var-a', AGENT_HOST_TOKEN: 'boot-1', OTHER: 'one', PATH: '/bin' };
  const key = env => connections.keyFor(stdioItem, stdioConfig(env));
  const base = key(baseEnv);

  t.ok('同じ参照先の値なら、ほかの環境変数（起動ごとに変わる値・参照していない値）が変わっても同じ鍵',
    key({ ...baseEnv, AGENT_HOST_TOKEN: 'boot-2', OTHER: 'two', PATH: '/other' }) === base);
  t.ok('${env:…} の参照先（秘密）を変えると別の鍵（MCP を起こし直す）', key({ ...baseEnv, MCP_TOKEN: 'token-b' }) !== base);
  t.ok('${env:…} を args に使っている参照先を変えると別の鍵', key({ ...baseEnv, MCP_SCRIPT: 'other.js' }) !== base);
  t.ok('env_vars で継ぐ変数を変えると別の鍵', key({ ...baseEnv, MCP_VAR: 'var-b' }) !== base);
  t.ok('定義の env の literal を変えると別の鍵（定義そのものが変わる）',
    connections.keyFor({ ...stdioItem, definition: { ...stdioItem.definition, env: { ...stdioItem.definition.env, LITERAL: 'v2' } } }, stdioConfig(baseEnv)) !== base);

  // HTTP は、ヘッダーの ${env:…} を解決した値が config.headers に入る（参照先を変えれば変わる）。参照していない値では変わらない
  const httpItem = { id: 'web', definition: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${env:HTTP_TOKEN}' } } };
  const httpConfig = (headers, env = {}) => ({ type: 'http', url: 'https://example.test/mcp', headers, env, timeout: 1000 });
  const httpBase = connections.keyFor(httpItem, httpConfig({ Authorization: 'Bearer a' }, { HTTP_TOKEN: 'a', OTHER: 'one' }));
  t.ok('HTTP のヘッダーの参照先を変えると別の鍵',
    connections.keyFor(httpItem, httpConfig({ Authorization: 'Bearer b' }, { HTTP_TOKEN: 'b', OTHER: 'one' })) !== httpBase);
  t.ok('HTTP でも参照していない値では変わらない',
    connections.keyFor(httpItem, httpConfig({ Authorization: 'Bearer a' }, { HTTP_TOKEN: 'a', OTHER: 'two' })) === httpBase);
}
