// 更新しただけの人の Hooks の動きを、main（0.42.5-beta.33・d786872e）の値で固定して比べる（ADR 0338）。LLM もエージェントも呼ばない。
//   - 期待値（PINNED）は main の prepareHooksTurn を同じ入力で動かして書き出したもの。このブランチの旧い道（hooksAgents の無い prepareHooksTurn）から作らない
//     （旧い道がこのブランチで変わると、比べる両方が一緒にずれて気づけないため）
//   - Devin は main の「実際の動き」で固定する。main は --config を作っていたが、Devin が読む前に消していたので、登録は Devin で動かず、取り込み（AGENTS.md・
//     Claude Code などの指示・Skills・MCP・Hooks）も止まっていなかった（2026-11-15 に本物の Devin で確かめた。目印の Hook は動かず、AGENTS.md の合言葉を答えた）
//   - 比べるのは、移行の前（hooks-agents.json が無い）と、移行した直後（そのときの実効の状態を書いた後）の両方
//   - PINNED の採り方（取り直すとき。Devin の欄は採らない）:
//       1. main の commit を別の worktree に出す（git worktree add --detach <作業用>/main-wt d786872e）
//       2. この試験の写しを作り、import の '../../core/' をすべて <作業用>/main-wt/core/ に替え、createHooksAgents の import と ha を外す（main には無い）。
//          scene は「AGENTS ごとに shape(a, await turn(a, cwd, false)) を JSON で書き出す」だけに替え、移行の直後の段（main には無い）と後片付けは流さない
//       3. 写しを node で流し、書き出した値のうち Devin 以外の 5 エージェントを PINNED へ写す。Devin は DEVIN_MAIN のまま（main の準備処理は --config の
//          計画を返すが、上のとおり実際には効かなかった。準備処理の出力からは採らない。本物の Devin で確かめ直すときだけ変える）
//       4. 中のリンク（node_modules などの ReparsePoint）を外してから git worktree remove で消す
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlyHooks } from '../../core/ply-hooks.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { createHooksAgents } from '../../core/hooks-agents.mjs';
import { prepareHooksTurn } from '../../core/hooks-unify.mjs';
import { codexHooksState } from '../../core/hooks-plan.mjs';
import { devinTurnConfig } from '../../core/backends/devin-config.mjs';

export const name = 'hooks-main-pinned';
export const title = 'Hooks: 更新しただけの人のターンを main の値で固定して比べる（移行の前と直後・Devin は main の実際の動き）';

// backend-allow: エージェントごとの起動に効く形を、試験の期待値として並べる
const AGENTS = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
const OFF_ENV = { GROK_CLAUDE_HOOKS_ENABLED: 'false', GROK_CURSOR_HOOKS_ENABLED: 'false', GROK_CODEX_HOOKS_ENABLED: 'false' };
const CODEX_OFF = ['<tmp>/home/.codex/hooks.json:stop:0:0', '<tmp>/repo/.codex/hooks.json:stop:0:0'];
// Devin は main の実際の動き: どの場面でも渡したものは動かず、取り込みは止まらない
const DEVIN_MAIN = { supplied: [], imports: 'run' };
const IDLE = { claude: { supplied: [], stopAll: false }, codex: { supplied: [], off: [] }, antigravity: { supplied: [], names: [] }, opencode: { supplied: [] }, devin: DEVIN_MAIN, grok: { supplied: [], env: null } };
const all = (claude, codex, agy, opencode, grok) => ({ claude: { supplied: claude, stopAll: true }, codex: { supplied: codex, off: CODEX_OFF },
  antigravity: { supplied: agy, names: ['audit'] }, opencode: { supplied: opencode }, devin: DEVIN_MAIN, grok: { supplied: grok, env: OFF_ENV } });
// main の prepareHooksTurn の値（Devin だけ実際の動き）。0.42.5-beta.33 の core を同じ入力で動かした（採り方は先頭の注）
const PINNED = {
  makaseru: IDLE,
  soroeru: all(['all', 'cx', 'tool'], ['all', 'cx'], ['all'], ['all', 'tool'], ['all', 'tool']),
  soroeruSomeOff: all(['cx', 'tool'], ['cx'], [], ['tool'], ['tool']),
  placeInside: all(['all', 'cx', 'tool'], ['all', 'cx'], ['all'], ['all', 'tool'], ['all', 'tool']),
  placeOutside: IDLE,
  soroeruDevRegDisabled: all(['all', 'cx', 'tool'], ['all', 'cx'], ['all'], ['all', 'tool'], ['all', 'tool']),
};

const w = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-pinned-')));
  try {
    const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), grokHome = path.join(tmp, 'grok-home');
    const repo = path.join(tmp, 'repo'), sub = path.join(repo, 'sub');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(grokHome, { recursive: true });
    await w(path.join(home, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node user-stop.mjs' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } });
    await w(path.join(home, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo codex-stop' }] }] } });
    await w(path.join(home, '.gemini', 'config', 'hooks.json'), { audit: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node a.cjs' }] }] } });
    await w(path.join(repo, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node proj.mjs' }] }] } });

    const findNode = async () => process.execPath;
    const hooksConfig = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(home, '.gemini'),
      claudeManaged: [path.join(tmp, 'managed', 'managed-settings.json')] });
    const plyHooks = createPlyHooks(data);
    const regs = {};
    for (const [name, agent, event, matcher, targets] of [
      ['all', 'claude', 'Stop', '', AGENTS],
      ['tool', 'claude', 'PreToolUse', 'Bash', ['claude', 'devin', 'grok', 'opencode']],
      ['cx', 'codex', 'Stop', '', ['claude', 'codex']],
      ['dev', 'claude', 'Stop', '', ['devin']],
    ]) regs[name] = (await plyHooks.save({ name, agent, event, matcher, command: `node ${name}.mjs`, targets })).id;
    const nameOf = Object.fromEntries(Object.entries(regs).map(([n, id]) => [id, n]));
    const ha = createHooksAgents({ dataDir: data, hooksConfig, plyHooks, findNode, grokHome });
    const norm = s => s.split(tmp).join('<tmp>').replace(/\\/g, '/');
    const codexList = cwd => [{ cwd, hooks: [
      { key: `${path.join(home, '.codex', 'hooks.json')}:stop:0:0`, source: 'user' },
      { key: `${path.join(repo, '.codex', 'hooks.json')}:stop:0:0`, source: 'project' }] }];

    // 起動に効く形（同じ起動なら同じ値）。Devin は、Devin が実際に読む --config の中身（渡す Hook と取り込みの止め）
    const shape = (a, r) => {
      if (r?.error) return { error: r.error };
      const rt = r?.runtime ?? null;
      const supplied = (rt?.supplied ?? []).map(s => nameOf[s.hook.id] ?? s.hook.id).sort();
      if (a === 'claude') return { supplied, stopAll: rt ? rt.stopAll !== false : false };
      if (a === 'codex') return { supplied, off: rt ? Object.keys(codexHooksState({ table: rt.table ?? {}, list: codexList(rt.cwd), ...(rt.stopRows ? { stopRows: rt.stopRows } : {}) }).state).map(norm).sort() : [] };
      if (a === 'antigravity') return { supplied, names: rt ? [...rt.names].map(norm).sort() : [] };
      if (a === 'devin') { const c = devinTurnConfig({ hooksRuntime: rt }); return { supplied: Object.keys(c?.hooks ?? {}).length ? supplied : [], imports: c?.read_config_from ? 'stopped' : 'run' }; }
      if (a === 'grok') return { supplied, env: rt?.compatHookEnv ?? null };
      return { supplied };
    };
    const turn = (a, cwd, withAgents) => prepareHooksTurn({ agent: a, cwd, ctx: { plyHooks, hooksConfig, dataDir: data, findNode, grokHome, ...(withAgents ? { hooksAgents: ha } : {}) } })
      .catch(e => ({ error: e.code ?? e.message }));

    async function scene(label, cwd = repo) {
      const bad = [];
      const check = (stage, got) => { for (const a of AGENTS) if (JSON.stringify(got[a]) !== JSON.stringify(PINNED[label][a])) bad.push(`${stage} ${a}: ${JSON.stringify(got[a])} / main ${JSON.stringify(PINNED[label][a])}`); };
      const before = {};
      for (const a of AGENTS) before[a] = shape(a, await turn(a, cwd, true));
      check('移行前', before);
      // 移行した直後: 最初の操作で書くのと同じ、そのときの実効の状態を書いてから流す
      const { state } = await ha.current();
      await w(ha.file, state);
      const after = {};
      for (const a of AGENTS) after[a] = shape(a, await turn(a, cwd, true));
      await ha.reset();
      check('移行の直後', after);
      t.ok(`${label}: 移行の前も直後も、6 つのエージェントのターンが main と同じ`, bad.length === 0, bad.join(' | '));
    }

    await scene('makaseru');
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    await scene('soroeru');
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [regs.all, regs.dev] } });
    await scene('soroeruSomeOff');
    await plyHooks.setOwner({ place: null, value: { owner: 'native' } });
    await plyHooks.setOwner({ place: repo, value: { owner: 'ply', disabled: [] } });
    await scene('placeInside', sub);
    await scene('placeOutside', tmp);
    await plyHooks.setOwner({ place: repo, value: { owner: 'native' } });
    await plyHooks.toggle(regs.dev, false);
    await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    await scene('soroeruDevRegDisabled');

    // Devin の始まりの一覧: 移行の前の Devin のマスはすべてオフで、取り込みは止まらない（main と同じ）
    await plyHooks.toggle(regs.dev, true);
    const m = await ha.matrix({ cwd: repo });
    const regRows = m.rows.filter(r => r.key in nameOf);
    const devinCells = Object.fromEntries(regRows.map(r => [nameOf[r.key], r.cells.devin?.state]));
    t.ok('Devin の始まり（旧「そろえる」で Devin へ向けた登録がある）: 登録の Devin のマスはすべてオフ、取り込みは止まらない',
      m.adopted === false && regRows.length === 4 && Object.values(devinCells).every(s => s === 'off') && await ha.devinImportsStopped(repo) === false, JSON.stringify(devinCells));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}
