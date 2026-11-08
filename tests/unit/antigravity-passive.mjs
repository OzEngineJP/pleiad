// Antigravity の受動の照会は `agy` を起こさない:
//   - auth.status（probe 無し。起動時・定期の確認）は最後に分かった見通しだけを返し、`agy` を起こさない
//   - models() は cache か「既定（agy の設定）」だけ。`agy models`（headless 保証が無いサブコマンド）は起こさない
//   - usage() だけは公式の headless 保証（--print/-p。未認証なら OAuth を始めず authentication required で落ちる、
//     対応版 1.1.11+）の内側で受動に起こせる。呼び出す引数・stdio・未認証の落ち方は偽 CLI で確かめる
//     （偽 CLI が確かめるのは Pleiad 側の呼び方。CLI 本体の保証は公式仕様と対応版の根拠）
//   - 未ログインが確定（authentication required / 認証 URL の要求）したら、以後の受動の照会は起こさない
//   - 認証成功のモデル cache がある状態で資格情報が失効しても、受動の models() は cache を返し、usage は
//     未認証で落ちて 'out' に戻る（毎回起こし続けない）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'antigravity-passive';
export const title = 'Antigravity: 受動の照会は agy を起こさない（usage は --print の保証内のみ・未ログインで以後は起こさない）';

const FAKE = path.resolve('tests/lib/fake-agy.mjs').replace(/\\/g, '/');

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-passive-'));
  const argsFile = path.join(dir, 'args.json');
  const authFile = path.join(dir, 'auth.ok');
  const saved = {};
  for (const key of ['AGENT_HOST_AGY_BIN', 'FAKE_AGY_NEEDS_AUTH', 'FAKE_AGY_AUTH_FILE', 'FAKE_AGY_ARGS_FILE', 'FAKE_AGY_VERSION']) {
    saved[key] = process.env[key];
  }
  // node は PATH から解く（空白を含む実行ファイルのパスは parseCommand を崩す）
  process.env.AGENT_HOST_AGY_BIN = `node "${FAKE}"`;
  process.env.FAKE_AGY_NEEDS_AUTH = '1';
  process.env.FAKE_AGY_AUTH_FILE = authFile;
  process.env.FAKE_AGY_ARGS_FILE = argsFile;
  delete process.env.FAKE_AGY_VERSION;
  const calls = async () => { try { return JSON.parse(await fs.readFile(argsFile, 'utf8')); } catch { return []; } };
  try {
    const { backend } = await import('../../core/backends/antigravity.mjs');

    // ---- 受動の認証状態の確認（probe 無し）は、見通しがどこにあっても `agy` を起こさない
    await backend.auth.status();
    assert.equal((await calls()).length, 0, '受動の auth.status は agy を起こさない');
    const models0 = await backend.models();
    assert.ok(models0 && typeof models0 === 'object' && '' in models0, '一覧を引けていなければ「既定（agy の設定）」だけ返す');
    assert.equal((await calls()).length, 0, '受動の models() も agy を起こさない');
    t.ok('受動の auth.status・models は agy を起こさない', true);

    // ---- usage() は --print の保証の内側。未認証なら authentication required で落ち、以後の受動照会を止める
    const unauthed = await backend.usage();
    assert.equal(unauthed.reason, 'no-login');
    assert.deepEqual(unauthed.windows, []);
    let args = await calls();
    // 起こし方の回帰: --version（認証しない）→ --print /usage（headless 保証の引数。stdio は pipe＝非 TTY）
    assert.deepEqual(args[0], ['--version']);
    assert.deepEqual(args.at(-1), ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s']);
    const spawned = args.length;
    assert.equal((await backend.usage()).reason, 'no-login', '未ログインが確定したら usage を起こさない');
    const statusOut = await backend.auth.status();
    assert.equal(statusOut.loggedIn, false);
    await backend.models();
    assert.equal((await calls()).length, spawned, '未ログイン確定後の受動の照会（usage・auth.status・models）は agy を起こさない');
    t.ok('未認証の usage は no-login で返し、以後の受動の照会は agy を起こさない', true);

    // ---- 明示の再確認（probe）は `agy models` を起こしてよい。失敗しても未ログインの確定だけ
    const probeFail = await backend.auth.status({ probe: true });
    assert.equal(probeFail.loggedIn, false);
    assert.ok((await calls()).some((a) => a.includes('models')), 'probe は agy models を起こす');
    t.ok('明示の probe だけが agy models を起こし、未ログインなら失敗を返す', true);

    // ---- ログインすると（明示の probe で）見通しが 'in' になり、usage は再び起こしてよい
    await fs.writeFile(authFile, 'ok');
    const probeIn = await backend.auth.status({ probe: true });
    assert.equal(probeIn.loggedIn, true);
    const ok = await backend.usage();
    assert.ok(ok.attempted === true && ok.windows.length > 0, 'ログイン中は usage を起こして読む');
    const cached = await backend.models();
    assert.ok(Object.keys(cached).some((id) => id.startsWith('fake-')), '引けた一覧を cache する');
    t.ok('明示の probe・usage の成功で見通しが in になり、モデル一覧を cache する', true);

    // ---- cache が残ったまま資格情報が失効: 受動の models() は cache を返し（起こさない）、
    //      usage は未認証で落ちて 'out' に戻り、以後の受動照会は起こさない
    await fs.rm(authFile);
    const before = (await calls()).length;
    const stale = await backend.models();
    assert.ok(Object.keys(stale).some((id) => id.startsWith('fake-')), '資格情報の失効後も受動の一覧は cache を返す');
    assert.equal((await calls()).length, before, '失効後の受動の models() は agy を起こさない');
    const expired = await backend.usage();
    assert.equal(expired.reason, 'no-login', '失効後の usage は未認証で落ち、見通しを out に戻す');
    const spawnedAfter = (await calls()).length;
    assert.equal((await backend.usage()).reason, 'no-login');
    assert.equal((await backend.auth.status()).loggedIn, false);
    assert.equal((await calls()).length, spawnedAfter, '失効が確定したら以後の受動の照会は agy を起こさない');
    t.ok('cache あるまま資格情報が失効しても、受動は cache/未ログインを返して起こさない', true);

    // ---- 古い CLI（/usage の print を持たない）: attempted:false で返し、認証の見通しを変えない
    process.env.FAKE_AGY_VERSION = '1.1.10';
    await fs.writeFile(authFile, 'ok');
    await backend.auth.status({ probe: true });   // 'in' に戻す（明示の文脈）
    const old = await backend.usage();
    assert.equal(old.attempted, false, '古い CLI は print を起こさない（needsUpdate）');
    const before2 = (await calls()).length;
    await backend.usage();
    const spawns = (await calls()).slice(before2);
    // 認証しない版確認だけが起こる（/usage は送らない。起こすたびに --version を確かめるのは既存の動き）
    assert.ok(spawns.length && spawns.every((a) => a.includes('--version')) && !spawns.some((a) => a.includes('/usage')), '古い CLI には /usage を送らない');
    t.ok('古い CLI には /usage を送らず、認証の見通しを変えない', true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
