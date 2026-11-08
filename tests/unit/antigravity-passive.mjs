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
  const envFile = path.join(dir, 'env.json');
  const saved = {};
  for (const key of ['AGENT_HOST_AGY_BIN', 'AGENT_HOST_DATA', 'AGENT_HOST_AGY_SUGGEST_HOME',
    'FAKE_AGY_NEEDS_AUTH', 'FAKE_AGY_AUTH_FILE', 'FAKE_AGY_ARGS_FILE', 'FAKE_AGY_ENV_FILE', 'FAKE_AGY_VERSION', 'FAKE_AGY_MODELS_FAIL']) {
    saved[key] = process.env[key];
  }
  // node は PATH から解く（空白を含む実行ファイルのパスは parseCommand を崩す）
  process.env.AGENT_HOST_AGY_BIN = `node "${FAKE}"`;
  process.env.AGENT_HOST_DATA = dir;   // 一覧の写し（antigravity/models.json）をこの試験の置き場に向ける
  process.env.AGENT_HOST_AGY_SUGGEST_HOME = path.join(dir, 'pleiad-agy-suggest');   // 候補づくりの使い捨ての home も閉じ込める
  process.env.FAKE_AGY_NEEDS_AUTH = '1';
  process.env.FAKE_AGY_AUTH_FILE = authFile;
  process.env.FAKE_AGY_ARGS_FILE = argsFile;
  process.env.FAKE_AGY_ENV_FILE = envFile;   // 候補づくりの起こしも控える（args には入らない。fake-agy.mjs 参照）
  delete process.env.FAKE_AGY_VERSION;
  const calls = async () => { try { return JSON.parse(await fs.readFile(argsFile, 'utf8')); } catch { return []; } };
  const envCalls = async () => { try { return JSON.parse(await fs.readFile(envFile, 'utf8')); } catch { return []; } };
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

    // ---- 一覧を引けていない間（cache 無し＝再起動直後）は、保存済みの明示モデルを
    //      「一覧に無い」で既定へ戻さない（claude.mjs と同じ考え。不実な id は CLI が断る）。形の悪いものは通さない
    assert.equal(await backend.validModel(''), true);
    assert.equal(await backend.validModel('saved-gemini-3-pro-high'), true, 'cache 無しでも保存済みの id は通す');
    assert.equal(await backend.validModel('bogus id!'), false, '形の悪いものは通さない');
    assert.equal(await backend.validModel('x'.repeat(300)), false);
    assert.equal((await calls()).length, spawned, 'validModel も agy を起こさない');
    t.ok('一覧未取得の間は保存済みの明示モデルを通す（起こさない）', true);

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
    // ---- 一覧が引けたあとは一覧どおりに見る（段違いは隠し行として残る。一覧に無い id は断る）
    assert.equal(await backend.validModel('fake-flash-low'), true);
    assert.equal(await backend.validModel('fake-antigravity-1'), true);
    assert.equal(await backend.validModel('not-in-list'), false, '一覧に無い id は断る');
    t.ok('明示の probe・usage の成功で見通しが in になり、モデル一覧を cache する', true);

    // ---- probe が未認証以外で落ちても「ログインしていない」と断定しない（見通しは in のまま。
    //      生の stderr（URL・パスを含みうる）も detail に出さない。確かめる UI が確定ログアウトと表示しないように）
    process.env.FAKE_AGY_MODELS_FAIL = '1';
    const probeUnknown = await backend.auth.status({ probe: true });
    assert.equal(probeUnknown.loggedIn, false);
    assert.equal(probeUnknown.unconfirmed, true, '理由の分からない失敗は未確認のまま');
    assert.ok(!String(probeUnknown.detail ?? '').includes('internal failure'), '生の stderr を detail に出さない');
    assert.ok(!String(probeUnknown.detail ?? '').includes('accounts.example.invalid'), '生の URL も detail に出さない');
    delete process.env.FAKE_AGY_MODELS_FAIL;
    assert.equal((await backend.auth.status()).loggedIn, true, '見通しは in のまま（out にも unknown にも戻さない）');
    t.ok('probe の未知の失敗は未確認扱い（ログアウト断定・生 stderr を出さない）', true);

    // ---- 一覧の写し: 次のプロセスは `agy models` 無しで一覧と段を戻す（保存済みの明示モデル・
    //      エフォートを失わない。写しは認証の証拠にしない）
    const modelsFile = path.join(dir, 'antigravity', 'models.json');
    const written = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
    assert.ok(Array.isArray(written.rows) && written.rows.length > 0 && written.rows.length <= 64, '一覧の写しを上限付きで残す');
    const fresh = (await import(`../../core/backends/antigravity.mjs?re=${Date.now()}`)).backend;
    const { effortOptions, validateEffort } = await import('../../core/effort.mjs');
    const beforeRe = (await calls()).length;
    // 起動直後に models・validModel・effortOptions が並んでも、全員が同じ写しの読み込みを待つ
    const [restored, validLow, options] = await Promise.all([
      fresh.models(), fresh.validModel('fake-flash-low'), effortOptions(fresh, 'fake-flash-low')]);
    assert.ok(restored['fake-flash-low'], '写しから一覧を戻す');
    assert.ok(restored['fake-flash-low'].efforts?.includes('low'), '段（エフォートの候補）も戻る');
    assert.equal(validLow, true);
    assert.ok(Object.hasOwn(options, 'low'), 'effortOptions も写しの段を返す');
    assert.equal(await validateEffort(fresh, 'low', 'fake-flash-low'), 'low', '保存済みのエフォートを既定へ落とさない');
    assert.equal((await calls()).length, beforeRe, '写しの復元は agy を起こさない');
    assert.equal((await fresh.auth.status()).unconfirmed, true, '写しはログインの証拠にしない（見通しは unknown のまま）');
    t.ok('一覧の写しで再起動後も明示モデル・エフォートを戻す（agy は起こさない・認証の証拠にしない）', true);

    // ---- 写しが無い・壊れている新しいプロセスでも、保存済みの明示モデルは通す
    await fs.writeFile(modelsFile, 'not json');
    const corrupt = (await import(`../../core/backends/antigravity.mjs?re=${Date.now() + 1}`)).backend;
    assert.equal(await corrupt.validModel('saved-gemini-3-pro-high'), true, '写しが壊れていても指定 id を保つ');
    assert.equal(await corrupt.validModel('bogus id!'), false);
    t.ok('写しが無い・壊れている新規でも指定 id を保つ', true);

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

    // ---- 未ログインが確定している間は suggestNext も新規起動しない（`--print` の保証内でも、
    //      起動ごとに使い捨ての会話履歴を書くため。確定していなければ従来どおり試す——保証内の機能を無用に止めない）
    const sugOutBefore = (await envCalls()).length;
    assert.equal(await backend.suggestNext({ prompt: 'test' }), null, '未ログイン確定の間は候補づくりを起こさない');
    assert.equal((await envCalls()).length, sugOutBefore, 'suggestNext も agy を起こさない');
    t.ok('未ログイン確定の間は suggestNext も起こさない', true);

    // ---- 古い CLI（/usage の print を持たない）: attempted:false で返し、認証の見通しを変えない
    process.env.FAKE_AGY_VERSION = '1.1.10';
    await fs.writeFile(authFile, 'ok');
    await backend.auth.status({ probe: true });   // 'in' に戻す（明示の文脈）
    // ---- 未ログインが確定していなければ、suggestNext は従来どおり `--print` で起こす（保証内の機能を無用に止めない）
    const sugInBefore = (await envCalls()).length;
    const sug = await backend.suggestNext({ prompt: '続きを書いて' });
    assert.ok((await envCalls()).length > sugInBefore, '確定していなければ候補づくりを従来どおり起こす');
    assert.equal(typeof sug, 'string', '候補の文字列を返す');
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
