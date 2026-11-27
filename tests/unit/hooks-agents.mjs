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
import { createPlyHooks, hooksWriteFailed } from '../../core/ply-hooks.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { createHooksAgents, nativeRowKey, parseState, effectiveAt, WS_KEY, LOCK_REASONS, FILE_NAME } from '../../core/hooks-agents.mjs';
import { prepareHooksTurn } from '../../core/hooks-unify.mjs';
import { classifyNativeRun, codexHooksState } from '../../core/hooks-plan.mjs';
import { devinTurnConfig } from '../../core/backends/devin-config.mjs';
import { containsPath } from '../../core/context-settings.mjs';
import { registry } from '../../core/ops/index.mjs';
import { agentShortName } from '../../core/backends/agents.mjs';
import { t as T } from '../../core/i18n.mjs';

export const name = 'hooks-agents';
export const title = 'Hook × エージェント: 行 ID・移行の式・旧の保存と同じ動き・一覧と実行時の一致・二重に動かさない・鍵の理由・操作の承認';

const AGENTS = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok', 'pleiad-agent'];
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
    // 形式 2: cwd を付けた操作はそのフォルダーに差分を書く。その場所で効く選択（全体 + 場所の差分）
    const effAt = async (cwd = repo) => effectiveAt(await ha.read(), cwd).agents;

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
    t.ok('一覧は列の短い名前（エージェントの記述の shortLabel）を載せる。使っていないエージェントの列も画面が短い名前で出せる',
      AGENTS.every(a => typeof before.labels?.[a] === 'string') && before.labels.devin === 'Devin' && before.labels.grok === 'Grok', JSON.stringify(before.labels));
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
        const idle = x => x && [OPENCODE, DEVIN, 'pleiad-agent'].includes(a) && !x.runtime?.supplied?.length && !devinTurnConfig({ hooksRuntime: x.runtime })?.read_config_from;
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

    // Devin へ渡す登録がある「そろえる」から移った人: main の動き（--config を Devin が読む前に消していたので、登録は動かず取り込みも止まらない）から始める。
    // Devin のマスを入れて渡すものができたターンから、旧「そろえる」の規則で取り込みが止まる
    const devReg = await plyHooks.save({ name: 'dev', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node dev.mjs', targets: [DEVIN] });
    const importsStopped = r => !!devinTurnConfig({ hooksRuntime: r?.runtime ?? null })?.read_config_from;
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    const devStart = await compare('そろえる・Devin へ渡す登録がある');
    const devAdopt = (await ha.current()).state;
    t.ok('旧「そろえる」で Devin へ向けた登録がある人: 移行の前も直後も Devin のターンは null（--config を付けない・取り込みを止めない。main の動き）',
      devStart.legacy[DEVIN] === null && devStart.adopted[DEVIN] === null, JSON.stringify({ legacy: devStart.legacy[DEVIN], adopted: devStart.adopted[DEVIN]?.record ?? devStart.adopted[DEVIN] }));
    t.ok('移行の式: Devin へ向けた登録は Devin を off から始め、互換は off のまま（入れたターンから止まる）',
      JSON.stringify(devAdopt.off[devReg.id]) === JSON.stringify([DEVIN]) && devAdopt.compat.devin === 'off', JSON.stringify({ off: devAdopt.off[devReg.id], compat: devAdopt.compat }));
    const devStartMatrix = await ha.matrix({ cwd: repo });
    t.ok('移行の前の一覧: 登録の Devin のマスはオフ、Claude の定義と作業場所の Devin の列は取り込みのとおり（devinImports）、取り込みは止まらない',
      cell(devStartMatrix, devReg.id, DEVIN).state === 'off' && cell(devStartMatrix, stopRow.key, DEVIN).detail === 'devinImports'
      && cell(devStartMatrix, WS_KEY, DEVIN).detail === 'devinImports' && await ha.devinImportsStopped(repo) === false);
    const warnCodes = (m, key) => (cell(m, key, DEVIN).warnings ?? []).map(w => w.code).join(',');
    t.ok('そのマスの注意: 入れると取り込みが止まる場所なので devinImportsStop（重ねるだけの devinConfig ではない）',
      warnCodes(devStartMatrix, devReg.id) === 'devinImportsStop', warnCodes(devStartMatrix, devReg.id));
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
    // 指示・Skills の表が Devin のマスを合わせる判定（段 2 のレビュー S2）: ターンの取り込みを止めるかと同じ答え
    await ha.setRow({ key: devReg.id, on: false, cwd: repo });
    const predOff = await ha.devinImportsStopped(repo);
    await ha.setRow({ key: devReg.id, on: true, cwd: repo });
    const predOn = await ha.devinImportsStopped(repo);
    t.ok('devinImportsStopped（移行後）: Devin へ渡す Hook があるときだけ true（ターンの取り込みの止め方と同じ）', predOn === true && predOff === false, JSON.stringify({ predOn, predOff }));
    const forDevin = await ha.importsStoppedFor(DEVIN, repo), forOther = await ha.importsStoppedFor('claude', repo);
    t.ok('importsStoppedFor: Devin は devinImportsStopped と同じ答え、ほかのエージェントは false', forDevin === true && forOther === false, JSON.stringify({ forDevin, forOther }));
    await ha.reset();
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    const predLegacy = !(await ha.exists()) && await ha.devinImportsStopped(repo);
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [devReg.id] } });
    const predLegacyNone = await ha.devinImportsStopped(repo);
    await plyHooks.setOwner({ place: null, value: { owner: 'native' } });
    const predNative = await ha.devinImportsStopped(repo);
    const nativeMatrix = await ha.matrix({ cwd: repo });
    t.ok('任せるから移る人の Devin のマスの注意は devinConfig（取り込みは止まらず、利用者の設定に重ねる）',
      cell(nativeMatrix, devReg.id, DEVIN).state === 'off' && (cell(nativeMatrix, devReg.id, DEVIN).warnings ?? []).map(w => w.code).join(',') === 'devinConfig',
      JSON.stringify(cell(nativeMatrix, devReg.id, DEVIN)));
    t.ok('devinImportsStopped（移行前）: いつも false（旧「そろえる」で Devin へ向けた登録があっても、main では取り込みが止まっていなかった）',
      predLegacy === false && predLegacyNone === false && predNative === false && importsStopped(legacyDevOff) === false, JSON.stringify({ predLegacy, predLegacyNone, predNative }));
    await plyHooks.remove(devReg.id);

    // ---------------------------------------------------------------- 最初の操作で写す
    const m1 = await ha.matrix({ cwd: repo });
    const firstTouch = await ha.setAgent({ key: reg.id, agent: CLAUDE, on: true, cwd: repo, expect: m1.revision });
    const saved = JSON.parse(await fs.readFile(path.join(data, FILE_NAME), 'utf8'));
    t.ok('最初の操作で写す: ファイルができ、押したセルだけが変わる（登録の Claude だけ入り、Codex は切れたまま）',
      saved.version === 2 && saved.adoptedFrom?.owner === 'native' && effectiveAt(parseState(saved), repo).agents.off[reg.id]?.join() === CODEX
      && !effectiveAt(parseState(saved), repo).agents.spread[reg.id] && firstTouch.revision !== m1.revision
      && Object.keys(saved.places[Object.keys(saved.places).find(k => containsPath(saved.places[k].path, repo) && containsPath(repo, saved.places[k].path))]?.rows ?? {}).join() === reg.id,
      JSON.stringify(saved.places));
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
      const effect = ws ? (empty ? ((await effAt()).off[WS_KEY] ?? []).includes(a) === on : afterKeys.has(projRow.key) !== beforeKeys.has(projRow.key)) : afterKeys.has(key) === !on;
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
    t.ok('行を切ると、どのエージェントでも動かない（エージェントごとの選択は覚えたまま）', offAll.every(k => !k.has(reg.id)) && (await effAt()).off[reg.id]?.join() === CODEX);
    await ha.setRow({ key: reg.id, on: true, cwd: repo });
    t.ok('入れていないエージェント（OpenCode・Grok・agy・Devin）では登録は動かない', (await Promise.all([OPENCODE, GROK, AGY, DEVIN].map(a => turnKeys(a)))).every(k => !k.has(reg.id)));
    const dup = await plyHooks.save({ name: 'dup', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node user-stop.mjs --token SECRET-HA-1', targets: [CLAUDE] });
    await plyHooks.toggle(dup.id, true);
    await ha.setRow({ key: dup.id, on: true, cwd: repo });
    const dupTurn = await newTurn(CLAUDE);
    t.ok('動き続けるネイティブと同じ登録は渡さない（二重に動かさない。理由は duplicate）',
      !dupTurn.runtime.supplied.some(x => x.hook.id === dup.id) && dupTurn.record.skipped.some(s => s.id === dup.id && s.reason === 'duplicate'), JSON.stringify(dupTurn.record.skipped));
    // 切った行を押して入れるとき、覚えた選択へ戻すか（was）・覚えが無く元の集合へ戻すか（default）を一覧が言う（読み上げの言い分け）
    await ha.setRow({ key: dup.id, on: false, cwd: repo });
    const dupOff = (await ha.matrix({ cwd: repo })).rows.find(r => r.key === dup.id);
    const regKept = (await ha.matrix({ cwd: repo })).rows.find(r => r.key === reg.id);
    t.ok('切った行の一覧: 覚えたエージェントごとの選択がある行は rowRestore: was、覚えが無い行は default',
      !(await effAt()).off[dup.id]?.length && dupOff.unused === true && dupOff.rowRestore === 'default'
      && (await effAt()).off[reg.id]?.join() === CODEX && regKept.rowRestore === 'was', JSON.stringify({ dup: [dupOff.unused, dupOff.rowRestore], reg: regKept.rowRestore }));
    await ha.setRow({ key: dup.id, on: true, cwd: repo });
    const dupOn = (await ha.matrix({ cwd: repo })).rows.find(r => r.key === dup.id);
    t.ok('入れ直した行は切れるオンがあるので、押す向きは切る（rowChangeableOn）', dupOn.rowChangeableOn === true && dupOn.unused === false, JSON.stringify([dupOn.rowChangeableOn, dupOn.unused]));
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
    t.ok('使うに戻すと、場所の上書きは消える', !Object.values((await ha.read()).places).some(p => Object.values(p.rows ?? {}).some(r => 'skip' in r)));

    // ---------------------------------------------------------------- 読めないファイル（壊れた・知らない版）: 会話を断り、直す操作で退避して戻す
    const goodText = await fs.readFile(ha.file, 'utf8');
    t.ok('知らない版は読めない扱い', parseState({ version: 3 }) === null && parseState({ version: 1 }) === null && parseState({ version: 2 })?.version === 2);
    const brokenFiles = async () => (await fs.readdir(data)).filter(n => n.startsWith('hooks-agents.broken-')).sort();
    const sameTurn = (x, y) => JSON.stringify(x?.record?.supplied ?? null) === JSON.stringify(y?.record?.supplied ?? null) && (x === null) === (y === null);
    for (const [label, text, fix] of [['壊れた JSON', '{"version":1,', 'repair'], ['知らない版', JSON.stringify({ version: 3, off: {} }), 'reset']]) {
      await fs.writeFile(ha.file, goodText);
      await ha.read(); // このプロセスで読めた選択（止めるものがある）
      await fs.writeFile(ha.file, text);
      const fresh = createHooksAgents({ dataDir: data, hooksConfig, plyHooks, findNode, grokHome }); // 一度も読めていない
      const freshTurn = agent => prepareHooksTurn({ agent, cwd: repo, ctx: { plyHooks, hooksConfig, dataDir: data, findNode, grokHome, hooksAgents: fresh } });
      let e1 = null, e2 = null;
      try { await freshTurn(CLAUDE); } catch (e) { e1 = e; }
      try { await newTurn(CLAUDE); } catch (e) { e2 = e; }
      t.ok(`${label}: 会話を断る（読めた選択でも止めるものがあれば断る。hooks.json の担当が Pleiad のときと同じ側）`, e1?.code === 'HOOKS_REFUSED' && e2?.code === 'HOOKS_REFUSED', `${e1?.code} ${e2?.code}`);
      t.ok(`${label}: 断る文が、実際にある直す操作（画面の「壊れたファイルを退避して直す」= hooks.repair）と退避を案内する（画面に出さない hooks.resetAgents は案内しない）`, /hooks.repair/.test(e1?.message) && !/hooks.resetAgents/.test(e1?.message) && /hooks-agents.broken-/.test(e1?.message)
        && registry.get('hooks.repair') && registry.get('hooks.resetAgents'));
      const m = await ha.matrix({ cwd: repo });
      t.ok(`${label}: 一覧は投げずに unreadable と直す操作を返す（画面の Hooks のタブが出す）`, m.unreadable === true && m.rows.length === 0 && m.repair.join() === 'hooks.repair,hooks.resetAgents' && m.adopted === true, JSON.stringify(m).slice(0, 300));
      let changeErr = null;
      try { await ha.setRow({ key: stopRow.key, on: true }); } catch (e) { changeErr = e; }
      t.ok(`${label}: 読めないまま一覧を変える操作は断り、ファイルはそのまま`, changeErr?.code === 'UNREADABLE' && await fs.readFile(ha.file, 'utf8') === text);
      const before = await brokenFiles();
      const r = fix === 'repair' ? await ha.repair() : await ha.reset();
      const after = await brokenFiles();
      const added = after.filter(n => !before.includes(n));
      t.ok(`${label}: ${fix === 'repair' ? '修復' : '以前の担当へ戻す'}は、壊れたファイルを消さずに退避して残す（中身はそのまま）`, added.length === 1 && r.backup === path.join(data, added[0])
        && await fs.readFile(r.backup, 'utf8') === text && !await ha.exists(), JSON.stringify({ added, r }));
      t.ok(`${label}: 直した後は移行前（旧の担当）の動きに戻り、会話を始められる`, sameTurn(await newTurn(CLAUDE), await legacyTurn(CLAUDE)) && sameTurn(await freshTurn(CLAUDE), await legacyTurn(CLAUDE))
        && (await ha.matrix({ cwd: repo })).adopted === false);
      t.ok(`${label}: 読めるファイルなら修復は何もしない`, await ha.repair() === null);
    }
    // 読めた選択で、このターンに止めるもの・渡すものが無かったエージェントは続ける（hooks.json の、確かにエージェント任せだった場所だけ続けるのと同じ）
    await fs.writeFile(ha.file, goodText);
    const quiet = [];
    for (const A of [CLAUDE, CODEX, AGY, OPENCODE, DEVIN, GROK]) if (await ha.forTurn({ agent: A, cwd: repo }) === null) quiet.push(A);
    const loud = [CLAUDE, CODEX, AGY, OPENCODE, DEVIN, GROK].filter(A => !quiet.includes(A));
    await fs.writeFile(ha.file, '{');
    const quietOk = [], loudRefused = [];
    for (const A of quiet) quietOk.push(await newTurn(A).then(x => x === null, () => false));
    for (const A of loud) loudRefused.push(await newTurn(A).then(() => false, e => e.code === 'HOOKS_REFUSED'));
    t.ok('読めなくなっても、最後に読めた選択でそのターンに変えるものが無かったエージェントだけ続け、ほかは断る', quiet.length > 0 && loud.length > 0 && quietOk.every(Boolean) && loudRefused.every(Boolean), JSON.stringify({ quiet, loud, quietOk, loudRefused }));
    for (const n of await brokenFiles()) await fs.rm(path.join(data, n));
    await fs.writeFile(ha.file, goodText);
    await ha.reset();
    t.ok('移行前へ戻す: 読めるファイルは消し（退避しない）、旧の担当の動きへ戻る', !await ha.exists() && (await brokenFiles()).length === 0 && await newTurn(CLAUDE) === null);

    // ---------------------------------------------------------------- 書けない: 生の Node の誤り（EISDIR: illegal operation …）でなく利用者の言葉で返す
    // （読めて書けない状態は OS ごとに作り方が違う（同じ名前のフォルダーは読みでも UNREADABLE になる）ので、変換の部分を直に見る）
    const head = T('plyHooks.write.failed', { reason: '' }).trim();
    const raw = code => Object.assign(new Error(`${code}: illegal operation on a directory, open 'C:\\data\\hooks-agents.json'`), { code });
    const conv = Object.fromEntries(['EISDIR', 'EPERM', 'ENOSPC', 'EIO'].map(c => [c, hooksWriteFailed(raw(c), FILE_NAME)]));
    t.ok('書けないときは HOOKS_WRITE_FAILED で、文は「Hooks の設定を保存できませんでした」から始まり、Node の誤りの文とパスを出さない',
      Object.values(conv).every(e => e.code === 'HOOKS_WRITE_FAILED' && e.message.startsWith(head) && !/illegal operation|C:\\data/.test(e.message) && e.cause?.code),
      JSON.stringify(Object.values(conv).map(e => e.message)));
    t.ok('書けない理由ごとの文（同じ名前のフォルダー・開けない・空きが無い）はファイル名を示し、知らない理由はコードだけ添える',
      conv.EISDIR.message.includes(FILE_NAME) && conv.EPERM.message.includes(FILE_NAME) && conv.ENOSPC.message === T('plyHooks.write.failed', { reason: T('plyHooks.write.full') })
      && conv.EIO.message.includes('EIO') && hooksWriteFailed(conv.EISDIR, 'x') === conv.EISDIR);

    // ---------------------------------------------------------------- 渡せないセル（relay）
    const ss = await plyHooks.save({ name: 'ctx', agent: CLAUDE, event: 'SessionStart', matcher: '', command: 'node ctx.mjs', targets: [CLAUDE] });
    await plyHooks.toggle(ss.id, true);
    const mRelay = await ha.matrix({ cwd: repo });
    const relay = cell(mRelay, ss.id, CLAUDE);
    t.ok('Pleiad が渡せないセルは鍵（relay）で理由のコード付き（Claude の SessionStart はコールバックで渡せない）', relay.mode === 'locked' && relay.reason === 'relay' && relay.detail === 'claudeCallback', JSON.stringify(relay));
    // 入れても動くエージェントが無い行のスイッチは押せない（押しても変わらない、を作らない。ADR 0337 §決定 4）。理由は渡せないマスの鍵
    const relayRow = mRelay.rows.find(r => r.key === ss.id);
    const relayRefused = await ha.setRow({ key: ss.id, on: true, cwd: repo }).then(() => null, e => e.message);
    t.ok('入れても動くエージェントが無い行は、行のスイッチが鍵（switchLock は渡せないマスの理由）で、操作も断る',
      relayRow.on === false && relayRow.switchable === false && relayRow.switchLock?.detail === 'claudeCallback' && relayRow.switchLock?.agent === CLAUDE
      && typeof relayRefused === 'string' && relayRefused.includes(ss.id), JSON.stringify({ relayRow: { on: relayRow.on, switchable: relayRow.switchable, switchLock: relayRow.switchLock }, relayRefused }));
    // 断る知らせの {{agent}} は、内部のキー（claude）ではなく表のマスの吹き出しと同じ表示名（Claude）
    t.ok('行のスイッチを断る知らせは、鍵のエージェントを表示名（Claude）で呼ぶ。内部のキーのままにしない',
      typeof relayRefused === 'string' && relayRefused.includes(agentShortName(CLAUDE)) && agentShortName(CLAUDE) !== CLAUDE
      && relayRefused.includes(`${agentShortName(CLAUDE)} で動き続ける`), relayRefused);
    const cellRefused = await ha.setAgent({ key: ss.id, agent: CLAUDE, on: true, cwd: repo }).then(() => null, e => e.message);
    t.ok('鍵のマスを押したときの知らせも {{agent}} は表示名（Claude）',
      typeof cellRefused === 'string' && cellRefused.includes('Claude') && !cellRefused.replaceAll(ss.id, '').includes(CLAUDE), cellRefused);
    const relayTurn = await newTurn(CLAUDE);
    // 止めるものも渡すものも無ければ今までと同じ起動（null）。理由は一覧のセルが持つ
    t.ok('渡せない登録は渡さない（ほかに変えるものが無ければ起動は今までと同じ）', !(relayTurn?.runtime.supplied ?? []).some(x => x.hook.id === ss.id) && (relayTurn === null || relayTurn.record.unsupported.some(u => u.id === ss.id)), JSON.stringify(relayTurn?.record ?? null));
    await plyHooks.remove(ss.id);
    await ha.reset();

    // ---------------------------------------------------------------- 書き換えた定義へ選択を引き継ぐ（外した Hook を少し直してもオンに戻らない）
    {
      const rk = path.join(tmp, 'rekey'), rkHome = path.join(rk, 'home'), rkData = path.join(rk, 'data'), rkRepo = path.join(rk, 'repo');
      await fs.mkdir(path.join(rkRepo, '.git'), { recursive: true });
      const rkSettings = path.join(rkHome, '.claude', 'settings.json');
      const cmd = c => ({ hooks: [{ type: 'command', command: c }] });
      const put = (stop, pre = [{ matcher: 'Bash', ...cmd('node g.mjs') }]) => w(rkSettings, { hooks: { Stop: stop.map(cmd), PreToolUse: pre } });
      await put(['node a.mjs', 'node b.mjs']);
      const rkConfig = createHooksConfig({ home: rkHome, codexHome: path.join(rkHome, '.codex'), claudeHome: path.join(rkHome, '.claude'), geminiHome: path.join(rkHome, '.gemini'), claudeManaged: [] });
      const rkPly = createPlyHooks(rkData);
      const hb = createHooksAgents({ dataDir: rkData, hooksConfig: rkConfig, plyHooks: rkPly, findNode, grokHome: path.join(rk, 'grok-home') });
      const rowOf = (m, text) => m.rows.filter(r => r.kind === 'native' && r.agent === CLAUDE && r.command.includes(text));
      const one = (m, text) => { const r = rowOf(m, text); if (r.length !== 1) throw new Error(`rows for ${text}: ${r.length}`); return r[0]; };
      const runs = async () => new Set(((await hb.hooksForTurn(CLAUDE, rkRepo)) ?? []).map(x => x.key));
      let m = await hb.matrix({ cwd: rkRepo });
      const A = one(m, 'a.mjs'), B = one(m, 'b.mjs'), G = one(m, 'g.mjs');
      t.ok('行に hooks.scan の id を載せる（同じ定義が 1 つなら 1 つ）', A.scanIds?.length === 1 && typeof A.scanIds[0] === 'string'
        && (await rkConfig.scan({ cwd: rkRepo, scopes: ['user', 'directory'], managed: true })).entries.some(e => e.id === A.scanIds[0] && e.command.includes('a.mjs')), JSON.stringify(A.scanIds));
      await hb.setAgent({ key: A.key, agent: CLAUDE, on: false, cwd: rkRepo });
      await hb.setAgent({ key: G.key, agent: CLAUDE, on: false, cwd: rkRepo });
      const spreadCell = cell(await hb.matrix({ cwd: rkRepo }), B.key, CODEX);
      await hb.setAgent({ key: B.key, agent: CODEX, on: true, cwd: rkRepo });
      m = await hb.matrix({ cwd: rkRepo });
      t.ok('前提: A と G を Claude で外し、B を Codex へ広げた', cell(m, A.key, CLAUDE).state === 'off' && cell(m, G.key, CLAUDE).state === 'off' && cell(m, B.key, CODEX).state === 'on' && !m.orphans.length,
        JSON.stringify({ spreadCell, b: cell(m, B.key, CODEX) }));

      // (d) 足す・並べ替える: 行 ID は変わらず、新しい行に選択は付かない
      await put(['node c.mjs', 'node b.mjs', 'node a.mjs']);
      m = await hb.matrix({ cwd: rkRepo });
      const C = one(m, 'c.mjs');
      t.ok('(d) 前に足して並べ替えても、外した・広げた選択は元の定義のまま。足した行には付かない', cell(m, A.key, CLAUDE).state === 'off' && cell(m, B.key, CODEX).state === 'on'
        && cell(m, C.key, CLAUDE).state === 'on' && cell(m, C.key, CODEX).state !== 'on' && !m.orphans.length);

      // (a) コマンドを直す: 消えた 1 つと現れた 1 つが対応する → 外した状態を引き継ぐ（一覧も実行時も）
      await put(['node c.mjs', 'node b.mjs', 'node a.mjs --fixed']);
      m = await hb.matrix({ cwd: rkRepo });
      const A1 = one(m, 'a.mjs --fixed');
      const r1 = await runs();
      t.ok('(a) 外した Hook のコマンドを直しても外したまま（一覧と実行時）', A1.key !== A.key && cell(m, A1.key, CLAUDE).state === 'off' && !r1.has(A1.key) && r1.has(C.key) && !m.orphans.length,
        JSON.stringify({ cell: cell(m, A1.key, CLAUDE), orphans: m.orphans }));
      const saved1 = await hb.read();
      t.ok('(a) 一覧を開いたときに引き継ぎを保存する（元の ID は残らない）', effectiveAt(saved1, rkRepo).agents.off[A1.key]?.includes(CLAUDE) && !effectiveAt(saved1, rkRepo).agents.off[A.key]
        && !JSON.stringify(saved1).includes(A.key), JSON.stringify(saved1.places));
      // (a) matcher を直す
      await put(['node c.mjs', 'node b.mjs', 'node a.mjs --fixed'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      const G1 = one(m, 'g.mjs');
      t.ok('(a) matcher を直しても外したまま', G1.key !== G.key && cell(m, G1.key, CLAUDE).state === 'off' && !(await runs()).has(G1.key));
      // (a) 広げた状態も 1 対 1 なら引き継ぐ
      await put(['node c.mjs', 'node b.mjs --v2', 'node a.mjs --fixed'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      const B1 = one(m, 'b.mjs --v2');
      t.ok('(a) 広げた Hook を 1 つだけ直したときは、広げた状態も引き継ぐ', cell(m, B1.key, CODEX).state === 'on' && !m.orphans.length);

      // 壊れている間（書きかけ）は何も動かさない
      await w(rkSettings, '{ "hooks": { "Stop": [');
      m = await hb.matrix({ cwd: rkRepo });
      await put(['node c.mjs', 'node b.mjs --v2', 'node a.mjs --fixed'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      const m2 = await hb.matrix({ cwd: rkRepo });
      t.ok('設定ファイルが壊れている間は、選択を移さず捨てず、直れば元のとおり', !m.orphans.length && cell(m2, A1.key, CLAUDE).state === 'off' && cell(m2, B1.key, CODEX).state === 'on' && !m2.orphans.length);

      // (d) 同じ定義が 2 つ: 1 つだけ書き換えると、書き換えた方も外したまま（残った方も外したまま）
      await put(['node c.mjs', 'node b.mjs --v2', 'node a.mjs --fixed', 'node a.mjs --fixed'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      t.ok('(d) 同じ定義を 2 つにしても 1 行（scan の id は 2 つ）で、外したまま', one(m, 'a.mjs --fixed').scanIds.length === 2 && cell(m, A1.key, CLAUDE).state === 'off' && !m.orphans.length);
      await put(['node c.mjs', 'node b.mjs --v2', 'node a.mjs --fixed', 'node a.mjs --copy'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      const A2 = one(m, 'a.mjs --copy');
      t.ok('(d) 2 つのうち 1 つだけ書き換えた: 両方とも外したまま', cell(m, A2.key, CLAUDE).state === 'off' && cell(m, A1.key, CLAUDE).state === 'off' && !m.orphans.length);

      // (d) 既にある定義と同じに書き換えた: 別の Hook（B）に外した状態を付けない。行き先の無い選択として返す
      await put(['node c.mjs', 'node b.mjs --v2', 'node a.mjs --fixed', 'node b.mjs --v2'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      const lostA2 = m.orphans.find(o => o.key === A2.key);
      t.ok('(d) 既にある定義と同じになった: その定義（広げた B）に外した状態は付かず、行き先の無い選択として返す', cell(m, B1.key, CLAUDE).state === 'on' && cell(m, B1.key, CODEX).state === 'on'
        && lostA2?.reason === 'ambiguous' && lostA2.off.includes(CLAUDE) && lostA2.agent === CLAUDE && lostA2.event === 'Stop' && lostA2.path === rkSettings, JSON.stringify(m.orphans));

      // (b)(c) 2 つを同時に直した: 対応を決められないので引き継がない（広げた状態も実行する側へ倒さない）。行き先の無い選択と候補を返す
      await put(['node c.mjs', 'node b.mjs --v3', 'node a.mjs --v3'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      const B3 = one(m, 'b.mjs --v3'), A3 = one(m, 'a.mjs --v3');
      const lost = Object.fromEntries(m.orphans.map(o => [o.key, o]));
      t.ok('(b) 対応が決められないときは引き継がず、行き先の無い選択（理由・候補・中身）を返す', lost[A1.key]?.reason === 'ambiguous' && lost[B1.key]?.reason === 'ambiguous'
        && lost[A1.key].candidates.includes(A3.key) && lost[A1.key].candidates.includes(B3.key) && lost[B1.key].spread.includes(CODEX), JSON.stringify(m.orphans));
      t.ok('(c) 広げた状態はあいまいなら引き継がない（ほかのエージェントで実行する側へ倒さない）', cell(m, B3.key, CODEX).state !== 'on' && cell(m, A3.key, CODEX).state !== 'on');
      t.ok('(b) 行き先の無い選択は、選択を変えた後も残る（黙って捨てない）', (await hb.setAgent({ key: C.key, agent: CLAUDE, on: false, cwd: rkRepo }), (await hb.matrix({ cwd: rkRepo })).orphans.some(o => o.key === A1.key && o.reason === 'ambiguous')));
      // 消した: 行き先が無い（gone）。残った定義には付かない
      await put(['node c.mjs', 'node b.mjs --v3'], [{ matcher: 'Bash|Edit', ...cmd('node g.mjs') }]);
      m = await hb.matrix({ cwd: rkRepo });
      t.ok('(d) 選択の無い行を消しても、ほかの行の選択は付け替わらず、前の行き先の無い選択は残る', m.orphans.some(o => o.key === A3.key) === false && cell(m, B3.key, CLAUDE).state === 'on' && cell(m, C.key, CLAUDE).state === 'off'
        && m.orphans.some(o => o.key === A1.key), JSON.stringify(m.orphans.map(o => [o.key, o.reason])));
      await fs.writeFile(rkSettings, JSON.stringify({ hooks: { Stop: [cmd('node c.mjs')] } }));
      // Claude の定義の行は Devin が取り込む（devinImports の鍵つきでオン）。この試験はマスで 1 つずつ書き込む
      await hb.setAgent({ key: C.key, agent: CLAUDE, on: false, cwd: rkRepo });
      m = await hb.matrix({ cwd: rkRepo });
      t.ok('(d) 外していない行を消しても、外した行の選択は付け替わらない', cell(m, C.key, CLAUDE).state === 'off');
      t.ok('(b) 外した行を消した（現れた行が無い）: 行き先の無い選択（gone）として返す', m.orphans.some(o => o.key === G1.key && o.reason === 'gone' && o.event === 'PreToolUse' && o.off.includes(CLAUDE)), JSON.stringify(m.orphans.map(o => [o.key, o.reason])));
      t.ok('覚えた組は revision に入れない（一覧を開いて保存しても版は変わらない）', (await hb.matrix({ cwd: rkRepo })).revision === m.revision);
    }

    // ---------------------------------------------------------------- 行のスイッチ（指示・Skills の行のスイッチと同じ決まり。ADR 0337・0338）
    {
      const rowOf = (mm, k) => mm.rows.find(r => r.key === k);
      const states = (mm, k) => Object.fromEntries(AGENTS.filter(a => rowOf(mm, k).cells[a]).map(a => [a, cell(mm, k, a).state]));
      let m = await ha.matrix({ cwd: repo });
      // (b) 任せるから移る前の登録（どのエージェントでも動いていない）: 戻す先が無いので元の集合（targets）だけで入る。ほかへは広げない
      t.ok('行のスイッチ（移行前）: 任せるの登録は切れていて押せる', !await ha.exists() && rowOf(m, reg.id).on === false && rowOf(m, reg.id).switchable === true, JSON.stringify(rowOf(m, reg.id)));
      await ha.setRow({ key: reg.id, on: true, cwd: repo, expect: m.revision });
      m = await ha.matrix({ cwd: repo });
      t.ok('戻す先の無い行を入れる: 元の集合（登録の targets の Claude・Codex）だけが入り、ほかのエージェントへは広げない',
        cell(m, reg.id, CLAUDE).state === 'on' && cell(m, reg.id, CODEX).state === 'on' && [OPENCODE, GROK, AGY, DEVIN].every(a => cell(m, reg.id, a)?.state !== 'on'), JSON.stringify(states(m, reg.id)));
      // (g) すでにオンの行を入れても変えない
      const onAgain = JSON.stringify(m.rows.map(r => [r.key, states(m, r.key)]));
      await ha.setRow({ key: reg.id, on: true, cwd: repo });
      const m2 = await ha.matrix({ cwd: repo });
      t.ok('すでにオンの行を入れても、どのマスも変わらない', JSON.stringify(m2.rows.map(r => [r.key, states(m2, r.key)])) === onAgain);
      // (e) 組の列のスイッチは、広げる確認の要るマスを入れない（確認はマスで 1 つずつ）
      const wide = [OPENCODE, GROK, AGY, DEVIN].find(a => cell(m, reg.id, a)?.mode === 'toggle' && cell(m, reg.id, a).needsConfirm);
      t.ok('登録にはほかのエージェントへ広げるマス（確認の要るマス）がある', !!wide, JSON.stringify(Object.fromEntries(AGENTS.map(a => [a, cell(m, reg.id, a)]))));
      await ha.setGroup({ group: 'ply', agent: wide, on: true, cwd: repo });
      m = await ha.matrix({ cwd: repo });
      t.ok('組の列を入れても、確認の要るマス（広げる）は入らない', cell(m, reg.id, wide).state === 'off', `${wide} ${JSON.stringify(cell(m, reg.id, wide))}`);
      // (a) 切ってから入れると、エージェントごとの選択（Codex を切った・ほかへ広げた）に戻る
      await ha.setAgent({ key: reg.id, agent: CODEX, on: false, cwd: repo });
      await ha.setAgent({ key: reg.id, agent: wide, on: true, cwd: repo });
      m = await ha.matrix({ cwd: repo });
      const picked = JSON.stringify(states(m, reg.id));
      await ha.setRow({ key: reg.id, on: false, cwd: repo });
      m = await ha.matrix({ cwd: repo });
      t.ok('行を切る: どのエージェントでも切れ、行は off', rowOf(m, reg.id).on === false && Object.values(states(m, reg.id)).every(v => v !== 'on'), JSON.stringify(states(m, reg.id)));
      await ha.setRow({ key: reg.id, on: true, cwd: repo });
      m = await ha.matrix({ cwd: repo });
      t.ok('行を入れ直す: 覚えた選択（Codex は切ったまま・広げた先は入ったまま）に戻る', JSON.stringify(states(m, reg.id)) === picked
        && cell(m, reg.id, CODEX).state === 'off' && cell(m, reg.id, wide).state === 'on', `${picked} → ${JSON.stringify(states(m, reg.id))}`);
      // (c) 切っても鍵つきでオンが残る行（Claude の定義は Devin が取り込む）: 押せる。切れるオンだけを一緒に切り、鍵つきのオン（Devin）は残す（ADR 0337 §決定 4・A′）
      const stopSw = rowOf(m, stopRow.key);
      t.ok('鍵つきでオンのマスが残る行（Claude の定義 × Devin の取り込み）: 一部オン（rowMixed でなくてよい）・鍵つきのオンが残り（rowFixed）、切れるオンがあり、押せる',
        stopSw.on === true && stopSw.switchable === true && stopSw.rowFixed === true && stopSw.rowChangeableOn === true && stopSw.rowNextOn === false
        && cell(m, stopRow.key, DEVIN).state === 'on' && cell(m, stopRow.key, DEVIN).mode === 'locked', JSON.stringify({ stopSw: { on: stopSw.on, sw: stopSw.switchable, lock: stopSw.switchLock, fixed: stopSw.rowFixed, ch: stopSw.rowChangeableOn, next: stopSw.rowNextOn }, cells: states(m, stopRow.key) }));
      const stopBefore = states(m, stopRow.key);
      await ha.setRow({ key: stopRow.key, on: false, cwd: repo });
      m = await ha.matrix({ cwd: repo });
      const stopCut = rowOf(m, stopRow.key);
      t.ok('その行を切る: 切れるオン（Claude）だけが切れ、鍵つきのオン（Devin の取り込み）は残る。行は鍵つきだけが動くので、押すと入れる向き',
        cell(m, stopRow.key, CLAUDE).state === 'off' && cell(m, stopRow.key, DEVIN).state === 'on' && stopCut.on === true
        && stopCut.rowFixed === true && stopCut.rowChangeableOn === false && stopCut.rowNextOn === true && stopCut.switchable === true, JSON.stringify({ was: stopBefore, now: states(m, stopRow.key), fixed: stopCut.rowFixed, ch: stopCut.rowChangeableOn, sw: stopCut.switchable, lock: stopCut.switchLock }));
      t.ok('鍵つきのオン（Devin）は切る前と同じ（切る操作が触らない）', cell(m, stopRow.key, DEVIN).state === stopBefore[DEVIN]);
      // 切れるオンが無く、鍵つきのオンだけが動く行（切った後の Claude の Stop。Devin の取り込みだけが残る）: 切る向きで押しても変えるものが無い。
      // rowSwitchPlan は idle の鍵（idleLock）を返し、setRow は INVALID で断る。ファイルも revision も変わらない（Devin の表示名で理由を言う）
      const idleFile = await fs.readFile(ha.file, 'utf8');
      const idleRev = m.revision;
      const idleErr = await ha.setRow({ key: stopRow.key, on: false, cwd: repo }).then(() => null, e => e);
      const idleAfter = await ha.matrix({ cwd: repo });
      t.ok('切れるオンが無い行（鍵つきのオンだけが動く）を切る向きで押すと、setRow は INVALID で断り、ファイルも revision も変えない（idleLock）',
        idleErr?.code === 'INVALID' && idleErr.message.includes(stopRow.key) && idleErr.message.includes('Devin')
        && await fs.readFile(ha.file, 'utf8') === idleFile && idleAfter.revision === idleRev, JSON.stringify({ code: idleErr?.code, msg: idleErr?.message }));
      await ha.setRow({ key: stopRow.key, on: stopCut.rowNextOn, cwd: repo });
      m = await ha.matrix({ cwd: repo });
      t.ok('もう一度押すと、切る前の選択に戻る（鍵つきのオンはそのまま）', JSON.stringify(states(m, stopRow.key)) === JSON.stringify(stopBefore) && rowOf(m, stopRow.key).rowChangeableOn === true, `${JSON.stringify(stopBefore)} → ${JSON.stringify(states(m, stopRow.key))}`);
      const wsRow = rowOf(m, WS_KEY);
      t.ok('作業場所の 1 行は、Devin が取り込む（鍵つきのオン）と切れるマスの両方を持つので、切る向きで押せる', wsRow.rowFixed === true && wsRow.switchable === true, JSON.stringify({ lock: wsRow.switchLock ?? null, fixed: wsRow.rowFixed, ch: wsRow.rowChangeableOn, cells: states(m, WS_KEY) }));
      // (d) 管理者の行
      t.ok('管理者の行: 行のスイッチは鍵（admin）', rowOf(m, adminRow.key).switchable === false && rowOf(m, adminRow.key).switchLock?.reason === 'admin');
      // (f) 組の行のスイッチ: 変えるものの無い行は飛ばし、ほかの行が黙って止まる行があれば、どれも変えずに断る（1 回の書き込み。半分だけ入った状態を作らない）
      const ownRows = mm => mm.rows.filter(r => r.group === 'own' && r.kind !== 'grokOwn' && r.scope !== 'managed');
      const snap = mm => JSON.stringify(mm.rows.map(r => [r.key, states(mm, r.key)]));
      const groupCut = await ha.setGroup({ group: 'own', on: false, cwd: repo }).then(() => 'ok', e => e);
      m = await ha.matrix({ cwd: repo });
      t.ok('組の行のスイッチ（切る）: 切れるオンを全部切り、鍵つきのオン（Devin の取り込み）は残す。断らない',
        groupCut === 'ok' && ownRows(m).every(r => r.rowChangeableOn === false)
        && cell(m, stopRow.key, CLAUDE).state === 'off' && cell(m, stopRow.key, DEVIN).state === 'on' && cell(m, codexRow.key, CODEX).state === 'off',
        JSON.stringify({ groupCut: groupCut?.message ?? groupCut, rows: ownRows(m).map(r => [r.key, r.rowChangeableOn, states(m, r.key)]) }));
      const cutSnap = snap(m);
      const idleRows = ownRows(m).filter(r => r.rowFixed === true && r.rowChangeableOn === false && r.on === true);
      const groupAgain = await ha.setGroup({ group: 'own', on: false, cwd: repo }).then(() => 'ok', e => e);
      m = await ha.matrix({ cwd: repo });
      t.ok('切れるオンが無い行（鍵つきのオンだけが動く）が組にあっても、変えるものが無い行は飛ばして断らず、何も変えない（rowSwitchPlan の idle）',
        idleRows.length >= 1 && groupAgain === 'ok' && snap(m) === cutSnap, JSON.stringify({ idle: idleRows.map(r => r.key), groupAgain: groupAgain?.message ?? groupAgain }));
      await ha.setGroup({ group: 'own', on: true, cwd: repo });
      // ほかの行が黙って止まる行（Claude はどれか 1 つを切ると、渡し直せない行（SessionStart のコールバック）が一緒に止まる）が組にあれば、どれも変えずに断る
      const claudeSettingsText = await fs.readFile(claudeSettings, 'utf8');
      await w(claudeSettings, { hooks: { ...JSON.parse(claudeSettingsText).hooks, SessionStart: [{ hooks: [{ type: 'command', command: 'node user-start.mjs' }] }] } });
      m = await ha.matrix({ cwd: repo });
      const startRow = m.rows.find(r => r.kind === 'native' && r.event === 'SessionStart' && r.agent === CLAUDE && r.scope === 'user');
      const silentFile = await fs.readFile(ha.file, 'utf8').catch(() => '');
      const silentRev = m.revision;
      const silentSnap = snap(m);
      const silentRow = await ha.setRow({ key: stopRow.key, on: false, cwd: repo }).then(() => 'ok', e => e);
      const silentGroup = await ha.setGroup({ group: 'own', on: false, cwd: repo }).then(() => 'ok', e => e);
      const silentAfter = await ha.matrix({ cwd: repo });
      t.ok('渡し直せない行がある Claude の行を切る向きで押すと、ほかの行が黙って止まるので、setRow も組の setGroup も INVALID で断り、ほかの行も変えない（revision・ファイル・どのマスもそのまま）',
        !!startRow && silentRow?.code === 'INVALID' && silentGroup?.code === 'INVALID' && silentAfter.revision === silentRev
        && await fs.readFile(ha.file, 'utf8').catch(() => '') === silentFile && snap(silentAfter) === silentSnap && cell(silentAfter, codexRow.key, CODEX).state === 'on',
        JSON.stringify({ start: !!startRow, row: silentRow?.message ?? silentRow, group: silentGroup?.message ?? silentGroup, sw: rowOf(m, stopRow.key).switchable, lock: rowOf(m, stopRow.key).switchLock }));
      await fs.writeFile(claudeSettings, claudeSettingsText);
      m = await ha.matrix({ cwd: repo });
      // 一覧の行のスイッチ（on）は、鍵つきでオンのマスも数える
      t.ok('行の on: 鍵つきでオンのマスだけが動いていても on', m.rows.every(r => r.on === Object.values(r.cells).some(c => c.state === 'on')));
      await ha.reset();
    }


    // ---------------------------------------------------------------- 操作（hooks.*）
    const calls = [];
    const deps = { locale: 'ja', calls, modeOf: async () => deps.mode, audit: async e => calls.push(['audit', e.op, e.risk]),
      approve: async req => { calls.push(['approve', req.op]); return { pending: true, requestId: 'setting-x' }; },
      sessionCwd: async () => repo, sessionBackend: async () => CLAUDE,
      hooks: { agents: ha, view: async () => null, setOwner: async () => { calls.push(['setOwner']); return { ok: true }; },
        unifyPreview: async () => { calls.push(['unifyPreview']); return { revision: 'r' }; }, copy: async () => { calls.push(['copy']); return { results: [] }; } } };
    const legacyOps = [['hooks.setOwner', { place: repo, value: { owner: 'ply' } }], ['hooks.setOwner', { place: null, value: { owner: 'ply' }, imports: [{ id: 'x', digest: 'y' }] }],
      ['hooks.unifyPreview', { cwd: repo }], ['hooks.copy', { source: { agent: CLAUDE }, targets: [{ agent: CODEX }], dryRun: true }], ['hooks.copy', { source: { agent: CLAUDE }, targets: [{ agent: CODEX }] }]];
    const asHuman = (id, args) => registry.invoke({ by: 'human', via: 'ui', local: true }, id, args, deps);
    const passed = [];
    for (const [id, args] of legacyOps) { const r = await asHuman(id, args); if (r.ok) passed.push(id); }
    t.ok('移行前: 旧い担当の操作（担当・場所ごとの担当・取り込み・切り替えの確認・写す）は今までどおり通る', passed.length === legacyOps.length && !await ha.exists(), passed.join());
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
    // 移行済み: 旧い担当の操作は効かないので、理由と新しい操作の名前で断る（承認のカードを出す前・中身を呼ぶ前）
    const before2 = calls.length;
    const moved = [];
    for (const [id, args] of legacyOps) moved.push(await asHuman(id, args), await as('ask', id, args));
    t.ok('移行済み: 旧い担当の操作は、人の画面からも agent からも HOOKS_MOVED で断り、中身も承認のカードも呼ばない', await ha.exists() && moved.every(r => r.ok === false && r.code === 'HOOKS_MOVED')
      && !calls.slice(before2).some(c => ['setOwner', 'unifyPreview', 'copy', 'approve'].includes(c[0])), JSON.stringify(moved.find(r => r.code !== 'HOOKS_MOVED') ?? null));
    t.ok('断りの文は、何をすればよいか（一覧の操作の名前・戻す操作）を示す', ['hooks.matrix', 'hooks.setAgent', 'hooks.setRow', 'hooks.setGroup', 'hooks.setPlace', 'hooks.resetAgents'].every(n => moved[0].error.includes(n))
      && moved[0].error.includes('hooks.setOwner'), moved[0].error);
    const resetOp = await as('bypass', 'hooks.resetAgents', {});
    t.ok('hooks.resetAgents: 移行前へ戻す', resetOp.ok && !await ha.exists());
    t.ok('移行前へ戻すと、旧い担当の操作はまた通る', (await asHuman('hooks.setOwner', { place: repo, value: { owner: 'ply' } })).ok);
    // ---------------------------------------------------------------- Devin の取り込みが止まり始める操作（3 回目のレビューの必須）
    // 旧「そろえる」で Devin へ向けた登録がある人の、実際の移行結果から: 止まっていない状態から止まる状態へ変える操作は、どの入口でも
    // 一覧が印を付け（セル stopsDevinImports・行 switchConfirm・この場所で使う here.confirm）、試算（dry）・承認のカード・戻りが知らせる
    {
      const other = path.join(tmp, 'other');
      await fs.mkdir(other, { recursive: true });
      const both = await plyHooks.save({ name: 'both', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node both.mjs', targets: [CLAUDE, DEVIN] });
      const only = await plyHooks.save({ name: 'only', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node only.mjs', targets: [DEVIN] });
      await plyHooks.setOwner({ place: repo, value: null });
      // 全体を先に「そろえる」にしてから、other だけ「任せる」（全体と同じ値の場所は保存のときに畳まれる）
      await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
      await plyHooks.setOwner({ place: other, value: { owner: 'native' } });
      const stopText = T('opsApproval.hooksDevinImportsStop', { note: '' }).trim();
      const rowOf = (m, k) => m.rows.find(r => r.key === k);
      const stops = (m, k) => cell(m, k, DEVIN).stopsDevinImports === true && cell(m, k, DEVIN).needsConfirm === true && warnCodes(m, k).includes('devinImportsStop');
      const m0 = await ha.matrix({ cwd: repo });
      t.ok('移行の結果の一覧: 元の対象に Devin を含む行の Devin のマス（広げる確認は要らない）も、入れると取り込みが止まり始めるので確認の印（stopsDevinImports）',
        !(await ha.exists()) && cell(m0, both.id, DEVIN).state === 'off' && stops(m0, both.id), JSON.stringify(cell(m0, both.id, DEVIN)));
      t.ok('Devin だけの行の行スイッチにも印（switchConfirm・devinImportsStop）。入っている行・Devin の無い行には付かない',
        rowOf(m0, only.id).switchConfirm?.warnings?.[0]?.code === 'devinImportsStop' && !rowOf(m0, both.id).switchConfirm && !rowOf(m0, reg.id).switchConfirm,
        JSON.stringify(rowOf(m0, only.id)));
      const mOther = await ha.matrix({ cwd: other });
      t.ok('取り込みの止まらない場所（任せるの場所の上書き）では、同じマスに止まる印を付けない',
        cell(mOther, both.id, DEVIN).stopsDevinImports !== true && !rowOf(mOther, only.id).switchConfirm, JSON.stringify(cell(mOther, both.id, DEVIN)));
      const dry = [await ha.setAgent({ key: both.id, agent: DEVIN, on: true, cwd: repo, dry: true }), await ha.setRow({ key: only.id, on: true, cwd: repo, dry: true }),
        await ha.setGroup({ group: 'ply', on: true, cwd: repo, dry: true }), await ha.setGroup({ group: 'ply', agent: DEVIN, on: true, cwd: repo, dry: true })];
      const dryOther = await ha.setAgent({ key: both.id, agent: DEVIN, on: true, cwd: other, dry: true });
      t.ok('試算（dry）: マス・行・まとまり（全体・Devin だけ）は devinImportsStop。止まらない場所では false。何も書かない',
        dry.every(r => r.devinImportsStop === true) && dryOther.devinImportsStop === false && !(await ha.exists()), JSON.stringify({ dry, dryOther }));

      // AI・CLI（hooks.set*）: 承認待ちになり、カードの文が取り込みが止まることを知らせる
      let lastReq = null;
      const approve0 = deps.approve;
      deps.approve = async req => { lastReq = req; return approve0(req); };
      const noteOf = async (op, args) => { lastReq = null; const r = await card(op, args); return r ? String(lastReq?.change?.note ?? '') : null; };
      const notes = { agent: await noteOf('hooks.setAgent', { key: both.id, agent: DEVIN, on: true }), row: await noteOf('hooks.setRow', { key: only.id, on: true }),
        group: await noteOf('hooks.setGroup', { group: 'ply', on: true }), groupDevin: await noteOf('hooks.setGroup', { group: 'ply', agent: DEVIN, on: true }) };
      const plain = await noteOf('hooks.setAgent', { key: reg.id, agent: CLAUDE, on: true });
      t.ok('hooks.setAgent（元の対象に Devin を含む行の Devin）・setRow（Devin だけの行）・setGroup: 承認待ちになり、カードの文に取り込みが止まること',
        Object.values(notes).every(n => n !== null && n.includes(stopText)) && plain !== null && !plain.includes(stopText) && !(await ha.exists()), JSON.stringify({ notes, plain }));
      const ran = await as('bypass', 'hooks.setAgent', { key: both.id, agent: DEVIN, on: true });
      t.ok('承認されて動いた操作の戻りに devinImportsStop、実際に取り込みが止まる（devinImportsStopped）',
        ran.ok && ran.result.devinImportsStop === true && await ha.devinImportsStopped(repo) === true, JSON.stringify(ran));
      const m1 = await ha.matrix({ cwd: repo });
      const second = await as('bypass', 'hooks.setRow', { key: only.id, on: true });
      t.ok('既に止まっている場所: 2 つ目の Devin のマス・行には止まる印を付けず、戻りにも devinImportsStop を付けない',
        cell(m1, only.id, DEVIN).stopsDevinImports !== true && !rowOf(m1, only.id).switchConfirm && second.ok && second.result.devinImportsStop === undefined,
        JSON.stringify({ cell: cell(m1, only.id, DEVIN), second }));
      await ha.setAgent({ key: both.id, agent: DEVIN, on: false, cwd: repo });
      await ha.setRow({ key: only.id, on: false, cwd: repo });
      const m2 = await ha.matrix({ cwd: repo });
      t.ok('Devin のマスを切って取り込みが戻ると、もう一度入れるときにまた印が付く（聞き直す）', await ha.devinImportsStopped(repo) === false && stops(m2, both.id));

      // この場所で使う（setPlace use: true）: この場所だけ外していた Devin の行を戻すと止まり始める
      // 形式 2: 上の setRow（cwd: repo）は repo に「使っていない」の差分を書いた。入れ直すのも repo で（全体を入れても repo の差分が勝つ）。その後でこの場所だけ外す
      await ha.setRow({ key: only.id, on: true, cwd: repo });
      await ha.setPlace({ place: repo, key: only.id, use: false });
      const m3 = await ha.matrix({ cwd: repo });
      const placeDry = await ha.setPlace({ place: repo, key: only.id, use: true, dry: true });
      const placeNote = await noteOf('hooks.setPlace', { place: repo, key: only.id, use: true });
      t.ok('この場所で使う: 押すと止まり始める行に here.confirm、試算は devinImportsStop、承認のカードの文も知らせる',
        await ha.devinImportsStopped(repo) === false && rowOf(m3, only.id).here?.use === false && rowOf(m3, only.id).here?.confirm?.warnings?.[0]?.code === 'devinImportsStop'
        && placeDry.devinImportsStop === true && placeNote?.includes(stopText), JSON.stringify({ here: rowOf(m3, only.id).here, placeDry, placeNote }));
      const placed = await as('bypass', 'hooks.setPlace', { place: repo, key: only.id, use: true });
      t.ok('この場所で使う: 戻りに devinImportsStop、その場所で取り込みが止まる', placed.ok && placed.result.devinImportsStop === true && await ha.devinImportsStopped(repo) === true, JSON.stringify(placed));

      // 元に戻す（setPlace reset: true）: 止まらない場所の上書き（任せる）を消して、止まっている全体へ戻ると止まり始める
      // 形式 2: 上の repo での操作は repo の差分に残る（全体は変えない）。全体で Devin へ入れておき、other の上書きを消すと全体を受け継いで止まり始める
      await ha.setAgent({ key: both.id, agent: DEVIN, on: true });
      const resetDry = await ha.setPlace({ place: other, reset: true, dry: true });
      const resetNote = await noteOf('hooks.setPlace', { place: other, reset: true });
      const resetRan = await as('bypass', 'hooks.setPlace', { place: other, reset: true });
      t.ok('場所の上書きを戻す（reset）: 試算・承認のカード・戻りが知らせ、その場所で取り込みが止まる',
        resetDry.devinImportsStop === true && resetNote?.includes(stopText) && resetRan.ok && resetRan.result.devinImportsStop === true && await ha.devinImportsStopped(other) === true,
        JSON.stringify({ resetDry, resetNote, resetRan }));
      deps.approve = approve0;
      await ha.reset();
      await plyHooks.setOwner({ place: other, value: null });
      await plyHooks.setOwner({ place: null, value: { owner: 'native' } });
      await plyHooks.remove(both.id);
      await plyHooks.remove(only.id);
    }
    t.ok('利用者の設定ファイルは最後まで書き換えない', await userUnchanged());
  } finally {
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-hooks-agents-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
