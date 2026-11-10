// Antigravity の受動の照会が `agy` を起こす条件:
//   - auth.status（probe 無し。起動時・定期の確認）は最後に分かった見通しだけを返し、`agy` を起こさない
//   - models() は cache（写し含む）か「既定（agy の設定）」だけを返す。
//     `agy models`（headless 保証が無いサブコマンド）は、このプロセスでログイン済みと確かめた所（'in'）でだけ起こす:
//       · 一覧が無いのに送信が覚えたエフォートを要る → requireModelCatalog が /usage で確かめてから取る（待つ）
//       · 使用量（/usage）が読めて一覧が無い → 裏で 1 回取る
//       · 'in' の間に一覧が読まれて TTL（AGENT_HOST_AGY_MODELS_TTL_MS。既定 5 分）を超えている → 裏で引き直す
//   - usage() だけは公式の headless 保証（--print/-p。未認証なら OAuth を始めず authentication required で落ちる、
//     対応版 1.1.11+）の内側で受動に起こせる。呼び出す引数・stdio・未認証の落ち方は偽 CLI で確かめる
//     （偽 CLI が確かめるのは Pleiad 側の呼び方。CLI 本体の保証は公式仕様と対応版の根拠）
//   - 未ログインが確定（authentication required / 認証 URL の要求）したら、以後の受動の照会も送信の関所も起こさない
//   - 認証成功のモデル cache がある状態で資格情報が失効しても、受動の models() は cache を返し、usage は
//     未認証で落ちて 'out' に戻る（毎回起こし続けない）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'antigravity-passive';
export const title = 'Antigravity: 受動の照会が agy を起こすのはログイン確定後だけ（usage は --print の保証内のみ）';

const FAKE = path.resolve('tests/lib/fake-agy.mjs').replace(/\\/g, '/');

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-passive-'));
  const argsFile = path.join(dir, 'args.json');
  const authFile = path.join(dir, 'auth.ok');
  const envFile = path.join(dir, 'env.json');
  const saved = {};
  for (const key of ['AGENT_HOST_AGY_BIN', 'AGENT_HOST_DATA', 'AGENT_HOST_AGY_SUGGEST_HOME', 'AGENT_HOST_AGY_MODELS_TTL_MS',
    'AGENT_HOST_AGY_MODELS_GATE_RETRY_MS', 'AGENT_HOST_AGY_EMPTY_SUCCESS_MS',
    'FAKE_AGY_NEEDS_AUTH', 'FAKE_AGY_AUTH_FILE', 'FAKE_AGY_ARGS_FILE', 'FAKE_AGY_ENV_FILE', 'FAKE_AGY_VERSION', 'FAKE_AGY_MODELS_FAIL', 'FAKE_AGY_DEFAULT_LABEL']) {
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

    // ---- 内部呼出しを分離できないので、候補の口（suggestNext）は持たない。ログインの状態に関わらず agy を起こさない
    const sugOutBefore = (await envCalls()).length;
    assert.equal(typeof backend.suggestNext, 'undefined', 'Antigravity は候補の内部呼出しを持たない');
    assert.equal(backend.capabilities.internalCall.state, 'impossible', '内部呼出しは分離できない');
    assert.equal(backend.capabilities.promptSuggestions.state, 'impossible', '候補も出せない');
    assert.equal((await envCalls()).length, sugOutBefore, '候補のために agy を起こさない');
    t.ok('Antigravity は内部呼出し（候補）を持たず、ログインの状態に関わらず agy を起こさない', true);

    // ---- 古い CLI（/usage の print を持たない）: attempted:false で返し、認証の見通しを変えない
    process.env.FAKE_AGY_VERSION = '1.1.10';
    await fs.writeFile(authFile, 'ok');
    await backend.auth.status({ probe: true });   // 'in' に戻す（明示の文脈）
    // ---- ログインしていても、候補の口は無い（内部呼出しの分離はログインと別の保証）
    const sugInBefore = (await envCalls()).length;
    assert.equal(typeof backend.suggestNext, 'undefined');
    assert.equal(backend.capabilities.internalCall.state, 'impossible');
    assert.equal((await envCalls()).length, sugInBefore, 'ログイン中でも候補のために agy を起こさない');
    t.ok('ログイン中でも Antigravity は候補の口を持たない', true);
    const old = await backend.usage();
    assert.equal(old.attempted, false, '古い CLI は print を起こさない（needsUpdate）');
    const before2 = (await calls()).length;
    await backend.usage();
    const spawns = (await calls()).slice(before2);
    // 認証しない版確認だけが起こる（/usage は送らない。起こすたびに --version を確かめるのは既存の動き）
    assert.ok(spawns.length && spawns.every((a) => a.includes('--version')) && !spawns.some((a) => a.includes('/usage')), '古い CLI には /usage を送らない');
    t.ok('古い CLI には /usage を送らず、認証の見通しを変えない', true);

    // ---- 送信の関所（requireModelCatalog）: 一覧が無ければ、/usage で見通しを確かめてから自分で取る。
    //      ログイン中なら取れ、「確かめる→取る」の全体は 1 本に束ねる（並ぶ呼び出しは同じ結果を受け取る）
    delete process.env.FAKE_AGY_VERSION;
    await fs.rm(modelsFile, { force: true });
    let reSeq = 0;
    const freshBackend = async () => (await import(`../../core/backends/antigravity.mjs?re=${Date.now()}-${++reSeq}`)).backend;
    const catalogCalls = () => calls().then((a) => a.filter((x) => x.at(-1) === 'models'));
    const usageCalls = () => calls().then((a) => a.filter((x) => x.includes('/usage')));
    const gate = await freshBackend();
    const beforeGate = (await catalogCalls()).length;
    const beforeGateUsage = (await usageCalls()).length;
    const [resolved] = await Promise.all([
      validateEffort(gate, 'low', 'fake-flash-high'),
      gate.requireModelCatalog(),
      gate.requireModelCatalog(),
    ]);
    assert.equal(resolved, 'low', '一覧を自分で取れれば保存済みのエフォートを適用する');
    assert.equal((await catalogCalls()).length, beforeGate + 1, '並ぶ取得は agy models を 1 本に束ねる');
    assert.equal((await usageCalls()).length, beforeGateUsage + 1, '並ぶ関所の /usage の確認も 1 本に束ねる');
    assert.equal((await gate.auth.status()).loggedIn, true, '一覧を取れた＝ログイン済みと分かる');
    t.ok('一覧が無くても送信の関所は /usage でログインを確かめて自分で一覧を取る（並ぶ関所は 1 本）', true);

    // ---- 未ログインと確かめられたら、関所は一覧を取りに行かずログインの案内を返す。確定後は usage すら起こさない
    await fs.rm(modelsFile, { force: true });   // 直前の取得が残した写しは消す（写しがあれば関所は素通しする）
    await fs.rm(authFile);
    const gateOut = await freshBackend();
    const beforeOut = (await catalogCalls()).length;
    await assert.rejects(gateOut.requireModelCatalog(), /ログイン/);
    assert.equal((await catalogCalls()).length, beforeOut, '見通しを確かめるのに agy models は起こさない');
    assert.equal((await gateOut.auth.status()).loggedIn, false);
    const stillOut = (await calls()).length;
    await assert.rejects(gateOut.requireModelCatalog(), /ログイン/);
    assert.equal((await calls()).length, stillOut, 'out のあとの関所は usage すら起こさない');
    t.ok('未ログインなら送信の関所は /usage で確かめてログインの案内を返す（agy models は起こさない）', true);

    // ---- 古い CLI（/usage を持たない）: 見通しを確かめられないので `agy models` は起こさず「確認して」の案内
    await fs.writeFile(authFile, 'ok');
    process.env.FAKE_AGY_VERSION = '1.1.10';
    const gateOld = await freshBackend();
    const beforeOld = (await calls()).length;
    await assert.rejects(gateOld.requireModelCatalog(), /モデル一覧/);
    const oldSpawns = (await calls()).slice(beforeOld);
    assert.ok(oldSpawns.length && oldSpawns.every((a) => a.includes('--version')) && !oldSpawns.some((a) => a.includes('models')), '古い CLI には一覧を取りに行かない');
    delete process.env.FAKE_AGY_VERSION;
    t.ok('見通しを確かめられなければ agy models は起こさず「一覧を確認して」の案内を返す', true);

    // ---- 使用量が読めて一覧（写しも無い）が無ければ、裏で 1 回一覧を取る（読むたびには取らない）
    await fs.rm(modelsFile, { force: true });
    const warm = await freshBackend();
    const beforeWarm = (await catalogCalls()).length;
    await warm.usage();
    for (let i = 0; i < 200 && (await catalogCalls()).length < beforeWarm + 1; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal((await catalogCalls()).length, beforeWarm + 1, 'usage が読めたら裏で一覧を 1 回取る');
    let warmed = {};
    for (let i = 0; i < 200 && !(warmed = await warm.models())['fake-flash-low']; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(warmed['fake-flash-low'], '裏で取れた一覧が見える');
    await warm.usage();
    assert.equal((await catalogCalls()).length, beforeWarm + 1, '一覧があるあとは usage のたびに取らない');
    t.ok('使用量が読めて一覧が無ければ裏で 1 回取り、取れた一覧を models() が見せる', true);

    // ---- 'in' の間、TTL を過ぎた一覧は読み取りをきっかけに裏で引き直す（agy 側の既定の変化を拾う。issue #161）
    process.env.AGENT_HOST_AGY_MODELS_TTL_MS = '1';
    process.env.FAKE_AGY_DEFAULT_LABEL = 'Fake Antigravity 1';
    const beforeTtl = (await catalogCalls()).length;
    await warm.models();   // TTL 超過の一覧 → 裏で引き直し
    delete process.env.AGENT_HOST_AGY_MODELS_TTL_MS;
    for (let i = 0; i < 200 && (await warm.models())['']?.resolvesTo !== 'fake-antigravity-1'; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal((await warm.models())[''].resolvesTo, 'fake-antigravity-1', '引き直した一覧で新しい既定が見える');
    assert.equal((await catalogCalls()).length, beforeTtl + 1, '裏の引き直しは 1 本');
    delete process.env.FAKE_AGY_DEFAULT_LABEL;
    t.ok('in の間は TTL 超過の一覧を読み取りをきっかけに裏で引き直す', true);

    // ---- 見通しが 'unknown'/'out' のままでは、古い一覧を返しても裏の引き直しは起こさない
    //      （写しの復元はログインの証拠にしない。'out' 確定後も同じ）
    const mirror = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
    mirror.fetchedAt = 1;   // 取れたのは昔（TTL 超過）
    await fs.writeFile(modelsFile, JSON.stringify(mirror));
    const asleep = await freshBackend();
    const beforeSleep = (await calls()).length;
    const restoredStale = await asleep.models();
    assert.ok(restoredStale['fake-flash-low'], '古い写しでも一覧は戻す');
    await asleep.requireModelCatalog();   // 写しがあるので関所も素通し（agy は起こさない）
    assert.equal((await calls()).length, beforeSleep, 'unknown のままでは引き直しも関所も agy を起こさない');
    t.ok('写しの復元だけのプロセス（unknown）は、古い一覧を返しても agy を起こさない', true);
    await fs.rm(authFile);
    const asleepOut = await freshBackend();
    await asleepOut.usage();   // AUTH_REQUIRED → 'out'
    const beforeOut2 = (await calls()).length;
    await asleepOut.models();
    assert.equal((await calls()).length, beforeOut2, 'out のままでは古い一覧でも引き直さない');
    await fs.writeFile(authFile, 'ok');
    t.ok('out のあとは古い一覧でも agy を起こさない', true);

    // ---- 認証の証拠: 保持役の付け直しが再生した result・本文の無い SUCCESS は 'in' にしない。
    //      再生はこのプロセスが確かめた訳ではなく、空の SUCCESS は打ち切り（print timeout）と見分けがつかない
    const noEvidence = await freshBackend();
    const replayCalls = (await calls()).length;
    // 保持役の子 1 つ分の写し（core/adopt.mjs の holderSource の形）。印（turn）から ack までが再生になる
    const replaySource = {
      id: 'agy-replay',
      client: { on() {}, off() {}, end() {}, kill() {}, mark() {}, label() {}, sendBatch() {} },
      state: { id: 'agy-replay', alive: true, acked: 1, seq: 1, marks: { turn: 1 } },
      attachable: true, acked: 0,
      async replay() {
        return [[1, JSON.stringify({ event: 'result', result: {
          conversation_id: 'conv-replay', status: 'SUCCESS', response: '過去の返事', duration_seconds: 0.1, num_turns: 1 } })]];
      },
      async *attach() { yield { exit: { code: 0, signal: null } }; },
      ack() {}, write() { return true; }, release() {}, dispose() {},
    };
    const adopted = await noEvidence.adoptTurn({
      sessionId: 'conv-replay', cwd: dir, emit: () => {},
      card: { held: true, agy: { sentAt: 1, resumed: true, sentHash: null, home: null, keys: null, hookRuns: null } },
      source: replaySource,
    });
    assert.equal(adopted.sessionId, 'conv-replay');
    assert.equal((await calls()).length, replayCalls, '付け直しの再生は agy を起こさない');
    assert.equal((await noEvidence.auth.status()).unconfirmed, true, '再生した SUCCESS はログインの証拠にしない');
    await noEvidence.models();
    assert.equal((await calls()).length, replayCalls, '再生の後の models() も agy models を起こさない');
    noEvidence.releaseConversation('conv-replay');
    // 本文の無い SUCCESS（'timeout' は空の SUCCESS を出してから印を stderr に書く。猶予を縮めて猶予後の確定側を試す）
    process.env.AGENT_HOST_AGY_EMPTY_SUCCESS_MS = '10';
    const emptySid = await noEvidence.runTurn({ cwd: dir, prompt: 'timeout', emit: () => {} }).then((r) => r?.sessionId).catch(() => null);
    if (emptySid) noEvidence.releaseConversation(emptySid);
    delete process.env.AGENT_HOST_AGY_EMPTY_SUCCESS_MS;
    assert.equal((await noEvidence.auth.status()).unconfirmed, true, '本文の無い SUCCESS もログインの証拠にしない');
    const afterEmpty = (await catalogCalls()).length;
    await noEvidence.models();
    assert.equal((await catalogCalls()).length, afterEmpty, '空の SUCCESS の後の models() も agy models を起こさない');
    t.ok('再生の result・本文の無い SUCCESS はログインの証拠にしない（一覧の自動の取得は開かない）', true);

    // ---- 関所の再試行の間隔は、裏の引き直しの間隔（TTL）と別。
    //      裏の取得が一時的な理由で落ちても、短い間隔（AGENT_HOST_AGY_MODELS_GATE_RETRY_MS。既定 30 秒）を過ぎれば自分で 1 回試す
    await fs.rm(modelsFile, { force: true });
    process.env.FAKE_AGY_MODELS_FAIL = '1';
    const retry = await freshBackend();
    await assert.rejects(retry.requireModelCatalog(), /モデル一覧/);   // /usage で 'in' にしてから取りに行くが、取得は落ちる
    const failedCalls = (await catalogCalls()).length;
    await assert.rejects(retry.requireModelCatalog(), /モデル一覧/);
    assert.equal((await catalogCalls()).length, failedCalls, '直前の失敗から短い間隔では agy models を起こさない');
    process.env.AGENT_HOST_AGY_MODELS_GATE_RETRY_MS = '1';
    delete process.env.FAKE_AGY_MODELS_FAIL;
    await new Promise((r) => setTimeout(r, 10));
    await retry.requireModelCatalog();
    assert.equal((await catalogCalls()).length, failedCalls + 1, '間隔を過ぎた関所は自分で 1 回取りに行く');
    assert.ok((await retry.models())['fake-flash-low'], '関所が取れた一覧が見える');
    t.ok('関所の再試行は直前の失敗からの短い間隔で控える（裏の失敗で送信が長く断られない）', true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
