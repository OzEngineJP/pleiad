// Hooks を「Hook × エージェント」の一覧にする（ADR 0338）。LLM もエージェントも呼ばない。試験用のホーム・作業場所・データ置き場だけを使う。
//   - 行 ID: 並びの位置を入れない（前に 1 つ足しても変わらない）
//   - 移行: 移行前は今までと同じ（ファイルを作らない）。最初の操作で、そのときの実効の状態を写す（任せる・そろえる・場所ごとの担当）
//   - 旧の保存を新しいコードで動かすと、同じ Hook が同じエージェントで動く（渡すもの・止めるもの）
//   - 一覧と実行時の一致: 入っているセルの Hook だけがそのエージェントのターンで動く。押せるセルは押すと実行時が変わる
//   - 二重に動かさない・切った行は動かさない・入れていないエージェントでは動かさない
//   - 鍵の理由（own・workspace・relay・admin）・押せないセルは断る・古い revision は断る・読めないファイルは会話を止める
//   - 実行時の部品: Codex の出どころごとの止め・Devin の取り込みの止め・Claude の分類（まとめて止めないターン）
//   - 操作（hooks.*）: Pleiad の登録を外す向きは write（togglePlyHook と同じ）。エージェントの設定の定義・作業場所・組 own / place を外す向きと、入れる向きは guarded（承認のカード。hooks.setOwner と同じ）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlyHooks } from '../../core/ply-hooks.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { createHooksAgents, nativeRowKey, parseState, WS_KEY, LOCK_REASONS, FILE_NAME } from '../../core/hooks-agents.mjs';
import { prepareHooksTurn } from '../../core/hooks-unify.mjs';
import { classifyNativeRun, codexHooksState } from '../../core/hooks-plan.mjs';
import { devinTurnConfig } from '../../core/backends/devin-config.mjs';
import { containsPath } from '../../core/context-settings.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'hooks-agents';
export const title = 'Hook × エージェント: 行 ID・移行の式・旧の保存と同じ動き・一覧と実行時の一致・二重に動かさない・鍵の理由・操作の承認';

// backend-allow: エージェントごとの元の集合と止め方を、試験の入力として並べる
const AGENTS = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
const [CLAUDE, CODEX, AGY, OPENCODE, DEVIN, GROK] = AGENTS;

const w = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const ids = r => (r?.record?.supplied ?? []).map(s => s.id).sort().join();

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-agents-')));
  try {
    const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), grokHome = path.join(tmp, 'grok-home');
    const repo = path.join(tmp, 'repo'), sub = path.join(repo, 'sub');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(grokHome, { recursive: true });
    const claudeSettings = path.join(home, '.claude', 'settings.json');
    await w(claudeSettings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node user-stop.mjs --token SECRET-HA-1' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } });
    await w(path.join(home, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo codex-stop' }] }] } });
    await w(path.join(home, '.gemini', 'config', 'hooks.json'), { audit: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node a.cjs' }] }] } });
    await w(path.join(repo, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node proj.mjs' }] }] } });
    const managed = path.join(tmp, 'managed', 'managed-settings.json');
    await w(managed, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node admin.mjs' }] }] } });

    const hooksConfig = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(home, '.gemini'), claudeManaged: [managed] });
    const plyHooks = createPlyHooks(data);
    const reg = await plyHooks.save({ name: 'reg', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node reg.mjs', targets: [CLAUDE, CODEX] });
    const findNode = async () => process.execPath;
    const ha = createHooksAgents({ dataDir: data, hooksConfig, plyHooks, findNode, grokHome });
    const legacyTurn = (agent, cwd = repo) => prepareHooksTurn({ agent, cwd, ctx: { plyHooks, hooksConfig, dataDir: data, findNode, grokHome } });
    const newTurn = (agent, cwd = repo) => prepareHooksTurn({ agent, cwd, ctx: { plyHooks, hooksConfig, dataDir: data, findNode, grokHome, hooksAgents: ha } });
    const userUnchanged = async () => (await fs.readFile(claudeSettings, 'utf8')).includes('SECRET-HA-1');

    // ---------------------------------------------------------------- 行 ID
    const inv0 = await ha.inventory({ cwd: repo, turn: true });
    const stopRow = inv0.rows.find(r => r.kind === 'native' && r.event === 'Stop' && r.agent === CLAUDE && r.scope === 'user');
    const guardRow = inv0.rows.find(r => r.kind === 'native' && r.event === 'PreToolUse' && r.agent === CLAUDE);
    const codexRow = inv0.rows.find(r => r.kind === 'native' && r.agent === CODEX);
    const agyRow = inv0.rows.find(r => r.kind === 'native' && r.agent === AGY);
    const projRow = inv0.rows.find(r => r.kind === 'native' && r.scope === 'project' && r.agent === CLAUDE);
    const adminRow = inv0.rows.find(r => r.scope === 'managed');
    t.ok('行が揃う: 登録・Claude のユーザー 2 つ・Codex・agy・作業場所・管理者・作業場所の 1 行',
      [stopRow, guardRow, codexRow, agyRow, projRow, adminRow].every(Boolean) && inv0.rows.some(r => r.key === reg.id) && inv0.rows.at(-1).key === WS_KEY,
      JSON.stringify(inv0.rows.map(r => `${r.kind}:${r.agent}:${r.scope}:${r.event}`)));
    t.ok('行 ID は hk- と 16 桁。組は own・place・admin・ply', /^hk-[0-9a-f]{16}$/.test(stopRow.key) && stopRow.group === 'own' && projRow.group === 'place' && adminRow.group === 'admin'
      && inv0.byKey.get(reg.id).group === 'ply');
    await w(claudeSettings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node first.mjs' }] }, { hooks: [{ type: 'command', command: 'node user-stop.mjs --token SECRET-HA-1' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } });
    const shifted = await ha.inventory({ cwd: repo, turn: true });
    t.ok('前に 1 つ足しても、元の定義の行 ID は変わらない（並びの位置を入れない）', shifted.byKey.has(stopRow.key) && shifted.byKey.has(guardRow.key));
    t.ok('コマンドの秘密は ID の材料にするが、ID からも一覧からも読めない', nativeRowKey({ ...stopRow.entry }, 'node user-stop.mjs --token SECRET-HA-1') === stopRow.key
      && !JSON.stringify((await ha.matrix({ cwd: repo })).rows).includes('SECRET-HA-1'));
    await w(claudeSettings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node user-stop.mjs --token SECRET-HA-1' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } });

    // ---------------------------------------------------------------- 移行前: 今までと同じ（ファイルを作らない）
    t.ok('移行前（任せる）: ファイルは無く、どのエージェントも今までどおり何も渡さない・止めない',
      !await ha.exists() && (await Promise.all(AGENTS.map(a => newTurn(a)))).every(x => x === null));
    const before = await ha.matrix({ cwd: repo });
    t.ok('移行前の一覧: adopted: false で、移行したらこうなる形を返す（見るだけでは書かない）', before.adopted === false && !await ha.exists()
      && before.agents.join() === AGENTS.join() && before.groups.join() === 'ply,own,place,admin');
    const cell = (m, key, a) => m.rows.find(r => r.key === key)?.cells[a];
    t.ok('任せる: 登録は動いていなかったので切れたまま、エージェントの定義は元のエージェントで入り',
      cell(before, reg.id, CLAUDE).state === 'off' && cell(before, stopRow.key, CLAUDE).state === 'on' && cell(before, codexRow.key, CODEX).state === 'on'
      && cell(before, agyRow.key, AGY).state === 'on' && cell(before, projRow.key, CLAUDE).state === 'on' && cell(before, WS_KEY, CLAUDE).state === 'on');

    // ---------------------------------------------------------------- 旧の保存（そろえる・場所ごと）を新しいコードで動かしても同じ
    const compare = async (label, cwd = repo) => {
      const legacy = {}, adopted = {};
      for (const a of AGENTS) legacy[a] = await legacyTurn(a, cwd).catch(e => ({ error: e.code }));
      const { state } = await ha.current();
      await w(ha.file, { ...state });
      for (const a of AGENTS) adopted[a] = await newTurn(a, cwd).catch(e => ({ error: e.code }));
      await ha.reset();
      const bad = [];
      for (const a of AGENTS) {
        let L = legacy[a], N = adopted[a];
        if (L?.error || N?.error) { if (L?.error !== N?.error) bad.push(`${a}: error ${L?.error} / ${N?.error}`); continue; }
        // 渡すものも止めるものも無いターンは、旧が空の記録を返しても新が null でも起動は同じ（OpenCode のコールバック無し・Devin の取り込みはそのまま）
        const idle = x => x && [OPENCODE, DEVIN].includes(a) && !x.runtime?.supplied?.length && !devinTurnConfig({ hooksRuntime: x.runtime })?.read_config_from;
        if (idle(L)) L = null;
        if (idle(N)) N = null;
        if (!L !== !N) { bad.push(`${a}: ${L ? 'legacy ran' : 'legacy null'} / ${N ? 'new ran' : 'new null'}`); continue; }
        if (!L) continue;
        if (ids(L) !== ids(N)) bad.push(`${a}: supplied ${ids(L)} / ${ids(N)}`);
        if (a === CLAUDE && N.runtime.stopAll !== true) bad.push('claude: not stopAll');
        if (a === GROK && JSON.stringify(N.runtime.compatHookEnv) !== JSON.stringify(L.runtime.compatHookEnv)) bad.push('grok: env');
        if (a === DEVIN && (devinTurnConfig({ hooksRuntime: L.runtime })?.read_config_from ? 1 : 0) !== (devinTurnConfig({ hooksRuntime: N.runtime })?.read_config_from ? 1 : 0)) bad.push('devin: imports');
        if (a === AGY && JSON.stringify([...L.runtime.names].sort()) !== JSON.stringify([...N.runtime.names].sort())) bad.push(`agy: names ${L.runtime.names} / ${N.runtime.names}`);
        if (a === CODEX) {
          // 旧は Codex の hooks/list の user・project をまとめて止める。新は行ごと（user）と出どころごと（project）
          const list = [{ hooks: [{ key: `${codexRow.path}:stop:0:0`, source: 'user' }, { key: `${path.join(repo, '.codex', 'hooks.json')}:stop:0:0`, source: 'project' }] }];
          const l = codexHooksState({ table: L.runtime.table, list }), n = codexHooksState({ table: N.runtime.table, list, stopRows: N.runtime.stopRows });
          if (JSON.stringify(l.state) !== JSON.stringify(n.state)) bad.push(`codex: state ${JSON.stringify(l.state)} / ${JSON.stringify(n.state)}`);
        }
      }
      t.ok(`${label}: 旧の保存を新しいコードで動かすと、同じ Hook を同じエージェントで渡し、同じものを止める`, bad.length === 0, bad.join(' | '));
      return { legacy, adopted };
    };
    await compare('任せる');
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    const ply = await compare('そろえる');
    t.ok('そろえる: 登録は Claude・Codex に渡り、Claude はまとめて止める（記録は mode: agents）',
      ids(ply.adopted[CLAUDE]) === reg.id && ids(ply.adopted[CODEX]) === reg.id && ply.adopted[CLAUDE].record.mode === 'agents' && ply.adopted[CLAUDE].record.stopAll === true);
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [reg.id] } });
    await compare('そろえる・登録を渡さない');
    await plyHooks.setOwner({ place: null, value: { owner: 'native' } });
    await plyHooks.setOwner({ place: repo, value: { owner: 'ply', disabled: [] } });
    await compare('場所ごとの担当（この場所だけそろえる）', sub);
    await compare('場所ごとの担当（その外は任せる）', tmp);
    await plyHooks.setOwner({ place: repo, value: { owner: 'native' } });

    // Devin へ渡す登録がある「そろえる」から移った人: Devin の取り込みは、渡すものがあるターンだけ止める（旧と同じ）
    const devReg = await plyHooks.save({ name: 'dev', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node dev.mjs', targets: [DEVIN] });
    const importsStopped = r => !!devinTurnConfig({ hooksRuntime: r?.runtime ?? null })?.read_config_from;
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    await compare('そろえる・Devin へ渡す登録がある');
    await ha.setRow({ key: devReg.id, on: false, cwd: repo });
    const devOff = await ha.matrix({ cwd: repo });
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [devReg.id] } });
    const legacyDevOff = await legacyTurn(DEVIN);
    t.ok('移行の後に Devin へ渡す登録を切る: 渡すものが無いターンは Devin の取り込みを止めない（旧「そろえる」で登録を外したときと同じ）',
      (await ha.read()).compat.devin === 'off' && !importsStopped(await newTurn(DEVIN)) && !importsStopped(legacyDevOff), JSON.stringify((await newTurn(DEVIN))?.record ?? null));
    t.ok('そのときの一覧: Claude の定義の Devin の列は取り込みのとおり（入り・devinImports）', cell(devOff, stopRow.key, DEVIN).state === 'on' && cell(devOff, stopRow.key, DEVIN).detail === 'devinImports'
      && cell(devOff, WS_KEY, DEVIN).detail === 'devinImports');
    await ha.setRow({ key: devReg.id, on: true, cwd: repo });
    const devOn = await ha.matrix({ cwd: repo });
    t.ok('入れ直すと、渡すターンは取り込みを止める（Claude の定義の Devin の列は devinCompatOff）', importsStopped(await newTurn(DEVIN)) && ids(await newTurn(DEVIN)) === devReg.id
      && cell(devOn, stopRow.key, DEVIN).state === 'off' && cell(devOn, stopRow.key, DEVIN).detail === 'devinCompatOff');
    await ha.reset();
    await plyHooks.setOwner({ place: null, value: { owner: 'native' } });
    await plyHooks.remove(devReg.id);

    // ---------------------------------------------------------------- 最初の操作で写す
    const m1 = await ha.matrix({ cwd: repo });
    const firstTouch = await ha.setAgent({ key: reg.id, agent: CLAUDE, on: true, cwd: repo, expect: m1.revision });
    const saved = JSON.parse(await fs.readFile(path.join(data, FILE_NAME), 'utf8'));
    t.ok('最初の操作で写す: ファイルができ、押したセルだけが変わる（登録の Claude だけ入り、Codex は切れたまま）',
      saved.version === 1 && saved.adoptedFrom?.owner === 'native' && saved.off[reg.id]?.join() === CODEX && !saved.spread[reg.id] && firstTouch.revision !== m1.revision);
    t.ok('写した後: Claude のターンは止めずに登録だけ足す（ネイティブはそのまま）。Codex には渡さない',
      ids(await newTurn(CLAUDE)) === reg.id && (await newTurn(CLAUDE)).runtime.stopAll === false && await newTurn(CODEX) === null);
    t.ok('利用者の設定ファイルは書き換えない', await userUnchanged());
    let stale = null;
    try { await ha.setAgent({ key: reg.id, agent: CODEX, on: true, cwd: repo, expect: m1.revision }); } catch (e) { stale = e; }
    t.ok('古い revision の操作は断る（CONFLICT）', stale?.code === 'CONFLICT');

    // ---------------------------------------------------------------- 一覧と実行時の一致・押せるセルは実行時を変える
    const turnKeys = async (a, cwd = repo) => new Set(((await ha.hooksForTurn(a, cwd)) ?? []).map(x => x.key));
    const mismatch = async (cwd = repo) => {
      const m = await ha.matrix({ cwd });
      const bad = [];
      for (const a of AGENTS) {
        const keys = await turnKeys(a, cwd);
        for (const row of m.rows) {
          if (row.kind === 'ws') continue;
          const c = row.cells[a];
          if (c.unknown) continue;
          if ((c.state === 'on') !== keys.has(row.key)) bad.push(`${a}:${row.scope}:${row.event}:${c.state}`);
        }
      }
      return { m, bad };
    };
    const consistent = await mismatch();
    t.ok('一覧と実行時の一致: 入っているセルの Hook だけが、そのエージェントのターンで動く', consistent.bad.length === 0, consistent.bad.join());
    const reasons = consistent.m.rows.flatMap(r => Object.values(r.cells)).filter(c => c.mode === 'locked').map(c => c.reason);
    t.ok('鍵の理由は own・workspace・relay・admin のどれか', reasons.length > 0 && reasons.every(r => LOCK_REASONS.includes(r)), [...new Set(reasons)].join());
    t.ok('管理者の行: Claude は鍵（admin）、ほかは none', cell(consistent.m, adminRow.key, CLAUDE).mode === 'locked' && cell(consistent.m, adminRow.key, CLAUDE).reason === 'admin'
      && AGENTS.filter(a => a !== CLAUDE).every(a => cell(consistent.m, adminRow.key, a).mode === 'none'));
    t.ok('Devin の Claude の定義は取り込みで動くので鍵（own）', cell(consistent.m, stopRow.key, DEVIN).mode === 'locked' && cell(consistent.m, stopRow.key, DEVIN).reason === 'own');
    t.ok('作業場所の 1 行: OpenCode・Grok は鍵（workspace）', cell(consistent.m, WS_KEY, OPENCODE).reason === 'workspace' && cell(consistent.m, WS_KEY, GROK).reason === 'workspace');
    let refused = null;
    try { await ha.setAgent({ key: adminRow.key, agent: CLAUDE, on: false, cwd: repo }); } catch (e) { refused = e; }
    t.ok('押せないセルを押すと断る（何もしないセルは無い）', refused?.code === 'INVALID');

    // 押せるセルを全部 1 つずつ押し、そのエージェントのターンで動くものが変わり、ほかのセルが黙って変わらないこと
    const toggles = consistent.m.rows.flatMap(r => AGENTS.filter(a => r.cells[a].mode === 'toggle').map(a => ({ key: r.key, a, on: r.cells[a].state === 'on', ws: r.kind === 'ws' })));
    const silent = [], noEffect = [];
    for (const { key, a, on, ws } of toggles) {
      const beforeKeys = await turnKeys(a);
      const m0 = await ha.matrix({ cwd: repo });
      await ha.setAgent({ key, agent: a, on: !on, cwd: repo });
      const m2 = await ha.matrix({ cwd: repo });
      const afterKeys = await turnKeys(a);
      // 作業場所の 1 行: この場所に定義が無い（empty）エージェントは、保存（全体の off）が変わることを見る（ほかの作業場所で効く）
      const empty = m0.rows.find(r => r.key === key).cells[a].empty;
      const effect = ws ? (empty ? ((await ha.read()).off[WS_KEY] ?? []).includes(a) === on : afterKeys.has(projRow.key) !== beforeKeys.has(projRow.key)) : afterKeys.has(key) === !on;
      if (!effect) noEffect.push(`${a}:${key}`);
      for (const r of m2.rows) for (const b of AGENTS) {
        if (r.key === key && b === a) continue;
        if (ws && b === a && r.cells[b].detail === 'followsWorkspace') continue;
        if (r.cells[b].state !== m0.rows.find(x => x.key === r.key).cells[b].state) silent.push(`${a}:${key} → ${b}:${r.key}`);
      }
      await ha.setAgent({ key, agent: a, on, cwd: repo });
    }
    t.ok('押せるセルは押すと、そのエージェントのターンで動くものが変わる', toggles.length >= 6 && noEffect.length === 0, `${toggles.length} ${noEffect.join()}`);
    t.ok('押せるセルを押しても、ほかのセルは黙って変わらない', silent.length === 0, silent.join());

    // ---------------------------------------------------------------- 止めて渡し直す（1 つずつ止められないエージェント）
    await ha.setAgent({ key: stopRow.key, agent: CLAUDE, on: false, cwd: repo });
    const claudeTurn = await newTurn(CLAUDE);
    const supplied = claudeTurn.runtime.supplied.map(x => x.hook.id);
    t.ok('Claude の 1 つを切る: まとめて止め、入っている定義（guard・作業場所・登録）を渡し直す。切ったものは渡さない',
      claudeTurn.runtime.stopAll === true && supplied.includes(guardRow.key) && supplied.includes(projRow.key) && supplied.includes(reg.id) && !supplied.includes(stopRow.key), supplied.join());
    t.ok('止めたターンは、ネイティブの記録と渡したものが重ならない（二重に動かない）', claudeTurn.record.kept.length === 0 || claudeTurn.record.kept.every(k => k.scope === 'managed'));
    t.ok('Claude をまとめて止めたターン: 止めた定義の発火は漏れと分類する', classifyNativeRun({ record: claudeTurn.record, backend: CLAUDE, name: 'Stop', event: 'Stop' }).leak === true);
    t.ok('止めないターン（mode: agents・stopAll: false）: ネイティブの発火は漏れでも知らないものでもない',
      JSON.stringify(classifyNativeRun({ record: { owner: 'ply', mode: 'agents', stopAll: false, stopped: [] }, backend: CLAUDE, name: 'Stop', event: 'Stop' })) === '{"leak":false,"unknownNative":false}');
    await ha.setAgent({ key: stopRow.key, agent: CLAUDE, on: true, cwd: repo });

    // ---------------------------------------------------------------- 切った行・入れていないエージェント・二重
    await ha.setRow({ key: reg.id, on: false, cwd: repo });
    const offAll = await Promise.all(AGENTS.map(a => turnKeys(a)));
    t.ok('行を切ると、どのエージェントでも動かない（エージェントごとの選択は覚えたまま）', offAll.every(k => !k.has(reg.id)) && (await ha.read()).off[reg.id]?.join() === CODEX);
    await ha.setRow({ key: reg.id, on: true, cwd: repo });
    t.ok('入れていないエージェント（OpenCode・Grok・agy・Devin）では登録は動かない', (await Promise.all([OPENCODE, GROK, AGY, DEVIN].map(a => turnKeys(a)))).every(k => !k.has(reg.id)));
    const dup = await plyHooks.save({ name: 'dup', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node user-stop.mjs --token SECRET-HA-1', targets: [CLAUDE] });
    await plyHooks.toggle(dup.id, true);
    await ha.setRow({ key: dup.id, on: true, cwd: repo });
    const dupTurn = await newTurn(CLAUDE);
    t.ok('動き続けるネイティブと同じ登録は渡さない（二重に動かさない。理由は duplicate）',
      !dupTurn.runtime.supplied.some(x => x.hook.id === dup.id) && dupTurn.record.skipped.some(s => s.id === dup.id && s.reason === 'duplicate'), JSON.stringify(dupTurn.record.skipped));
    await plyHooks.remove(dup.id);

    // ---------------------------------------------------------------- 広げる（ほかのエージェントでも実行する）
    const mSpread = await ha.matrix({ cwd: repo });
    const codexToClaude = cell(mSpread, codexRow.key, CLAUDE);
    t.ok('広げるセルは確認を求める（needsConfirm）・Codex の信頼の警告に根拠が付く', codexToClaude.mode === 'toggle' && codexToClaude.needsConfirm === true
      && codexToClaude.warnings?.some(x => x.code === 'codexTrustAtTurn' && typeof x.evidence === 'string' && x.evidence.length > 0), JSON.stringify(codexToClaude));
    await ha.setAgent({ key: codexRow.key, agent: CLAUDE, on: true, cwd: repo });
    const spreadTurn = await newTurn(CLAUDE);
    t.ok('広げると Claude のターンで Codex の定義を渡す（止めずに足す）', spreadTurn.runtime.stopAll === false && spreadTurn.runtime.supplied.some(x => x.hook.id === codexRow.key));
    t.ok('広げても元の Codex は自分で動かす（Pleiad は渡さない・止めない）', await newTurn(CODEX).then(x => x === null || (!x.runtime.supplied.some(s => s.hook.id === codexRow.key) && !x.runtime.stopRows.length)));
    await ha.setAgent({ key: codexRow.key, agent: CLAUDE, on: false, cwd: repo });

    // ---------------------------------------------------------------- Codex・agy・Grok・Devin の止め方
    await ha.setAgent({ key: codexRow.key, agent: CODEX, on: false, cwd: repo });
    const cx = await newTurn(CODEX);
    t.ok('Codex の定義を切る: その行（パス・イベント・組・番号）だけを止める', cx.runtime.stopRows.length === 1 && cx.runtime.stopRows[0].path === codexRow.path && cx.runtime.stopRows[0].event === 'Stop');
    const cxState = codexHooksState({ table: cx.runtime.table, list: [{ hooks: [{ key: `${codexRow.path}:stop:0:0`, source: 'user' }, { key: `${codexRow.path}:stop:1:0`, source: 'user' }] }], stopRows: cx.runtime.stopRows });
    t.ok('Codex: 同じファイルの別の定義は止めない', cxState.state[`${codexRow.path}:stop:0:0`]?.enabled === false && !cxState.state[`${codexRow.path}:stop:1:0`], JSON.stringify(cxState.state));
    await ha.setAgent({ key: codexRow.key, agent: CODEX, on: true, cwd: repo });
    await ha.setAgent({ key: WS_KEY, agent: CODEX, on: false, cwd: repo });
    const cxWs = await newTurn(CODEX);
    t.ok('Codex の作業場所を切る: 出どころ（project）ごと止める（読めなかった定義も止まる）', cxWs.runtime.stopRows.some(r => r.source === 'project'));
    const projState = codexHooksState({ table: {}, list: [{ hooks: [{ key: 'C:/r/.codex/hooks.json:stop:0:0', source: 'project' }, { key: 'C:/u/.codex/hooks.json:stop:0:0', source: 'user' }] }], stopRows: [{ source: 'project' }] });
    t.ok('Codex: 出どころの止めはユーザーの定義を止めない', projState.state['C:/r/.codex/hooks.json:stop:0:0']?.enabled === false && !projState.state['C:/u/.codex/hooks.json:stop:0:0']);
    await ha.setAgent({ key: WS_KEY, agent: CODEX, on: true, cwd: repo });
    await ha.setAgent({ key: agyRow.key, agent: AGY, on: false, cwd: repo });
    const ag = await newTurn(AGY);
    t.ok('agy の定義を切る: 名前で止める（ほかの名前は止めない）', ag.runtime.names.join() === 'audit' && ag.runtime.file && ag.record.mode === 'agents');
    await ha.setAgent({ key: agyRow.key, agent: AGY, on: true, cwd: repo });
    const gk = await ha.matrix({ cwd: repo });
    t.ok('Grok は Claude のユーザーの定義を互換で読む（入り）。作業場所は信頼が無いので読まない', cell(gk, stopRow.key, GROK).state === 'on' && cell(gk, projRow.key, GROK).state === 'off');
    await ha.setAgent({ key: stopRow.key, agent: GROK, on: false, cwd: repo });
    const gr = await newTurn(GROK);
    t.ok('Grok の 1 つを切る: Claude の互換だけを止め、残りを渡し直す（Cursor・Codex の互換は止めない）',
      gr.runtime.compatHookEnv?.GROK_CLAUDE_HOOKS_ENABLED === 'false' && !('GROK_CODEX_HOOKS_ENABLED' in gr.runtime.compatHookEnv)
      && gr.runtime.supplied.some(x => x.hook.id === guardRow.key) && !gr.runtime.supplied.some(x => x.hook.id === stopRow.key), JSON.stringify(gr.runtime.compatHookEnv));
    await ha.setAgent({ key: stopRow.key, agent: GROK, on: true, cwd: repo });
    t.ok('元に戻すと Grok は今までと同じ起動（何も渡さない）', await newTurn(GROK) === null);
    t.ok('Devin: 止めずに渡すときは取り込みを止めない・止めるときだけ read_config_from', !devinTurnConfig({ hooksRuntime: { supplied: [], stopImports: false } })?.read_config_from
      && Object.values(devinTurnConfig({ hooksRuntime: { supplied: [], stopImports: true } })?.read_config_from ?? {}).every(v => v === false)
      && Object.keys(devinTurnConfig({ hooksRuntime: { supplied: [], stopImports: true } })?.read_config_from ?? {}).length > 0);
    t.ok('Devin: 旧の runtime（stopImports が無い）は、渡すものがあるときだけ止める（今までどおり）', !devinTurnConfig({ hooksRuntime: { supplied: [] } })?.read_config_from);

    // ---------------------------------------------------------------- この場所で使う
    await ha.setPlace({ place: repo, key: guardRow.key, use: false });
    const placed = await ha.matrix({ cwd: sub });
    t.ok('この場所で使わない: その場所（子も）では切れ、一覧の here.use が false', placed.rows.find(r => r.key === guardRow.key).here.use === false && cell(placed, guardRow.key, CLAUDE).state === 'off'
      && placed.skipFrom?.toLowerCase() === repo.toLowerCase());
    t.ok('この場所で使わない: その場所の Claude のターンでは動かず（まとめて止めて残りを渡し直す）、外では動く',
      !(await turnKeys(CLAUDE, sub)).has(guardRow.key) && (await turnKeys(CLAUDE, tmp)).has(guardRow.key));
    await ha.setPlace({ place: repo, key: guardRow.key, use: true });
    t.ok('使うに戻すと、場所の上書きは消える', !(await ha.read()).places[Object.keys((await ha.read()).places)[0]]?.skip?.length);

    // ---------------------------------------------------------------- 読めないファイル・移行前へ戻す
    const goodText = await fs.readFile(ha.file, 'utf8');
    await fs.writeFile(ha.file, '{');
    let unread = null, unreadMatrix = null;
    try { await newTurn(CLAUDE); } catch (e) { unread = e; }
    try { await ha.matrix({ cwd: repo }); } catch (e) { unreadMatrix = e; }
    t.ok('読めない hooks-agents.json は会話を止める（今までの担当で動かすと、切ったはずの Hook が動くため）', unread?.code === 'HOOKS_REFUSED' && unreadMatrix?.code === 'UNREADABLE');
    t.ok('知らない版は読めない扱い', parseState({ version: 2 }) === null && parseState({ version: 1 })?.version === 1);
    await fs.writeFile(ha.file, goodText);
    await ha.reset();
    t.ok('移行前へ戻す: ファイルを消し、旧の担当の動きへ戻る', !await ha.exists() && await newTurn(CLAUDE) === null);

    // ---------------------------------------------------------------- 渡せないセル（relay）
    const ss = await plyHooks.save({ name: 'ctx', agent: CLAUDE, event: 'SessionStart', matcher: '', command: 'node ctx.mjs', targets: [CLAUDE] });
    await plyHooks.toggle(ss.id, true);
    const mRelay = await ha.matrix({ cwd: repo });
    const relay = cell(mRelay, ss.id, CLAUDE);
    t.ok('Pleiad が渡せないセルは鍵（relay）で理由のコード付き（Claude の SessionStart はコールバックで渡せない）', relay.mode === 'locked' && relay.reason === 'relay' && relay.detail === 'claudeCallback', JSON.stringify(relay));
    await ha.setRow({ key: ss.id, on: true, cwd: repo });
    const relayTurn = await newTurn(CLAUDE);
    // 止めるものも渡すものも無ければ今までと同じ起動（null）。理由は一覧のセルが持つ
    t.ok('渡せない登録は渡さない（ほかに変えるものが無ければ起動は今までと同じ）', !(relayTurn?.runtime.supplied ?? []).some(x => x.hook.id === ss.id) && (relayTurn === null || relayTurn.record.unsupported.some(u => u.id === ss.id)), JSON.stringify(relayTurn?.record ?? null));
    await plyHooks.remove(ss.id);
    await ha.reset();

    // ---------------------------------------------------------------- 操作（hooks.*）
    const calls = [];
    const deps = { locale: 'ja', calls, modeOf: async () => deps.mode, audit: async e => calls.push(['audit', e.op, e.risk]),
      approve: async req => { calls.push(['approve', req.op]); return { pending: true, requestId: 'setting-x' }; },
      sessionCwd: async () => repo, sessionBackend: async () => CLAUDE, hooks: { agents: ha } };
    const as = async (mode, id, args) => { deps.mode = { bypass: { scope: 'full', autonomy: 'never' }, ask: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'readonly', autonomy: 'ask' } }[mode];
      return registry.invoke({ by: 'agent', via: 'mcp', sessionId: 's1' }, id, args, deps); };
    const listed = await as('ask', 'hooks.matrix', {});
    t.ok('hooks.matrix: 会話の作業場所の一覧。agent にもコマンドの秘密は出ない', listed.ok && listed.result.cwd === repo && !JSON.stringify(listed).includes('SECRET-HA-1'), JSON.stringify(listed).slice(0, 300));
    // 外す向き: Pleiad の登録は承認なし（togglePlyHook の enabled: false と同じ）。利用者の見張りの Hook を止める向きは承認のカード（hooks.setOwner と同じ）
    const approvals = () => calls.filter(c => c[0] === 'approve').length;
    const noCard = async (op, args) => { const n = approvals(); const r = await as('ask', op, args); return r.ok && approvals() === n ? r : null; };
    const card = async (op, args) => { const n = approvals(); const r = await as('ask', op, args); return r.pending === true && approvals() === n + 1 ? r : null; };
    t.ok('hooks.setAgent・setRow・setGroup・setPlace: Pleiad の登録・組 ply を外す向きは write（承認の要る会話でも通る）',
      !!await noCard('hooks.setAgent', { key: reg.id, agent: CODEX, on: false }) && !!await noCard('hooks.setRow', { key: reg.id, on: false })
      && !!await noCard('hooks.setGroup', { group: 'ply', on: false }) && !!await noCard('hooks.setPlace', { place: repo, key: reg.id, use: false }));
    t.ok('hooks.setAgent・setRow: エージェントの設定の定義（hk-）・作業場所の Hooks（ws:hooks）を外す向きは guarded（承認のカード）',
      !!await card('hooks.setAgent', { key: stopRow.key, agent: CLAUDE, on: false }) && !!await card('hooks.setRow', { key: stopRow.key, on: false })
      && !!await card('hooks.setAgent', { key: WS_KEY, agent: CLAUDE, on: false }) && !!await card('hooks.setRow', { key: WS_KEY, on: false }));
    t.ok('hooks.setGroup: 組 own・place を外す向きは guarded', !!await card('hooks.setGroup', { group: 'own', agent: CLAUDE, on: false }) && !!await card('hooks.setGroup', { group: 'place', on: false }));
    t.ok('hooks.setPlace: エージェントの設定の定義・作業場所の Hooks をその場所で使わない向き・上書きを消す向きは guarded',
      !!await card('hooks.setPlace', { place: repo, key: stopRow.key, use: false }) && !!await card('hooks.setPlace', { place: repo, key: WS_KEY, use: false })
      && !!await card('hooks.setPlace', { place: repo, reset: true }));
    const widen = await card('hooks.setAgent', { key: stopRow.key, agent: CLAUDE, on: true });
    t.ok('入れる向きは、どの行でも guarded（承認のカード）', !!widen && !!await card('hooks.setAgent', { key: reg.id, agent: CLAUDE, on: true })
      && !!await card('hooks.setRow', { key: reg.id, on: true }) && !!await card('hooks.setGroup', { group: 'ply', on: true }) && !!await card('hooks.setPlace', { place: repo, key: reg.id, use: true }));
    const bypassNative = await as('bypass', 'hooks.setAgent', { key: stopRow.key, agent: CLAUDE, on: false });
    t.ok('承認の要らない会話（full・never）なら、ネイティブを外す向きもそのまま通る', bypassNative.ok, JSON.stringify(bypassNative));
    await as('bypass', 'hooks.setAgent', { key: stopRow.key, agent: CLAUDE, on: true });
    await as('bypass', 'hooks.setRow', { key: reg.id, on: true });
    await as('bypass', 'hooks.setGroup', { group: 'ply', on: true });
    await as('bypass', 'hooks.setPlace', { place: repo, key: reg.id, use: true });
    t.ok('hooks.setRow: 読み取りの会話は断る', (await as('plan', 'hooks.setRow', { key: stopRow.key, on: true })).code === 'READ_ONLY_MODE');
    const human = await registry.invoke({ by: 'human', via: 'ui', local: true }, 'hooks.setAgent', { key: stopRow.key, agent: CLAUDE, on: true, cwd: repo }, deps);
    t.ok('人（画面）の操作はそのまま通り、revision を返す', human.ok && typeof human.result.revision === 'string', JSON.stringify(human));
    const badCell = await as('bypass', 'hooks.setAgent', { key: adminRow.key, agent: CLAUDE, on: false });
    t.ok('agent が押せないセルを押すと INVALID で返す（人の画面には例外のまま届く）', badCell.code === 'INVALID', JSON.stringify(badCell));
    const resetOp = await as('bypass', 'hooks.resetAgents', {});
    t.ok('hooks.resetAgents: 移行前へ戻す', resetOp.ok && !await ha.exists());
    t.ok('利用者の設定ファイルは最後まで書き換えない', await userUnchanged());
  } finally {
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-hooks-agents-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
