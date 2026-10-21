// 同期で届いた skill・指示ファイルの受け入れ待ち（core/plus/sync/engine.mjs、docs/plus.md「届いた変更」、ADR 0245）。
// 偽の Plus と 2 台のホストで、届いたものを人の「取り込む」まで書かない・取り込むと書く・捨てた版は出し直さない（新しい版は出す）・
// 自分の PC が出した変更は待ちに置かない・手元が変わっていたら取り込まない・消すのも待ちに置く・中身の無い消した印を受けない、を確かめる。
// 設定の項目は今のまま自動で書く。時計と fs.watch は差し替える。LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createSyncKeys } from '../../core/plus/sync/keys.mjs';
import { createSyncTargets } from '../../core/plus/sync/targets.mjs';
import { createSyncSettings } from '../../core/plus/sync/settings.mjs';
import { createSyncEngine, SYNC_DEBOUNCE_MS } from '../../core/plus/sync/engine.mjs';

export const name = 'plus-sync-inbox';
export const title = '同期の受け入れ待ち: 届いた skill・指示ファイルは取り込むまで書かない・取り込む・捨てた版は出し直さない・自分の変更は待たない・手元の変更を上書きしない・中身の無い消した印を受けない';

const UID = 'inbox-user';
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ps-inbox-')));
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:9' });
  plus.state.accounts[UID] = { uid: UID, email: 'user@example.com', provider: 'test', status: 'plus', plan: { id: 'plus', name: 'Plus' }, limits: null, usage: null, sync: {} };
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: path.join(tmp, 'cfg'), appVersion: 'test' });
  const put = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };
  const read = file => fs.readFile(file, 'utf8').catch(() => null);
  const exists = p => fs.stat(p).then(() => true, () => false);
  const engines = [];
  let hostSeq = 0;

  async function makeHost(label) {
    const root = path.join(tmp, label);
    const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
    const hostId = `host-${label}`;
    const clock = fakeClock(T0);
    const logs = [];
    const calls = [];
    const base = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' });
    const client = { request(method, p, opts) { calls.push(`${method} ${p.split('?')[0]}`); return base.request(method, p, opts); } };
    const secrets = createSecretStore({ file: path.join(dataDir, 'plus-secrets.json'), cipher: plainCipher });
    const store = {};
    const listeners = new Set();
    const settings = createSyncSettings({
      settings: [{ key: 'colorish', sync: true, default: 'red', read: async () => store.colorish ?? null, write: async (_c, v) => { store.colorish = v; } }],
      ctx: () => ({}), onWritten: k => { for (const fn of listeners) fn(k); },
    });
    const watchers = [];
    const watch = (dir, _opts, listener) => { const w = { dir, listener, close() { w.closed = true; }, on() {} }; watchers.push(w); return w; };
    const emit = file => {
      for (const w of watchers) {
        const rel = path.relative(w.dir, file);
        if (!w.closed && !rel.startsWith('..') && !path.isAbsolute(rel)) w.listener('change', rel);
      }
    };
    let engine = null;
    const keys = createSyncKeys({ client, secrets, uid: () => UID, hostId: () => hostId, log: l => logs.push(l), onShared: to => engine?.noteShared(to) });
    const targets = createSyncTargets({ dataDir, home, env: {}, settings, log: l => logs.push(l) });
    engine = createSyncEngine({
      client, keys, targets, dataDir, uid: () => UID, hostId: () => hostId, log: l => logs.push(l), clock, watch,
      settingsEvents: { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    });
    engines.push(engine);
    plus.state.hosts[hostId] = {
      hostId, uid: UID, publicKey: 'not-used', name: label, platform: 'linux', online: false, lastSeenAt: null,
      syncPublicKey: await keys.publicKey(), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++hostSeq)).toISOString(), deviceCount: 0,
    };
    return { label, hostId, dataDir, clock, logs, calls, engine, targets, store, emit, skill: (...rel) => path.join(targets.skillRoots.claude, ...rel), claudeMd: targets.instructions.claude };
  }

  const settle = async h => { await h.clock.flush(); await h.engine.idle(); };
  const adv = async (h, ms) => { await h.clock.advance(ms); await settle(h); };
  const puts = h => h.calls.filter(c => c.startsWith('PUT /v1/sync/items/')).length;
  // 直す前のエンジンには受け入れ待ちの口が無い。落ちる形（空・undefined）で読む
  const list = async h => (await h.engine.inbox?.list?.()) ?? [];
  const find = async (h, logical) => (await list(h)).find(x => x.path === logical) ?? null;
  const take = async (h, id) => (await h.engine.inbox?.take?.(id)) ?? null;
  const drop = async (h, id) => (await h.engine.inbox?.drop?.(id)) ?? null;
  const SKILL = 'skills/claude/shared/SKILL.md';
  const CLAUDE = 'instructions/claude';

  try {
    // ================= A が上げ、B が受ける =================
    const a = await makeHost('a');
    const b = await makeHost('b');
    await put(a.skill('shared', 'SKILL.md'), 'v1\n');
    await put(a.claudeMd, 'rules from a\n');
    a.store.colorish = 'blue';
    await put(b.claudeMd, 'rules on b\n');
    await a.engine.start();
    await b.engine.start();
    await adv(a, 5 * 60_000);   // A の見回りで B に鍵を渡す
    await b.engine.run();
    t.ok('B は鍵を受けて idle', b.engine.status().state === 'idle', JSON.stringify(b.engine.status()));

    t.ok('届いた skill は、取り込むまで ~/.claude に書かない', !(await exists(b.skill('shared', 'SKILL.md'))));
    t.ok('届いた指示ファイルは、取り込むまで手元のものを書き換えない', (await read(b.claudeMd)) === 'rules on b\n');
    t.ok('設定の項目は今のまま自動で書く', b.store.colorish === 'blue');
    const bSkill = await find(b, SKILL), bClaude = await find(b, CLAUDE);
    t.ok('受け入れ待ちに 2 件（新しいファイル・変更）・送った PC が載る',
      bSkill?.kind === 'new' && bClaude?.kind === 'change' && bSkill.from === a.hostId && bClaude.from === a.hostId,
      JSON.stringify(await list(b)));
    t.ok('状態の inbox に件数が出る', b.engine.status().inbox === 2, JSON.stringify(b.engine.status()));
    const inboxDir = path.join(b.dataDir, 'plus', 'sync-inbox');
    const claudeDir = bClaude ? path.join(inboxDir, bClaude.id) : inboxDir;
    const meta = JSON.parse((await read(path.join(claudeDir, 'meta.json'))) ?? 'null');
    t.ok('<data>/plus/sync-inbox/<項目>/ に incoming・base・meta.json（from・at・kind）を置く',
      (await read(path.join(claudeDir, 'incoming'))) === 'rules from a\n' && (await read(path.join(claudeDir, 'base'))) === 'rules on b\n'
      && meta?.from === a.hostId && meta?.kind === 'change' && Number.isFinite(Date.parse(meta?.at)), JSON.stringify(meta));
    t.ok('待っている間、B は手元の版を上げ直さない', puts(b) === 0, String(puts(b)));
    await a.engine.run();
    t.ok('自分の PC が出した変更は待ちに置かない（A の待ちは空）', (await list(a)).length === 0 && a.engine.status().inbox === 0);

    // ================= 取り込む =================
    const took = bSkill ? await take(b, bSkill.id) : null;
    t.ok('取り込むと書く（同じバイト列）', took?.taken === true && (await read(b.skill('shared', 'SKILL.md'))) === 'v1\n', JSON.stringify(took));
    t.ok('取り込んだものは待ちから消え、件数が減る', !(await find(b, SKILL)) && b.engine.status().inbox === 1);
    const putsTook = puts(b);
    b.emit(b.skill('shared', 'SKILL.md'));
    await settle(b);
    await adv(b, SYNC_DEBOUNCE_MS + 1000);
    await b.engine.run();
    t.ok('取り込んだ版は上げ直さない', puts(b) === putsTook, String(puts(b) - putsTook));

    // ================= 自分の変更は待たない・相手には待ちで届く =================
    await put(b.skill('shared', 'SKILL.md'), 'v2 from b\n');
    b.emit(b.skill('shared', 'SKILL.md'));
    await settle(b);
    await adv(b, SYNC_DEBOUNCE_MS);
    t.ok('B が変えて上げた版は、B の待ちに置かない', puts(b) === putsTook + 1 && !(await find(b, SKILL)), String(puts(b) - putsTook));
    await a.engine.run();
    const aSkill = await find(a, SKILL);
    t.ok('A には変更として待ちに届き、A のファイルはそのまま', aSkill?.kind === 'change' && aSkill.from === b.hostId && (await read(a.skill('shared', 'SKILL.md'))) === 'v1\n',
      JSON.stringify(aSkill));

    // ================= 捨てる =================
    const dropped = aSkill ? await drop(a, aSkill.id) : null;
    t.ok('捨てると待ちから消え、ファイルは手元のまま', dropped !== null && !(await find(a, SKILL)) && (await read(a.skill('shared', 'SKILL.md'))) === 'v1\n');
    const aPuts = puts(a);
    await a.engine.run();
    t.ok('捨てても何も上げない', puts(a) === aPuts);
    // 鍵が替わると全部が届き直す。捨てた版は出し直さない
    await b.engine.reset();
    a.engine.stop();
    await a.engine.start();
    t.ok('鍵が替わって同じ版が届き直しても、捨てた版は出さない', a.engine.status().state === 'idle' && !(await find(a, SKILL)), JSON.stringify(await list(a)));
    await put(b.skill('shared', 'SKILL.md'), 'v3 from b\n');
    b.emit(b.skill('shared', 'SKILL.md'));
    await settle(b);
    await adv(b, SYNC_DEBOUNCE_MS);
    await a.engine.run();
    const aSkill3 = await find(a, SKILL);
    t.ok('新しい版が来たら、また出す', aSkill3?.kind === 'change' && (await read(path.join(a.dataDir, 'plus', 'sync-inbox', aSkill3.id, 'incoming'))) === 'v3 from b\n',
      JSON.stringify(aSkill3));

    // ================= 手元が変わっていたら取り込まない =================
    await put(a.skill('shared', 'SKILL.md'), 'edited on a\n');
    const refused = aSkill3 ? await take(a, aSkill3.id) : null;
    t.ok('待ちに置いた後に手元が変わっていたら、上書きせずに知らせる', refused?.taken === false && refused.reason === 'local_changed'
      && (await read(a.skill('shared', 'SKILL.md'))) === 'edited on a\n' && Boolean(await find(a, SKILL)), JSON.stringify(refused));

    // ================= 消すのも待ちに置く =================
    await put(a.skill('gone', 'SKILL.md'), 'to be removed\n');
    a.emit(a.skill('gone', 'SKILL.md'));
    await settle(a);
    await adv(a, SYNC_DEBOUNCE_MS);
    await b.engine.run();
    const gone = await find(b, 'skills/claude/gone/SKILL.md');
    if (gone) await take(b, gone.id);
    t.ok('B が新しいファイルを取り込む', (await read(b.skill('gone', 'SKILL.md'))) === 'to be removed\n');
    await fs.rm(a.skill('gone', 'SKILL.md'));
    a.emit(a.skill('gone', 'SKILL.md'));
    await settle(a);
    await adv(a, SYNC_DEBOUNCE_MS);
    await b.engine.run();
    const del = await find(b, 'skills/claude/gone/SKILL.md');
    t.ok('消したのが届いても、取り込むまでファイルは消さない（消すとして待ちに置く）', del?.kind === 'delete' && (await read(b.skill('gone', 'SKILL.md'))) === 'to be removed\n',
      JSON.stringify(del));
    const delTook = del ? await take(b, del.id) : null;
    t.ok('消すのを取り込むとファイルが消える', delTook?.taken === true && !(await exists(b.skill('gone', 'SKILL.md'))));

    // ================= 中身の無い消した印を受けない =================
    const bState = JSON.parse(await fs.readFile(b.engine.stateFile, 'utf8'));
    const rec = bState.items[SKILL];
    const ledger = plus.state.sync[UID];
    const rejectedBefore = b.logs.filter(l => l.startsWith('sync item rejected')).length;
    const fileBefore = await read(b.skill('shared', 'SKILL.md'));
    const heldBefore = JSON.stringify(await find(b, SKILL));
    // サーバーの台帳の項目を、中身の無い消した印に差し替えて配る
    const live = { ...ledger.items[rec.itemId] };
    ledger.items[rec.itemId] = { ...live, rev: rec.rev + 1, seq: ++ledger.seq, ciphertext: null, deleted: true };
    await b.engine.run();
    t.ok('中身（暗号文）の無い消した印は受けない（ファイルも待ちも変わらない）', (await read(b.skill('shared', 'SKILL.md'))) === fileBefore
      && JSON.stringify(await find(b, SKILL)) === heldBefore && b.logs.filter(l => l.startsWith('sync item rejected')).length === rejectedBefore + 1, JSON.stringify(b.logs.slice(-3)));
    // サーバーの deleted が平文と食い違うものも受けない
    ledger.items[rec.itemId] = { ...live, seq: ++ledger.seq, deleted: true };   // 暗号文は本物（同じ rev）、deleted だけ違う
    await b.engine.run();
    t.ok('サーバーの deleted と中身の deleted が食い違う項目は受けない', (await read(b.skill('shared', 'SKILL.md'))) === fileBefore
      && JSON.stringify(await find(b, SKILL)) === heldBefore && b.logs.filter(l => l.startsWith('sync item rejected')).length === rejectedBefore + 2, JSON.stringify(b.logs.slice(-3)));
    ledger.items[rec.itemId] = { ...live, seq: ++ledger.seq };
  } finally {
    for (const e of engines) e.stop();
    await plus.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
