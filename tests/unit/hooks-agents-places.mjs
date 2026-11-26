// Hook × エージェントの選択をフォルダーごとに持つ（hooks-agents.json の形式 2。Issue #25・ADR 0338）。LLM もエージェントも呼ばない。試験用のホーム・作業場所・データ置き場だけを使う。
//   - 形式 1 から 2 への移行: 写し（hooks-agents.v1-backup.json。既にあれば残す）・同じ意味（全体とどの場所でも同じ選択）・受け継ぐ値と同じ差分は書かない
//   - 行ごとの受け継ぎ（全体 → 祖先の場所 → この場所。深い場所が勝つ）・上書き・戻す（hooks.revertRow）・場所を消す（hooks.removePlace。フォルダーが無くても）
//   - 一覧の from・overridden・overriddenAt・changes・places・groupRows
//   - 探す場所の追加ルート（scanRoots）の Hooks: 行（kind: root）に出て、Pleiad が渡す（一覧と実行時が同じ）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlyHooks } from '../../core/ply-hooks.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { createHooksAgents, parseState, parseStateV1, effectiveAt, migrateV1, migrationDiffers, FILE_NAME } from '../../core/hooks-agents.mjs';
import { prepareHooksTurn } from '../../core/hooks-unify.mjs';
import { containsPath, pathKey } from '../../core/context-settings.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'hooks-agents-places';
export const title = 'Hook × エージェント（フォルダーごと）: 形式 2 への移行・行ごとの受け継ぎ・上書きと戻す・場所を消す・一覧の出どころ・追加ルートの Hooks';

const [CLAUDE, CODEX] = ['claude', 'codex'];
const BACKUP = 'hooks-agents.v1-backup.json';

const w = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const cell = (m, key, a) => m.rows.find(r => r.key === key)?.cells?.[a] ?? null;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-places-')));
  try {
    const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), grokHome = path.join(tmp, 'grok-home');
    const repo = path.join(tmp, 'repo'), sub = path.join(repo, 'sub'), gone = path.join(tmp, 'gone');
    const userRoot = path.join(tmp, 'roots', 'user'), dirRoot = path.join(tmp, 'roots', 'dir');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(gone, { recursive: true });
    await fs.mkdir(grokHome, { recursive: true });
    await w(path.join(home, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node user-stop.mjs' }] }] } });
    // 追加ルートの Hooks（エージェントは読まない場所）。ユーザーの範囲と作業場所の範囲
    await w(path.join(userRoot, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node root-user.mjs' }] }] } });
    await w(path.join(userRoot, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo root-codex' }] }] } });
    await w(path.join(dirRoot, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node root-dir.mjs' }] }] } });

    const hooksConfig = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(home, '.gemini'), claudeManaged: [] });
    const plyHooks = createPlyHooks(data);
    const reg = await plyHooks.save({ name: 'reg', agent: CLAUDE, event: 'Stop', matcher: '', command: 'node reg.mjs', targets: [CLAUDE, CODEX] });
    const findNode = async () => process.execPath;
    let roots = { user: [], directory: [] };
    const scanRoots = async cwd => ({ user: roots.user, directory: cwd ? roots.directory : [] });
    const ha = createHooksAgents({ dataDir: data, hooksConfig, plyHooks, findNode, grokHome, scanRoots });
    const file = path.join(data, FILE_NAME);
    const eff = async (cwd) => effectiveAt(await ha.read(), cwd).agents;

    // ---------------------------------------------------------------- 形式 1 から 2 への移行
    // 全体: reg は Codex で切る。repo: 丸ごとの写し（reg を Claude でも切る）と使わない行。sub: 丸ごとの写し（全体と同じ）
    const v1 = { version: 1, off: { [reg.id]: [CODEX] }, spread: {}, unused: [], compat: { grok: 'native', devin: 'native' },
      places: {
        [pathKey(repo)]: { path: repo, skip: [reg.id], agents: { off: { [reg.id]: [CLAUDE, CODEX] }, spread: {}, unused: [], compat: { grok: 'native', devin: 'off' } } },
        [pathKey(sub)]: { path: sub, skip: [], agents: { off: { [reg.id]: [CODEX] }, spread: {}, unused: [], compat: { grok: 'native', devin: 'native' } } },
      }, adoptedFrom: { owner: 'native', at: '2026-01-01T00:00:00.000Z' }, seen: [] };
    const v1Text = JSON.stringify(v1, null, 2);
    await w(file, v1Text);
    const migrated = await ha.read();
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    t.ok('移行: 形式 2 で書き直す（読むだけで移す）', migrated?.version === 2 && onDisk.version === 2);
    t.ok('移行: 前の形式 1 を hooks-agents.v1-backup.json に写す（中身はそのまま）', await fs.readFile(path.join(data, BACKUP), 'utf8') === v1Text);
    const parsedV1 = parseStateV1(v1);
    t.ok('移行: 全体とどの場所でも、どの行でも同じ選択（migrationDiffers が null）', migrationDiffers(parsedV1, parseState(onDisk)) === null);
    const repoPlace = onDisk.places[pathKey(repo)];
    const subPlace = onDisk.places[pathKey(sub)];
    t.ok('移行: 差分だけを書く（受け継ぐ値と違う欄だけ。repo は全体と、sub は repo と比べる。同じ欄 grok は書かない）',
      JSON.stringify(repoPlace?.rows?.[reg.id]) === JSON.stringify({ off: [CLAUDE, CODEX], skip: true }) && repoPlace?.compat?.devin === 'off' && !('grok' in (repoPlace?.compat ?? {}))
      && JSON.stringify(subPlace?.rows?.[reg.id]) === JSON.stringify({ off: [CODEX], skip: false }) && subPlace?.compat?.devin === 'native' && !('grok' in (subPlace?.compat ?? {})),
      JSON.stringify(onDisk.places));
    const atSub = effectiveAt(parseState(onDisk), sub);
    t.ok('移行: 子（sub）は形式 1 では子の丸ごとの写しが勝っていた。形式 2 でも同じ（Codex だけ切る・使わない行にしない・Devin は native）',
      atSub.agents.off[reg.id]?.join() === CODEX && !atSub.skip[reg.id] && atSub.agents.compat.devin === 'native', JSON.stringify(atSub));
    t.ok('移行の照合: 意味が違う形式 2 は場所を返す（書く前に断るための判定）',
      same(String(migrationDiffers(parsedV1, { ...parseState(onDisk), places: {} })), repo));
    t.ok('移行の純粋な関数は、写しても同じ形（もう一度移しても変わらない）', JSON.stringify(migrateV1(parsedV1).places) === JSON.stringify(parseState(onDisk).places));
    // 既にある写しは残す（2 回目の移行で上書きしない）
    await w(file, JSON.stringify({ ...v1, off: {} }));
    await ha.read();
    t.ok('移行: 写しが既にあれば上書きしない（最初の形式 1 が残る）', await fs.readFile(path.join(data, BACKUP), 'utf8') === v1Text);
    t.ok('移行: 書きかけの一時ファイルを残さない', !(await fs.readdir(data)).some(n => n.includes('.migrate.')));

    // ---------------------------------------------------------------- 行ごとの受け継ぎ・上書き・戻す
    await fs.rm(file, { force: true });
    // 移す前（任せる先 native）は登録の Hook はどこでも切れている。全体で Claude・Codex を入れてから、フォルダーで変える
    const m0 = await ha.matrix({ cwd: null });
    await ha.setAgent({ key: reg.id, agent: CLAUDE, on: true, cwd: null, expect: m0.revision });
    await ha.setAgent({ key: reg.id, agent: CODEX, on: true, cwd: null });
    t.ok('前提: 全体では Claude・Codex で入っている（場所の差分なし）', !(await eff(null)).off[reg.id]?.length && !Object.keys((await ha.read()).places).length);
    await ha.setAgent({ key: reg.id, agent: CODEX, on: false, cwd: repo });
    let s = await ha.read();
    t.ok('cwd つきの操作はそのフォルダーに行の差分を書く（全体は変えない）', JSON.stringify(s.places[pathKey(repo)]?.rows?.[reg.id]) === JSON.stringify({ off: [CODEX] })
      && !s.off[reg.id]?.length, JSON.stringify(s));
    t.ok('子のフォルダーは親の差分を受け継ぐ', (await eff(sub)).off[reg.id]?.join() === CODEX && !(await eff(null)).off[reg.id]?.length);
    await ha.setAgent({ key: reg.id, agent: CODEX, on: true, cwd: sub });
    s = await ha.read();
    t.ok('子で上書き: 「何も切らない」を差分として書ける（off: []）。深い場所が勝つ', JSON.stringify(s.places[pathKey(sub)]?.rows?.[reg.id]) === JSON.stringify({ off: [] })
      && !(await eff(sub)).off[reg.id]?.length && (await eff(repo)).off[reg.id]?.join() === CODEX, JSON.stringify(s.places));
    const mSub = await ha.matrix({ cwd: sub }), mRepo = await ha.matrix({ cwd: repo }), mAll = await ha.matrix({ cwd: null });
    const rowSub = mSub.rows.find(r => r.key === reg.id), rowRepo = mRepo.rows.find(r => r.key === reg.id), rowAll = mAll.rows.find(r => r.key === reg.id);
    t.ok('一覧: from はこの行の選択が来た場所、overridden はこのフォルダーに差分がある', same(rowSub.from, sub) && rowSub.overridden === true && same(rowRepo.from, repo) && rowRepo.overridden === true
      && !('overriddenAt' in rowSub), JSON.stringify([rowSub.from, rowRepo.from]));
    t.ok('一覧（cwd なし）: from は null、差分を持つ場所の並び overriddenAt', rowAll.from === null && rowAll.overridden === false && rowAll.overriddenAt.length === 2
      && rowAll.overriddenAt.some(p => same(p, repo)) && rowAll.overriddenAt.some(p => same(p, sub)), JSON.stringify(rowAll.overriddenAt));
    t.ok('一覧: changes はこのフォルダーの差分の数（cwd なしは合計）、places は差分を持つ場所', mSub.changes === 1 && mRepo.changes === 1 && mAll.changes === 2
      && mAll.places.length === 2 && mAll.places.every(p => p.changes === 1), JSON.stringify(mAll.places));
    const gRepo = mRepo.groupRows.find(g => g.group === 'ply');
    t.ok('一覧: 組の行にも from・overridden（cwd なしは overriddenAt）', gRepo && same(gRepo.from, repo) && gRepo.overridden === true
      && mAll.groupRows.find(g => g.group === 'ply')?.overriddenAt?.length === 2, JSON.stringify(mRepo.groupRows));
    // 受け継ぐ値と同じにすると、その差分と空になった場所は消える
    await ha.setAgent({ key: reg.id, agent: CODEX, on: false, cwd: sub });
    t.ok('受け継ぐ値と同じに戻すと、子の差分と空になった場所を消す', !(await ha.read()).places[pathKey(sub)] && (await eff(sub)).off[reg.id]?.join() === CODEX);
    // 戻す（hooks.revertRow）
    const before = await ha.matrix({ cwd: repo });
    const dryRevert = await ha.revertRow({ cwd: repo, key: reg.id, dry: true });
    t.ok('戻す（試算）: 消える行を返し、何も書かない', dryRevert.removed.join() === reg.id && (await ha.matrix({ cwd: repo })).revision === before.revision);
    let stale = null;
    try { await ha.revertRow({ cwd: repo, key: reg.id, expect: 'stale-revision' }); } catch (e) { stale = e; }
    t.ok('戻す: 古い revision は断る（CONFLICT）', stale?.code === 'CONFLICT');
    const reverted = await ha.revertRow({ cwd: repo, keys: [reg.id], expect: before.revision });
    t.ok('戻す: フォルダーの行の差分を消し、受け継ぐ値（全体）へ戻る。空の場所も消す', reverted.removed.join() === reg.id && !(await eff(repo)).off[reg.id]?.length && !(await ha.read()).places[pathKey(repo)]);
    const noop = await ha.revertRow({ cwd: repo, key: reg.id });
    t.ok('戻す: 差分が無ければ何も書かない', noop.removed.length === 0 && noop.revision === reverted.revision);

    // この場所で使わない（hooks.setPlace use: false）にした行は、行のスイッチを「この場所で使う」に戻す向きで押せる（skipHere）
    await ha.setPlace({ place: repo, key: reg.id, use: false });
    const mSkip = await ha.matrix({ cwd: repo });
    const rowSkip = mSkip.rows.find(r => r.key === reg.id);
    t.ok('この場所で使わない行: skipHere で、行のスイッチは押せて（鍵なし）次は入れる向き・戻すと外す前の選択',
      rowSkip?.skipHere === true && rowSkip.switchable === true && rowSkip.rowNextOn === true && rowSkip.rowRestore === 'was'
      && !('switchLock' in rowSkip) && rowSkip.here?.use === false && rowSkip.overridden === true, JSON.stringify(rowSkip));
    t.ok('全体の一覧（cwd なし）には skipHere を付けない', !('skipHere' in ((await ha.matrix({ cwd: null })).rows.find(r => r.key === reg.id) ?? {})));
    await ha.setPlace({ place: repo, key: reg.id, use: true });
    const rowUse = (await ha.matrix({ cwd: repo })).rows.find(r => r.key === reg.id);
    t.ok('この場所で使うに戻すと skipHere は外れ、空になった場所の差分も消える',
      !('skipHere' in rowUse) && rowUse.here?.use === true && !(await ha.read()).places[pathKey(repo)], JSON.stringify(rowUse));

    // ---------------------------------------------------------------- 場所を消す（フォルダーが無くても）
    await ha.setAgent({ key: reg.id, agent: CLAUDE, on: false, cwd: gone });
    t.ok('前提: 消すフォルダーに差分がある', Boolean((await ha.read()).places[pathKey(gone)]));
    await fs.rm(gone, { recursive: true, force: true });
    const removed = await ha.removePlace({ cwd: gone });
    t.ok('場所を消す（hooks.removePlace）: フォルダーが消えていても、pathKey で引いて差分を消す', removed.removed === true && !(await ha.read()).places[pathKey(gone)]);
    t.ok('場所を消す: 差分の無い場所は removed: false', (await ha.removePlace({ cwd: gone })).removed === false);
    t.ok('操作の一覧に hooks.revertRow・hooks.removePlace（画面の WS コマンド revertHookRow・removeHookPlace）',
      registry.get('hooks.revertRow')?.legacyCommand === 'revertHookRow' && registry.get('hooks.removePlace')?.legacyCommand === 'removeHookPlace');

    // ---------------------------------------------------------------- 追加ルートの Hooks（scanRoots）
    roots = { user: [userRoot], directory: [dirRoot] };
    const mRoot = await ha.matrix({ cwd: repo });
    const rootRows = mRoot.rows.filter(r => r.kind === 'root');
    const rUser = rootRows.find(r => r.command.includes('root-user')), rDir = rootRows.find(r => r.command.includes('root-dir')), rCodex = rootRows.find(r => r.command.includes('root-codex'));
    t.ok('追加ルートの Hooks は行（kind: root・組 root）に出て、どのルートかを持つ', rUser && rDir && rCodex && rootRows.every(r => r.group === 'root')
      && same(rUser.root, userRoot) && rUser.rootScope === 'user' && same(rDir.root, dirRoot) && rDir.rootScope === 'directory' && mRoot.groups.includes('root'),
      JSON.stringify(rootRows.map(r => [r.kind, r.root, r.rootScope, r.command])));
    t.ok('作業場所の範囲のルートは cwd が無い一覧には出ない', !(await ha.matrix({ cwd: null })).rows.some(r => r.kind === 'root' && r.command.includes('root-dir')));
    t.ok('追加ルートの Hooks: 渡せるエージェントでは入り（押せる）', cell(mRoot, rUser.key, CLAUDE)?.state === 'on' && cell(mRoot, rUser.key, CLAUDE)?.mode === 'toggle'
      && cell(mRoot, rCodex.key, CODEX)?.state === 'on', JSON.stringify([cell(mRoot, rUser.key, CLAUDE), cell(mRoot, rCodex.key, CODEX)]));
    const lockedOff = Object.values(rUser.cells).filter(c => c.state !== 'on');
    t.ok('追加ルートの Hooks: 渡せないエージェントは鍵つきで切れていて理由がある', lockedOff.every(c => c.mode !== 'toggle' || c.needsConfirm === true)
      && lockedOff.filter(c => c.mode === 'locked').every(c => typeof c.reason === 'string' && c.reason.length > 0), JSON.stringify(rUser.cells));
    const turnKeys = async (a, cwd = repo) => new Set(((await ha.hooksForTurn(a, cwd)) ?? []).map(x => x.key));
    const claudeKeys = await turnKeys(CLAUDE);
    t.ok('追加ルートの Hooks: その エージェントのターンで Pleiad が渡す（hooksForTurn）', claudeKeys.has(rUser.key) && claudeKeys.has(rDir.key) && (await turnKeys(CODEX)).has(rCodex.key),
      [...claudeKeys].join());
    const plan = await ha.turnPlan(CLAUDE, repo);
    t.ok('追加ルートの Hooks: 実行の計画で渡すもの（deliver）に入る', plan.deliver.some(x => x.row.key === rUser.key), JSON.stringify(plan.deliver.map(x => x.row.key)));
    const turn = await prepareHooksTurn({ agent: CLAUDE, cwd: repo, ctx: { plyHooks, hooksConfig, dataDir: data, findNode, grokHome, hooksAgents: ha } });
    t.ok('追加ルートの Hooks: ターンの組み立て（forTurn）でも渡す', (turn?.runtime?.supplied ?? []).some(x => x.hook.id === rUser.key), JSON.stringify((turn?.runtime?.supplied ?? []).map(x => x.hook.id)));
    await ha.setAgent({ key: rUser.key, agent: CLAUDE, on: false, cwd: repo });
    t.ok('追加ルートの Hooks: このフォルダーで切ると渡さない（外では渡す）', !(await turnKeys(CLAUDE)).has(rUser.key) && (await turnKeys(CLAUDE, tmp)).has(rUser.key));
    roots = { user: [], directory: [] };
    t.ok('ルートを外すと行も消える', !(await ha.matrix({ cwd: repo })).rows.some(r => r.kind === 'root'));
  } finally {
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-hooks-places-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
