import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevinBackend } from '../../core/backends/devin.mjs';
import { createGrokBackend } from '../../core/backends/grok.mjs';

export const name = 'devin-grok-auth';
export const title = 'Devin/Grok auth status, terminal login guidance and logout';

const fixture = id => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', `fake-${id}.mjs`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function testDevinGrokAuth(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dg-auth-')));
  const KEYS = ['AGENT_HOST_DEVIN_LOGIN_MS', 'AGENT_HOST_DEVIN_POLL_MS', 'AGENT_HOST_GROK_LOGIN_MS', 'AGENT_HOST_GROK_POLL_MS', 'AGENT_HOST_GROK_HOME', 'FAKE_DEVIN_AUTH_FILE', 'XAI_API_KEY'];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  process.env.AGENT_HOST_DEVIN_LOGIN_MS = '4000'; process.env.AGENT_HOST_DEVIN_POLL_MS = '50';
  process.env.AGENT_HOST_GROK_LOGIN_MS = '4000'; process.env.AGENT_HOST_GROK_POLL_MS = '50';
  delete process.env.XAI_API_KEY;
  // ログインの見張りは unref のタイマーで進む（サーバーで走ることを前提にした形）。テスト中はイベントループを空にしない
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    // ---- Devin: `devin auth status` の JSON（fixture）を読み、logout は CLI を起こす ----
    const authFile = path.join(scratch, 'devin-auth.txt');
    await fs.writeFile(authFile, 'out');
    const devin = createDevinBackend({ command: () => [process.execPath, fixture('devin')] });
    process.env.FAKE_DEVIN_AUTH_FILE = authFile;
    let st = await devin.auth.status();
    assert.deepEqual({ loggedIn: st.loggedIn, account: st.account }, { loggedIn: false, account: null }, 'devin: 未ログインが読める');
    const events = [];
    const login = devin.auth.login({ emit: e => events.push(e) });
    await sleep(150);
    await fs.writeFile(authFile, 'in');   // 人が端末で `devin auth login` を済ませたのと同じ
    await login;
    assert.equal(events[0].phase, 'url', 'devin: 先にコマンドの案内が出る');
    assert.match(events[0].url, /auth login$/, 'devin: 案内は devin auth login');
    assert.equal(events.at(-1).phase, 'done', 'devin: 済んだら done');
    st = await devin.auth.status();
    assert.equal(st.loggedIn, true, 'devin: ログイン後は loggedIn');
    assert.equal(st.account, 'fixture-devin', 'devin: アカウント名は status の出力から');
    await devin.auth.logout();
    st = await devin.auth.status();
    assert.equal(st.loggedIn, false, 'devin: logout 後は未ログイン');

    // ---- Grok: auth.json の有無と XAI_API_KEY・`grok models` で見る ----
    const grokHome = path.join(scratch, 'grok-home');
    process.env.AGENT_HOST_GROK_HOME = grokHome;
    const grok = createGrokBackend({ command: () => [process.execPath, fixture('grok')] });
    st = await grok.auth.status();
    assert.equal(st.loggedIn, false, 'grok: auth.json が無ければ未ログイン');
    const gEvents = [];
    const gLogin = grok.auth.login({ emit: e => gEvents.push(e) });
    await sleep(150);
    await fs.mkdir(grokHome, { recursive: true });
    await fs.writeFile(path.join(grokHome, 'auth.json'), '{"grok.com":{}}');   // `grok login` が書くのと同じ
    await gLogin;
    assert.match(gEvents[0].url, /login$/, 'grok: 案内は grok login');
    assert.equal(gEvents.at(-1).phase, 'done');
    st = await grok.auth.status();
    assert.equal(st.loggedIn, true, 'grok: auth.json があればログイン済み');
    await grok.auth.logout();   // fixture は auth.json を消す
    st = await grok.auth.status();
    assert.equal(st.loggedIn, false, 'grok: logout で auth.json が消えて未ログイン');
    t.ok('devin/grok の status・login の案内・logout が fixture で通る', true);
  } finally {
    clearInterval(keepAlive);
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await fs.rm(scratch, { recursive: true, force: true });
    cleanupTestData();
  }
}
