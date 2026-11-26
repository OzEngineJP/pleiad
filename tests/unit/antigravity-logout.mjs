// Antigravity の 1 つ目のアカウント（CLI のログイン）の［ログアウト］と、ブラウザーでの入り直し（ADR 0365 の追記）。
//   - ログアウトは ACP の `logout`。agy が initialize で agentCapabilities.auth.logout を返したときだけ送る
//   - 口を返さない版では状態に logout: false が載り、画面は［ログアウト］を出さない
//   - 入り直しは ACP の `authenticate`（oauth-personal）。ファイル保存の env を付けない既定の場所（OS の資格情報ストア）に入る
//   - 失敗（ログアウトを断った・ログインを断った）は、押したカードに出せる 1 行の文で返る
// 🔴 本物の agy は使わない（この PC の 1 つ目のログインは利用者の Antigravity のアプリと共用）。身代わり（tests/lib/fake-agy.mjs）だけで流す
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t as tr } from '../../core/i18n.mjs';

export const name = 'antigravity-logout';
export const title = 'Antigravity の 1 つ目のアカウントは ACP の logout で外し、authenticate でブラウザーから入り直す';

const fake = fileURLToPath(new URL('../lib/fake-agy.mjs', import.meta.url));
const exists = (p) => fs.access(p).then(() => true, () => false);

export default async function run(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-logout-'));
  const home = path.join(data, 'home');
  await fs.mkdir(home);
  const keychain = path.join(data, 'keychain-marker');   // 身代わりの「OS の資格情報ストア」
  const acpLog = path.join(data, 'acp.jsonl');
  const keys = ['AGENT_HOST_AGY_BIN', 'AGENT_HOST_DATA', 'USERPROFILE', 'HOME', 'FAKE_AGY_AUTH_FILE', 'FAKE_AGY_NEEDS_AUTH', 'FAKE_AGY_ACP_LOG',
    'FAKE_AGY_AUTH_HOLD_MS', 'FAKE_AGY_AUTH_REFUSE', 'FAKE_AGY_NO_LOGOUT', 'FAKE_AGY_LOGOUT_FAIL', 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, {
      AGENT_HOST_AGY_BIN: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`,
      AGENT_HOST_DATA: data, USERPROFILE: home, HOME: home,
      FAKE_AGY_AUTH_FILE: keychain, FAKE_AGY_NEEDS_AUTH: '1', FAKE_AGY_ACP_LOG: acpLog,
    });
    for (const k of ['FAKE_AGY_AUTH_HOLD_MS', 'FAKE_AGY_AUTH_REFUSE', 'FAKE_AGY_NO_LOGOUT', 'FAKE_AGY_LOGOUT_FAIL', 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE']) delete process.env[k];
    await fs.writeFile(keychain, 'ok');   // ログイン済みから始める
    const acp = await import('../../core/backends/antigravity-acp.mjs');
    acp.forgetAgyLogoutOffer();
    const { backend } = await import(`../../core/backends/antigravity.mjs?re=logout-${Date.now()}`);
    const sent = async () => (await fs.readFile(acpLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l).method).filter(Boolean);

    // ---- 1. 明示の確認で、ログイン済みと口の有無が分かる
    const before = await backend.auth.status({ probe: true });
    t.ok('ログイン済みと分かる', before.loggedIn === true, JSON.stringify(before));
    t.ok('agy がログアウトの口を返すので logout: true が載る', before.logout === true, JSON.stringify(before));

    // ---- 2. ログアウト: ACP の logout を送り、資格情報が消え、状態は未ログインになる
    await backend.auth.logout();
    t.ok('ACP の logout を送る', (await sent()).includes('logout'), (await sent()).join());
    t.ok('資格情報が消える', !(await exists(keychain)));
    const after = await backend.auth.status();
    t.ok('外した後は agy を起こさずに未ログインと出る', after.loggedIn === false && !after.unconfirmed, JSON.stringify(after));
    t.ok('外した後も［ログインする］の口は残る（logout: true のまま）', after.logout === true, JSON.stringify(after));
    const probed = await backend.auth.status({ probe: true });
    t.ok('確かめ直しても未ログイン', probed.loggedIn === false, JSON.stringify(probed));

    // ---- 3. ブラウザーでの入り直し: authenticate（oauth-personal）。会話は作らない。既定の場所に入る
    await fs.writeFile(acpLog, '');
    const events = [];
    await backend.auth.login({ emit: (e) => events.push(e) });
    const methods = await sent();
    t.ok('ACP の authenticate を送る', methods.includes('authenticate'), methods.join());
    t.ok('試しの session/new は送らない（agy の会話を作らない）', !methods.includes('session/new'), methods.join());
    t.ok('ブラウザーでのログインを案内する（端末のコマンドは出さない）',
      events.some(e => e.phase === 'url' && e.message === tr('antigravity.accounts.loginInBrowser') && !e.url), JSON.stringify(events));
    t.ok('終わると done が届く', events.some(e => e.phase === 'done'), JSON.stringify(events));
    t.ok('既定の場所（OS の資格情報ストアに相当）に入る（ファイル保存にしない）', await exists(keychain)
      && !(await exists(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))));
    const back = await backend.auth.status();
    t.ok('入り直した後はログイン済み', back.loggedIn === true, JSON.stringify(back));

    // ---- 4. 入り直しを agy が断った: 理由を 1 行で AGY_LOGIN_REFUSED。次のログインは始められる
    await fs.rm(keychain, { force: true });
    process.env.FAKE_AGY_AUTH_REFUSE = 'This account has no Antigravity subscription';
    let refused = null;
    try { await backend.auth.login({ emit: () => {} }); } catch (e) { refused = e; }
    t.ok('断られたら AGY_LOGIN_REFUSED で返る', refused?.code === 'AGY_LOGIN_REFUSED', `${refused?.code} ${refused?.message}`);
    t.ok('理由を 1 行で伝える', typeof refused?.message === 'string' && !refused.message.includes('\n')
      && refused.message.includes('This account has no Antigravity subscription'), refused?.message);
    delete process.env.FAKE_AGY_AUTH_REFUSE;

    // ---- 5. 入り直しをやめた: ブラウザーを待つ agy を止め、CANCELLED で返る
    process.env.FAKE_AGY_AUTH_HOLD_MS = '10000';
    const waiting = [];
    let urlSeen;
    const seen = new Promise((r) => { urlSeen = r; });
    const pending = backend.auth.login({ emit: (e) => { waiting.push(e); if (e.phase === 'url') urlSeen(); } }).then(() => null, (e) => e);
    await seen;
    const cancel = await backend.auth.cancel();
    const stopped = await pending;
    t.ok('待っているログインをやめられる', cancel.cancelled === true && stopped?.code === 'CANCELLED', `${JSON.stringify(cancel)} ${stopped?.code}`);
    t.ok('やめたら資格情報は残らない', !(await exists(keychain)));
    t.ok('やめた後に待っているログインは無い', (await backend.auth.cancel()).cancelled === false);
    delete process.env.FAKE_AGY_AUTH_HOLD_MS;

    // ---- 6. ログアウトを agy が断った: 押したカードに出す短い文（wire の生の文は出さない）
    await fs.writeFile(keychain, 'ok');
    process.env.FAKE_AGY_LOGOUT_FAIL = 'keyring: secret service unavailable at /run/user/1000';
    let failed = null;
    try { await backend.auth.logout(); } catch (e) { failed = e; }
    t.ok('ログアウトの失敗は短い文で返る', failed?.message === tr('antigravity.auth.logoutRefused'), failed?.message);
    t.ok('失敗したら資格情報は残る', await exists(keychain));
    delete process.env.FAKE_AGY_LOGOUT_FAIL;

    // ---- 7. 口を返さない古い版: 状態に logout: false（画面は［ログアウト］を出さない）。押されても送らずに断る
    process.env.FAKE_AGY_NO_LOGOUT = '1';
    acp.forgetAgyLogoutOffer();
    const old = await backend.auth.status({ probe: true });
    t.ok('口を返さない版では logout: false が載る', old.logout === false, JSON.stringify(old));
    await fs.writeFile(acpLog, '');
    let noOffer = null;
    try { await backend.auth.logout(); } catch (e) { noOffer = e; }
    t.ok('口が無ければ logout を送らずに断る', noOffer?.message === tr('antigravity.auth.logoutInAgy') && !(await sent()).includes('logout'), noOffer?.message);
    t.ok('口が無い版では資格情報に触れない', await exists(keychain));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const acp = await import('../../core/backends/antigravity-acp.mjs');
    acp.forgetAgyLogoutOffer();
    await fs.rm(data, { recursive: true, force: true }).catch(() => {});
  }
}
