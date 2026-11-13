// Claude のアカウントごとのモデル一覧・検証・キャッシュ隔離・秘匿・無効化・LRU・Mythos 説明・bot/心拍の backendForAccount（ADR 0326）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { buildClaudeModels } from '../../core/backends/claude-models.mjs';
import { backendForAccount } from '../../core/backends/index.mjs';
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
          throw new Error(`HTTP 401 bearer ${TOK_VERIFIED}`);
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

      // エラーにトークンが混ざってもログ・エラー文から伏せる
      mode = 'leak-error';
      await verified.models(w2, { refresh: true });
      const verifiedErrLogs = logs.filter((l) => l.includes('claude') || l.includes('401') || l.includes('トークン') || l.includes(TOK_VERIFIED));
      assert.equal(logs.some((l) => l.includes(TOK_VERIFIED)), false, 'ログに生のトークンを出さない');
      t.ok('probe 失敗のエラーやログに生トークンを残さない', verifiedErrLogs.every((l) => !l.includes(TOK_VERIFIED)));
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

      // CATALOG_MAX (64) の LRU 上限確認: 32 件超の 40 件を積んでも最初の要素が追い出されない
      const accounts40 = Array.from({ length: 40 }, (_, i) => {
        const id = `lru-acct-${i}`;
        customRows.set(id, () => STANDARD_14);
        return claude.forAccount({ id, token: TOK_PLAIN });
      });
      for (const a of accounts40) await a.models(w1);
      const c0Before = calls.get(`lru-acct-0|${w1}`);
      await accounts40[0].models(w1);
      assert.equal(calls.get(`lru-acct-0|${w1}`), c0Before);
      t.ok('キャッシュ上限を 32 件超へ広げたため 40 件のアカウント登録でも 1 件目が追い出されない', true);
    } finally {
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
    const baseBackend = {
      id: 'claude',
      capabilities: { accounts: 'token', internalCall: true },
      models: async () => ({ 'claude-haiku-4-5-20251001': {}, 'claude-mythos-5-2': {} }),
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
      backendForAccount: async (b, acctId) => {
        scopedCalls.push({ backend: b.id, acctId });
        return b.forAccount({ id: acctId });
      },
      resolveModel: async (_cur, m, b) => (b.accountId === 'acct-verified' && 'claude-mythos-5-2' in await b.models() ? 'claude-mythos-5-2' : (m || 'haiku')),
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
      t.ok('心拍の askBackend は backendForAccount でアカウントへ絞ってからモデル解決・実行する', true);
    } finally {
      pulse.stop();
      brain.close();
      await channels.close();
    }
  }

  // ---- 6. bot 会話同期（core/bots/sessions.mjs）: 承認のあるアカウントで Mythos を持つ bot を承認の無いアカウントへ切り替えると既存会話のモデルを既定へ戻す（agent 揃い）
  {
    const sessMap = new Map();
    const baseBackend = {
      id: 'claude',
      capabilities: { accounts: 'token' },
      modes: () => ({ default: { label: 'Default', scope: 'workspace', autonomy: 'ask' } }),
      models: async () => ({ sonnet: {} }),
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
      backendForAccount: async (b, acctId) => (acctId ? b.forAccount({ id: acctId }) : b),
      createConversation: async () => 'bot-sess-1',
      resolveModel: async (_sid, given, backend) => (given && given in await backend.models() ? given : ''),
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
  }

  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
