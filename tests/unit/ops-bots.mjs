// bots.* の操作（registry 越し。サーバーの道具は身代わり）: 作成と DM のチャンネル・AI から見える操作と見えない操作（承認モードは人だけ）・
// 範囲を広げる向きの update は承認・狭める向きは通る・Antigravity の bot は yolo だけ・削除・一覧の使用量と状態・DM の会話。ADR 0082・0109
// bot のアカウント（bots.setAccount。人だけ・bot のエージェントに登録の無い id と使えないアカウントは断る・会話に写す（送った Codex の会話は次のターンの予約）・バックエンドを替えると ''。ADR 0224）
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registry } from '../../core/ops/index.mjs';
import { createBotService } from '../../core/bots/service.mjs';

export const name = 'ops-bots';
export const title = 'bots.* の操作: 作成と DM・human-only は承認モードとアカウント・広げる向きは承認・Antigravity は yolo だけ・削除・一覧の使用量';

const human = { by: 'human', via: 'ui', local: true };
const agent = (sessionId, via = 'mcp') => ({ by: 'agent', via, sessionId });
const MODES = {
  ask: { scope: 'workspace', autonomy: 'ask' },
  bypass: { scope: 'full', autonomy: 'never' },
  plan: { scope: 'readonly', autonomy: 'ask' },
};
const CLAUDE_MODES = {
  default: { scope: 'workspace', autonomy: 'ask' }, auto: { scope: 'workspace', autonomy: 'judge' },
  plan: { scope: 'readonly', autonomy: 'ask' }, bypass: { scope: 'full', autonomy: 'never' },
};

/** 身代わり: バックエンド 3 つ（Claude はトークン・Codex は資格情報のアカウント・Antigravity は無し）・会話の保存・チャンネルの口・使用量・実行中のターン・登録したアカウント */
function fake(dataDir, { usage = [], dmFails = false } = {}) {
  const sessions = {};
  let n = 0;
  const backends = {
    claude: { id: 'claude', modes: () => CLAUDE_MODES, capabilities: { accounts: 'token' } },
    codex: { id: 'codex', capabilities: { accounts: 'agent' }, modes: () => ({ ask: { scope: 'workspace', autonomy: 'ask' }, full: { scope: 'workspace', autonomy: 'never' }, yolo: { scope: 'full', autonomy: 'never' } }) },
    antigravity: { id: 'antigravity', modes: () => ({ yolo: { scope: 'full', autonomy: 'never' } }) },
  };
  const calls = { dm: [], archive: [], update: [], conversations: [], events: [], reserved: [] };
  const channels = {
    createDm: async ({ bot }) => { if (dmFails) throw new Error('channels.createDm is not implemented yet'); calls.dm.push(bot.id); return { id: `c_dm_${bot.id}`, kind: 'dm', name: bot.name, cwd: null }; },
    get: async ({ channelId }) => ({ id: channelId, kind: 'dm', name: 'dm', cwd: null }),
    update: async (args, author) => { calls.update.push({ ...args, author }); },
    archive: async (args) => { calls.archive.push(args); },
  };
  const host = {
    getBackend: (id) => backends[id] ?? null, listBackends: () => Object.values(backends),
    resolveModel: async (_s, model) => (model && model !== 'bad' ? model : 'm-default'),
    resolveEffort: async (_s, effort) => { if (effort === 'bad') throw new Error('unknown effort'); return effort || 'medium'; },
    currentLocale: () => 'ja',
    createConversation: async (backend, info) => { const id = `sess-${++n}`; calls.conversations.push({ id, backend: backend.id, info }); return id; },
    store: {
      get: async (id) => sessions[id] ?? {}, getAll: async () => sessions,
      setMeta: async (id, meta) => { sessions[id] = { ...sessions[id], ...meta }; },
      setMode: async (id, mode) => { sessions[id] = { ...sessions[id], mode }; },
      setModel: async (id, model) => { sessions[id] = { ...sessions[id], model }; },
      setSessionData: async (id, field, value) => { sessions[id] = { ...sessions[id], [field]: value }; },
      removeSession: async (id) => { delete sessions[id]; },
    },
    usageStore: { records: async ({ sessionIds, since }) => usage.filter((r) => sessionIds.includes(r.sessionId) && r.at >= since) },
    runtime: { turns: new Map(), waiting: new Map() },
    accountList: async (backendId) => ({
      claude: [{ id: 'acc-oz', name: 'OZ', ready: true }, { id: 'acc-bare', name: 'Bare', ready: false }],
      codex: [{ id: 'acct-cx', name: 'Work', ready: true }],
    })[backendId] ?? [],
    reserveAccount: async (sessionId, account) => { calls.reserved.push({ sessionId, account }); sessions[sessionId] = { ...sessions[sessionId], nextSettings: { ...sessions[sessionId]?.nextSettings, account } }; },
  };
  const service = createBotService({ dataDir, channels, host, emit: (e) => calls.events.push(e), now: () => 1_000_000 });
  const approvals = [];
  const deps = {
    locale: 'ja', bots: service, audit: async () => {},
    modeOf: async (id) => (id === 'bypass' ? MODES.bypass : id === 'plan' ? MODES.plan : MODES.ask),
    approve: async (request) => { approvals.push(request); return { pending: true, requestId: `r${approvals.length}` }; },
  };
  const call = (principal, op, args) => registry.invoke(principal, op, args, deps);
  return { service, host, sessions, calls, approvals, call, backends };
}

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-bots-'));
  const folderA = path.join(dir, 'a'), folderB = path.join(dir, 'b');
  await fs.mkdir(folderA); await fs.mkdir(folderB);
  try {
    // ---- 口の出し分け: setMode だけが human-only。AI にも MCP・CLI にも出る操作はカタログ・CLI から
    const ids = (principal) => registry.list(principal).map((o) => o.id).filter((id) => id.startsWith('bots.')).sort().join();
    t.ok('AI（MCP）には bots の 5 つ（setMode 以外）が出る', ids(agent('x')) === 'bots.create,bots.delete,bots.get,bots.list,bots.update', ids(agent('x')));
    t.ok('AI（CLI）にも同じ', ids(agent('x', 'cli')) === 'bots.create,bots.delete,bots.get,bots.list,bots.update', ids(agent('x', 'cli')));
    t.ok('画面（人）には setMode も出る', ids(human).includes('bots.setMode'));
    t.ok('どの操作も直のツールではない（T4 の余りが小さい）', registry.ops.filter((o) => o.id.startsWith('bots.')).every((o) => o.surfaces.mcp !== 'direct'));
    t.ok('危険度: list・get は read、create・update は write、delete は guarded、setMode・setAccount は human-only',
      ['bots.list:read', 'bots.get:read', 'bots.create:write', 'bots.update:write', 'bots.delete:guarded', 'bots.setMode:human-only', 'bots.setAccount:human-only'].every((s) => registry.get(s.split(':')[0]).risk === s.split(':')[1]));
    t.ok('setAccount は画面（人）にだけ出る（MCP・CLI の口を持たない）', ids(human).includes('bots.setAccount') && registry.get('bots.setAccount').surfaces.mcp === false && registry.get('bots.setAccount').surfaces.cli === false);

    const f = fake(dir);
    await f.service.start();
    const { call, calls, approvals, sessions } = f;

    // ---- 作成: 既定の弱いモード・DM のチャンネル・名前の一意
    const made = await call(human, 'bots.create', { name: 'Owl', icon: '🦉', persona: 'のんびり屋', backend: 'claude' });
    t.ok('人が作ると通り、DM のチャンネルができる', made.ok && made.result.dmChannelId === `c_dm_${made.result.id}` && calls.dm.length === 1, JSON.stringify(made));
    t.ok('承認モードは作業場所に書けて毎回聞くもの・フォルダーなし・他の会話へ送るは既定で ON', made.result.mode === 'default' && made.result.folders.length === 0 && made.result.sendToOthers === true);
    t.ok('返りに使用量と状態が付く', made.result.usage.weekTokens === 0 && made.result.state === 'idle');
    t.ok('botsChanged が出る', calls.events.some((e) => e.type === 'botsChanged' && e.bot?.name === 'Owl'));
    const owl = made.result.id;
    const dup = await call(human, 'bots.create', { name: 'ＯＷＬ', backend: 'claude' });
    t.ok('名前の重複（大小・全角半角）は BOT_NAME_TAKEN', !dup.ok && dup.code === 'BOT_NAME_TAKEN' && dup.error.includes('ＯＷＬ'), JSON.stringify(dup));
    t.ok('不正な名前・アイコン・バックエンド・モデル・エフォートは INVALID',
      (await Promise.all([{ name: 'a b' }, { name: 'あなた' }, { name: 'X', icon: 'x' }, { name: 'X', backend: 'nope' }, { name: 'X', backend: 'claude', model: 'bad' }, { name: 'X', backend: 'claude', effort: 'bad' }]
        .map((a) => call(human, 'bots.create', a)))).every((r) => !r.ok && r.code === 'INVALID'));
    t.ok('バックエンドを省くと既定（先頭）', (await call(human, 'bots.create', { name: 'Default' })).result.backend === 'claude');

    // ---- AI が作る: 承認が要る
    const asking = { ...agent('ask'), mode: MODES.ask };
    const pending = await call(asking, 'bots.create', { name: 'Fox', backend: 'claude', reason: '調べ物用' });
    t.ok('束縛された AI（承認が要るモード）が作ると承認カードが出て、まだ作られない', pending.ok && pending.pending === true && f.service.byName && !(await f.service.byName('Fox')), JSON.stringify(pending));
    t.ok('承認カードに名前・アイコン・バックエンドが出る', approvals.at(-1).change.rows.some((r) => r.path === 'name' && r.after === 'Fox') && approvals.at(-1).reason === '調べ物用');
    await approvals.at(-1).proceed();
    t.ok('人が許可すると作られる', (await f.service.byName('Fox'))?.backend === 'claude');
    // S-5: 承認カードに、作られる承認モードの行を出す。弱くないモード（Antigravity の yolo）は loosens
    const agyCard = await call(asking, 'bots.create', { name: 'Gravity2', backend: 'antigravity' });
    t.ok('S-5: AI が作る Antigravity の bot の承認カードに、作られる承認モード（yolo）の行と loosens: true が出る（まだ作られない）', agyCard.pending === true && approvals.at(-1).change.loosens === true
      && approvals.at(-1).change.rows.some((r) => r.path === 'mode' && r.after === 'yolo') && !(await f.service.byName('Gravity2')), JSON.stringify(approvals.at(-1).change));
    const claudeCard = await call(asking, 'bots.create', { name: 'Calm', backend: 'claude' });
    t.ok('S-5: Claude の bot は既定の弱いモード（default）の行で、loosens は false', claudeCard.pending === true && approvals.at(-1).change.loosens === false && approvals.at(-1).change.rows.some((r) => r.path === 'mode' && r.after === 'default'));
    const defaultCard = await call(asking, 'bots.create', { name: 'Plain' });
    t.ok('S-5: backend を省いても、既定の backend のモードの行が出る', defaultCard.pending === true && approvals.at(-1).change.rows.some((r) => r.path === 'mode' && r.after === 'default'));
    t.ok('S-5: riskReason は「いつも最も弱いモード」とは言わず、backend の既定のモードで始まりカードに出ると言う', /default approval mode of its backend/.test(registry.get('bots.create').riskReason) && /Antigravity/.test(registry.get('bots.create').riskReason) && !/weakest approval mode with no folders/.test(registry.get('bots.create').riskReason));
    approvals.length -= 3;
    const bypassed = await call({ ...agent('bypass'), mode: MODES.bypass }, 'bots.create', { name: 'Hawk', backend: 'claude' });
    t.ok('すべて自動のモードの会話は承認なしで作れる', bypassed.ok && !bypassed.pending && (await f.service.byName('Hawk')) !== null);
    t.ok('束縛されていない AI（外の CLI）は画面へ誘導（NEEDS_UI）', (await call({ by: 'agent', via: 'cli' }, 'bots.create', { name: 'Nope' })).code === 'NEEDS_UI');
    t.ok('読み取りモードの会話は作れない', (await call({ ...agent('plan'), mode: MODES.plan }, 'bots.create', { name: 'Nope' })).code === 'READ_ONLY_MODE');

    // ---- 承認モードは人だけ
    const sess = await f.service.ensureDmSession({ botId: owl });
    t.ok('DM の会話ができ、sidecar に bot の印が付く', sess.created && sessions[sess.sessionId].bot.botId === owl && sessions[sess.sessionId].bot.kind === 'dm' && sessions[sess.sessionId].bot.snapshotDue === true);
    t.ok('会話の題は「🦉 Owl」・モードは bot のもの', calls.conversations.at(-1).info.title === '🦉 Owl' && sessions[sess.sessionId].mode === 'default' && sessions[sess.sessionId].backend === 'claude' && sessions[sess.sessionId].unsent === true);
    const aiMode = await call(asking, 'bots.setMode', { botId: owl, mode: 'bypass' });
    t.ok('AI からは bots.setMode が存在しないのと同じ（NOT_FOUND）', !aiMode.ok && aiMode.code === 'NOT_FOUND');
    const setMode = await call(human, 'bots.setMode', { botId: owl, mode: 'auto' });
    t.ok('人が決めると変わり、今ある会話の承認モードも揃う', setMode.ok && setMode.result.mode === 'auto' && sessions[sess.sessionId].mode === 'auto');
    t.ok('知らないモードは INVALID', (await call(human, 'bots.setMode', { botId: owl, mode: 'zzz' })).code === 'INVALID');
    t.ok('無い bot は BOT_NOT_FOUND', (await call(human, 'bots.setMode', { botId: 'b_nope', mode: 'auto' })).code === 'BOT_NOT_FOUND');
    // ルーティンの会話の承認モードはルーティンの mode。bot のモードを変えても揃えない（スレッド・DM の会話は揃う）
    const wren = (await call(human, 'bots.create', { name: 'Wren', backend: 'claude' })).result;
    const wrenRoutine = await f.service.createSession({ botId: wren.id, channel: { id: 'c_r', kind: 'channel', name: 'r', cwd: folderA }, threadId: 'p_r', kind: 'routine', routineId: 'r_x', rootText: '朝' });
    const wrenThread = await f.service.createSession({ botId: wren.id, channel: { id: 'c_r', kind: 'channel', name: 'r', cwd: folderA }, threadId: 'p_t', kind: 'thread', rootText: '朝' });
    sessions[wrenRoutine.sessionId].mode = 'plan';
    await call(human, 'bots.setMode', { botId: wren.id, mode: 'auto' });
    t.ok('bot の承認モードを変えても、ルーティンの会話はルーティンの mode のまま（スレッドの会話は揃う）', sessions[wrenRoutine.sessionId].mode === 'plan' && sessions[wrenThread.sessionId].mode === 'auto');
    const agy = (await call(human, 'bots.create', { name: 'Gravity', backend: 'antigravity' })).result;
    t.ok('Antigravity の bot は yolo で始まる', agy.mode === 'yolo');
    t.ok('Antigravity の bot は yolo 以外を断る', (await call(human, 'bots.setMode', { botId: agy.id, mode: 'default' })).code === 'INVALID' && (await call(human, 'bots.setMode', { botId: agy.id, mode: 'yolo' })).ok);

    // ---- bot のアカウントも人だけ（ADR 0224）
    t.ok('作った bot のアカウントは \'\'（ログイン中）', made.result.account === '' && sessions[sess.sessionId].claudeAccount === undefined);
    const aiAccount = await call(asking, 'bots.setAccount', { botId: owl, account: 'acc-oz' });
    const freeAccount = await call({ ...agent('bypass'), mode: MODES.bypass }, 'bots.setAccount', { botId: owl, account: 'acc-oz' });
    t.ok('AI からは bots.setAccount が存在しないのと同じ（NOT_FOUND。すべて自動のモードでも）', aiAccount.code === 'NOT_FOUND' && freeAccount.code === 'NOT_FOUND' && (await f.service.get({ botId: owl })).account === '');
    t.ok('AI の bots.update ではアカウントを変えられない（strict で INVALID）', (await call({ ...agent('bypass'), mode: MODES.bypass }, 'bots.update', { botId: owl, account: 'acc-oz' })).code === 'INVALID'
      && (await call(human, 'bots.update', { botId: owl, account: 'acc-oz' })).code === 'INVALID' && (await f.service.get({ botId: owl })).account === '');
    const unknown = await call(human, 'bots.setAccount', { botId: owl, account: 'acc-gone' });
    t.ok('登録の無いアカウントは INVALID（変わらない）', unknown.code === 'INVALID' && /not registered/.test(unknown.error) && (await f.service.get({ botId: owl })).account === '', JSON.stringify(unknown));
    const bare = await call(human, 'bots.setAccount', { botId: owl, account: 'acc-bare' });
    t.ok('使えない（トークンの無い）アカウントは INVALID（変わらない）', bare.code === 'INVALID' && /not ready/.test(bare.error) && (await f.service.get({ botId: owl })).account === '', JSON.stringify(bare));
    t.ok('無い bot は BOT_NOT_FOUND', (await call(human, 'bots.setAccount', { botId: 'b_nope', account: '' })).code === 'BOT_NOT_FOUND');
    const eventsBefore = calls.events.length;
    const chosen = await call(human, 'bots.setAccount', { botId: owl, account: 'acc-oz' });
    t.ok('人が選ぶと変わり、返り（bots.get と同じ形）に account が出る', chosen.ok && chosen.result.account === 'acc-oz' && typeof chosen.result.usage?.weekTokens === 'number', JSON.stringify(chosen));
    t.ok('botsChanged が出る', calls.events.slice(eventsBefore).some((e) => e.type === 'botsChanged' && e.bot?.account === 'acc-oz'));
    t.ok('今ある DM の会話の claudeAccount も揃う（次のターンから効く）', sessions[sess.sessionId].claudeAccount === 'acc-oz');
    t.ok('一覧と get も account を返す', (await call(human, 'bots.list', {})).result.bots.find((b) => b.id === owl)?.account === 'acc-oz'
      && (await call(agent('s'), 'bots.get', { botId: owl })).result.account === 'acc-oz');
    const owlThread = await f.service.createSession({ botId: owl, channel: { id: 'c_a', kind: 'channel', name: 'a', cwd: folderA }, threadId: 'p_a', kind: 'thread', rootText: 'x' });
    const owlRoutine = await f.service.createSession({ botId: owl, channel: { id: 'c_a', kind: 'channel', name: 'a', cwd: folderA }, threadId: 'p_ar', kind: 'routine', routineId: 'r_a', rootText: 'x' });
    t.ok('新しく作るスレッド・ルーティンの会話にも bot のアカウントが付く', sessions[owlThread.sessionId].claudeAccount === 'acc-oz' && sessions[owlRoutine.sessionId].claudeAccount === 'acc-oz');
    const same = calls.events.length;
    t.ok('同じアカウントをもう一度選んでも何も書かない', (await call(human, 'bots.setAccount', { botId: owl, account: 'acc-oz' })).ok && calls.events.length === same);
    const back = await call(human, 'bots.setAccount', { botId: owl, account: '' });
    t.ok('\'\'（ログイン中）はいつでも選べ、今ある会話（ルーティンも）も \'\' に揃う', back.ok && back.result.account === ''
      && [sess.sessionId, owlThread.sessionId, owlRoutine.sessionId].every((id) => sessions[id].claudeAccount === ''));
    // Codex の bot: Codex のアカウントを選べる（Claude のアカウントは選べない）
    const kite = (await call(human, 'bots.create', { name: 'Kite', backend: 'codex' })).result;
    const kiteDm = await f.service.ensureDmSession({ botId: kite.id });
    const kiteClaude = await call(human, 'bots.setAccount', { botId: kite.id, account: 'acc-oz' });
    t.ok('Codex の bot に Claude のアカウントは INVALID（bot のエージェントに登録の無い id）', kiteClaude.code === 'INVALID' && /not registered/.test(kiteClaude.error) && (await f.service.get({ botId: kite.id })).account === '', JSON.stringify(kiteClaude));
    const kiteSet = await call(human, 'bots.setAccount', { botId: kite.id, account: 'acct-cx' });
    t.ok('Codex の bot は Codex のアカウントを選べ、まだ送っていない会話には claudeAccount として付く', kiteSet.ok && kiteSet.result.account === 'acct-cx' && sessions[kiteDm.sessionId].claudeAccount === 'acct-cx' && calls.reserved.length === 0);
    const kiteThread = await f.service.createSession({ botId: kite.id, channel: { id: 'c_k', kind: 'channel', name: 'k', cwd: folderA }, threadId: 'p_k', kind: 'thread', rootText: 'x' });
    t.ok('新しく作る Codex の会話にも bot のアカウントが付く', sessions[kiteThread.sessionId].claudeAccount === 'acct-cx');
    sessions[kiteDm.sessionId].unsent = false;
    await call(human, 'bots.setAccount', { botId: kite.id, account: '' });
    t.ok('送った Codex の会話は、次のターンの予約で替える（ネイティブの会話はアカウントごと。その場では書き換えない）',
      calls.reserved.some((r) => r.sessionId === kiteDm.sessionId && r.account === '') && sessions[kiteDm.sessionId].claudeAccount === 'acct-cx'
      && !calls.reserved.some((r) => r.sessionId === kiteThread.sessionId) && sessions[kiteThread.sessionId].claudeAccount === '', JSON.stringify(calls.reserved));
    const reservedBefore = calls.reserved.length;
    await call(human, 'bots.setAccount', { botId: kite.id, account: 'acct-cx' });
    await call(human, 'bots.setAccount', { botId: kite.id, account: 'acct-cx' });
    t.ok('予約が同じアカウントなら、もう一度は予約しない', calls.reserved.length === reservedBefore + 1);
    const gravity = (await call(human, 'bots.create', { name: 'Gravity3', backend: 'antigravity' })).result;
    const gravitySet = await call(human, 'bots.setAccount', { botId: gravity.id, account: 'acc-oz' });
    t.ok('アカウントを持てないエージェント（Antigravity）の bot はログイン中（空）だけ', gravitySet.code === 'INVALID' && (await call(human, 'bots.setAccount', { botId: gravity.id, account: '' })).ok, JSON.stringify(gravitySet));
    const kiteSwap = await call(human, 'bots.update', { botId: kite.id, backend: 'claude' });
    t.ok('バックエンドを替えるとアカウントはログイン中（空）に戻る（id はエージェントごと）', kiteSwap.ok && kiteSwap.result.account === '' && (await f.service.get({ botId: kite.id })).account === '', JSON.stringify(kiteSwap));

    // ---- update: 狭める向きは通る・広げる向きは承認
    const before = approvals.length;
    const rename = await call(asking, 'bots.update', { botId: owl, name: 'NightOwl', model: 'm-x', effort: 'high' });
    t.ok('名前・モデル・エフォートは承認なしで通る', rename.ok && !rename.pending && rename.result.name === 'NightOwl' && approvals.length === before, JSON.stringify(rename));
    // S-2: AI が人格を変えるのは承認（外から来た文に押された bot が、自分の人格を恒久的に書き換える足場になる）。人が変えるのは承認なし
    const personaAsk = await call(asking, 'bots.update', { botId: owl, persona: '夜型' });
    t.ok('AI が人格を変えると承認カード（loosens・まだ変わらない）。bot 自身の人格も同じ', personaAsk.pending === true && approvals.length === before + 1 && approvals.at(-1).change.loosens === true
      && approvals.at(-1).change.rows.some((r) => r.path === 'persona' && r.after === '夜型') && (await f.service.get({ botId: owl })).persona === 'のんびり屋');
    approvals.pop();
    const personaHuman = await call(human, 'bots.update', { botId: owl, persona: '夜型' });
    t.ok('人が人格を変えるのは承認なし', personaHuman.ok && !personaHuman.pending && personaHuman.result.persona === '夜型' && approvals.length === before);
    const uploadDir = path.join(dir, 'uploads');
    await fs.mkdir(uploadDir);
    const source = path.join(uploadDir, 'source.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(source, png);
    const imageAsk = await call(asking, 'bots.update', { botId: owl, iconImage: source });
    t.ok('AI の画像アイコン変更は人格と同じ承認を要し、承認前には保存しない', imageAsk.pending === true && approvals.at(-1).change.loosens === true && !(await f.service.get({ botId: owl })).iconImage);
    approvals.pop();
    const imageSet = await call(human, 'bots.update', { botId: owl, iconImage: source });
    let iconFile = imageSet.result.iconImage;
    t.ok('画像アイコンは形式の拡張子で置き場へ縮小せずに写す', imageSet.ok && iconFile !== source && iconFile.startsWith(uploadDir) && iconFile.endsWith('.png') && (await fs.readFile(iconFile)).equals(png));
    await fs.unlink(source);
    t.ok('元画像を外しても保存したアイコンは読める', (await fs.readFile(iconFile)).equals(png));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
    for (const [ext, bytes] of [['jpg', jpeg], ['webp', webp]]) {
      const nextSource = path.join(uploadDir, `source.${ext}`);
      await fs.writeFile(nextSource, bytes);
      const previous = iconFile;
      const next = await call(human, 'bots.update', { botId: owl, iconImage: nextSource });
      iconFile = next.result.iconImage;
      t.ok(`${ext} も形式を確かめて元のバイトのまま写し、古い写しを消す`, next.ok && iconFile.endsWith(`.${ext}`) && (await fs.readFile(iconFile)).equals(bytes) && !(await fs.stat(previous).catch(() => null)));
      await fs.unlink(nextSource);
    }
    const cleared = await call(human, 'bots.update', { botId: owl, iconImage: null });
    t.ok('画像を外すと絵文字へ戻り、古い写しは消える', cleared.ok && cleared.result.icon === '🦉' && !cleared.result.iconImage && !(await fs.stat(iconFile).catch(() => null)));
    t.ok('読めない画像パスは保存を拒む', (await call(human, 'bots.update', { botId: owl, iconImage: source })).code === 'INVALID');
    const forged = path.join(uploadDir, 'forged.png');
    await fs.writeFile(forged, Buffer.from('not a PNG'));
    t.ok('拡張子だけ PNG のファイルは拒む', (await call(human, 'bots.update', { botId: owl, iconImage: forged })).code === 'INVALID');
    const oversized = path.join(uploadDir, 'oversized.png');
    await fs.writeFile(oversized, Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
    t.ok('1MiB を超える画像は拒む', (await call(human, 'bots.update', { botId: owl, iconImage: oversized })).code === 'INVALID');
    t.ok('名前を変えると DM のチャンネルの表示名も揃える', calls.update.some((u) => u.channelId === `c_dm_${owl}` && u.name === 'NightOwl'));
    t.ok('モデル・エフォートの変更が今ある会話に反映される', sessions[sess.sessionId].model === 'm-x' && sessions[sess.sessionId].effort === 'high');
    t.ok('ほかの bot の名前への変更は BOT_NAME_TAKEN', (await call(asking, 'bots.update', { botId: owl, name: 'fox' })).code === 'BOT_NAME_TAKEN');
    t.ok('何も変えない update は何も書かない（承認も要らない）', (await call(asking, 'bots.update', { botId: owl, name: 'NightOwl' })).ok && approvals.length === before);

    const add = await call(asking, 'bots.update', { botId: owl, folders: [{ path: folderA }] });
    t.ok('フォルダーを足すと承認カード（まだ変わらない）', add.pending === true && (await f.service.get({ botId: owl })).folders.length === 0, JSON.stringify(add));
    t.ok('承認カードの前後に folders が出る', approvals.at(-1).change.rows.some((r) => r.path === 'folders' && r.after.includes(folderA)) && approvals.at(-1).change.loosens === true);
    await approvals.at(-1).proceed();
    t.ok('許可すると足される（既定は rw）', (await f.service.get({ botId: owl })).folders.map((x) => `${x.access}:${x.path}`).join() === `rw:${folderA}`);
    t.ok('人は承認なしで足せる', (await call(human, 'bots.update', { botId: owl, folders: [{ path: folderA }, { path: folderB, access: 'ro' }] })).ok);
    t.ok('相対パス・無いフォルダー・ファイルは INVALID', (await Promise.all(['rel/path', path.join(dir, 'nope'), path.join(dir, 'a', '..', 'nope')]
      .map((p) => call(human, 'bots.update', { botId: owl, folders: [{ path: p }] })))).every((r) => r.code === 'INVALID'));
    const mark = approvals.length;
    t.ok('フォルダーを減らす向きは承認なし', (await call(asking, 'bots.update', { botId: owl, folders: [{ path: folderA }] })).ok && approvals.length === mark
      && (await f.service.get({ botId: owl })).folders.length === 1);
    await call(human, 'bots.update', { botId: owl, folders: [{ path: folderA, access: 'ro' }] });
    const rw = await call(asking, 'bots.update', { botId: owl, folders: [{ path: folderA, access: 'rw' }] });
    t.ok('ro を rw にする向きも広げる向き（承認）', rw.pending === true);

    t.ok('他の会話へ送るを OFF にするのは承認なし・ON にするのは承認', (await call(asking, 'bots.update', { botId: owl, sendToOthers: false })).ok && approvals.length === mark + 1
      && (await call(asking, 'bots.update', { botId: owl, sendToOthers: true })).pending === true);
    t.ok('送れる会話を足すのは承認・外すのは承認なし', (await call(asking, 'bots.update', { botId: owl, sendTargets: ['sess-9'] })).pending === true);
    await call(human, 'bots.update', { botId: owl, sendTargets: ['sess-9', 'sess-8'] });
    const sizeBefore = approvals.length;
    t.ok('送れる会話を外す向きは承認なし', (await call(asking, 'bots.update', { botId: owl, sendTargets: ['sess-9'] })).ok && approvals.length === sizeBefore);

    const swap = await call(asking, 'bots.update', { botId: owl, backend: 'antigravity' });
    t.ok('承認モードが強くなるバックエンドへの変更（Antigravity は yolo だけ）は承認', swap.pending === true, JSON.stringify(swap));
    const swapped = await call(human, 'bots.update', { botId: owl, backend: 'antigravity' });
    t.ok('人が変えるとモードは yolo・モデルとエフォートは既定に戻る', swapped.ok && swapped.result.mode === 'yolo' && swapped.result.model === '' && swapped.result.effort === '');
    t.ok('バックエンドを変えても今の会話はそのまま（次の新しい会話から）', sessions[sess.sessionId].backend === 'claude');
    t.ok('弱いモードへ戻る向き（Antigravity → Claude）は承認なし', (await call(asking, 'bots.update', { botId: owl, backend: 'claude' })).ok);
    t.ok('無い bot の update は BOT_NOT_FOUND', (await call(asking, 'bots.update', { botId: 'b_nope', name: 'Z' })).code === 'BOT_NOT_FOUND');
    t.ok('承認モードは update の引数にできない（strict）', (await call(human, 'bots.update', { botId: owl, mode: 'bypass' })).code === 'INVALID');

    // ---- DM の会話: 同じ bot なら使い回し・バックエンドを変えたら新しく
    t.ok('Claude の bot を Codex に変えると、そのエージェントの既定のモードになる', (await call(human, 'bots.update', { botId: owl, backend: 'codex' })).result.mode === 'ask');
    const again = await f.service.ensureDmSession({ botId: owl });
    t.ok('バックエンドを変えた bot の DM は新しい会話（古い会話は残る）', again.created === true && again.sessionId !== sess.sessionId && sessions[sess.sessionId] !== undefined);
    t.ok('同じなら使い回す', (await f.service.ensureDmSession({ botId: owl })).sessionId === again.sessionId && (await f.service.ensureDmSession({ botId: owl })).created === false);
    const thread = await f.service.createSession({ botId: owl, channel: { id: 'c_1', kind: 'channel', name: 'checkout-perf', cwd: folderA }, threadId: 'p_1', kind: 'thread', rootText: 'ページが重い\nなぜ' });
    t.ok('スレッドの会話の題は「🦉 Owl · #チャンネル › 根の頭」・チャンネルの cwd が bot のフォルダーの中ならそれ',
      calls.conversations.at(-1).info.title === '🦉 NightOwl · #checkout-perf › ページが重い なぜ' && thread.cwd === folderA && sessions[thread.sessionId].bot.threadId === 'p_1' && sessions[thread.sessionId].bot.kind === 'thread', calls.conversations.at(-1).info.title);
    const outside = await f.service.createSession({ botId: owl, channel: { id: 'c_2', kind: 'channel', name: 'x', cwd: path.join(dir, 'elsewhere') }, threadId: 'p_2', kind: 'thread' });
    t.ok('チャンネルの cwd が bot のフォルダーの外なら、bot の先頭のフォルダー', outside.cwd === folderA, outside.cwd);

    // ---- 一覧: 使用量（今週の記録だけ・sessionId で引く）と状態
    const g = fake(path.join(dir, 'g'), { usage: [
      { sessionId: 'sess-1', at: 1_000_000 - 1000, inputTokens: 100, outputTokens: 20, cachedTokens: 60 },
      { sessionId: 'sess-1', at: 1_000_000 - 8 * 24 * 3600_000, inputTokens: 999, outputTokens: 999, cachedTokens: 0 },
      { sessionId: 'sess-other', at: 1_000_000, inputTokens: 5000, outputTokens: 5000, cachedTokens: 0 },
    ] });
    await g.service.start();
    const gBot = (await g.call(human, 'bots.create', { name: 'Metered', backend: 'claude' })).result;
    const gSess = await g.service.ensureDmSession({ botId: gBot.id });
    t.ok('前提: DM の会話は sess-1', gSess.sessionId === 'sess-1');
    const listed = await g.call(human, 'bots.list', {});
    t.ok('使用量は今週のその bot の会話の分だけ・キャッシュ率', listed.result.bots[0].usage.weekTokens === 120 && Math.abs(listed.result.bots[0].usage.cacheRatio - 0.6) < 1e-9, JSON.stringify(listed.result.bots[0].usage));
    g.host.runtime.turns.set('k', { info: { sessionId: 'sess-1' } });
    t.ok('走っているターンがあれば working', (await g.call(human, 'bots.get', { botId: gBot.id })).result.state === 'working');
    g.host.runtime.waiting.set('w', { payload: { sessionId: 'sess-1' } });
    t.ok('承認待ちがあれば waiting（working より優先）', (await g.call(human, 'bots.get', { botId: gBot.id })).result.state === 'waiting');
    t.ok('AI も一覧を読める', (await g.call(agent('s'), 'bots.list', {})).ok && (await g.call(agent('s'), 'bots.get', { botId: gBot.id })).ok);
    t.ok('無い bot の get は BOT_NOT_FOUND', (await g.call(human, 'bots.get', { botId: 'b_nope' })).code === 'BOT_NOT_FOUND');

    // ---- DM のチャンネルを作れない間（S1 より前）も bot は作れ、後から作る
    const early = fake(path.join(dir, 'early'), { dmFails: true });
    await early.service.start();
    const e1 = await early.call(human, 'bots.create', { name: 'Early', backend: 'claude' });
    t.ok('チャンネルの口が使えなくても bot は作れる（dmChannelId は空）', e1.ok && e1.result.dmChannelId === '');
    const e2 = await early.service.ensureDmSession({ botId: e1.result.id });
    t.ok('DM の会話は作れる（チャンネルは後から）', e2.created === true && early.sessions[e2.sessionId].bot.channelId === null);

    // ---- 削除
    const dp = approvals.length;
    const delAsk = await call(asking, 'bots.delete', { botId: owl, reason: '使わない' });
    t.ok('AI の削除は承認（まだ消えない）', delAsk.pending === true && (await f.service.get({ botId: owl })) !== null && approvals.length === dp + 1);
    t.ok('承認カードに消す bot が出る', approvals.at(-1).change.rows[0].before.includes('Owl') && approvals.at(-1).change.rows[0].after === null);
    const del = await call(human, 'bots.delete', { botId: owl });
    t.ok('人が消すと消え、DM のチャンネルは archive', del.ok && (await f.service.get({ botId: owl })) === null && calls.archive.some((a) => a.channelId === `c_dm_${owl}` && a.on === true));
    t.ok('会話は消さず、bot の印だけ外す（Chats の一覧に戻る）', sessions[sess.sessionId] !== undefined && sessions[sess.sessionId].bot === null && sessions[again.sessionId].bot === null);
    t.ok('botsChanged（removed）が出る', calls.events.some((e) => e.type === 'botsChanged' && e.removed === owl));
    t.ok('もう一度は BOT_NOT_FOUND', (await call(human, 'bots.delete', { botId: owl })).code === 'BOT_NOT_FOUND');
    t.ok('消した名前は使える', (await call(human, 'bots.create', { name: 'Owl', backend: 'claude' })).ok);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
