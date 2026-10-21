// 同期のエンジン（core/plus/sync/engine.mjs、docs/plus.md「同期」）。偽の Plus（tests/lib/fake-plus.mjs）と 2 台のホストで、
// バイト列のまま運ぶ・秘密情報と変数を運ばない・api に届くのは暗号文だけ・消すのが伝わる・競合と写しの片付け・5 秒まとめ・10 分ごと・同時に 1 本・
// 容量の上限と戻り・同期を切る・自分で書いたものを上げ直さない・決めた欄だけを送る、を確かめる。
// 登録が外れた PC（403 host）・鍵を持つ PC が外れてもデータを消さない・始め直したあとの設定の勝ち負け（docs/plus.md「同期の始め直しと登録の外れ」）も見る。
// 時計と fs.watch は差し替える。LLM も外のネットワークも使わない。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createSyncKeys, SYNC_ACCOUNT_KEY } from '../../core/plus/sync/keys.mjs';
import { createSyncTargets } from '../../core/plus/sync/targets.mjs';
import { createSyncSettings } from '../../core/plus/sync/settings.mjs';
import { createSyncEngine, SYNC_DEBOUNCE_MS, SYNC_RECEIVE_MS, CONFLICT_KEEP_MS } from '../../core/plus/sync/engine.mjs';
import { createPlusSync } from '../../core/plus/sync/index.mjs';
import { decryptItem, deriveItemKeys, fromB64url } from '../../core/plus/sync/crypto.mjs';

export const name = 'plus-sync-engine';
export const title = '同期のエンジン: 2 台で運ぶ・バイト列のまま・秘密情報と変数を運ばない・api には暗号文だけ・消す・競合・5 秒まとめ・10 分ごと・1 本だけ・容量・切る・自分の書き込み・登録の外れ・始め直しの設定';

const UID = 'test-user';
const UID2 = 'test-user-rejoin';                  // 登録の外れと始め直しを見るアカウント
const SECRET = 'SECRET-VALUE-zq81x';           // 秘密情報と変数の値（作り物）
const MACHINE = 'machine-only-value-k3';         // sync: false の設定の値
const LIMIT = 9_876_543;                          // 偽の容量の上限（作り物）
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const PUT_FIELDS = ['baseRev', 'ciphertext', 'deleted', 'hostId', 'keyId'];

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ps-eng-')));
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:9' });
  plus.state.syncLimitBytes = LIMIT;
  for (const uid of [UID, UID2]) {
    plus.state.accounts[uid] = { uid, email: 'user@example.com', provider: 'test', status: 'plus', plan: { id: 'plus', name: 'Plus' }, limits: null, usage: null, sync: {} };
  }
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: path.join(tmp, 'cfg'), appVersion: 'test' });
  const put = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };
  const exists = p => fs.stat(p).then(() => true, () => false);
  const engines = [];
  let hostSeq = 0;

  /** 1 台のホスト: 自分の home・<data>・秘密の置き場・設定・時計・watch・api の客（呼んだ口を数える） */
  async function makeHost(label, { uid = UID } = {}) {
    const root = path.join(tmp, label);
    const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
    const hostId = `host-${label}`;
    const clock = fakeClock(T0);
    const logs = [];
    const calls = [];
    const errors = [];
    let inFlight = 0, maxInFlight = 0;
    const activity = { inFlight: () => inFlight, last: 0 };
    const base = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(uid), appVersion: 'test' });
    const client = {
      async request(method, p, opts) {
        calls.push(`${method} ${p.split('?')[0]}`);
        activity.last = performance.now();
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        try { return await base.request(method, p, opts); }
        catch (e) { errors.push(`${method} ${p.split('/').slice(0, 4).join('/')} ${e.status} ${e.code} ${e.message}${e.body?.current ? ' +current' : ''}`); throw e; }
        finally { inFlight--; activity.last = performance.now(); }
      },
    };
    const secrets = createSecretStore({ file: path.join(dataDir, 'plus-secrets.json'), cipher: plainCipher });
    // 秘密情報と変数（値の置き場と、名前の置き場）
    const secretValues = createSecretStore({ file: path.join(dataDir, 'secret-values.json'), cipher: plainCipher });
    await secretValues.set('MY_TOKEN', SECRET);
    await put(path.join(dataDir, 'secrets.json'), JSON.stringify({ version: 1, items: [{ name: 'MY_TOKEN', note: SECRET }] }));
    // 設定（defineSetting の形の作り物）
    const store = {};
    const def = (key, extra) => ({ key, sync: true, default: 'red', read: async () => store[key] ?? null, write: async (_c, v) => { store[key] = v; }, ...extra });
    const listeners = new Set();
    const settings = createSyncSettings({
      settings: [def('colorish'), def('machineOnly', { sync: false, default: null })],
      ctx: () => ({}), onWritten: k => { for (const fn of listeners) fn(k); },
    });
    const settingsEvents = { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
    const changeSetting = (key, value) => { store[key] = value; for (const fn of listeners) fn([key]); };
    // fs.watch の差し替え: 張った場所を覚え、試験から出来事を起こす
    const watchers = [];
    const watch = (dir, opts, listener) => { const w = { dir, listener, close() { w.closed = true; }, on() {} }; watchers.push(w); return w; };
    const emit = (file) => {
      for (const w of watchers) {
        if (w.closed) continue;
        const rel = path.relative(w.dir, file);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) w.listener('change', rel);
      }
    };
    let engine = null;
    const keys = createSyncKeys({ client, secrets, uid: () => uid, hostId: () => hostId, log: l => logs.push(l), onShared: to => engine?.noteShared(to) });
    const targets = createSyncTargets({ dataDir, home, env: {}, settings, log: l => logs.push(l) });
    const statuses = [];
    let hostLost = 0;   // onHostLost（403 host）の回数
    engine = createSyncEngine({
      client, keys, targets, dataDir, uid: () => uid, hostId: () => hostId, log: l => logs.push(l), settingsEvents, clock, watch,
      onStatus: s => statuses.push(s), onHostLost: () => { hostLost++; },
    });
    engines.push(engine);
    plus.state.hosts[hostId] = {
      hostId, uid, publicKey: 'not-used', name: label, platform: 'linux', online: false, lastSeenAt: null,
      syncPublicKey: await keys.publicKey(), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++hostSeq)).toISOString(), deviceCount: 0,
    };
    const skill = (...rel) => path.join(targets.skillRoots.claude, ...rel);
    return {
      label, hostId, home, dataDir, clock, logs, calls, errors, engine, targets, keys, secrets, store, changeSetting, emit, statuses, skill,
      activity, maxInFlight: () => maxInFlight, resetInFlight: () => { maxInFlight = 0; }, hostLost: () => hostLost,
      claudeMd: targets.instructions.claude,
    };
  }

  // タイマーから始まった回は待てる約束を返さないので、api の呼び出しが止んで少したつまで実時間で待つ
  const settle = async (h) => {
    for (let i = 0; i < 400; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (h.activity.inFlight() === 0 && performance.now() - h.activity.last > 80) return;
    }
  };
  const adv = async (h, ms) => { await h.clock.advance(ms); await settle(h); };
  const itemPuts = () => plus.state.syncBodies.filter(b => b.method === 'PUT' && b.path.startsWith('/v1/sync/items/'));
  const count = (h, what) => h.calls.filter(c => c === what).length;

  try {
    // ================= A: 最初の 1 台 =================
    const a = await makeHost('a');
    const crlfBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\r\nname: demo\r\ndescription: 試験\r\n---\r\n本文 line\r\nlast line without newline', 'utf8')]);
    await put(a.skill('demo', 'SKILL.md'), crlfBom);
    await put(a.claudeMd, 'global instructions\n');
    await put(path.join(a.targets.skillRoots.pleiad, 'mine', 'SKILL.md'), 'pleiad skill\n');
    // 秘密の名前・.env は skill の置き場の中にあっても運ばない
    await put(a.skill('demo', 'secret-notes.md'), SECRET);
    await put(a.skill('demo', '.env'), `TOKEN=${SECRET}`);
    a.store.colorish = 'blue';
    a.store.machineOnly = MACHINE;

    await a.engine.start();
    const ledger = plus.state.sync[UID];
    t.ok('A: 鍵を作り、手元の項目を上げて idle', a.engine.status().state === 'idle' && Boolean(ledger?.keyId) && Object.keys(ledger.items).length === 4,
      JSON.stringify({ status: a.engine.status(), items: Object.keys(ledger?.items ?? {}).length, logs: a.logs }));
    t.ok('A: lastSyncedAt は時計の今', a.engine.status().lastSyncedAt === new Date(T0).toISOString());
    t.ok('A: 状態に api の返す totalBytes と limitBytes が載る', a.engine.status().limitBytes === LIMIT);
    t.ok('A: watch は skill の置き場と指示ファイルの親に張る', a.engine.watching().includes(a.targets.skillRoots.claude) && a.engine.watching().includes(path.dirname(a.claudeMd)));

    // ================= B: 2 台目は鍵を待つ → A が渡す → 受ける =================
    const b = await makeHost('b');
    await put(b.skill('from-b', 'SKILL.md'), 'written on b\n');
    await b.engine.start();
    t.ok('B: 自分宛ての鍵が無いので waiting_key（項目を上げない）', b.engine.status().state === 'waiting_key' && count(b, 'PUT /v1/sync/items') === 0);
    // A の 5 分ごとの見回りで鍵を渡す
    await adv(a, 5 * 60_000);
    t.ok('A: 5 分ごとの見回りで B に鍵を渡す', ledger.keys[b.hostId]?.wrappedBy === a.hostId, JSON.stringify(Object.keys(ledger.keys)));
    await b.engine.run();
    t.ok('B: 鍵を受けて idle', b.engine.status().state === 'idle', JSON.stringify({ s: b.engine.status(), logs: b.logs }));
    const bSkill = await fs.readFile(b.skill('demo', 'SKILL.md')).catch(() => null);
    t.ok('B: BOM・CRLF・末尾の改行の無さを含めて同じバイト列で届く', bSkill?.equals(crlfBom) === true);
    t.ok('B: 全体の指示ファイルと Pleiad の skill も届く', (await fs.readFile(b.claudeMd, 'utf8').catch(() => '')) === 'global instructions\n'
      && (await fs.readFile(path.join(b.targets.skillRoots.pleiad, 'mine', 'SKILL.md'), 'utf8').catch(() => '')) === 'pleiad skill\n');
    t.ok('B: sync の設定は normalize を通して届く・sync: false の設定は届かない', b.store.colorish === 'blue' && b.store.machineOnly === undefined);
    t.ok('B: 秘密の名前・.env のファイルは届かない', !(await exists(b.skill('demo', 'secret-notes.md'))) && !(await exists(b.skill('demo', '.env'))));
    t.ok('B: 受けたファイルの mtime は送った側の mtime', Math.abs((await fs.stat(b.skill('demo', 'SKILL.md'))).mtimeMs - (await fs.stat(a.skill('demo', 'SKILL.md'))).mtimeMs) < 2000);
    await a.engine.run();
    t.ok('A: B の skill を受ける', (await fs.readFile(a.skill('from-b', 'SKILL.md'), 'utf8').catch(() => '')) === 'written on b\n');

    // ---- 自分で書いたものは上げ直さない
    const bPutsBefore = count(b, 'PUT /v1/sync/items'), bStateBefore = count(b, 'GET /v1/sync/state');
    b.emit(b.skill('demo', 'SKILL.md'));
    b.emit(b.claudeMd);
    await settle(b);
    await adv(b, SYNC_DEBOUNCE_MS + 1000);
    t.ok('B: 受けて書いたファイルの watch の出来事では回さない・上げ直さない',
      count(b, 'PUT /v1/sync/items') === bPutsBefore && count(b, 'GET /v1/sync/state') === bStateBefore, JSON.stringify(b.calls.slice(-5)));

    // ================= 秘密情報と変数を運ばない・運営は中身を読めない =================
    const wire = JSON.stringify(plus.state.syncBodies) + JSON.stringify(plus.state.sync) + JSON.stringify(plus.state.calls) + JSON.stringify(plus.state.hosts);
    t.ok('秘密情報と変数の値は、api に届いた本文・台帳のどこにも無い', !wire.includes(SECRET) && !wire.includes(Buffer.from(SECRET).toString('base64')));
    t.ok('sync: false の設定の値も api に届かない', !wire.includes(MACHINE) && !wire.includes(Buffer.from(JSON.stringify(MACHINE)).toString('base64')));
    const plainBits = ['SKILL.md', 'skills/', 'instructions/', 'settings/', 'colorish', 'demo', 'from-b', 'global instructions', 'written on b', '本文', 'name: demo',
      crlfBom.toString('base64'), Buffer.from('global instructions\n').toString('base64')];
    const seen = plainBits.filter(s => wire.includes(s));
    t.ok('api に届くのは暗号文だけ（論理名・中身・その base64 が本文・台帳に出ない）', seen.length === 0, seen.join());
    const kA = await a.secrets.get(SYNC_ACCOUNT_KEY);
    const kBuf = fromB64url(kA.key);
    t.ok('K は api に届かない（どの形でも）', [kBuf.toString('base64url'), kBuf.toString('base64'), kBuf.toString('hex')].every(s => !wire.includes(s)));
    // K を持つ側として api の全項目を開き、秘密が暗号文の中にも入っていないことを見る
    const { enc, id } = deriveItemKeys(kBuf);
    const opened = Object.entries(ledger.items).filter(([, it]) => it.ciphertext).map(([itemId, it]) =>
      decryptItem({ encKey: enc, idKey: id, keyId: ledger.keyId, uid: UID, itemId, rev: it.rev, ciphertext: it.ciphertext }));
    t.ok('K を持つ側が開いても、全項目が開け、秘密情報と変数・秘密の名前・sync: false の設定は入っていない',
      opened.length > 0 && opened.every(Boolean)
      && opened.every(o => !o.path.includes('secret') && !o.path.includes('.env') && !o.path.includes('machineOnly') && !o.content.toString('latin1').includes(SECRET) && !o.content.toString('utf8').includes(MACHINE)),
      JSON.stringify(opened.map(o => o?.path)));
    t.ok('K の無い者（別の K）には開けない', Object.entries(ledger.items).filter(([, it]) => it.ciphertext).every(([itemId, it]) => {
      const other = deriveItemKeys(crypto.randomBytes(32));
      return decryptItem({ encKey: other.enc, idKey: other.id, keyId: ledger.keyId, uid: UID, itemId, rev: it.rev, ciphertext: it.ciphertext }) === null;
    }));
    const localLedger = await fs.readFile(a.engine.stateFile, 'utf8');
    t.ok('手元の覚え（sync-state.json）にも秘密の値・鍵は無い', !localLedger.includes(SECRET) && !localLedger.includes(kA.key) && !localLedger.includes('secret-notes'));
    const putKeys = itemPuts().map(p => Object.keys(JSON.parse(p.body)).sort().join());
    t.ok('PUT items には決めた欄（baseRev・keyId・ciphertext・deleted・hostId）だけを送る', putKeys.length > 0 && putKeys.every(k => k === PUT_FIELDS.join()), [...new Set(putKeys)].join(' | '));
    const allLogs = [...a.logs, ...b.logs].join('\n');
    t.ok('ログに論理名・中身・秘密を出さない', !/SKILL\.md|skills\/|instructions\/|settings\/|colorish|global instructions|demo/.test(allLogs) && !allLogs.includes(SECRET), allLogs);

    // ================= 手元の変更: 5 秒まとめ =================
    await put(a.skill('demo', 'extra.md'), 'one');
    const aState0 = count(a, 'GET /v1/sync/state');
    a.emit(a.skill('demo', 'extra.md'));
    await adv(a, 2000);
    await put(a.skill('demo', 'extra2.md'), 'two');
    a.emit(a.skill('demo', 'extra2.md'));
    a.emit(path.join(a.targets.skillRoots.claude, 'demo', 'node_modules', 'x.js'));
    await adv(a, SYNC_DEBOUNCE_MS - 2000 - 1);
    t.ok('最初の変更から 5 秒たつまでは回さない', count(a, 'GET /v1/sync/state') === aState0);
    await adv(a, 1);
    t.ok('5 秒たったら、まとめて 1 回だけ回す', count(a, 'GET /v1/sync/state') === aState0 + 1 && Object.keys(ledger.items).length === 7, JSON.stringify({ n: count(a, 'GET /v1/sync/state') - aState0, items: Object.keys(ledger.items).length }));
    const aState1 = count(a, 'GET /v1/sync/state');
    a.emit(path.join(a.targets.skillRoots.claude, 'demo', 'node_modules', 'y.js'));
    a.emit(path.join(a.targets.skillRoots.claude, 'demo', '.git', 'HEAD'));
    await adv(a, SYNC_DEBOUNCE_MS + 1);
    t.ok('入れないもの（node_modules・.git）の出来事では回さない', count(a, 'GET /v1/sync/state') === aState1);

    // ---- 設定の変更も 5 秒まとめで上げる
    a.changeSetting('colorish', 'green');
    a.changeSetting('machineOnly', 'machine-2');
    await adv(a, SYNC_DEBOUNCE_MS);
    t.ok('設定の変更で回して上げる', count(a, 'GET /v1/sync/state') === aState1 + 1);

    // ================= 10 分ごとに受ける =================
    const bState0 = count(b, 'GET /v1/sync/items');
    await adv(b, T0 + SYNC_RECEIVE_MS - 1 - b.clock.now());   // B を start したのは T0
    t.ok('B: 10 分たつまでは受けに行かない（5 分の見回りは鍵だけ）', count(b, 'GET /v1/sync/items') === bState0);
    await adv(b, 1);
    t.ok('B: 10 分ごとに受ける', count(b, 'GET /v1/sync/items') > bState0 && (await fs.readFile(b.skill('demo', 'extra2.md'), 'utf8').catch(() => '')) === 'two' && b.store.colorish === 'green');
    t.ok('B: sync: false の設定は変えても届かない', b.store.machineOnly === undefined);

    // ================= 同時に 1 本だけ =================
    a.resetInFlight();
    const s0 = count(a, 'GET /v1/sync/state');
    const p1 = a.engine.run(), p2 = a.engine.run(), p3 = a.engine.run();
    await Promise.all([p1, p2, p3]);
    t.ok('回っている間の呼び出しは同じ回を返し、終わったあとに 1 回だけまとめて回す', p1 === p2 && p2 === p3 && count(a, 'GET /v1/sync/state') - s0 === 2);
    t.ok('同時に api を呼ぶのは 1 本だけ', a.maxInFlight() === 1);

    // ================= 消すのが伝わる =================
    await fs.rm(a.skill('demo', 'extra.md'));
    a.emit(a.skill('demo', 'extra.md'));
    await adv(a, SYNC_DEBOUNCE_MS);
    const delPut = itemPuts().at(-1);
    t.ok('A: 消した項目を deleted: true で上げる', JSON.parse(delPut.body).deleted === true);
    await b.engine.run();
    t.ok('B: 消したのが届いてファイルが消える', !(await exists(b.skill('demo', 'extra.md'))) && (await exists(b.skill('demo', 'extra2.md'))));
    a.changeSetting('colorish', 'red');   // 既定に戻す → 項目は消える
    await adv(a, SYNC_DEBOUNCE_MS);
    await b.engine.run();
    t.ok('既定に戻した設定は、ほかの PC でも既定に戻る', b.store.colorish === 'red');

    // ================= 競合 =================
    const target = 'conflict.md';
    await put(a.skill('demo', target), 'base');
    await a.engine.run(); await b.engine.run();
    // 両方で変える。A が先に上げるが、B の方が新しい
    await put(a.skill('demo', target), 'from a (older)');
    await fs.utimes(a.skill('demo', target), new Date(T0 + 1000), new Date(T0 + 1000));
    await put(b.skill('demo', target), 'from b (newer)');
    await fs.utimes(b.skill('demo', target), new Date(T0 + 5000), new Date(T0 + 5000));
    await a.engine.run();
    await b.engine.run();
    t.ok('競合: mtime の新しい方（B）を採る', (await fs.readFile(b.skill('demo', target), 'utf8')) === 'from b (newer)');
    const conflictFiles = async h => (await fs.readdir(h.engine.conflictsDir, { recursive: true, withFileTypes: true }).catch(() => [])).filter(f => f.isFile());
    const bc = await conflictFiles(b);
    const bcContent = bc.length ? await fs.readFile(path.join(bc[0].parentPath ?? bc[0].path, bc[0].name), 'utf8') : '';
    t.ok('競合: 負けた方（A の版）を sync-conflicts/<日時>/<論理名> に写す', bc.length === 1 && bcContent === 'from a (older)'
      && path.relative(b.engine.conflictsDir, path.join(bc[0].parentPath ?? bc[0].path, bc[0].name)).split(path.sep).slice(1).join('/') === `skills/claude/demo/${target}`,
      JSON.stringify(bc.map(f => path.join(f.parentPath ?? f.path, f.name))));
    t.ok('競合: 状態に写しの数が出る', b.engine.status().conflicts === 1);
    await a.engine.run();
    t.ok('競合: 勝った版がもう一方にも届く', (await fs.readFile(a.skill('demo', target), 'utf8')) === 'from b (newer)');
    // 同じ mtime なら相手
    await put(a.skill('demo', target), 'tie a');
    await put(b.skill('demo', target), 'tie b');
    for (const h of [a, b]) await fs.utimes(h.skill('demo', target), new Date(T0 + 9000), new Date(T0 + 9000));
    await a.engine.run(); await b.engine.run();
    t.ok('競合: mtime が同じなら相手の版を採る', (await fs.readFile(b.skill('demo', target), 'utf8')) === 'tie a');

    // ---- 30 日を過ぎた写しは start のときに消す
    const pad = n => String(n).padStart(2, '0');
    const stamp = ms => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
    const now = b.clock.now();
    await put(path.join(b.engine.conflictsDir, stamp(now - CONFLICT_KEEP_MS - 60_000), 'skills', 'claude', 'old.md'), 'old');
    await put(path.join(b.engine.conflictsDir, stamp(now - CONFLICT_KEEP_MS + 60 * 60_000), 'skills', 'claude', 'young.md'), 'young');
    b.engine.stop();
    await b.engine.start();
    const left = (await fs.readdir(b.engine.conflictsDir)).sort();
    t.ok('30 日を過ぎた写しのフォルダーは start で消え、30 日以内のものは残る',
      !left.includes(stamp(now - CONFLICT_KEEP_MS - 60_000)) && left.includes(stamp(now - CONFLICT_KEEP_MS + 60 * 60_000)), left.join());

    // ================= 1MB を超える項目 =================
    await put(a.skill('demo', 'big.bin'), crypto.randomBytes(900 * 1024));   // ファイルは 1MB 以下でも、平文（JSON）は 1MB を超える
    const putsBig = itemPuts().length;
    await a.engine.run();
    t.ok('平文が 1MB を超える項目は api に送らず、ログに too large', itemPuts().length === putsBig && a.logs.some(l => l.startsWith('sync item too large')) && a.engine.status().state === 'idle');
    await fs.rm(a.skill('demo', 'big.bin'));
    // api の 413 too_large: 中身が変わるまで上げ直さない
    plus.state.syncItemLimit = 300;
    await put(a.skill('demo', 'medium.md'), 'm'.repeat(400));
    await a.engine.run();
    const putsMed = itemPuts().length;
    await a.engine.run();
    t.ok('413 too_large の項目は中身が変わるまで上げ直さない', itemPuts().length === putsMed && a.engine.status().state === 'idle');
    plus.state.syncItemLimit = null;
    await put(a.skill('demo', 'medium.md'), 'm'.repeat(401));
    await a.engine.run();
    t.ok('中身が変われば上げ直す', itemPuts().length === putsMed + 1 && JSON.parse(itemPuts().at(-1).body).deleted === false);

    // ================= 容量の上限と戻り =================
    plus.state.syncLimitBytes = ledger.totalBytes + 50;   // 作り物の小さい上限
    await put(a.skill('demo', 'quota.md'), 'q'.repeat(2000));
    await a.engine.run();
    t.ok('容量を超えると 413 sync_quota で状態は quota、limitBytes は api の返す値', a.engine.status().state === 'quota' && a.engine.status().limitBytes === ledger.totalBytes + 50,
      JSON.stringify(a.engine.status()));
    t.ok('容量の上限では、その項目は台帳に載らない', !Object.values(ledger.items).some(it => it.ciphertext && it.size > 2000));
    await fs.rm(a.skill('demo', 'extra2.md'));
    await a.engine.run();
    t.ok('容量の上限でも、消すのは上げる', JSON.parse(itemPuts().at(-1).body).deleted === true);
    plus.state.syncLimitBytes = LIMIT;
    await a.engine.run();
    t.ok('上限が空けば戻り、残っていた項目を上げる', a.engine.status().state === 'idle' && a.engine.status().limitBytes === LIMIT && JSON.parse(itemPuts().at(-1).body).deleted === false);
    await b.engine.run();
    t.ok('戻ったあとの項目はほかの PC に届く', (await fs.readFile(b.skill('demo', 'quota.md'), 'utf8').catch(() => '')) === 'q'.repeat(2000));

    // ================= 409 rev を受けたら、受けてから上げ直す =================
    await put(a.skill('demo', 'race.md'), 'r0');
    await a.engine.run(); await b.engine.run();
    await put(b.skill('demo', 'race.md'), 'r-b');
    await fs.utimes(b.skill('demo', 'race.md'), new Date(T0 + 20_000), new Date(T0 + 20_000));
    await b.engine.run();
    // A は B の版を知らずに上げる → 409 rev → 受ける → A の方が新しいので上げ直す
    await put(a.skill('demo', 'race.md'), 'r-a');
    await fs.utimes(a.skill('demo', 'race.md'), new Date(T0 + 30_000), new Date(T0 + 30_000));
    const raceBodies = plus.state.syncBodies.length, raceErrors = a.errors.length;
    // 受ける口を 1 回だけ空で返させ、A に B の版を知らないまま上げさせる
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/items$/, status: 200, extra: { items: [], cursor: 0, more: false } });
    await a.engine.run();
    const racePuts = plus.state.syncBodies.slice(raceBodies).filter(x => x.method === 'PUT' && x.path.startsWith('/v1/sync/items/'));
    t.ok('409 rev（current 付き）を受ける', a.errors.slice(raceErrors).some(e => e === 'PUT /v1/sync/items 409 conflict rev +current'), JSON.stringify(a.errors.slice(raceErrors)));
    t.ok('409 rev のあと、相手の版を受けて、新しい手元の版を上げ直す', (await fs.readFile(a.skill('demo', 'race.md'), 'utf8')) === 'r-a'
      && racePuts.length === 2 && JSON.parse(racePuts[1].body).baseRev === JSON.parse(racePuts[0].body).baseRev + 1, JSON.stringify(racePuts.map(x => x.body.slice(0, 40))));
    await b.engine.run();
    t.ok('上げ直した版がほかの PC に届く', (await fs.readFile(b.skill('demo', 'race.md'), 'utf8')) === 'r-a');
    plus.state.syncFail.length = 0;

    // ================= 誤りの扱い =================
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/items$/, status: 429, code: 'rate_limited', message: 'slow down', headers: { 'retry-after': '42' } });
    await a.engine.run();
    t.ok('429: 状態は error（rate_limited）', a.engine.status().state === 'error' && a.engine.status().error === 'rate_limited');
    const s429 = count(a, 'GET /v1/sync/state');
    await adv(a, 41_000);
    t.ok('429: Retry-After の秒数までは呼ばない', count(a, 'GET /v1/sync/state') === s429);
    await adv(a, 1_000);
    t.ok('429: Retry-After のあとにやり直して戻る', count(a, 'GET /v1/sync/state') === s429 + 1 && a.engine.status().state === 'idle');
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/items$/, status: 503, code: 'unavailable', message: 'down', count: 2 });
    await a.engine.run();
    const s503 = count(a, 'GET /v1/sync/state');
    await adv(a, 60_000);
    t.ok('503: 1 分あとにやり直す', count(a, 'GET /v1/sync/state') === s503 + 1 && a.engine.status().state === 'error');
    await adv(a, 2 * 60_000 - 1);
    t.ok('503 が続くと間を倍にする（2 分）', count(a, 'GET /v1/sync/state') === s503 + 1);
    await adv(a, 1);
    t.ok('間をおいたやり直しで戻る', count(a, 'GET /v1/sync/state') === s503 + 2 && a.engine.status().state === 'idle');

    // ================= 同期を切る =================
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/items$/, status: 403, code: 'forbidden', message: 'sync_disabled' });
    await b.engine.run();
    t.ok('403 sync_disabled は disabled（誤りにしない）', b.engine.status().state === 'disabled' && b.engine.status().error === null);
    plus.state.accounts[UID].sync = { enabled: false };
    const putsOff = itemPuts().length;
    await put(a.skill('demo', 'while-off.md'), 'off');
    await a.engine.run();
    t.ok('アカウントの同期が切れていると disabled で、何も上げない', a.engine.status().state === 'disabled' && itemPuts().length === putsOff);
    plus.state.accounts[UID].sync = {};
    await a.engine.run();
    t.ok('入れ直すと上げる', a.engine.status().state === 'idle' && itemPuts().length === putsOff + 1);

    // ---- 401 は止める
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/state$/, status: 401, code: 'unauthenticated', message: 'no', count: 5 });
    await b.engine.run();
    const b401 = count(b, 'GET /v1/sync/state');
    await adv(b, SYNC_RECEIVE_MS * 2);
    t.ok('401 は止める（error・やり直さない・見回りもしない）', b.engine.status().state === 'error' && count(b, 'GET /v1/sync/state') === b401);
    plus.state.syncFail.length = 0;

    // ================= やり直す（新しい鍵）=================
    const oldKeyId = ledger.keyId;
    a.engine.stop(); await a.engine.start();
    await a.engine.reset();
    const fresh = plus.state.sync[UID];
    t.ok('やり直すと新しい鍵で手元の全部を上げ直す', fresh.keyId !== oldKeyId && a.engine.status().state === 'idle' && Object.keys(fresh.items).length > 0
      && Object.values(fresh.items).every(it => it.keyId === fresh.keyId));
    b.engine.stop(); await b.engine.start();
    t.ok('やり直した PC が新しい鍵を渡し、ほかの PC は新しい鍵で受け直す', b.engine.status().state === 'idle' && (await b.secrets.get(SYNC_ACCOUNT_KEY))?.keyId === fresh.keyId
      && (await fs.readFile(b.skill('demo', 'SKILL.md'))).equals(crlfBom), JSON.stringify({ s: b.engine.status(), logs: b.logs.slice(-5) }));

    // ---- 止める
    a.engine.stop();
    t.ok('stop で off・タイマーも watch も残らない', a.engine.status().state === 'off' && a.clock.pending() === 0 && a.engine.watching().length === 0);

    // ================= アカウントの停止と再開（index.mjs の update()）=================
    // A の置き場と鍵のまま、セッションと登録を差し替えて createPlusSync から回す。人の操作（今すぐ同期・起動し直し）はしない
    const clockS = fakeClock(a.clock.now());
    const callsS = [];
    let readAt = 1;
    let snap = { signedIn: true, account: { uid: UID, status: 'plus' }, accountReadAt: readAt };
    const readAccount = status => { readAt += 1; snap = { ...snap, account: { ...snap.account, status }, accountReadAt: readAt }; };
    const baseS = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' });
    let inFlightS = 0;
    const hs = { clock: clockS, activity: { inFlight: () => inFlightS, last: 0 } };
    const clientS = {
      async request(m, p, o) {
        callsS.push(`${m} ${p.split('?')[0]}`);
        inFlightS++; hs.activity.last = performance.now();
        try { return await baseS.request(m, p, o); } finally { inFlightS--; hs.activity.last = performance.now(); }
      },
    };
    const sync = createPlusSync({
      session: { client: clientS, snapshot: () => snap },
      host: () => ({ state: 'registered', hostId: a.hostId }), secrets: a.secrets, dataDir: a.dataDir, home: a.home, env: {},
      clock: clockS, watch: () => ({ close() {}, on() {} }),
    });
    engines.push(sync.engine);
    const countS = what => callsS.filter(c => c === what).length;
    await sync.update();
    t.ok('停止の前: update() で回して idle', sync.getSyncStatus().state === 'idle', JSON.stringify(sync.getSyncStatus()));

    // 10 分ごとの受け取りで 403 account_disabled
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/state$/, status: 403, code: 'account_disabled', message: 'disabled', count: 100 });
    await adv(hs, SYNC_RECEIVE_MS);
    const stopped = sync.getSyncStatus();
    t.ok('403 account_disabled: error ではなく stopped（理由は account_disabled）', stopped.state === 'stopped' && stopped.error === 'account_disabled', JSON.stringify(stopped));
    t.ok('403 account_disabled: タイマーを残さない（受け取りも鍵の受け渡しも張り直さない）', clockS.pending() === 0, String(clockS.pending()));
    const stoppedState = countS('GET /v1/sync/state');
    readAccount('disabled');
    await sync.update();
    await adv(hs, SYNC_RECEIVE_MS * 2);
    t.ok('停止の間（disabled と読めている）: api を呼ばず、stopped のまま', countS('GET /v1/sync/state') === stoppedState && sync.getSyncStatus().state === 'stopped');

    // 再開: アカウントを plus と読み直して update() → 1 回回って idle（error が残らない）
    plus.state.syncFail.length = 0;
    readAccount('plus');
    await sync.update();
    t.ok('再開: plus と読めた update() で 1 回回って idle', sync.getSyncStatus().state === 'idle' && sync.getSyncStatus().error === null && countS('GET /v1/sync/state') === stoppedState + 1,
      JSON.stringify({ s: sync.getSyncStatus(), n: countS('GET /v1/sync/state') - stoppedState }));
    const itemsBefore = countS('GET /v1/sync/items');
    await adv(hs, SYNC_RECEIVE_MS);
    t.ok('再開: 10 分たつと受け取りが走る（タイマーを張り直している）', countS('GET /v1/sync/items') === itemsBefore + 1 && sync.getSyncStatus().state === 'idle',
      JSON.stringify({ n: countS('GET /v1/sync/items') - itemsBefore, s: sync.getSyncStatus() }));

    // セッションがまだ plus と読んでいる間に api が not_plus を返した: 新しく plus と読めるまで回さない
    plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/state$/, status: 403, code: 'not_plus', message: 'not plus', count: 100 });
    await adv(hs, SYNC_RECEIVE_MS);
    t.ok('403 not_plus: stopped（理由は not_plus）', sync.getSyncStatus().state === 'stopped' && sync.getSyncStatus().error === 'not_plus', JSON.stringify(sync.getSyncStatus()));
    plus.state.syncFail.length = 0;
    const notPlusState = countS('GET /v1/sync/state');
    await sync.update();
    t.ok('not_plus のあと、アカウントを読み直さないままの update() では回さない', countS('GET /v1/sync/state') === notPlusState && sync.getSyncStatus().state === 'stopped');
    readAccount('plus');
    await sync.update();
    t.ok('not_plus のあと、plus と読み直した update() で回して idle', sync.getSyncStatus().state === 'idle' && countS('GET /v1/sync/state') === notPlusState + 1);
    sync.stop();

    // ================= 鍵を持つ PC が外れた（運営の画面）→ 新しい PC は消さずに待つ → 外れた PC が登録し直す =================
    const a2 = await makeHost('a2', { uid: UID2 });
    await put(a2.skill('mine-a2', 'SKILL.md'), 'skill on a2\n');
    await put(a2.claudeMd, 'instructions on a2\n');
    a2.store.colorish = 'blue';
    await a2.engine.start();
    const l2 = plus.state.sync[UID2];
    const key1 = l2.keyId;
    const live = () => Object.values(l2.items).filter(it => it.deleted !== true).length;
    const items1 = live();
    t.ok('外れの前: A2 が鍵を作って項目を上げる', a2.engine.status().state === 'idle' && Boolean(key1) && items1 >= 3, JSON.stringify({ s: a2.engine.status(), items1 }));
    const a2Row = { ...plus.state.hosts[a2.hostId] };
    plus.unbindHost(a2.hostId, 'admin');
    const c2 = await makeHost('c2', { uid: UID2 });
    await put(c2.skill('mine-c2', 'SKILL.md'), 'skill on c2\n');
    c2.store.colorish = 'pink';
    const resets2 = plus.state.syncBodies.filter(x => x.path === '/v1/sync/reset').length;
    await c2.engine.start();
    const c2Wait = c2.engine.status();
    t.ok('鍵を持つ PC が外れても、データがあれば新しい PC は始め直さずに待つ（reset を送らない・項目と keyId はそのまま）',
      c2Wait.state === 'waiting_key' && plus.state.syncBodies.filter(x => x.path === '/v1/sync/reset').length === resets2 && l2.keyId === key1 && live() === items1,
      JSON.stringify(c2Wait));
    t.ok('待つ間の状態の wait: 鍵を持つ PC は外れている（holder: false）・件数はサーバーの項目の数',
      c2Wait.wait?.holder === false && c2Wait.wait.itemCount === items1 && c2Wait.wait.holders.some(h => h.hostId === a2.hostId && h.registered === false), JSON.stringify(c2Wait.wait));
    const c2Reset = await c2.engine.reset();
    t.ok('確かめ無しの「やり直す」は confirmNeeded を返し、何も消えない',
      c2Reset.confirmNeeded === true && c2Reset.status.state === 'waiting_key' && c2Reset.status.wait?.itemCount === items1 && l2.keyId === key1 && live() === items1, JSON.stringify(c2Reset));
    // 外れた A2: 403 host → unregistered で止まり、上へ 1 回だけ知らせる
    await put(a2.skill('mine-a2', 'more.md'), 'while removed\n');
    await a2.engine.run();
    t.ok('外れた PC は 403 host で unregistered（error にしない・やり直しのタイマーを残さない）',
      a2.engine.status().state === 'unregistered' && a2.engine.status().error === null && a2.clock.pending() === 0, JSON.stringify(a2.engine.status()));
    t.ok('403 host で onHostLost を 1 回呼ぶ', a2.hostLost() === 1);
    await a2.engine.start();
    t.ok('外れたままもう一度回しても、onHostLost は呼び直さない', a2.engine.status().state === 'unregistered' && a2.hostLost() === 1, JSON.stringify({ s: a2.engine.status(), n: a2.hostLost(), logs: a2.logs.slice(-4) }));
    // 登録し直す（PUT /v1/hosts が鍵の行の detachedAt を外す。登録の側の動きは plus-hosts で確かめる）
    plus.state.hosts[a2.hostId] = a2Row;
    l2.keys[a2.hostId].detachedAt = null;
    delete plus.state.hostsRemoved[a2.hostId];
    await a2.engine.start();
    t.ok('登録し直した A2 は、元の鍵のまま回り直す（作り直さない）', a2.engine.status().state === 'idle' && l2.keyId === key1 && (await a2.secrets.get(SYNC_ACCOUNT_KEY))?.keyId === key1);
    t.ok('登録し直した A2 が C2 に鍵を渡す', l2.keys[c2.hostId]?.wrappedBy === a2.hostId && l2.keys[c2.hostId].keyId === key1);
    t.ok('鍵を渡した PC の状態の sharedTo に、渡した先（名前つき）が載る',
      a2.engine.status().sharedTo.length === 1 && a2.engine.status().sharedTo[0].hostId === c2.hostId && a2.engine.status().sharedTo[0].name === 'c2', JSON.stringify(a2.engine.status().sharedTo));
    await c2.engine.run();
    t.ok('C2 は鍵を受けて、A2 の項目を受ける', c2.engine.status().state === 'idle' && c2.engine.status().wait === null
      && (await fs.readFile(c2.skill('mine-a2', 'more.md'), 'utf8').catch(() => '')) === 'while removed\n');
    t.ok('初めて加わる PC は、アカウントの設定を採る（手元の pink ではなく blue）', c2.store.colorish === 'blue');
    t.ok('どの PC の手元のファイルも消えない', await exists(a2.skill('mine-a2', 'SKILL.md')) && await exists(c2.skill('mine-c2', 'SKILL.md')));
    await a2.engine.run();
    t.ok('C2 の手元にあったものも A2 に届く', (await fs.readFile(a2.skill('mine-c2', 'SKILL.md'), 'utf8').catch(() => '')) === 'skill on c2\n');

    // ================= 始め直したあと、鍵を受けた PC の設定が負けない =================
    // A2 を止めた（PC を落とした）間に、A2 の設定を変える。C2 が同期をやり直す（鍵を持つので確かめは要らない）
    a2.engine.stop();
    a2.store.colorish = 'green';
    const c2Reset2 = await c2.engine.reset();
    const key2 = plus.state.sync[UID2].keyId;
    t.ok('鍵を持つ PC の「やり直す」は確かめ無しで作り直す', c2Reset2.confirmNeeded === false && key2 !== key1 && c2.engine.status().state === 'idle', JSON.stringify(c2Reset2));
    // A2 を起動し直す（C2 より後の時刻）。新しい鍵を受けて、覚えを空にしてから受ける
    await a2.clock.advance(c2.clock.now() - a2.clock.now() + 60_000);
    await a2.engine.start();
    t.ok('起動し直した A2 は新しい鍵で idle', a2.engine.status().state === 'idle' && (await a2.secrets.get(SYNC_ACCOUNT_KEY))?.keyId === key2, JSON.stringify(a2.engine.status()));
    t.ok('鍵が替わったあと、手元で変えていた設定は、始め直した PC の「初めて上げた設定」に負けない', a2.store.colorish === 'green');
    const a2Local = JSON.parse(await fs.readFile(a2.engine.stateFile, 'utf8'));
    t.ok('手元の覚えに rejoinedAt（鍵が替わった時刻）が残る（起動し直しても使う）', a2Local.keyId === key2 && a2Local.rejoinedAt === a2.clock.now(), JSON.stringify({ k: a2Local.keyId === key2, r: a2Local.rejoinedAt }));
    t.ok('鍵を渡した先（sharedTo）は起動し直しても、鍵が替わっても残る', a2.engine.status().sharedTo.some(s => s.hostId === c2.hostId));
    await c2.engine.run();
    t.ok('勝った A2 の設定が C2 に届く', c2.store.colorish === 'green');
  } finally {
    for (const e of engines) e.stop();
    await plus.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
