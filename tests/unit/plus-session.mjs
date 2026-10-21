// Pleiad Plus のセッション（core/plus/）。偽の Plus（tests/lib/fake-plus.mjs）だけと話す。本物の api には送らない。
// 「ブラウザー」は openExternal が受けたログインの URL を fetch して 302 の行き先（ループバックの戻り先）を叩くことで代わりにする。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlusConfig, parseAuthConfig } from '../../core/plus/config.mjs';
import { createPlusSession, PlusError } from '../../core/plus/session.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';

export const name = 'plus-session';
export const title = 'Plus のセッション: ログインの往復・失敗・取り直し・保管・状態・写し・401 のやり直し';

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

async function setup({ env = {}, loginTtlMs = 10 * 60_000, dataDir, appVersion = '0.32.0', optIn } = {}) {
  const plus = await startFakePlus();
  const dir = dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'ply-plus-'));
  const secrets = createSecretStore({ file: path.join(dir, 'plus-secrets.json'), cipher: plainCipher });
  const clock = fakeClock(Date.now());
  const opened = [];
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url, ...env }, dataDir: dir, appVersion, now: clock.now, optIn });
  const session = createPlusSession({ config, secrets, openExternal: u => opened.push(u), now: clock.now, timers: clock, loginTtlMs, fetchFn: fetch, appVersion });
  const events = [];
  session.onChange(ev => events.push(ev));
  return { plus, dir, secrets, clock, opened, session, events };
}

/** 外のブラウザーの代わり: ログインのページを開き、302 の戻り先（ループバック）を叩く */
async function browse(opened, { state } = {}) {
  const url = new URL(opened.at(-1));
  if (state !== undefined) url.searchParams.set('state', state);
  const r = await fetch(url, { redirect: 'manual' });
  const location = r.headers.get('location');
  await r.body?.cancel().catch(() => {});
  if (!location) throw new Error(`login page did not redirect: ${r.status}`);
  const back = await fetch(location);
  return { status: back.status, text: await back.text(), location };
}

async function signedInSession(opts) {
  const ctx = await setup(opts);
  await ctx.session.init();
  ctx.plus.state.nextLogin = { uid: 'user-1', email: 'user@example.com' };
  await ctx.session.login();
  await browse(ctx.opened);
  await tick();
  return ctx;
}

export default async function (t) {
  // ---- 1. ログインの往復 ----------------------------------------------------
  {
    const { plus, dir, secrets, opened, session, events } = await setup();
    await session.init();
    const st0 = await session.status();
    t.ok('起動: 未ログイン・state on・入口あり', st0.signedIn === false && st0.available === true && st0.state === 'on');

    plus.state.nextLogin = { uid: 'user-1', email: 'user@example.com' };
    const r = await session.login();
    t.ok('login() が始まる', r.started === true && (await session.status()).login.phase === 'waiting');
    t.ok('ログインの URL に PKCE と state と言語が載る',
      /code_challenge=[^&]+/.test(opened[0]) && /code_challenge_method=S256/.test(opened[0]) && /state=[^&]+/.test(opened[0])
      && /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback/.test(opened[0]) && /lang=(ja|en)/.test(opened[0]));

    const back = await browse(opened);
    await tick();
    const st = await session.status();
    t.ok('往復でログインできる', st.signedIn === true && st.login.phase === 'idle', `status=${back.status} phase=${st.login.phase}`);
    t.ok('成功ページの文', back.status === 200 && /close this tab|閉じてかまいません/.test(back.text));
    const stored = await secrets.get('plus:session');
    t.ok('保管に plus:session が入り、ID トークンは保管に無い',
      typeof stored?.refreshToken === 'string' && stored.uid === 'user-1' && stored.tokenProjectId === 'test-project' && !('idToken' in stored));
    const rawEntry = JSON.parse(await fs.readFile(path.join(dir, 'plus-secrets.json'), 'utf8')).entries['plus:session'];
    t.ok('保管ファイルの中身にも ID トークンが無い', rawEntry && !('idToken' in JSON.parse(rawEntry.data)));
    t.ok('signedIn・login の知らせが出る', events.some(e => e.type === 'signedIn') && events.some(e => e.type === 'login'));
    // account の読み取り（無い uid は free）
    await tick(20);
    t.ok('account が読める（free）', (await session.status()).account?.status === 'free', JSON.stringify((await session.status()).account));
    await plus.close();
  }

  // ---- 2. 失敗: state が違う・error・期限切れ --------------------------------
  {
    const { plus, opened, session } = await setup();
    await session.init();
    plus.state.nextLogin = { uid: 'user-1' };
    await session.login();
    const back = await browse(opened, { state: 'wrong-state' });
    await tick();
    t.ok('state が違う → failed', back.status === 400 && (await session.status()).login.phase === 'failed');
    t.ok('失敗ページの文', /Couldn't sign in|ログインできませんでした/.test(back.text));

    plus.state.nextLogin = { error: 'access_denied' };
    await session.login();
    await browse(opened);
    await tick();
    t.ok('error が来る → failed', (await session.status()).login.phase === 'failed');
    await plus.close();
  }
  {
    // 受け口の期限（試験の時計で短く）に何も来ない
    const { plus, session, clock } = await setup({ loginTtlMs: 60 });
    await session.init();
    plus.state.nextLogin = { uid: 'user-1' };
    await session.login();
    await clock.advance(61);
    t.ok('期限を過ぎる → failed', (await session.status()).login.phase === 'failed');
    await plus.close();
  }

  // ---- 3. ログイン中にもう一度 login() / cancelLogin() ----------------------
  {
    const { plus, opened, session } = await setup();
    await session.init();
    plus.state.nextLogin = { uid: 'user-1' };
    await session.login();
    const firstRedirect = new URL(opened[0]).searchParams.get('redirect_uri');
    await session.login();
    t.ok('2 回目も始まる', opened.length === 2 && opened[1] !== opened[0]);
    const refused = await fetch(firstRedirect).then(() => false, () => true);
    t.ok('前の受け口は閉じている', refused === true);
    await browse(opened);
    await tick();
    t.ok('新しい試みは通る', (await session.status()).signedIn === true);

    await session.logout();
    await session.login();
    session.cancelLogin();
    t.ok('cancelLogin → idle', (await session.status()).login.phase === 'idle');
    await plus.close();
  }

  // ---- 4. 期限の 5 分前で取り直す・single-flight・refresh_token の保管 ------
  {
    const { plus, secrets, session, clock } = await signedInSession();
    plus.state.rotateRefresh = true;
    const before = (await secrets.get('plus:session')).refreshToken;
    const calls0 = plus.state.calls.filter(c => c.path.startsWith('/v1/token')).length;
    // 期限はまだ先 → 取り直さない
    await session.getIdToken();
    t.ok('期限前は取り直さない', plus.state.calls.filter(c => c.path.startsWith('/v1/token')).length === calls0);
    // 期限の 5 分前を過ぎる → 5 本同時でも更新の口は 1 回
    await clock.advance(3600_000);
    await Promise.all([...Array(5)].map(() => session.getIdToken()));
    const refreshCalls = plus.state.calls.filter(c => c.path.startsWith('/v1/token')).length - calls0;
    t.ok('取り直しは 1 本にまとまる', refreshCalls === 1, `calls=${refreshCalls}`);
    const after = (await secrets.get('plus:session')).refreshToken;
    t.ok('替わった refresh_token が保管される', typeof after === 'string' && after !== before);
    await plus.close();
  }

  // ---- 5. 更新の拒否（TOKEN_EXPIRED など）→ 保管が消えて未ログイン -----------
  {
    const { plus, secrets, session } = await signedInSession();
    plus.state.refreshError = 'TOKEN_EXPIRED';
    const err = await session.getIdToken({ force: true }).then(() => null, e => e);
    const st = await session.status();
    t.ok('TOKEN_EXPIRED → 未ログイン', err?.code === 'unauthenticated' && st.signedIn === false && (await secrets.get('plus:session')) === undefined);
    await plus.close();
  }

  // ---- 6. 届かない（state.down）: reachable: false、1 分おきに 5 回 ----------
  {
    const { plus, session, clock } = await signedInSession();
    plus.state.down = true;
    const p = session.getIdToken({ force: true }).then(() => null, e => e);
    await tick();
    t.ok('届かない間は reachable: false', (await session.status()).reachable === false);
    await clock.advance(5 * 60_000);
    const err = await p;
    const tries = plus.state.calls.filter(c => c.path.startsWith('/v1/token')).length;
    t.ok('5 回で諦める', err?.code === 'network' && tries === 5, `tries=${tries}`);
    await plus.close();
  }

  // ---- 6b. accountReadAt: GET /v1/account を読めたときだけ進む（中継の 4401 account の止まりを解く手がかり） ----
  {
    const { plus, session, clock } = await signedInSession();
    await tick(20);
    const read1 = session.snapshot().accountReadAt;
    t.ok('account を読めたら accountReadAt が入る', typeof read1 === 'number' && read1 > 0, String(read1));
    let reply = { status: 403, body: { error: { code: 'account_disabled', message: 'stopped' } } };
    plus.route('GET', '/v1/account', (req, res) => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await clock.advance(30_000);
    await session.status({ refresh: true });
    await tick(20);
    const s2 = session.snapshot();
    t.ok('読めなかった（403 account_disabled）ときは accountReadAt が進まない', s2.account?.status === 'disabled' && s2.accountReadAt === read1,
      `${s2.account?.status} ${s2.accountReadAt}`);
    reply = { status: 200, body: { uid: 'user-1', email: 'user@example.com', status: 'plus' } };
    await clock.advance(30_000);
    await session.status({ refresh: true });
    await tick(20);
    const s3 = session.snapshot();
    t.ok('読み直して plus と分かると accountReadAt が進む', s3.account?.status === 'plus' && s3.accountReadAt > read1,
      `${s3.account?.status} ${s3.accountReadAt}`);
    await plus.close();
  }

  // ---- 7. tokenProjectId が違う → 保管を消して relogin ----------------------
  {
    // 前の起動で別のプロジェクト宛に保管されたセッションが残っている、を模す
    const { plus, secrets, session } = await setup();
    await secrets.set('plus:session', { refreshToken: 'rt-old', uid: 'user-1', email: 'user@example.com', tokenProjectId: 'other-project', apiKey: 'test-api-key', savedAt: new Date().toISOString() });
    await session.init();
    const st = await session.status();
    t.ok('tokenProjectId が違う → relogin', st.error?.code === 'relogin' && st.signedIn === false && (await secrets.get('plus:session')) === undefined);
    await plus.close();
  }

  // ---- 8. off・AGENT_HOST_PLUS=0・maintenance・minClient ----------------------
  {
    const { plus, session } = await setup();
    plus.state.state = 'off';
    await session.init();
    const st = await session.status();
    t.ok('state off → available: false', st.available === false && st.state === 'off');
    const err = await session.login().then(() => null, e => e);
    t.ok('off のとき login() は始まらない', err instanceof PlusError);
    await plus.close();
  }
  {
    const { plus, session } = await setup({ env: { AGENT_HOST_PLUS: '0' } });
    await session.init();
    t.ok('AGENT_HOST_PLUS=0 → available: false', (await session.status()).available === false);
    await plus.close();
  }
  {
    const { plus, session } = await setup();
    plus.state.state = 'maintenance';
    await session.init();
    const err = await session.login().then(() => null, e => e);
    t.ok('maintenance → login() は始まらない（code maintenance）', err?.code === 'maintenance', String(err?.code));
    await plus.close();
  }
  {
    const { plus, session } = await setup({ appVersion: '0.1.0' });
    plus.state.minClient = { desktop: '9.9.9', android: '9.9.9' };
    await session.init();
    const st = await session.status();
    const err = await session.login().then(() => null, e => e);
    t.ok('minClient より古い → needsUpdate で login() は始まらない', st.needsUpdate === true && err?.code === 'update', `needsUpdate=${st.needsUpdate} code=${err?.code}`);
    await plus.close();
  }

  // ---- 9. api に届かないとき plus-config.json の写しで状態を作る -------------
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-plus-cfg-'));
    const a = await setup({ dataDir: dir });
    await a.session.init();
    t.ok('読めた値が plus-config.json に残る', JSON.parse(await fs.readFile(path.join(dir, 'plus-config.json'), 'utf8'))?.state === 'on');
    await a.plus.close();   // api を止める
    // 新しい設定（同じ dataDir）では届かないので写しを使う
    const clock = fakeClock(Date.now());
    const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: a.plus.url }, dataDir: dir, appVersion: '0.32.0', now: clock.now });
    const got = await config.get({ fresh: true });
    t.ok('届かないとき写しの値で状態を作る', got?.state === 'on' && config.derive(got).available === true);
    // 写しも無く届かない → state は null
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-plus-cfg2-'));
    const config2 = createPlusConfig({ env: { AGENT_HOST_PLUS_API: a.plus.url }, dataDir: dir2, appVersion: '0.32.0', now: clock.now });
    const got2 = await config2.get({ fresh: true });
    t.ok('写しも届かない → state は null', got2 === null && config2.derive(got2).state === null);
  }

  // ---- 10. 401 を 1 回 → 取り直してやり直す。2 回続く → relogin -------------
  {
    const { plus, session } = await signedInSession();
    let n = 0;
    plus.route('GET', '/v1/thing', (req, res) => {
      n++;
      if (n === 1) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"unauthenticated","message":"bad token"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    const out = await session.client.request('GET', '/v1/thing');
    t.ok('401 を 1 回 → 取り直してやり直す', out?.ok === true && n === 2, `n=${n}`);
    // ずっと 401 → relogin
    let m = 0;
    plus.route('GET', '/v1/bad', (req, res) => { m++; res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"code":"unauthenticated","message":"bad token"}}'); });
    const err = await session.client.request('GET', '/v1/bad').then(() => null, e => e);
    const st = await session.status();
    t.ok('2 回続けて 401 → relogin', m === 2 && err?.code === 'unauthenticated' && st.error?.code === 'relogin' && st.signedIn === false, `m=${m} code=${err?.code} err=${st.error?.code}`);
    await plus.close();
  }

  // ---- 11. logout は api に何も送らない ------------------------------------
  {
    const { plus, session } = await signedInSession();
    const calls = plus.state.calls.length;
    const st = await session.logout();
    t.ok('logout → 未ログイン・api には送らない', st.signedIn === false && plus.state.calls.length === calls);
    await plus.close();
  }

  // ---- 12. visibility と入口の印（docs/plus.md「入口を出すリンク」）------------
  {
    const plus = await startFakePlus();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-plus-vis-'));
    const base = { env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: dir, appVersion: '0.32.0' };
    t.ok('visibility の欄が無い・知らない値 → optin に倒す',
      parseAuthConfig({ state: 'on' }).visibility === 'optin' && parseAuthConfig({ state: 'on', visibility: 'beta' }).visibility === 'optin');
    // optin: 印（pleiad://plus/enable）が無い端末は入口を出さない。印有り・AGENT_HOST_PLUS=1 は出す
    plus.state.visibility = 'optin';
    const optinCfg = await createPlusConfig(base).get({ fresh: true });
    t.ok('optin・印無し → 入口を出さない', createPlusConfig(base).derive(optinCfg).available === false);
    t.ok('optin・印有り → 入口を出す', createPlusConfig({ ...base, optIn: () => true }).derive(optinCfg).available === true);
    t.ok('optin・AGENT_HOST_PLUS=1 → 印無しでも出す', createPlusConfig({ ...base, env: { ...base.env, AGENT_HOST_PLUS: '1' } }).derive(optinCfg).available === true);
    // public は印無しでも出る。state off・AGENT_HOST_PLUS=0 はいつでも隠す
    plus.state.visibility = 'public';
    const pubCfg = await createPlusConfig(base).get({ fresh: true });
    t.ok('public・印無し → 入口を出す', createPlusConfig(base).derive(pubCfg).available === true);
    t.ok('AGENT_HOST_PLUS=0 → 全部隠す', createPlusConfig({ ...base, env: { ...base.env, AGENT_HOST_PLUS: '0' }, optIn: () => true }).derive(pubCfg).available === false);
    t.ok('state off → 全部隠す', createPlusConfig({ ...base, optIn: () => true }).derive({ ...pubCfg, state: 'off' }).available === false);
    await plus.close();
  }
  {
    // セッションの status も同じ。印を変えて refresh() すると知らせる（plusStatus イベントが画面を描き直す）
    let flag = false;
    const { plus, session, events } = await setup({ optIn: () => flag });
    plus.state.visibility = 'optin';
    await session.init();
    t.ok('status も optin・印無しを隠す', session.snapshot().available === false);
    flag = true;
    session.refresh();
    t.ok('印を立てて refresh() → 知らせて出す', events.some(e => e.type === 'config') && session.snapshot().available === true);
    await plus.close();
  }
}
