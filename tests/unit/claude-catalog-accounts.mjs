// Claude のアカウントごとのモデル一覧・検証・キャッシュ隔離・秘匿・無効化・LRU・Mythos 説明・bot/心拍の backendForAccount（ADR 0326）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backend as claude, setClaudeSdkForTest, probeClaudeCatalogForTest } from '../../core/backends/claude.mjs';
import { createUsageMonitor } from '../../core/delegation-usage.mjs';
import { buildClaudeModels } from '../../core/backends/claude-models.mjs';
import { backendForAccount, accountUnavailableBackend } from '../../core/backends/index.mjs';
import { currentLocale, setLocale } from '../../core/i18n.mjs';
import { createBrainStore } from '../../core/brain/store.mjs';
import { createPulse } from '../../core/brain/pulse.mjs';
import { createBudget } from '../../core/bots/budget.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createBotSessions } from '../../core/bots/sessions.mjs';
import { normalizePulse } from '../../core/bots/store.mjs';

export const name = 'claude-catalog-accounts';
export const title = 'Claude: アカウントごとのモデル一覧・検証・anyCatalog 隔離・秘匿・無効化・Mythos 説明・心拍';

const TOK_VERIFIED = 'sk-ant-oat01-' + 'V'.repeat(40);
const TOK_PLAIN = 'sk-ant-oat01-' + 'N'.repeat(40);

const STANDARD_14 = [
  { value: 'default', displayName: 'Default', description: 'Use default model' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 4.6' },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: '' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: '' },
  { value: 'claude-opus-5', displayName: 'Opus 5', description: '' },
  { value: 'claude-fable-5', displayName: 'Fable 5', description: '' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
  { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
];
const MYTHOS_16 = [
  ...STANDARD_14,
  { value: 'claude-mythos-5-2', resolvedModel: 'claude-mythos-5-2', displayName: 'Mythos 5.2', description: '' },
  { value: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1', displayName: 'Mythos 5.1', description: '' },
];
const SHORT_4 = [
  { value: 'default', displayName: 'Default', description: '' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: '' },
];

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

export default async function (t) {
  // 同じ worker で先に走った suite の一覧を持ち込まず、終わるときも残さない
  // （後の suite は、CLI の版の目印の食い違いで前の一覧を忘れることを当てにして書かれている。
  //  fake の実行ファイルは目印が無いので、残すと後の suite の「取れていない間」の答えに混ざる）
  claude.invalidateModels();
  const prevLocale = currentLocale();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-cat-acct-'));
  const w1 = path.join(dir, 'w1');
  const w2 = path.join(dir, 'w2');
  const w3 = path.join(dir, 'w3');
  await Promise.all([w1, w2, w3].map((p) => fs.mkdir(p, { recursive: true })));

  // ---- 1. Mythos の説明文（ja / en 両方）
  try {
    setLocale('ja');
    const jaMap = buildClaudeModels({ rows: MYTHOS_16 });
    assert.equal(jaMap['claude-mythos-5-2']?.label, 'Mythos 5.2');
    assert.equal(jaMap['claude-mythos-5-2']?.note, '承認された組織向け。使用枠は Fable と共有');
    setLocale('en');
    const enMap = buildClaudeModels({ rows: MYTHOS_16 });
    assert.equal(enMap['claude-mythos-5-2']?.note, 'For verified organizations. Shares the Fable usage limit.');
    t.ok('Mythos の説明文は ja / en の辞書から補う', true);
  } finally {
    setLocale(prevLocale);
  }

  // ---- 2. backendForAccount: accounts: 'token' / 'agent' で forAccount を呼ぶ（ログイン中・未指定は元を包む／そのまま）
  {
    const loginNull = await backendForAccount(claude, null);
    const loginUndef = await backendForAccount(claude, undefined);
    assert.equal(loginNull.id, 'claude');
    assert.equal(loginUndef.id, 'claude');
    const plainWrapped = await backendForAccount({ id: 'no-accounts', capabilities: {} }, { id: 'a1' });
    assert.equal(plainWrapped.id, 'no-accounts');
    const verified = await backendForAccount(claude, { id: 'acc-wrap-verified', token: TOK_VERIFIED });
    assert.notEqual(verified, claude);
    assert.equal(verified.id, 'claude');

    let agentSeen = null;
    const agentLike = {
      id: 'custom-agent',
      capabilities: { accounts: 'agent' },
      forAccount: (acct) => { agentSeen = acct; return { id: 'custom-agent', scoped: acct.id }; },
    };
    const wrappedAgent = await backendForAccount(agentLike, { id: 'a1' });
    assert.equal(agentSeen?.id, 'a1');
    assert.equal(wrappedAgent.scoped, 'a1');
    t.ok('backendForAccount は token / agent の両方で forAccount を返し、未指定なら元のバックエンド', true);
  }

  // ---- 3. probeCatalog の資格情報受け渡し・トークン秘匿・missing token・anyCatalog 隔離・invalidateModels
  {
    const seenProbes = [];
    const logs = [];
    const origError = console.error;
    console.error = (...a) => { logs.push(a.map(String).join(' ')); };
    let mode = 'normal';
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude',
      cliSigThrottleMs: 1e9,
      query: ({ options }) => {
        const tok = options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '';
        seenProbes.push({ cwd: options?.cwd, hasTok: Boolean(tok), isVerified: tok === TOK_VERIFIED, isPlain: tok === TOK_PLAIN });
        if (mode === 'leak-error' && tok === TOK_VERIFIED) {
          // message・cause・追加の項目のどこにもトークンが混ざる失敗（見分けに要る code だけは残る）
          throw Object.assign(new Error(`HTTP 401 bearer ${TOK_VERIFIED}`, { cause: new Error(`upstream rejected ${TOK_VERIFIED}`) }),
            { code: 'E401', detail: `Authorization: Bearer ${TOK_VERIFIED}` });
        }
        const rows = tok === TOK_VERIFIED ? MYTHOS_16 : STANDARD_14;
        return {
          initializationResult: async () => ({ models: rows }),
          supportedModels: async () => rows,
          close: () => {},
          async *[Symbol.asyncIterator]() {},
        };
      },
    });
    try {
      const verified = await backendForAccount(claude, { id: 'acct-q-verified', token: TOK_VERIFIED });
      const plain = await backendForAccount(claude, { id: 'acct-q-plain', token: TOK_PLAIN });
      const missing = await backendForAccount(claude, { id: 'acct-q-missing', token: '' });

      const [mLogin, mVerified, mPlain] = await Promise.all([claude.models(w1), verified.models(w1), plain.models(w1)]);
      assert.equal('claude-mythos-5-2' in mLogin, false);
      assert.equal('claude-mythos-5-2' in mVerified, true);
      assert.equal('claude-mythos-5-2' in mPlain, false);
      assert.equal('mythos' in mVerified, false);
      // validModel は「models() に無かったとき、まだ一度も一覧を取れていない間だけ形の良い id を通す」フォールバック
      assert.equal(await plain.validModel('claude-mythos-5-2', w1), false);
      assert.equal(await claude.validModel('claude-mythos-5-2', w1), false);
      assert.equal(await verified.matchModel('claude-mythos-5-2', w1), 'claude-mythos-5-2');
      assert.equal(await plain.matchModel('claude-mythos-5-2', w1), null);
      assert.equal(await claude.matchModel('claude-mythos-5-2', w1), null);
      t.ok('probeCatalog: 承認のあるアカウントだけ Mythos 5.2 を持ち、ほかのアカウントとログイン中のアカウントは持たない（別名 mythos も作らない）', true);

      // トークンの無いアカウントは CLI を起こさず、ログイン中へフォールバックもしない
      const beforeMissing = seenProbes.length;
      const mMissing = await missing.models(w1);
      assert.equal(seenProbes.length, beforeMissing);
      assert.equal('claude-mythos-5-2' in mMissing, false);
      t.ok('トークンが無いアカウントの models は CLI を起こさず静的フォールバック', true);

      // エラーにトークンが混ざっても、ログと、投げ直すエラー（message・cause・追加の項目・stack）から伏せる
      mode = 'leak-error';
      const logsBefore = logs.length;
      await verified.models(w2, { refresh: true });
      const newLogs = logs.slice(logsBefore);
      assert.ok(newLogs.some((l) => l.includes('モデル一覧を取れなかった')), `失敗のログが出ていること: ${JSON.stringify(newLogs)}`);
      assert.equal(logs.some((l) => l.includes(TOK_VERIFIED)), false, 'ログに生のトークンを出さない');
      let thrown = null;
      try { await probeClaudeCatalogForTest(w2, true, { id: 'acct-q-verified', token: TOK_VERIFIED }); } catch (e) { thrown = e; }
      assert.ok(thrown, 'トークンの混ざった失敗は投げ直される');
      assert.equal(String(thrown.message).includes(TOK_VERIFIED), false, 'message にトークンを残さない');
      assert.equal('cause' in thrown, false, '元のエラー（cause）を渡さない');
      assert.equal('detail' in thrown, false, '元のエラーの追加の項目を渡さない');
      assert.equal(thrown.code, 'E401', '見分けに要る code だけは残す');
      assert.equal(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)).includes(TOK_VERIFIED), false, 'stack にもトークンを残さない');
      t.ok('probe 失敗のログが出ていて、ログと投げ直すエラー（message・cause・追加の項目・stack）に生トークンを残さない', true);
    } finally {
      console.error = origError;
      restore();
      claude.invalidateModels();
    }
  }

  // ---- 4. sdk.probe の署名（生トークンを渡さない）・anyCatalog・coldSince・短い一覧・generation・LRU 64
  {
    const probeOpts = [];
    const customRows = new Map();
    const calls = new Map();
    const gates = new Map();
    const bump = (k) => calls.set(k, (calls.get(k) ?? 0) + 1);
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude',
      cliSigThrottleMs: 1e9,
      probe: async (cwd, isDefault, extra) => {
        probeOpts.push({ cwd, isDefault, extra });
        const acc = extra?.accountId ?? 'login';
        bump(`${acc}|${cwd}`);
        if (gates.has(acc)) {
          const g = gates.get(acc);
          gates.delete(acc);
          g.started?.resolve();
          return { rows: await g.promise, efforts: {}, applied: !isDefault };
        }
        const handler = customRows.get(acc);
        if (typeof handler === 'function') return { rows: handler(cwd, isDefault), efforts: {}, applied: !isDefault };
        if (handler instanceof Error) throw handler;
        return { rows: acc.startsWith('verified') ? MYTHOS_16 : STANDARD_14, efforts: {}, applied: !isDefault };
      },
    });
    try {
      // sdk.probe に生トークンを含めない（accountId だけ）
      const verifiedIso = claude.forAccount({ id: 'verified-iso', token: TOK_VERIFIED });
      const plainIso = claude.forAccount({ id: 'plain-iso', token: TOK_PLAIN });
      const coldIso = claude.forAccount({ id: 'cold-iso', token: TOK_PLAIN });

      const mVerified = await verifiedIso.models(w1);
      assert.equal('claude-mythos-5-2' in mVerified, true);
      assert.equal(JSON.stringify(probeOpts.at(-1)).includes(TOK_VERIFIED), false);
      assert.equal(probeOpts.at(-1).extra?.accountId, 'verified-iso');
      t.ok('sdk.probe には生トークンを渡さず accountId だけ渡す', true);

      // anyCatalog の隔離: verified-iso が成功済みでも、失敗した plain-iso (別 cwd) には verified-iso の Mythos を貸さない
      customRows.set('plain-iso', new Error('offline'));
      const mPlainFail = await plainIso.models(w2);
      assert.equal('claude-mythos-5-2' in mPlainFail, false);
      t.ok('別アカウント（verified-iso）の anyCatalog を失敗中の plain-iso へ返さない', true);

      // plain-iso 自身が w1 で固有のモデルを一度取れたあとは、w3 の失敗では plain-iso 自身の anyCatalog を返す
      customRows.set('plain-iso', () => [...STANDARD_14, { value: 'claude-plain-only', displayName: 'Plain Only', description: '' }]);
      const mPlainOk = await plainIso.models(w1);
      assert.equal('claude-plain-only' in mPlainOk, true);
      customRows.set('plain-iso', new Error('offline-again'));
      const mPlainAny = await plainIso.models(w3);
      assert.equal('claude-plain-only' in mPlainAny && !('claude-mythos-5-2' in mPlainAny), true);
      t.ok('失敗時は同じアカウント自身の anyCatalog だけを返す', true);

      // coldSince / 未取得判定の隔離: plain-iso が取得済みでも、未取得のまま失敗した cold-iso は形の良いモデルを即座には断らない
      customRows.set('cold-iso', new Error('not ready'));
      assert.equal(await plainIso.validModel('claude-mythos-5-2', w1), false);
      assert.equal(await coldIso.validModel('claude-mythos-5-2', w1), true);
      t.ok('他アカウントの取得済み状態を共有せず、一覧を一度も取れていないアカウントは形の良い ID を断らない', true);

      // 短い一覧保護（ADR 0310）のアカウントごと維持（新しい cwd でも完全な anyCatalog を短い一覧で上書きしない）
      const wShort = path.join(dir, 'w-short');
      customRows.set('verified-iso', () => SHORT_4);
      const afterShort = await verifiedIso.models(wShort, { refresh: true });
      assert.equal('claude-mythos-5-2' in afterShort, true);
      assert.equal('claude-mythos-5-2' in await verifiedIso.models(w1), true);
      t.ok('短い一覧を受け取ってもそのアカウントの完全な一覧を上書きしない', true);

      // 完全な一覧を一度も取れていないアカウントが短い一覧を返しても、別のアカウントの完全な一覧は貸さない（その短い一覧を使う）
      customRows.set('short-iso', () => SHORT_4);
      const shortIso = claude.forAccount({ id: 'short-iso', token: TOK_PLAIN });
      const mShort = await shortIso.models(w1);
      assert.equal('claude-opus-4-6' in mShort, true);
      assert.equal('claude-opus-4-8' in mShort, false);
      assert.equal('claude-mythos-5-2' in mShort, false);
      t.ok('短い一覧しか返さないアカウントへ、別のアカウントの完全な一覧を貸さない（ADR 0310 の規則もアカウントごと）', true);

      // invalidateModels(accountId) と in-flight の世代保護
      customRows.set('plain-iso', () => STANDARD_14);
      await plainIso.models(w1, { refresh: true });
      const plainCountBefore = calls.get(`plain-iso|${w1}`) ?? 0;

      const wInv = path.join(dir, 'w-inv');
      const staleGate = { ...deferred(), started: deferred() };
      gates.set('verified-iso', staleGate);
      const inFlight = verifiedIso.models(wInv, { refresh: true });
      await staleGate.started.promise;
      claude.invalidateModels('verified-iso');
      customRows.set('verified-iso', () => [
        ...MYTHOS_16,
        { value: 'claude-fresh-after-inv', displayName: 'Fresh After Inv', description: '' },
      ]);
      staleGate.resolve([...STANDARD_14, { value: 'claude-stale-before-inv', displayName: 'Stale Before Inv', description: '' }]);
      await inFlight;
      const freshAfterInv = await verifiedIso.models(wInv);
      await plainIso.models(w1);
      assert.equal('claude-fresh-after-inv' in freshAfterInv, true);
      assert.equal('claude-stale-before-inv' in freshAfterInv, false);
      assert.equal(calls.get(`plain-iso|${w1}`), plainCountBefore);
      t.ok('invalidateModels(accountId): 取得中の古い結果をキャッシュに書かず、他のアカウントのキャッシュも壊さない', true);

      // 一覧の記憶の上限（claude.mjs の CATALOG_MAX = 64）: 同じアカウントで、作業場所を上限より多く引く。
      // 上限を超えて追い出されるのは「最も長く触っていない 1 件」だけで、途中で触った作業場所と新しい作業場所は残る。
      // （作業場所が上限以下なら追い出しの経路に入らず、上限が 1 でも通ってしまうので、必ず上限を 1 つ超えるところまで引く）
      const CATALOG_MAX = 64;
      const lruCwds = Array.from({ length: CATALOG_MAX + 1 }, (_, i) => path.join(dir, `lru-${i}`));
      const lruCount = (cwd) => calls.get(`lru-iso|${cwd}`) ?? 0;
      customRows.set('lru-iso', () => STANDARD_14);
      const lruIso = claude.forAccount({ id: 'lru-iso', token: TOK_PLAIN });
      // 最初の 64 件は取り直し（refresh）で確実に 1 回ずつ引く（通常の呼び出しは手元の答えがあると裏で引くので、回数が揺れる）
      for (const cwd of lruCwds.slice(0, CATALOG_MAX)) await lruIso.models(cwd, { refresh: true });
      assert.equal(lruCwds.slice(0, CATALOG_MAX).every((cwd) => lruCount(cwd) === 1), true, '上限までは 1 回ずつ引いて、全部残っている');
      // 先頭（最も古い）を触って、最近使った側へ寄せる（記憶に残っているので引かない）
      await lruIso.models(lruCwds[0]);
      assert.equal(lruCount(lruCwds[0]), 1);
      // 上限を 1 つ超える 65 件目を引く → 最も長く触っていない 2 件目（lru-1）だけが追い出される
      await lruIso.models(lruCwds[CATALOG_MAX], { refresh: true });
      assert.equal(lruCount(lruCwds[CATALOG_MAX]), 1);
      // 残っているものは、通常の呼び出しで引き直さない（引き直せば回数が増える。裏の引き直しが走る暇を与えてから数える）
      const kept = [0, 2, 3, 31, 32, 62, 63, 64];
      for (const i of kept) await lruIso.models(lruCwds[i]);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(kept.map((i) => lruCount(lruCwds[i])), kept.map(() => 1), '触った先頭と新しい作業場所と途中のものは残る');
      // 追い出されたのは 2 件目だけ: 取り直すと CLI をもう 1 回起こす
      await lruIso.models(lruCwds[1], { refresh: true });
      assert.equal(lruCount(lruCwds[1]), 2, '追い出された作業場所は引き直す');
      t.ok('一覧の記憶の上限（64）を超えて引いても、追い出されるのは最も長く触っていない 1 件だけで、途中で触った作業場所は残る', true);
    } finally {
      restore();
      claude.invalidateModels();
    }
  }

  // ---- 4b. 失敗の再試行待ち・warmModels の直列・入れ替え／削除で一覧を忘れる・互換の接続先でアカウントのトークンを渡さない（アカウントごと）
  {
    claude.invalidateModels();
    const calls = new Map();
    const startOrder = [];
    const behaviour = new Map();
    let inflight = 0, peak = 0;
    const origError = console.error;
    const realNow = Date.now;
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude',
      cliSigThrottleMs: 1e9,
      probe: async (cwd, isDefault, extra) => {
        const acc = extra?.accountId ?? 'login';
        calls.set(acc, (calls.get(acc) ?? 0) + 1);
        startOrder.push(acc);
        inflight++; peak = Math.max(peak, inflight);
        try {
          // CLI が答えるまでの間（これが重なると peak が 2 以上になる）
          await new Promise((r) => setTimeout(r, 15));
          const h = behaviour.get(acc);
          if (h instanceof Error) throw h;
          return { rows: typeof h === 'function' ? h() : STANDARD_14, efforts: {}, applied: !isDefault };
        } finally { inflight--; }
      },
    });
    try {
      console.error = () => {}; // 失敗のログは試験の出力に混ぜない
      const upOnly = () => [...STANDARD_14, { value: 'claude-up-only', displayName: 'Up Only', description: '' }];
      const down = claude.forAccount({ id: 'retry-down', token: TOK_PLAIN });
      const up = claude.forAccount({ id: 'retry-up', token: TOK_VERIFIED });
      behaviour.set('retry-down', new Error('offline'));
      behaviour.set('retry-up', upOnly);

      // 失敗した直後の再試行待ち（60 秒）の間は、取り直し（refresh）でも CLI を起こし直さず、固定の一覧で答える
      const failedList = await down.models(w1, { refresh: true });
      assert.equal(calls.get('retry-down'), 1);
      assert.equal('claude-up-only' in failedList, false);
      await down.models(w1, { refresh: true });
      await down.models(w1);
      await down.models(w1, { refresh: true });
      assert.equal(calls.get('retry-down'), 1, '再試行待ちの間は、取り直しでも CLI を起こし直さない');
      // 別のアカウントは待ちに巻き込まれず、引ける。引けたあとも、待ちの間のアカウントへその一覧を貸さない
      const upList = await up.models(w1, { refresh: true });
      assert.equal('claude-up-only' in upList, true);
      assert.equal(calls.get('retry-up'), 1);
      const downWhileUp = await down.models(w1, { refresh: true });
      assert.equal('claude-up-only' in downWhileUp, false, '別のアカウントの一覧を貸さない');
      assert.equal(calls.get('retry-down'), 1);
      assert.equal(await down.validModel('claude-up-only'), true, 'まだ一度も引けていないアカウントは、形の良い ID を断らない（別のアカウントの一覧では裁かない）');
      // 待ちが明けたら（60 秒後）また引く
      Date.now = () => realNow() + 61_000;
      behaviour.set('retry-down', () => [...STANDARD_14, { value: 'claude-down-back', displayName: 'Down Back', description: '' }]);
      const downBack = await down.models(w1, { refresh: true });
      Date.now = realNow;
      assert.equal(calls.get('retry-down'), 2, '待ちが明けたら起こし直す');
      assert.equal('claude-down-back' in downBack, true);
      assert.equal('claude-up-only' in downBack, false);
      assert.equal(calls.get('retry-up'), 1, '別のアカウントの待ちや再開は、このアカウントに影響しない');
      t.ok('失敗の再試行待ちはアカウントごと: 待ちの間は取り直しでも CLI を起こし直さず、ほかのアカウントの一覧を貸さず、明けたら引き直す', true);

      // warmModels は、アカウントが何件あっても（ログイン中も含めて）CLI を同時に起こさず、呼んだ順に 1 本ずつ引く。1 件が失敗しても続きを止めない
      calls.clear(); startOrder.length = 0; inflight = 0; peak = 0;
      const warmIds = ['warm-a', 'warm-b', 'warm-c'];
      const warmers = warmIds.map((id) => claude.forAccount({ id, token: TOK_PLAIN }));
      behaviour.set('warm-b', new Error('warm failed'));
      await Promise.all([claude.warmModels(w1), ...warmers.map((a) => a.warmModels(w1))]);
      assert.equal(peak, 1, 'warm は CLI を同時に起こさない');
      assert.deepEqual(startOrder, ['login', ...warmIds], '呼んだ順に 1 本ずつ引く');
      assert.deepEqual(['login', ...warmIds].map((id) => calls.get(id)), [1, 1, 1, 1], '失敗した 1 件があっても、後ろのアカウントを引く');
      t.ok('warmModels は、ログイン中と登録アカウントの一覧を同時に起こさず順に引き、1 件の失敗で続きを止めない', true);

      // トークンの入れ替え・アカウントの削除（invalidateModels(accountId)）で、そのアカウントの一覧を忘れる。ほかのアカウントの一覧は残る
      calls.clear();
      behaviour.set('swap-iso', () => STANDARD_14);
      behaviour.set('keep-iso', () => STANDARD_14);
      const swap = claude.forAccount({ id: 'swap-iso', token: TOK_PLAIN });
      const keep = claude.forAccount({ id: 'keep-iso', token: TOK_PLAIN });
      assert.equal('claude-mythos-5-2' in await swap.models(w1, { refresh: true }), false);
      await keep.models(w1, { refresh: true });
      assert.equal(await swap.validModel('claude-mythos-5-2'), false, '一覧を引いたあとは、一覧に無い ID を断る');
      // 入れ替え: 同じ id のまま新しいトークン（承認のあるアカウントのもの）で引き直す
      claude.invalidateModels('swap-iso');
      behaviour.set('swap-iso', () => MYTHOS_16);
      const swapped = claude.forAccount({ id: 'swap-iso', token: TOK_VERIFIED });
      assert.equal(await swapped.validModel('claude-mythos-5-2'), true, '忘れた直後は一覧を持たない（引くまでは形の良い ID を断らない）');
      assert.equal('claude-mythos-5-2' in await swapped.models(w1, { refresh: true }), true, '入れ替え後は新しい一覧を引く');
      assert.equal(calls.get('swap-iso'), 2);
      assert.equal(calls.get('keep-iso'), 1);
      // 削除: 忘れたあとは、引かれず、一覧も残らない（同じ id で未登録の状態に戻る）
      claude.invalidateModels('swap-iso');
      const before = [...startOrder];
      assert.equal(await swapped.validModel('claude-mythos-5-2'), true);
      assert.deepEqual(startOrder, before, '削除したあとの確認は CLI を起こさない');
      await keep.models(w1);
      assert.equal(calls.get('keep-iso'), 1, 'ほかのアカウントの一覧は残る');
      t.ok('トークンの入れ替え・削除（invalidateModels(accountId)）でそのアカウントの一覧だけを忘れ、削除後に CLI を起こさず、ほかのアカウントの一覧は残す', true);

      // 互換の接続先の会話では、アカウントのトークンを渡さない（接続先の鍵で走る。アカウントの一覧でも裁かない）。公式のときはアカウントのトークンを渡す
      const seenRuns = [];
      const origRun = claude.runTurn;
      claude.runTurn = (opts) => { seenRuns.push({ endpoint: Boolean(opts?.endpoint), token: opts?.oauthToken ?? null }); return (async function* () {})(); };
      try {
        const scoped = claude.forAccount({ id: 'compat-iso', token: TOK_VERIFIED });
        scoped.runTurn({ endpoint: { id: 'ep-compat', baseUrl: 'http://127.0.0.1:1' } });
        scoped.runTurn({});
        scoped.runTurn({ oauthToken: TOK_PLAIN });
      } finally { claude.runTurn = origRun; }
      assert.deepEqual(seenRuns.map((r) => [r.endpoint, r.token]), [[true, null], [false, TOK_VERIFIED], [false, TOK_PLAIN]],
        '互換の接続先ではアカウントのトークンを足さず、公式では足す（呼び出し側が渡したトークンはそのまま）');
      t.ok('互換の接続先の会話にはアカウントのトークンを渡さず、公式の会話には渡す', true);
    } finally {
      Date.now = realNow;
      console.error = origError;
      restore();
      claude.invalidateModels();
    }
  }

  // ---- 4c. 一覧が手元に入った・変わったときの知らせ（onModelsChanged。ADR 0329）:
  //          固定の一覧を答えたあとに本物の一覧が取れたとき・中身が変わったときだけ、アカウントの id だけを添えて知らせる
  {
    claude.invalidateModels();
    const behaviour = new Map();
    const gates = new Map();
    const realNow = Date.now;
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude',
      cliSigThrottleMs: 1e9,
      probe: async (cwd, isDefault, extra) => {
        const acc = extra?.accountId ?? 'login';
        const gate = gates.get(acc);
        if (gate) { gates.delete(acc); gate.started.resolve(); await gate.promise; }
        const h = behaviour.get(acc);
        if (h instanceof Error) throw h;
        return { rows: typeof h === 'function' ? h() : STANDARD_14, efforts: {}, applied: !isDefault };
      },
    });
    const heard = [];
    // 先に登録したリスナーが投げても、後ろのリスナーと一覧の取得は巻き込まれない
    const throwing = claude.onModelsChanged(() => { throw new Error('listener failed'); });
    const off = claude.onModelsChanged((event) => heard.push(event));
    const takeHeard = () => heard.splice(0).map((event) => event.account);
    const origError = console.error;
    try {
      console.error = () => {};
      const extra = { value: 'claude-new-model', displayName: 'New Model', description: '' };
      behaviour.set('notify-late', () => MYTHOS_16);
      const late = claude.forAccount({ id: 'notify-late', token: TOK_VERIFIED });

      // 起動直後・アカウントの追加直後: 取れるのが待ち（3 秒）より遅い。画面の要求は固定の一覧で答える
      const gate = { ...deferred(), started: deferred() };
      gates.set('notify-late', gate);
      const first = late.models(w1);
      await gate.started.promise;
      Date.now = () => realNow() + 4_000; // 待ちの上限を過ぎた後の要求
      const fixed = await late.models(w1);
      Date.now = realNow;
      assert.equal('claude-mythos-5-2' in fixed, false, '取れていない間は固定の一覧で答える');
      assert.deepEqual(takeHeard(), [], '取れる前は知らせない');
      // 本物の一覧が取れたとき、そのアカウントの id で 1 回だけ知らせる（別のリスナーが投げても、一覧の取得も他のリスナーも巻き込まない）
      gate.resolve();
      await first;
      assert.deepEqual(takeHeard(), ['notify-late']);
      assert.equal('claude-mythos-5-2' in await late.models(w1), true, '知らせたあとの取り直しは本物の一覧を返す');
      t.ok('固定の一覧を答えたあとに本物の一覧が取れたら、そのアカウントの id で 1 回だけ知らせる（リスナーの失敗に巻き込まれない）', true);

      // 同じ中身の取り直し（TTL が切れたあと）・別の作業場所の取得は知らせない
      Date.now = () => realNow() + 31 * 60_000;
      await late.models(w1, { refresh: true });
      Date.now = realNow;
      await late.models(w2);
      await new Promise((r) => setTimeout(r, 30)); // 別の作業場所は手元の答えを返して裏で引く
      assert.deepEqual(takeHeard(), [], '中身が同じなら知らせない');
      t.ok('同じ中身の取り直し・別の作業場所の取得では知らせない', true);

      // 中身が変わったとき（新しいモデルが増えた）は知らせる
      behaviour.set('notify-late', () => [...MYTHOS_16, extra]);
      Date.now = () => realNow() + 62 * 60_000;
      await late.models(w1, { refresh: true });
      Date.now = realNow;
      assert.deepEqual(takeHeard(), ['notify-late']);
      assert.equal('claude-new-model' in await late.models(w1), true);
      t.ok('一覧の中身が変わったときは知らせる', true);

      // ログイン中の一覧は '' で知らせる。トークンは載せない
      behaviour.set('login', () => STANDARD_14);
      await claude.models(w1, { refresh: true });
      const events = heard.splice(0);
      assert.deepEqual(events.map((event) => event.account), ['']);
      assert.deepEqual(Object.keys(events[0]), ['account'], '知らせに載せるのはアカウントの id だけ');
      t.ok('ログイン中の一覧は空の id で知らせ、知らせにトークンを載せない', true);

      // 取っている最中にアカウントを入れ替えた（invalidateModels）ら、古い結果は知らせない
      const staleGate = { ...deferred(), started: deferred() };
      gates.set('notify-gone', staleGate);
      const gone = claude.forAccount({ id: 'notify-gone', token: TOK_PLAIN });
      const staleRun = gone.models(w1, { refresh: true });
      await staleGate.started.promise;
      claude.invalidateModels('notify-gone');
      staleGate.resolve();
      await staleRun;
      assert.deepEqual(takeHeard(), [], '入れ替え・削除で捨てた結果は知らせない');
      t.ok('取得中に入れ替え・削除（invalidateModels）で捨てた結果は知らせない', true);

      // 外したリスナー（返り値）には届かない
      off();
      behaviour.set('notify-late', () => MYTHOS_16);
      Date.now = () => realNow() + 93 * 60_000;
      await late.models(w1, { refresh: true });
      Date.now = realNow;
      assert.deepEqual(takeHeard(), []);
      t.ok('外したリスナーには届かない', true);
    } finally {
      Date.now = realNow;
      console.error = origError;
      off();
      throwing();
      restore();
      claude.invalidateModels();
    }
  }

  // ---- 5. 心拍（core/brain/pulse.mjs の askBackend）: host.backendForAccount でアカウントへ絞ってからモデル解決・実行する
  {
    const pulseDir = path.join(dir, 'pulse');
    const clockBase = new Date(2026, 9, 4, 12, 0, 0).getTime();
    let clock = clockBase;
    const now = () => clock;
    const bot = { id: 'b_verified', name: 'ミソス', icon: '🦊', persona: '', backend: 'claude', account: 'acct-verified', model: '', pulse: normalizePulse({ on: true, everyMin: 10 }) };
    const bots = { list: async () => [bot], get: async ({ botId }) => botId === bot.id ? bot : null };
    const channels = createChannelService({ dir: path.join(pulseDir, 'channels'), now, listBots: bots.list });
    await channels.start();
    const home = await channels.create({ name: 'home', members: [bot.id] }, { kind: 'human' });
    await channels.update({ channelId: home.id, budget: { daily: 10 } }, { kind: 'human' });
    clock += 11 * 60_000;
    await channels.post({ channelId: home.id, text: 'Mythos アカウントで心拍を回すテスト' }, { kind: 'human' });
    clock += 1000;

    const scopedCalls = [];
    let loginListReads = 0;   // ログイン中（アカウントを絞らない）の一覧を読んだ回数。アカウントを引けないときも、ここへは落ちない
    const baseBackend = {
      id: 'claude',
      capabilities: { accounts: 'token', internalCall: true },
      models: async () => { loginListReads++; return { 'claude-haiku-4-5-20251001': {}, 'claude-mythos-5-2': {} }; },
      modes: () => ({ plan: { scope: 'readonly', autonomy: 'never' } }),
      internalTurn: async () => ({ text: '{}' }),
      forAccount: (account) => ({
        id: 'claude',
        accountId: account.id,
        capabilities: { accounts: 'token', internalCall: true },
        models: async () => (account.id === 'acct-verified' ? { 'claude-mythos-5-2': {} } : {}),
        modes: () => ({ plan: { scope: 'readonly', autonomy: 'never' } }),
        internalTurn: async () => ({ text: '{}' }),
      }),
    };
    const host = {
      currentLocale: () => 'ja',
      store: {
        getPrefs: async () => ({}),
        get: async () => ({}),
        setMeta: async () => {},
        setMode: async () => {},
        setModel: async () => {},
        setSessionData: async () => {},
      },
      readQuota: async () => null,
      usageStore: {},
      listBackends: () => [baseBackend],
      getBackend: () => baseBackend,
      // server の bot の道具 accountBackend と同じ形: アカウントの範囲に絞ったバックエンド。引けないときは、断る（使えない）バックエンドを返す
      accountBackend: async (b, acctId) => {
        scopedCalls.push({ backend: b.id, acctId });
        return acctId === 'acct-gone' ? accountUnavailableBackend(b, new Error('account not found')) : b.forAccount({ id: acctId });
      },
      resolveModel: async (_cur, m, b) => {
        const list = await b.models();   // 引けなければここで断る（server の resolveModel と同じ）
        return b.accountId === 'acct-verified' && 'claude-mythos-5-2' in list ? 'claude-mythos-5-2' : (m || 'haiku');
      },
      resolveEffort: async () => null,
      internalCall: async ({ backend, accountId, model }) => {
        scopedCalls.push({ internalCallBackend: backend.id, accountId, model });
        return { text: JSON.stringify({ do: 'none' }), usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 }, callId: 'c1' };
      },
    };
    const brain = createBrainStore({ dataDir: pulseDir, now });
    const budget = createBudget({ channels, host, now, brain });
    const fakeClock = { now, setTimer: () => ({}), clearTimer: () => {} };
    const pulse = createPulse({ dataDir: pulseDir, brain, channels, bots, host, budget, dispatch: { handoff: async () => ({ ok: true }) }, clock: fakeClock, now });
    try {
      const res = await pulse.beat(bot.id, { force: true });
      assert.equal(res.ran, true);
      assert.ok(scopedCalls.some((c) => c.acctId === 'acct-verified'), JSON.stringify(scopedCalls));
      assert.ok(scopedCalls.some((c) => c.internalCallBackend === 'claude' && c.accountId === 'acct-verified' && c.model === 'claude-mythos-5-2'), JSON.stringify(scopedCalls));
      t.ok('心拍の askBackend は accountBackend でアカウントへ絞ってからモデル解決・実行する', true);

      // アカウントを引けない（消した等）bot: ログイン中の一覧へ落とさず、使えないバックエンドを受けて断る（内部呼出しは起こさない）
      scopedCalls.length = 0;
      bot.account = 'acct-gone';
      const gone = await pulse.beat(bot.id, { force: true });
      assert.equal(gone.did, 'error', JSON.stringify(gone));
      assert.match(gone.error, /account not found/);
      assert.ok(scopedCalls.some((c) => c.acctId === 'acct-gone'), JSON.stringify(scopedCalls));
      assert.ok(!scopedCalls.some((c) => c.internalCallBackend), '引けないアカウントでは内部呼出しを起こさない');
      assert.equal(loginListReads, 0, 'ログイン中の一覧へ落とさない');
      t.ok('心拍: アカウントを引けないときは、ログイン中の一覧へ落とさず、内部呼出しも起こさずに断る', true);
    } finally {
      pulse.stop();
      brain.close();
      await channels.close();
    }
  }

  // ---- 6. bot 会話同期（core/bots/sessions.mjs）: 承認のあるアカウントで Mythos を持つ bot を承認の無いアカウントへ切り替えると既存会話のモデルを既定へ戻す（agent 揃い）
  {
    const sessMap = new Map();
    let loginReads = 0, creations = 0;   // ログイン中（アカウントを絞らない）の一覧を読んだ回数・会話を作った回数
    const baseBackend = {
      id: 'claude',
      capabilities: { accounts: 'token' },
      modes: () => ({ default: { label: 'Default', scope: 'workspace', autonomy: 'ask' } }),
      models: async () => { loginReads++; return { sonnet: {} }; },
      forAccount: (account) => ({
        id: 'claude',
        capabilities: { accounts: 'token' },
        modes: () => ({ default: { label: 'Default', scope: 'workspace', autonomy: 'ask' } }),
        models: async () => (account.id === 'acct-verified' ? { sonnet: {}, 'claude-mythos-5-2': {} } : { sonnet: {} }),
      }),
    };
    const host = {
      currentLocale: () => 'ja',
      getBackend: () => baseBackend,
      // server の bot の道具 accountBackend と同じ形: 引けない（消した等）アカウントは、断る（使えない）バックエンドを返す
      accountBackend: async (b, acctId) => (acctId === 'acct-gone' ? accountUnavailableBackend(b, new Error('account not found')) : acctId ? b.forAccount({ id: acctId }) : b),
      createConversation: async () => { creations++; return 'bot-sess-1'; },
      resolveModel: async (_sid, given, backend) => {
        const list = await backend.models();   // 引けなければここで断る（server の resolveModel と同じ。モデルを指定しない bot でも一覧は読む）
        return given && given in list ? given : '';
      },
      resolveEffort: async () => '',
      store: {
        get: async (id) => sessMap.get(id) ?? {},
        setMeta: async (id, meta) => { sessMap.set(id, { ...(sessMap.get(id) ?? {}), ...meta }); },
        setMode: async (id, mode) => { sessMap.set(id, { ...(sessMap.get(id) ?? {}), mode }); },
        setModel: async (id, model) => { sessMap.set(id, { ...(sessMap.get(id) ?? {}), model }); },
        setSessionData: async (id, k, v) => { sessMap.set(id, { ...(sessMap.get(id) ?? {}), [k]: v }); },
        removeSession: async (id) => { sessMap.delete(id); },
      },
    };
    const botSessions = createBotSessions({ host });
    const bot = { id: 'b_sync', name: 'MythosBot', icon: '🦊', backend: 'claude', account: 'acct-verified', model: 'claude-mythos-5-2', effort: '', mode: 'default', folders: [{ path: w1 }] };
    const created = await botSessions.create({ bot, kind: 'dm', rootText: 'hi' });
    assert.equal(created.model, 'claude-mythos-5-2');
    assert.equal(sessMap.get(created.sessionId).claudeAccount, 'acct-verified');

    // 承認の無いアカウントへ切り替えて同期すると、新アカウントの一覧に無い Mythos は会話では '' に戻る
    await botSessions.sync(created.sessionId, { ...bot, account: 'acct-plain' });
    assert.equal(sessMap.get(created.sessionId).model, '');
    assert.equal(sessMap.get(created.sessionId).claudeAccount, 'acct-plain');
    t.ok('bot のアカウント切替で既存会話のモデルを新アカウントの一覧で再検証し、無ければ既定へ戻す', true);

    // アカウントを引けない（消した等）bot: ログイン中の一覧へ落とさず、引けなかった理由で断る
    const goneBot = { ...bot, id: 'b_gone', account: 'acct-gone', model: '' };
    const made = creations;
    await assert.rejects(() => botSessions.create({ bot: goneBot, kind: 'dm', rootText: 'hi' }), /account not found/);
    assert.equal(creations, made, '引けないアカウントでは会話を作らない');
    // 既存の会話: モデルを別の一覧で書き換えない（モデルを持つ会話は、持ったまま。ログイン中の一覧には無いので、落ちていれば '' になる）
    sessMap.set('bot-sess-gone', { backend: 'claude', cwd: w1, mode: 'default', model: 'claude-mythos-5-2', claudeAccount: 'acct-verified', bot: { botId: 'b_sync', kind: 'dm' } });
    await assert.rejects(() => botSessions.sync('bot-sess-gone', { ...bot, account: 'acct-gone', model: 'claude-mythos-5-2' }), /account not found/);
    assert.equal(sessMap.get('bot-sess-gone').model, 'claude-mythos-5-2', '引けないアカウントでは、別の一覧でモデルを書き換えない');
    assert.equal(sessMap.get('bot-sess-gone').claudeAccount, 'acct-verified');
    assert.equal(loginReads, 0, 'ログイン中の一覧へ落とさない');
    t.ok('bot のアカウントを引けないときは、ログイン中の一覧へ落とさず、会話を作らず・既存の会話のモデルを書き換えずに断る', true);
  }

  // ---- 6b. accountUnavailableBackend: アカウントを引けない（消した・トークンが無い）会話に渡すバックエンド
  {
    claude.invalidateModels();
    const home = path.join(dir, 'home-unavailable');
    await fs.mkdir(home, { recursive: true });
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude',
      cliSigThrottleMs: 1e9,
      probe: async (cwd, isDefault, extra) => ({ rows: extra?.accountId === 'acct-verified' ? MYTHOS_16 : STANDARD_14, efforts: {}, applied: !isDefault }),
    });
    try {
      const error = new Error('account not found');
      const base = await backendForAccount(claude, null);
      assert.ok(base.capabilities.internalCall, '前提: 基のバックエンドは内部呼出しに対応している');
      const blocked = accountUnavailableBackend(base, error);
      // アカウントの資格情報を要るものは、引けなかった理由で断る
      for (const member of ['models', 'validModel', 'matchModel', 'warmModels', 'runTurn', 'adoptTurn', 'internalTurn', 'suggestTitle']) {
        await assert.rejects(() => blocked[member](home, 'claude-mythos-5-2'), /account not found/, member);
      }
      // 断るものに合わせて、内部呼出しの能力の印も外す。アカウントを選べる印は残す（画面でアカウントを選び直せる）
      assert.equal(blocked.capabilities.internalCall, false);
      assert.equal(blocked.capabilities.accounts, 'token');
      // 印を外しただけでは「非対応」に見えるので、引けなかった理由を持つ（題の生成などが、非対応と取り違えさせずに理由を伝える）
      assert.equal(blocked.accountError, error);
      assert.equal(base.accountError, undefined, '基のバックエンドは理由を持たない');
      // 履歴は共有の設定フォルダーから読める（基のまま）
      for (const member of ['listSessions', 'getSession', 'getMessages']) assert.equal(blocked[member], base[member], member);
      assert.equal(blocked.id, 'claude');
      // 選び直したアカウントで束縛し直すと、そのアカウントの一覧で動く（断るのは引けなかった会話だけ）
      const rebound = await backendForAccount(blocked, { id: 'acct-verified', token: TOK_VERIFIED });
      assert.ok('claude-mythos-5-2' in await rebound.models(home), '選び直したアカウントの一覧で引ける');
      assert.equal(rebound.capabilities.internalCall, base.capabilities.internalCall);
      // 別のアカウントの一覧・ログイン中の一覧は返さない（断った後に、承認の無いアカウントの一覧が混ざらない）
      assert.ok(!('claude-mythos-5-2' in await (await backendForAccount(blocked, { id: 'acct-plain', token: TOK_PLAIN })).models(home)));
      // 'agent' 種は、資格情報が無いと履歴の元にも触れないので、Pleiad が持つ分だけ読む（これまでどおり）
      const agentBlocked = accountUnavailableBackend({ id: 'agentish', label: 'Agentish', capabilities: { accounts: 'agent' }, traits: {}, modes: () => ({}) }, error);
      await assert.rejects(() => agentBlocked.models(home), /account not found/);
      assert.equal(agentBlocked.capabilities.accounts, 'agent');
      assert.equal(agentBlocked.accountError, undefined, 'agent 種はこれまでどおり（理由の持ち方を足さない）');
      t.ok('アカウントを引けない会話のバックエンド: トークンを要るものだけ断り、履歴は読め、アカウントは選び直せる（agent 種は Pleiad が持つ分だけ読む）', true);
    } finally {
      restore();
      claude.invalidateModels();
    }
  }

  // ---- 7. 使用量の監視（core/delegation-usage.mjs）と一覧の CLI: 取り直しで一覧の CLI を並べて起こさず、取り直しを重ねても増やさず、公開をアカウントの数で遅らせない
  {
    claude.invalidateModels();
    // サーバー（core/server.mjs）は、先読みと監視が同じ作業場所（ホーム）の一覧を読む。その写し
    const home = path.join(dir, 'home');
    await fs.mkdir(home, { recursive: true });
    const starts = [];
    let inflight = 0, peak = 0, gate = null;
    const accountIds = ['mon-v1', 'mon-p1', 'mon-v2', 'mon-p2', 'mon-p3'];
    const verifiedIds = new Set(['mon-v1', 'mon-v2']);
    const registry = new Map(accountIds.map((id) => [id, { id, token: verifiedIds.has(id) ? TOK_VERIFIED : TOK_PLAIN }]));
    const scopedOf = (id) => claude.forAccount(registry.get(id));
    const realNow = Date.now;
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude',
      cliSigThrottleMs: 1e9,
      probe: async (cwd, isDefault, extra) => {
        const acc = extra?.accountId ?? 'login';
        starts.push(acc);
        inflight++; peak = Math.max(peak, inflight);
        try {
          // gate が立っている間は、CLI の答えをここで止める（止めている間に、ほかの CLI が起きないことを見る）
          await (gate ? gate.promise : new Promise((r) => setTimeout(r, 10)));
          return { rows: verifiedIds.has(acc) ? MYTHOS_16 : STANDARD_14, efforts: {}, applied: !isDefault };
        } finally { inflight--; }
      },
    });
    // 先読み: ログイン中 → 登録アカウントを 1 つずつ（server の warmBackendModels と同じ順）
    const warmAll = async () => {
      await claude.warmModels(home).catch(() => {});
      for (const id of accountIds) await scopedOf(id).warmModels(home).catch(() => {});
    };
    const monitor = createUsageMonitor({
      backends: () => [claude],
      read: async () => null,
      candidates: () => ['claude:sonnet', ...accountIds.map((id) => `claude@${id}:claude-mythos-5-2`)],
      scopeForAccount: async (_b, id) => (registry.has(id) ? scopedOf(id) : null),
      // 監視は passive（手元の一覧だけ）で頼む。server の modelKnown も同じ形で答える
      modelKnown: async (b, model, _account, { passive = false } = {}) => {
        const opts = passive ? { passive: true } : {};
        return Object.hasOwn(await b.models(home, opts), model) || await b.validModel(model, home) || Boolean(await b.matchModel(model, home, opts).catch(() => null));
      },
      warm: warmAll,
    });
    try {
      // (a) 一覧を 1 つも引いていない間は、取り直しても CLI を起こさない（手元の一覧だけで答える。一覧が無ければ「一覧に無い」とは言わない）
      await monitor.refresh();
      await monitor.settle();
      assert.deepEqual(starts, [], '一覧が無い間の使用量の取り直しは CLI を起こさない');
      assert.equal(monitor.snapshot().claude.accountModels['mon-p1']['claude-mythos-5-2'], true, '一覧を引く前は、候補を「一覧に無い」と言わない');

      // (b) 起動の先読み: CLI は同時に 1 本だけ、ログイン中 → 登録アカウントの順。そのあとの取り直しは各アカウントの手元の一覧で判定し、CLI を起こさない
      await warmAll();
      assert.equal(peak, 1, '先読みは一覧の CLI を同時に起こさない');
      assert.deepEqual(starts, ['login', ...accountIds], '先読みは、ログイン中 → 登録アカウントを 1 つずつ');
      await monitor.refresh();
      await monitor.settle();
      const mythosKnown = Object.fromEntries(accountIds.map((id) => [id, monitor.snapshot().claude.accountModels[id]['claude-mythos-5-2']]));
      assert.deepEqual(mythosKnown, { 'mon-v1': true, 'mon-p1': false, 'mon-v2': true, 'mon-p2': false, 'mon-p3': false }, 'アカウントごとの手元の一覧で判定する');
      assert.equal(starts.length, accountIds.length + 1, '一覧が揃ったあとの取り直しは、一覧に無い候補があっても CLI を起こさない');

      // (c) 取り直しを重ねても CLI は増えない
      for (let i = 0; i < 3; i++) { await monitor.refresh(); await monitor.settle(); }
      assert.equal(starts.length, accountIds.length + 1, '取り直しを重ねても CLI は増えない');
      t.ok('使用量の監視: 一覧が無い間・揃っている間は、取り直しても一覧の CLI を起こさず、先読みはログイン中 → アカウントを 1 つずつ順に引く', true);

      // (d) 一覧の期限（30 分）が切れたあとの取り直し: 公開は一覧の CLI を待たない。確かめ直し（先読み）は 1 本ずつ。確かめ直しの最中に取り直しを重ねても CLI は増えない
      Date.now = () => realNow() + 31 * 60_000;
      gate = deferred();
      const base = starts.length;
      const outcome = await Promise.race([monitor.refresh().then(() => 'published'), new Promise((r) => setTimeout(() => r('blocked'), 1500))]);
      assert.equal(outcome, 'published', '使用量の公開は、一覧の確かめ直し（CLI）を待たない');
      for (let i = 0; i < 100 && inflight < 1; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(inflight, 1, '確かめ直しが始まっている（CLI が 1 本、止められている）');
      for (let i = 0; i < 3; i++) await monitor.refresh();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(starts.length - base, 1, '確かめ直しの最中は CLI が 1 本だけ（取り直しを重ねても、アカウントの数だけ並べて起こさない）');
      assert.equal(starts[base], 'login');
      assert.equal(peak, 1);
      const release = gate;
      gate = null;
      release.resolve();
      await monitor.settle();
      assert.deepEqual(starts.slice(base), ['login', ...accountIds], '期限切れの一覧は、ログイン中と各アカウントを 1 回ずつ、順に引き直す');
      assert.equal(peak, 1, '一覧の CLI は同時に 1 本だけ');
      t.ok('使用量の監視: 一覧の期限が切れたあとも、公開は一覧の CLI を待たず、確かめ直しは 1 本ずつ・取り直しを重ねても CLI は増えない（アカウントの数だけ並べて起こさない）', true);
    } finally {
      Date.now = realNow;
      restore();
      claude.invalidateModels();
    }
  }

  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
