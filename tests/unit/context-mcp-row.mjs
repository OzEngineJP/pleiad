// 外部 MCP の行のスイッチ（ADR 0337 §決定 4 の 2026-11-17 改訂・承認済みの ToBe-A′）:
//   鍵つきでオンのマスが残る行でも押せる。押すと、鍵の無いオンだけをまとめて 1 度の保存でオフにし、鍵つきは残る。もう一度押すと外す前の組に戻る。
//   オフにする前の組は context-mcp-was.json（設定の外。旧い版は知らない）に置く。ここでは集計・押した結果・保存の形・記録の読み書きを固定する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMcpMatrix, mcpRowMeta, planMcpRowPress } from '../../core/context-mcp-matrix.mjs';
import {
  createMcpWas, emptyMcpWas, MCP_WAS_FILE, MCP_WAS_MAX_NAMES, MCP_WAS_MAX_PLACES, MCP_WAS_MAX_AGENTS, MCP_WAS_MAX_BROKEN, normalizeMcpWas,
} from '../../core/context-mcp-was.mjs';
import { DEFAULT_SCAN, legacyPlan, normalizeKind } from '../../core/context-settings.mjs';
import { setMcpOffLinker } from '../../core/backends/mcp-off-home.mjs';
import { contextOps } from '../../core/ops/context.mjs';

export const name = 'context-mcp-row';
export const title = '外部 MCP の行のスイッチ: 鍵つきでオンが残る行も押せる・戻し先の記録（設定の外）・1 度の保存・アイコンとの整合';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-row-'));
  try {
    setMcpOffLinker(() => {}); // リンクを作れる PC として数える
    const op = id => contextOps.find(o => o.id === id);
    const ALL = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
    const T = { state: 'on', mode: 'toggle' }, F = { state: 'off', mode: 'toggle' }, L = { state: 'on', mode: 'locked', reason: 'own' }, N = { state: 'off', mode: 'none' };

    // ---- 集計（mcpRowMeta）と押した結果（planMcpRowPress）。マスは { state, mode }
    const row = (cells, extra = {}) => ({ key: 'k', name: 'k', group: 'ply', origins: [], cells: Object.fromEntries(ALL.map(a => [a, cells[a] ?? N])), ...extra });
    const allOn = row({ claude: T, codex: T, opencode: T });
    const m1 = mcpRowMeta(allOn, ALL);
    t.ok('全部オン: 横棒ではなくオン。鍵つきなし。押すと向きはオフ', !m1.rowMixed && m1.rowSwitchOn && !m1.rowFixed && m1.rowChangeableOn && m1.rowNextOn === false && !m1.rowLocked, m1);
    const part = row({ claude: T, codex: F, opencode: L });
    const m2 = mcpRowMeta(part, ALL);
    t.ok('一部オン＋鍵つき: 横棒（一部オン）・鍵つきが残る・押せる（向きはオフ）', m2.rowMixed && m2.rowFixed && m2.rowChangeableOn && m2.rowNextOn === false && !m2.rowLocked, m2);
    const p2 = planMcpRowPress(part, ALL, null, false);
    t.ok('押す（オフ）: 鍵の無いオン（claude）だけをオフにする。鍵つき（opencode）・もともとオフ（codex）は変えない', p2.changes.map(c => `${c.agent}:${c.on}`).join() === 'claude:false' && p2.was.join() === 'claude', p2);
    const lockOnly = row({ claude: F, codex: F, opencode: L }, { group: 'agent', origins: ['opencode'] });
    const m3 = mcpRowMeta(lockOnly, ALL);
    t.ok('鍵つきでオンだけ残る行（戻し先なし・自分の設定の名前）: 横棒＋鍵・押せない（他のエージェントへ新しく広げない）', m3.rowMixed && m3.rowFixed && !m3.rowChangeableOn && m3.rowLocked && m3.rowRestore === null, m3);
    t.ok('押せない行を押そうとしても保存しない（refused）', planMcpRowPress(lockOnly, ALL, null, true).refused === true);
    const m4 = mcpRowMeta(lockOnly, ALL, ['claude', 'codex']);
    t.ok('鍵つきだけ残る行に、外す前の組の記録があれば押せる（戻し先は記録）', !m4.rowLocked && m4.rowRestore === 'was' && m4.restoreAgents.join() === 'claude,codex', m4);
    const p4 = planMcpRowPress(lockOnly, ALL, ['claude', 'codex'], true);
    t.ok('戻す: 記録の組の鍵の無いマスだけをオンにする（鍵つき・使えないマスは触らない）', p4.changes.map(c => `${c.agent}:${c.on}`).join() === 'claude:true,codex:true' && p4.source === 'was', p4);
    const p4b = planMcpRowPress(lockOnly, ALL, ['claude', 'opencode', 'devin'], true);
    t.ok('記録に今は鍵つき・使えなくなったマスがあっても、触らない（鍵の無いマスだけ）', p4b.changes.map(c => c.agent).join() === 'claude', p4b);
    const off = row({ claude: F, codex: F, opencode: F }, { group: 'ply' });
    t.ok('全部オフ（Pleiad の登録）・記録なし: 既定（鍵の無いマスすべて）へ戻す', planMcpRowPress(off, ALL, null, true).changes.map(c => c.agent).join() === 'claude,codex,opencode' && planMcpRowPress(off, ALL, null, true).source === 'default');
    const offAgent = row({ claude: F, codex: F, opencode: F }, { group: 'agent', origins: ['codex'] });
    const pa = planMcpRowPress(offAgent, ALL, null, true);
    t.ok('全部オフ（エージェントの設定の名前）・記録なし: 持っているエージェントだけ（他へ広げない）', pa.changes.map(c => c.agent).join() === 'codex' && pa.source === 'default', pa);
    t.ok('全部オフ・記録あり: 記録の組へ戻す（既定より優先）', planMcpRowPress(offAgent, ALL, ['claude'], true).changes.map(c => c.agent).join() === 'claude');
    const mixed = row({ claude: T, codex: F, opencode: L });
    t.ok('鍵の無いオンがある行にオンの向きを送っても変えない（広げない・古い画面の押し直し）', planMcpRowPress(mixed, ALL, ['codex'], true).noop === true);
    t.ok('鍵の無いオンが無い行にオフの向きを送っても変えない（何もしない）', planMcpRowPress(lockOnly, ALL, null, false).noop === true);
    const none = row({});
    t.ok('押せるマスも鍵つきでオンも無い行: 押せない', mcpRowMeta(none, ALL).rowLocked && !mcpRowMeta(none, ALL).rowSwitchOn);
    const blocked = row({ claude: T, codex: { state: 'off', mode: 'blocked', reason: 'relay' } });
    const mb = mcpRowMeta(blocked, ALL);
    t.ok('使えない（blocked）・鍵つきのオフは数えない: 鍵の無いオンだけなら「オン」（横棒にしない）', !mb.rowMixed && mb.rowSwitchOn && !mb.rowFixed, mb);

    // ---- 一覧（buildMcpMatrix）の行に集計が付き、記録が戻し先に効く
    const kind = { owner: 'ply', agents: { off: {}, spread: {} } };
    const native = { claude: [{ name: 'cl', transport: 'stdio' }], codex: [], antigravity: [{ name: 'ag', transport: 'stdio' }], opencode: [], devin: [], grok: [] };
    const base = { kind, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, registered: [{ name: 'reg', transport: 'stdio' }], native };
    const mat = buildMcpMatrix(base);
    const reg = mat.rows.find(r => r.key === 'reg'), ag = mat.rows.find(r => r.key === 'ag');
    t.ok('一覧の行に rowMixed・rowFixed・rowChangeableOn・rowNextOn・rowRestore・rowLocked が付く', ['rowMixed', 'rowFixed', 'rowChangeableOn', 'rowNextOn', 'rowRestore', 'rowLocked'].every(k => k in reg), Object.keys(reg));
    t.ok('Pleiad の登録の行（全部オン）: 押せる・向きはオフ', reg.rowChangeableOn && reg.rowNextOn === false && !reg.rowLocked, reg);
    t.ok('Antigravity だけが持つ名前（鍵つきでオン）: 他のエージェントは広げていないのでオフ＝横棒＋鍵・押せない', ag.rowFixed && !ag.rowChangeableOn && ag.rowLocked && ag.rowMixed, ag);
    const withWas = buildMcpMatrix({ ...base, restore: { ag: ['claude'] } }).rows.find(r => r.key === 'ag');
    t.ok('記録があれば、押せる（戻し先は記録）', !withWas.rowLocked && withWas.rowRestore === 'was', withWas);

    // ---- 記録のファイル（設定の外）
    const dataDir = path.join(tmp, 'data');
    const was = createMcpWas(dataDir);
    t.ok('記録が無ければ空', JSON.stringify(await was.get(null)) === '{}');
    await was.set(null, 'reg', ['codex', 'claude', 'claude']);
    await was.set('/work/place', 'x', ['grok']);
    t.ok('全体と場所ごとに別々に覚える（エージェントは重複なし・昇順）', (await was.get(null)).reg.join() === 'claude,codex' && (await was.get('/work/place')).x.join() === 'grok' && !('x' in await was.get(null)));
    const saved1 = JSON.parse(await fs.readFile(path.join(dataDir, MCP_WAS_FILE), 'utf8'));
    t.ok('ファイルの形: { version: 1, places: { <場所のキー。全体は *>: { <名前>: [エージェント] } } }', saved1.version === 1 && saved1.places['*'].reg.join() === 'claude,codex' && Object.keys(saved1).join() === 'version,places', saved1);
    await was.set(null, 'reg', null);
    t.ok('null・空で消す。空になった場所は消える', !('reg' in await was.get(null)) && !('*' in JSON.parse(await fs.readFile(path.join(dataDir, MCP_WAS_FILE), 'utf8')).places));
    const brokenFiles = async () => (await fs.readdir(dataDir)).filter((f) => /^context-mcp-was\.broken-.+\.json$/.test(f)).sort();
    await fs.writeFile(path.join(dataDir, MCP_WAS_FILE), '{ broken');
    t.ok('壊れたファイルは空として読む（設定は無事で、戻し先が既定になるだけ）。読むだけでは動かさない', JSON.stringify(await was.get(null)) === '{}' && (await brokenFiles()).length === 0);
    await was.set(null, 'a', ['claude']);
    const brokenA = await brokenFiles();
    t.ok('次に書くとき、壊れた物は context-mcp-was.broken-<時刻>.json へ退避してから作り直す（消さない）',
      (await was.get(null)).a.join() === 'claude' && brokenA.length === 1 && await fs.readFile(path.join(dataDir, brokenA[0]), 'utf8') === '{ broken', brokenA);
    await fs.writeFile(path.join(dataDir, MCP_WAS_FILE), JSON.stringify({ version: 9, places: { '*': { a: ['claude'] } } }));
    t.ok('知らない版は空として読む', JSON.stringify(await was.get(null)) === '{}');
    await was.set(null, 'b', ['codex']);
    const brokenB = (await brokenFiles()).filter((f) => !brokenA.includes(f));
    t.ok('知らない版も、書くときは退避してから作り直す（新しい版の覚えを黙って消さない）',
      brokenB.length === 1 && JSON.parse(await fs.readFile(path.join(dataDir, brokenB[0]), 'utf8')).version === 9 && (await was.get(null)).b.join() === 'codex' && !('a' in await was.get(null)), brokenB);
    // 退避は MCP_WAS_MAX_BROKEN 個まで（古い物から消す。置き場を際限なく増やさない）
    for (let i = 0; i < MCP_WAS_MAX_BROKEN + 2; i++) {
      await fs.writeFile(path.join(dataDir, MCP_WAS_FILE), `{ broken ${i}`);
      await was.set(null, `r${i}`, ['claude']);
    }
    const brokenAll = await brokenFiles();
    const newestBroken = await fs.readFile(path.join(dataDir, brokenAll.at(-1)), 'utf8').catch(() => '');
    t.ok('退避した読めないファイルは MCP_WAS_MAX_BROKEN 個まで（今退避した物は必ず残る）', brokenAll.length === MCP_WAS_MAX_BROKEN && newestBroken.startsWith('{ broken'), brokenAll);

    // 読み込みの失敗（ENOENT・壊れ・形の違い以外）は空として読まない。次の set で 1 件だけのファイルに上書きして、ほかの覚えを全部消さないため
    await fs.writeFile(path.join(dataDir, MCP_WAS_FILE), JSON.stringify({ version: 1, places: { '*': { keep1: ['claude'], keep2: ['codex'] } } }));
    const realRead = fs.readFile;
    const failWith = async (code, run) => {
      fs.readFile = async (p, ...rest) => {
        if (String(p).endsWith(MCP_WAS_FILE)) throw Object.assign(new Error(`${code}: fake`), { code });
        return realRead.call(fs, p, ...rest);
      };
      try { return await run(); } finally { fs.readFile = realRead; }
    };
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EIO']) {
      const getErr = await failWith(code, () => was.get(null).then(() => null, (e) => e));
      const setErr = await failWith(code, () => was.set(null, 'new', ['grok']).then(() => null, (e) => e));
      const after = JSON.parse(await fs.readFile(path.join(dataDir, MCP_WAS_FILE), 'utf8'));
      t.ok(`読み込みが ${code} で失敗したら、get も set も投げる。ファイルは上書きされず、ほかの覚えが残る`,
        getErr?.code === code && setErr?.code === code && Object.keys(after.places['*']).sort().join() === 'keep1,keep2', JSON.stringify({ getErr: getErr?.code, setErr: setErr?.code, after }));
    }
    t.ok('失敗のあとの set は、直列の待ちを詰まらせず次の set が通る', (await was.set(null, 'ok', ['claude']), (await was.get(null)).ok.join() === 'claude' && 'keep1' in await was.get(null)));
    // 呼ぶ側（context.setMcpRow の rememberMcpRow）は覚えの失敗を握る: 操作は成功し、覚えだけが書かれない（下の setMcpRow の試験の前に、握る形を固定する）
    const dirOnly = path.join(tmp, 'was-dir');
    await fs.mkdir(path.join(dirOnly, MCP_WAS_FILE), { recursive: true });
    const wasDir = createMcpWas(dirOnly);
    const dirErr = await wasDir.set(null, 'x', ['claude']).then(() => null, (e) => e);
    t.ok('ファイルの場所がディレクトリ（EISDIR）など、読めない失敗でも投げる（空にして上書きを試みない）', dirErr?.code === 'EISDIR' && (await fs.stat(path.join(dirOnly, MCP_WAS_FILE))).isDirectory(), dirErr?.code);

    // 上限と直列化
    const manyPlaces = emptyMcpWas();
    for (let i = 0; i < MCP_WAS_MAX_PLACES + 30; i++) manyPlaces.places[`/p/${i}`] = { n: ['claude'] };
    const cappedPlaces = normalizeMcpWas(manyPlaces);
    t.ok('場所の数に上限がある（200。先に入れた物から外す）',
      MCP_WAS_MAX_PLACES === 200 && Object.keys(cappedPlaces.places).length === MCP_WAS_MAX_PLACES && !('/p/0' in cappedPlaces.places) && `/p/${MCP_WAS_MAX_PLACES + 29}` in cappedPlaces.places);
    const manyAgents = normalizeMcpWas({ version: 1, places: { '*': { n: Array.from({ length: MCP_WAS_MAX_AGENTS + 10 }, (_, i) => `agent${String(i).padStart(2, '0')}`) } } });
    t.ok('1 つの名前のエージェントの数に上限がある（24）', MCP_WAS_MAX_AGENTS === 24 && manyAgents.places['*'].n.length === MCP_WAS_MAX_AGENTS, manyAgents.places['*'].n.length);
    const serialDir = path.join(tmp, 'was-serial');
    const wasSerial = createMcpWas(serialDir);
    await Promise.all(Array.from({ length: 30 }, (_, i) => wasSerial.set(i % 2 ? `/place/${i % 5}` : null, `n${i}`, ['claude', 'codex'])));
    const serialSaved = JSON.parse(await fs.readFile(path.join(serialDir, MCP_WAS_FILE), 'utf8'));
    const serialNames = Object.values(serialSaved.places).flatMap((o) => Object.keys(o));
    t.ok('set を並行に呼んでも直列に書く（どれも失われず、ファイルは常に完結した JSON）', serialNames.length === 30 && new Set(serialNames).size === 30, serialNames.length);
    // 先に失敗した set があっても、続けて呼んだ set は書かれる（直列の鎖が切れない）。1 つ目は読み込みの失敗で投げる
    const chainDir = path.join(tmp, 'was-chain');
    const wasChain = createMcpWas(chainDir);
    await wasChain.set(null, 'seed', ['claude']);
    const chainResults = await failWith('EBUSY', () => Promise.allSettled([wasChain.set(null, 'a', ['claude'])]));
    const chainSecond = await wasChain.set(null, 'b', ['codex']).then(() => 'ok', () => 'ng');
    t.ok('直列の鎖: 失敗した set の後ろに続けて呼んだ set も書かれ、前の覚えは残る',
      chainResults[0].status === 'rejected' && chainSecond === 'ok' && Object.keys(await wasChain.get(null)).sort().join() === 'b,seed');
    const big = { version: 1, places: { '*': Object.fromEntries(Array.from({ length: MCP_WAS_MAX_NAMES + 20 }, (_, i) => [`n${i}`, ['claude']])) } };
    const capped = normalizeMcpWas(big);
    t.ok('名前の数に上限がある（先に入れた物から外す）', Object.keys(capped.places['*']).length === MCP_WAS_MAX_NAMES && !('n0' in capped.places['*']) && `n${MCP_WAS_MAX_NAMES + 19}` in capped.places['*']);
    t.ok('空の記録の形', JSON.stringify(emptyMcpWas()) === '{"version":1,"places":{}}');
    // 旧い版: 設定（context-scans.json の kinds.mcp）には何も足さない。保存する agents は { off, spread } のまま、旧い検査（strict）を通る
    const scope = sources => ({ ...DEFAULT_SCAN, sources });
    void legacyPlan(scope(['claude']), scope(['claude']));

    // ---- 操作 context.setMcpRow（実際の ctx の形で）。保存は 1 度、記録は設定の外
    const saves = [];
    const store = createMcpWas(path.join(tmp, 'ctx-data'));
    let kindValue = { owner: 'native', user: null, directory: null, agents: { off: {}, spread: {} } };
    const nat = {
      claude: [{ name: 'cl', transport: 'stdio' }, { name: 'shared', transport: 'stdio' }],
      codex: [{ name: 'shared', transport: 'stdio' }],
      antigravity: [{ name: 'shared', transport: 'stdio' }], // 止める手が無い（鍵つきでオン）
      opencode: [], devin: [], grok: [],
    };
    const ctxOf = () => ({
      actor: { kind: 'human' },
      context: {
        view: async () => ({ defaults: { kinds: { instruction: { value: { owner: 'native' } }, skill: { value: { owner: 'native' } }, mcp: { value: kindValue } } }, places: [] }),
        agentMcp: async () => ({ agents: nat }),
        claudeExtras: async () => ({ plugins: [], connectors: [], reading: false, readFailed: false }),
        set: async args => { saves.push(structuredClone(args)); kindValue = structuredClone(args.value); return { defaults: {} }; },
        mcpRestore: store,
      },
      mcp: { list: async () => ({ servers: [] }) },
    });
    const ctx = ctxOf();
    const rowOf = async key => (await op('context.mcpMatrix').handler(ctx, {})).rows.find(r => r.key === key);
    const press = (key, on) => op('context.setMcpRow').handler(ctx, { name: key, on }).then(r => r, e => e);
    const cellsOf = async key => Object.fromEntries(Object.entries((await rowOf(key)).cells).filter(([, c]) => c.state === 'on').map(([a, c]) => [a, `${c.state}/${c.mode}`]));
    const before = await rowOf('shared');
    t.ok('操作の前: shared は claude・codex が鍵の無いオン、antigravity が鍵つきでオン（横棒でなくオン・鍵つきあり）', before.cells.claude.state === 'on' && before.cells.codex.state === 'on' && before.cells.antigravity.mode === 'locked' && before.rowFixed && before.rowChangeableOn && before.rowNextOn === false, before);
    const r1 = await press('shared', false);
    t.ok('オフ: 保存は 1 度だけ・成功', r1.ok === true && saves.length === 1 && r1.changed.sort().join() === 'claude,codex', { r1, n: saves.length });
    t.ok('オフ: 保存した agents.off は鍵の無いオンだけ（claude・codex）。鍵つき（antigravity）は書かない', saves[0].value.agents.off.shared.join() === 'claude,codex', saves[0].value);
    t.ok('オフ: 保存した設定は旧い検査（kinds.mcp の strict）を通る（新しい項目を足していない）', (() => { try { normalizeKind('mcp', saves[0].value, tmp, tmp); return true; } catch { return false; } })());
    const after = await rowOf('shared');
    t.ok('オフの後: 鍵つきのオンだけ残る＝横棒＋鍵・向きはオン（戻す）・押せる（記録があるため）', after.rowMixed && after.rowFixed && !after.rowChangeableOn && after.rowNextOn === true && !after.rowLocked && after.rowRestore === 'was' && after.cells.antigravity.state === 'on', after);
    t.ok('記録は設定の外: 外す前の組（claude・codex）が覚えてある', (await store.get(null)).shared.join() === 'claude,codex');
    const r2 = await press('shared', true);
    t.ok('もう一度押す（オン）: 外す前の組（claude・codex）へ戻す。保存は 1 度・記録は消える', r2.ok === true && saves.length === 2 && r2.source === 'was' && r2.changed.sort().join() === 'claude,codex' && !('shared' in await store.get(null)) && !('shared' in (saves[1].value.agents.off ?? {})), { r2, saves: saves.length });
    t.ok('戻した後は元の組（オンのマスだけ見る。他のエージェントの列はオフのまま）', JSON.stringify(await cellsOf('shared')) === JSON.stringify({ claude: 'on/toggle', codex: 'on/toggle', antigravity: 'on/locked' }), await cellsOf('shared'));
    // アイコンとの整合: 外した後に 1 つだけオンにして、また外す
    await press('shared', false);
    await op('context.setMcpAgent').handler(ctx, { name: 'shared', agent: 'codex', on: true });
    t.ok('外した後にアイコンを 1 つオン: 古い記録は消える（次に外すときに作り直す）', !('shared' in await store.get(null)));
    const nSaves0 = saves.length;
    const r3 = await press('shared', true);
    t.ok('鍵の無いオンがある行にオンの向きを送っても何も変えない（広げない）。保存しない', r3.ok === true && r3.changed.length === 0 && saves.length === nSaves0, r3);
    const nSaves = saves.length;
    await press('shared', false);
    const rWas = await store.get(null);
    t.ok('アイコンで鍵の無いオンが 1 つ（codex）だけの行を行のスイッチでオフ: 記録は codex だけ', rWas.shared.join() === 'codex' && saves.length === nSaves + 1, rWas);
    await press('shared', true);
    t.ok('戻すと codex だけ（claude を新しく足さない）', JSON.stringify(await cellsOf('shared')) === JSON.stringify({ codex: 'on/toggle', antigravity: 'on/locked' }), await cellsOf('shared'));
    // 最後の 1 つをアイコンで外すと、その前の組を覚える（行のスイッチで戻せる）
    await op('context.setMcpAgent').handler(ctx, { name: 'shared', agent: 'claude', on: true });
    await op('context.setMcpAgent').handler(ctx, { name: 'shared', agent: 'claude', on: false });
    await op('context.setMcpAgent').handler(ctx, { name: 'shared', agent: 'codex', on: false });
    t.ok('アイコンで最後の 1 つを外した: その前の組（codex）を覚える', (await store.get(null)).shared?.join() === 'codex', await store.get(null));
    // 自分の設定の名前を持たず、鍵つきでオンだけの行（antigravity の ag）は、最初は押せない（戻し先が無い）
    nat.antigravity.push({ name: 'agonly', transport: 'stdio' });
    const agonly = await rowOf('agonly');
    t.ok('鍵つきでオンだけ・戻し先なしの行（antigravity だけの名前）は押せない', agonly.rowLocked && agonly.rowFixed && !agonly.rowChangeableOn, agonly);
    const nBefore = saves.length;
    const e1 = await press('agonly', true);
    t.ok('押せない行は断って保存しない（他のエージェントへ新しく広げない）', e1?.code === 'INVALID' && saves.length === nBefore, e1);
    const e2 = await press('nope', false);
    t.ok('一覧に無い名前は断る', e2?.code === 'INVALID');
    // 保存に失敗したら、覚えも消す（途中まで保存した状態を作らない）
    const failing = ctxOf();
    failing.context.set = async () => { throw new Error('disk full'); };
    failing.context.mcpRestore = store;
    await press('shared', true); // 行をオンの状態に戻してから（鍵の無いオンが無いと、オフは何も保存しない）
    await store.set(null, 'shared', null);
    const eF = await op('context.setMcpRow').handler(failing, { name: 'shared', on: false }).then(() => null, e => e);
    t.ok('保存に失敗したら失敗を返し、戻し先の記録も残さない', eF && !('shared' in await store.get(null)), eF);
    // 覚えられなくても操作は成功する（戻し先が既定になるだけ）
    const deaf = ctxOf();
    deaf.context.mcpRestore = { get: async () => ({}), set: async () => { throw new Error('read-only'); } };
    const okDeaf = await op('context.setMcpRow').handler(deaf, { name: 'shared', on: true }).then(r => r, e => e);
    t.ok('記録を書けなくても、行の操作そのものは成功する', okDeaf.ok === true, okDeaf);
  } finally {
    setMcpOffLinker(null);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
