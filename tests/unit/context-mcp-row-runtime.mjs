// 外部 MCP の行のスイッチを実際の配り先で確かめる（ADR 0337 §決定 4 の 2026-11-17 改訂・承認済みの ToBe-A′）:
//   行をオフにすると、変えられるエージェントの設定が実際に外れ（実行時に使えなくなり）、鍵つき（止められない）のエージェントは変わらない。
//   もう一度押すと、外す前の組が実行時にも戻る。アイコン（context.setMcpAgent）との組み合わせでも画面と実行時が食い違わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCAN, legacyPlan } from '../../core/context-settings.mjs';
import { resolveRuntime } from '../../core/context-runtime.mjs';
import { scanContext } from '../../core/context-scan.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';
import { AGENT_ORDER, canStopName } from '../../core/context-mcp-matrix.mjs';
import { createMcpWas } from '../../core/context-mcp-was.mjs';
import { setMcpOffLinker } from '../../core/backends/mcp-off-home.mjs';
import { contextOps } from '../../core/ops/context.mjs';

export const name = 'context-mcp-row-runtime';
export const title = '外部 MCP の行のスイッチ: オフで実行時に使えなくなる（鍵つきは変わらない）・戻すと実行時も戻る';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-rowrt-'));
  try {
    setMcpOffLinker(() => {}); // リンクを作れる PC として数える
    const op = id => contextOps.find(o => o.id === id);
    const cwd = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
    const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    // shared: Claude・Codex・Grok の設定にある名前（Grok は止める手が無い＝鍵つきでオン）。reg: Pleiad の登録だけ
    await write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { shared: { command: 'shared' } } }));
    await write(path.join(home, '.codex/config.toml'), '[mcp_servers.shared]\ncommand = "shared"\n');
    await write(path.join(home, '.grok/config.toml'), '[mcp_servers.shared]\ncommand = "shared"\n');
    const def = c => ({ transport: 'stdio', command: c, args: [] });
    const plyServers = { file: path.join(tmp, 'ply-mcp.json'), servers: [{ name: 'reg', definition: def('reg') }] };
    const all = ['common', 'claude', 'codex', 'opencode', 'devin', 'grok', 'antigravity'];
    const scope = { ...DEFAULT_SCAN, sources: all };
    const ids = AGENT_ORDER.filter(id => AGENTS[id]);

    const scan = await scanContext({ cwd, plan: { user: { roots: [], kinds: { instruction: null, skill: null, mcp: { sources: all.filter(s => s !== 'common'), excludePaths: [] } } },
      directory: { roots: [], kinds: { instruction: null, skill: null, mcp: { sources: all.filter(s => s !== 'common'), excludePaths: [] } } }, mcp: { disabled: [], prefer: {} }, skill: { prefer: {} } } }, { home });
    const native = Object.fromEntries(ids.map(id => [id, []]));
    for (const e of scan.entries) {
      if (e.kind !== 'mcp') continue;
      for (const source of new Set(e.origins.map(o => o.source))) for (const id of ids) {
        if (!(AGENTS[id].contextSources ?? []).filter(s => s !== 'common').includes(source)) continue;
        if (native[id].some(s => s.name === e.name)) continue;
        native[id].push({ name: e.name, transport: e.transport, scope: e.scope, scopes: e.status === 'disabled' ? [] : [e.scope], disabled: e.status === 'disabled' });
      }
    }
    const ownEnabled = (id, n) => native[id].some(s => s.name === n && !s.disabled);
    const stoppable = (id, n) => canStopName(id, n, native[id].find(s => s.name === n)?.scopes);
    const owners = ids.filter(id => ownEnabled(id, 'shared'));
    const fixed = owners.filter(id => !stoppable(id, 'shared'));
    const changeable = owners.filter(id => stoppable(id, 'shared'));
    t.ok('前提: shared を持つエージェントのうち、止められない物（鍵つき）と止められる物がある', fixed.length >= 1 && changeable.length >= 2, JSON.stringify({ owners, fixed, changeable }));

    // 実際の ctx と同じ形（保存は kindValue に入れる）
    let kindValue = { owner: 'ply', user: null, directory: null, agents: { off: {}, spread: {} } };
    const store = createMcpWas(path.join(tmp, 'data'));
    const ctx = {
      actor: { kind: 'human' },
      context: {
        view: async () => ({ defaults: { kinds: { instruction: { value: { owner: 'native' } }, skill: { value: { owner: 'native' } }, mcp: { value: kindValue } } }, places: [] }),
        agentMcp: async () => ({ agents: native }),
        claudeExtras: async () => ({ plugins: [], connectors: [], reading: false, readFailed: false }),
        set: async args => { kindValue = structuredClone(args.value); return { defaults: {} }; },
        mcpRestore: store,
      },
      mcp: { list: async () => ({ servers: plyServers.servers.map(s => ({ name: s.name, transport: 'stdio' })) }) },
    };
    const press = (n, on) => op('context.setMcpRow').handler(ctx, { name: n, on }).then(r => r, e => e);
    const icon = (n, agent, on) => op('context.setMcpAgent').handler(ctx, { name: n, agent, on }).then(r => r, e => e);
    const rowOf = async n => (await op('context.mcpMatrix').handler(ctx, {})).rows.find(r => r.key === n);

    // 実行時に使えるか（core/context-runtime.mjs の suppress と、止められない自分の定義の残り方）
    const usableAt = (rt, id, n) => rt.servers.some(s => s.name === n) || (ownEnabled(id, n) && !((rt.mcp.suppress ?? []).includes(n) && stoppable(id, n)));
    const runtimeNow = async id => {
      const plan = legacyPlan(scope, scope); plan.mcp.agents = kindValue.agents;
      return resolveRuntime({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, plan, removedMcp: [] }, { home, plyServers, agent: id });
    };
    const usableMap = async n => Object.fromEntries(await Promise.all(ids.map(async id => [id, usableAt(await runtimeNow(id), id, n)])));
    const onIds = m => Object.keys(m).filter(id => m[id]).sort().join();
    // 画面の「オン」と実行時が同じ（行の操作の前後すべて）
    const sameAsScreen = async (label, n) => {
      const row = await rowOf(n), real = await usableMap(n);
      const bad = ids.filter(id => (row.cells[id].state === 'on') !== real[id]);
      t.ok(`${label}: 画面のオンと実行時に使えるかが全エージェントで一致（${n}）`, bad.length === 0, JSON.stringify({ bad, row: Object.fromEntries(ids.map(id => [id, row.cells[id].state])), real }));
      return real;
    };

    const start = await sameAsScreen('初期', 'shared');
    t.ok('初期: shared は持っているエージェントすべてで使える', onIds(start) === [...owners].sort().join(), onIds(start));
    const startReg = await sameAsScreen('初期', 'reg');

    // 行をオフ: 変えられるエージェントは実行時に使えなくなり、鍵つき（止められない）は変わらない
    const r1 = await press('shared', false);
    t.ok('行をオフ: 成功し、変えたのは鍵の無いオンだけ', r1.ok === true && r1.changed.slice().sort().join() === changeable.slice().sort().join(), r1);
    const off = await sameAsScreen('オフ後', 'shared');
    t.ok('オフ後の実行時: 変えられるエージェントは使えない・鍵つきは今までどおり使える', changeable.every(id => !off[id]) && fixed.every(id => off[id]) && onIds(off) === [...fixed].sort().join(), onIds(off));
    const rowOff = await rowOf('shared');
    t.ok('オフ後の画面: 横棒＋鍵（鍵つきのオンだけ残る）・戻す記録があり押せる', rowOff.rowMixed && rowOff.rowFixed && !rowOff.rowChangeableOn && rowOff.rowRestore === 'was' && !rowOff.rowLocked, rowOff);
    // 他の行は巻き込まない
    t.ok('ほかの行（reg）は変わらない', onIds(await usableMap('reg')) === onIds(startReg));

    // もう一度押す: 外す前の組へ戻り、実行時にも戻る
    const r2 = await press('shared', true);
    t.ok('もう一度押す: 外す前の組へ戻す（記録から）', r2.ok === true && r2.source === 'was' && r2.changed.slice().sort().join() === changeable.slice().sort().join(), r2);
    const back = await sameAsScreen('戻した後', 'shared');
    t.ok('戻した後の実行時: 初期と同じ', onIds(back) === onIds(start), onIds(back));

    // アイコンとの組み合わせ: 行をオフ → アイコンを 1 つオン → 画面と実行時が一致 → 行をオフ（そのアイコンだけ外れる）→ 戻す
    await press('shared', false);
    const one = changeable[0];
    await icon('shared', one, true);
    const mid = await sameAsScreen('オフ → アイコンを 1 つオン', 'shared');
    t.ok('アイコンで 1 つだけオンにした実行時: そのエージェントと鍵つきだけが使える', onIds(mid) === [one, ...fixed].sort().join(), onIds(mid));
    await press('shared', false);
    const mid2 = await sameAsScreen('もう一度行をオフ', 'shared');
    t.ok('もう一度行をオフ: 実行時もそのエージェントが外れ、鍵つきだけが残る', onIds(mid2) === [...fixed].sort().join(), onIds(mid2));
    await press('shared', true);
    const mid3 = await sameAsScreen('戻す', 'shared');
    t.ok('戻すのは直前に外した組（アイコンで 1 つだけオンにしていた物）だけ。ほかのエージェントへ新しく広げない', onIds(mid3) === [one, ...fixed].sort().join(), onIds(mid3));

    // Pleiad の登録の行: オフで全エージェントの実行時から外れ、戻すと戻る（鍵つきの無い行）
    await press('reg', false);
    const regOff = await sameAsScreen('登録の行をオフ', 'reg');
    t.ok('登録の行: オフで実行時に使えるエージェントが無くなる', onIds(regOff) === '', onIds(regOff));
    await press('reg', true);
    const regBack = await sameAsScreen('登録の行を戻す', 'reg');
    t.ok('登録の行: 戻すと初期と同じ', onIds(regBack) === onIds(startReg), onIds(regBack));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
