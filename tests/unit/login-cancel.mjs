// 待っているログインをやめる（authCancel。設定のカード・初回の案内・会話の失敗の行の［やめる］。ADR 0243）。
//   - 見張り（core/auth/login-watch.mjs）: cancel は待ちをすぐ起こし、CANCELLED で返す。待っていなければ何もしない
//   - 端末のコマンドで入るエージェント（Grok・Devin）: 見張りを止めて CANCELLED で返り、待ちが残らない（すぐ次のログインを始められる）。
//     時間切れは code: TIMEOUT（失敗のイベントにも載る）
//   - Codex: app-server に account/login/cancel を送り（戻り先の 1455 番の待ち受けを閉じる）、CANCELLED で返る。通知の聞き手を残さない
// 子プロセスは fixture（tests/lib/fake-*.mjs）だけ、Codex は RPC の境界だけを差し替える
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLoginWatch } from '../../core/auth/login-watch.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { rpc } from '../../core/backends/codex-rpc.mjs';

export const name = 'login-cancel';
export const title = '待っているログインをやめる: 見張り・Grok・Devin・Codex の cancel と、時間切れの code';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = id => path.join(here, '..', 'lib', `fake-${id}.mjs`);
// 見張りの間隔と時間切れは読み込んだときに決まる。試験ごとに新しく読む（ほかの試験の読み込みと分ける）
let fresh = 0;
const load = rel => import(`${pathToFileURL(path.join(here, '..', '..', rel)).href}?login-cancel=${++fresh}`);
const settle = p => p.then(() => null, e => e);

export default async function (t) {
  // ---- 見張り
  {
    const watch = createLoginWatch('Test');
    t.ok('待っていなければ cancel は何もしない', watch.cancel().cancelled === false);
    const run = watch.begin();
    const started = Date.now();
    const waiting = settle(run.pause(10_000));
    const res = watch.cancel();
    const error = await waiting;
    run.end();
    t.ok('cancel は待ちをすぐ起こし、CANCELLED で返る', res.cancelled === true && error?.code === 'CANCELLED' && Date.now() - started < 1000, `${error?.code} ${Date.now() - started}ms`);
    t.ok('やめた後は何も待っていない', watch.cancel().cancelled === false);
  }

  const KEYS = ['AGENT_HOST_DEVIN_LOGIN_MS', 'AGENT_HOST_DEVIN_POLL_MS', 'AGENT_HOST_GROK_LOGIN_MS', 'AGENT_HOST_GROK_POLL_MS', 'AGENT_HOST_GROK_HOME', 'FAKE_DEVIN_AUTH_FILE', 'XAI_API_KEY'];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'login-cancel-')));
  // 見張りのタイマーは unref（サーバーで走る前提）。試験の間はイベントループを空にしない
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    delete process.env.XAI_API_KEY;
    process.env.AGENT_HOST_GROK_HOME = path.join(scratch, 'grok-home');
    process.env.FAKE_DEVIN_AUTH_FILE = path.join(scratch, 'devin-auth.txt');
    await fs.writeFile(process.env.FAKE_DEVIN_AUTH_FILE, 'out');
    const agents = [
      ['Grok', 'core/backends/grok.mjs', 'createGrokBackend', 'grok', 'GROK'],
      ['Devin', 'core/backends/devin.mjs', 'createDevinBackend', 'devin', 'DEVIN'],
    ];
    for (const [label, file, create, id, env] of agents) {
      // 見張りの間隔を長くして、cancel が次の確かめを待たずに返ることを見る
      process.env[`AGENT_HOST_${env}_LOGIN_MS`] = '60000';
      process.env[`AGENT_HOST_${env}_POLL_MS`] = '3000';
      const backend = (await load(file))[create]({ command: () => [process.execPath, fixture(id)] });
      t.ok(`${label}: 待っていなければ cancel は何もしない`, (await backend.auth.cancel()).cancelled === false);
      const start = async () => {
        const events = [];
        let shown;
        const url = new Promise(resolve => { shown = resolve; });
        const login = settle(backend.auth.login({ emit: e => { events.push(e); if (e.phase === 'url') shown(); } }));
        await Promise.race([url, login]);
        return { login, events };
      };
      const first = await start();
      const started = Date.now();
      const res = await backend.auth.cancel();
      const error = await first.login;
      t.ok(`${label}: cancel で見張りを止め、login は CANCELLED で返る`, res.cancelled === true && error?.code === 'CANCELLED' && Date.now() - started < 2000,
        `${JSON.stringify(res)} ${error?.code} ${error?.message} ${Date.now() - started}ms`);
      t.ok(`${label}: やめたものは失敗のイベントを出さない`, !first.events.some(e => e.phase === 'error'), JSON.stringify(first.events));
      // 待ちが残っていれば「ログインを待っています」で断られる
      const second = await start();
      t.ok(`${label}: やめた後はすぐ次のログインを始められる`, second.events.some(e => e.phase === 'url'), JSON.stringify(second.events));
      await backend.auth.cancel();
      t.ok(`${label}: 2 度目もやめられる`, (await second.login)?.code === 'CANCELLED');

      // 時間切れ
      process.env[`AGENT_HOST_${env}_LOGIN_MS`] = '150';
      process.env[`AGENT_HOST_${env}_POLL_MS`] = '20';
      const quick = (await load(file))[create]({ command: () => [process.execPath, fixture(id)] });
      const events = [];
      const timedOut = await settle(quick.auth.login({ emit: e => events.push(e) }));
      t.ok(`${label}: 時間切れは code: TIMEOUT で返り、失敗のイベントにも載る`, timedOut?.code === 'TIMEOUT' && events.some(e => e.phase === 'error' && e.code === 'TIMEOUT'),
        `${timedOut?.code} ${JSON.stringify(events)}`);
    }
  } finally {
    clearInterval(keepAlive);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // ---- Codex（RPC の境界だけを差し替える）
  const originals = { request: rpc.request, onNotify: rpc.onNotify, onDown: rpc.onDown };
  try {
    const asked = [];
    let listeners = 0, downs = 0;
    rpc.onNotify = () => { listeners++; return () => { listeners--; }; };
    rpc.onDown = () => { downs++; return () => { downs--; }; };
    rpc.request = async (method, params) => {
      asked.push({ method, params });
      if (method === 'account/login/start') return { loginId: 'lg-cancel', authUrl: 'https://auth.example.invalid/' };
      if (method === 'account/login/cancel') return {};
      throw new Error(`unexpected RPC: ${method}`);
    };
    t.ok('Codex: 待っていなければ cancel は何もしない', (await codex.auth.cancel()).cancelled === false);
    const events = [];
    let shown;
    const url = new Promise(resolve => { shown = resolve; });
    const login = settle(codex.auth.login({ emit: e => { events.push(e); if (e.phase === 'url') shown(); } }));
    await Promise.race([url, login]);
    const res = await codex.auth.cancel();
    const error = await login;
    t.ok('Codex: cancel で login は CANCELLED で返る', res.cancelled === true && error?.code === 'CANCELLED', `${JSON.stringify(res)} ${error?.code} ${error?.message}`);
    const sent = asked.find(x => x.method === 'account/login/cancel');
    t.ok('Codex: app-server に account/login/cancel をそのログインの id で送る', sent?.params?.loginId === 'lg-cancel', JSON.stringify(asked));
    t.ok('Codex: 通知と切断の聞き手を残さない', listeners === 0 && downs === 0, `notify=${listeners} down=${downs}`);
    t.ok('Codex: やめた後は何も待っていない', (await codex.auth.cancel()).cancelled === false);
    t.ok('Codex: やめたものは済んだのイベントを出さない', !events.some(e => e.phase === 'done'), JSON.stringify(events));
  } finally {
    Object.assign(rpc, originals);
  }
}
