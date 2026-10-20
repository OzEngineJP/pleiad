// 設定 › 委譲「委譲先の自動選択に使うキー」の画面が読む形（core/server.mjs の delegationRoutingState）。
// data.keys.openrouter に { via, hasKey, keyRef, plus } が乗る。状態ごとの plus の中身と、キーの値・ID トークンが出ないことを確かめる。
// 偽の Plus（tests/lib/fake-plus.mjs）だけと話す。ログインは plus-main-port が拾う外に開く URL を fetch で辿る。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';

export const name = 'delegation-settings-plus';
export const title = '委譲のキーの形: via・hasKey・keyRef・plus（状態ごと・値は出さない）';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const BASE_ACCOUNT = { uid: 'user-1', email: 'user@example.com', provider: 'google.com' };
const PLUS_ACCOUNT = { ...BASE_ACCOUNT, status: 'plus', plan: { name: 'Pleiad Plus' },
  limits: { hosts: 3, creditsPerMonth: 500, syncBytes: 100 }, usage: { credits: 120, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: false } };

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-deleg-plus-'));
  const capture = path.join(scratch, 'external.log');
  const plus = await startFakePlus();
  const server = await startServer({ dataDir: scratch, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: capture } });
  const c = await open({ port: server.port, token: server.token });
  const routing = () => c.cmd('delegationRouting');
  const plusOf = async () => (await routing()).keys?.openrouter?.plus ?? null;
  /** 外に開こうとした URL（ログインのページ）を辿ってログインを終わらせる */
  let externalSeen = 0;
  async function login(account) {
    plus.state.accounts['user-1'] = account;
    await c.cmd('plusLogin');
    let url = '';
    for (let i = 0; i < 100 && !url; i++) {
      const lines = (await fs.readFile(capture, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
      if (lines.length > externalSeen) { externalSeen = lines.length; url = lines.at(-1); }
      else await sleep(50);
    }
    t.ok('ログインのページが開こうとされた', url.startsWith(`${plus.url}/login`), url);
    await fetch(url);   // /login → loopback /callback（redirect は fetch が辿る）
    for (let i = 0; i < 100; i++) {
      const st = await c.cmd('plusStatus');
      if (st.signedIn) return;
      await sleep(50);
    }
    throw new Error('ログインが終わらない');
  }
  const logout = () => c.cmd('plusLogout');

  try {
    // ---- ログインしていない: via・hasKey は空、plus は「選べない」状態 ----
    {
      const k = (await routing()).keys?.openrouter;
      const p = k?.plus;
      t.ok('未ログイン: via・hasKey・keyRef は空', k.via === null && k.hasKey === false && k.keyRef === null);
      t.ok('未ログイン: signedIn:false・status/email は無い（ログインへの案内が要る）', p && p.signedIn === false && p.status === null && p.email === null);
      t.ok('未ログイン: limitReached:false・resetAt は無い', p.limitReached === false && p.resetAt === null);
      t.ok('未ログイン: state は on・行は出る', p.state === 'on' && p.available !== false);
    }

    // ---- ログイン（plus）→ 自動で両方に plus が選ばれる ----
    await login(PLUS_ACCOUNT);
    {
      const k = (await routing()).keys?.openrouter;
      const p = k?.plus;
      t.ok('plus: メールと status が返る', p.email === 'user@example.com' && p.status === 'plus' && p.signedIn === true);
      t.ok('plus: 選んでいる印は via:plus（両方に自動で選ぶ）。keyRef は null', k.via === 'plus' && k.keyRef === null);
      t.ok('plus: 送れるので hasKey は true', k.hasKey === true);
      t.ok('plus: limitReached:false・resetAt はアカウントの値', p.limitReached === false && p.resetAt === PLUS_ACCOUNT.usage.resetAt);
    }

    // ---- OpenRouter のキーを登録して選ぶ → via: key ----
    {
      const added = await c.cmd('setApiKey', { provider: 'openrouter', key: KEY });
      await c.cmd('setApiKeyUse', { use: 'judge:jev', id: added.id });
      const k = (await routing()).keys?.openrouter;
      t.ok('OpenRouter: via:key・keyRef は選んだ id', k.via === 'key' && k.keyRef === added.id && k.hasKey === true);
    }

    // ---- 上限に達した → limitReached・resetAt ----
    await logout();
    await login({ ...PLUS_ACCOUNT, usage: { credits: 500, resetAt: '2026-12-01T00:00:00+09:00' } });
    {
      const p = await plusOf();
      t.ok('上限: limitReached:true・resetAt は使い切りの戻る日', p.limitReached === true && p.resetAt === '2026-12-01T00:00:00+09:00' && p.email === 'user@example.com');
    }

    // ---- free・disabled → status が返る（行は出て選べない）----
    await logout();
    await login({ ...BASE_ACCOUNT, status: 'free', plan: null, limits: null, usage: null, sync: null });
    {
      const p = await plusOf();
      t.ok('free: status:free・メールは返る', p.status === 'free' && p.email === 'user@example.com');
    }
    await logout();
    await login({ ...BASE_ACCOUNT, status: 'disabled', plan: null, limits: null, usage: null, sync: null });
    {
      const p = await plusOf();
      t.ok('disabled: status:disabled が返る', p.status === 'disabled');
    }

    // ---- ログアウト → plus を選んでいても印は残り、効き目は「キーが無い」 ----
    await logout();
    await login(PLUS_ACCOUNT);
    await c.cmd('setApiKeyUse', { use: 'judge:jev', id: 'plus' });
    await logout();
    {
      const k = (await routing()).keys?.openrouter;
      const p = k?.plus;
      t.ok('ログアウト: plus の印は残る（via:plus）・送れないので hasKey:false（キーが無いと同じ）', k.via === 'plus' && k.hasKey === false);
      t.ok('ログアウト: signedIn:false・status は前のまま残らない', p.signedIn === false && p.status === null);
    }

    // ---- state: off → 行を出さないための印が返る ----
    // config の写しは 5 分持つ。plusLogin は config を取り直してから off で断るので、それで状態を読み直させる
    plus.state.state = 'off';
    await c.cmd('plusLogin').catch(() => {});
    {
      const p = await plusOf();
      t.ok('state:off → plus.state が off（行ごと出さない）', p.state === 'off');
    }
    plus.state.state = 'on';

    // ---- 値は出さない（キーの値・トークン・秘密の欄が応答に無い）----
    {
      const raw = JSON.stringify(await routing());
      t.ok('応答にキーの値・ID トークン・更新トークンは出さない',
        !raw.includes(KEY) && !raw.includes('refreshToken') && !raw.includes('idToken') && !raw.includes('id_token') && !raw.includes('refresh_token'));
    }
  } finally {
    c.close();
    await server.stop();
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
