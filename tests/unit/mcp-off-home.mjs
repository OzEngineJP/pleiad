import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncMcpOffHome, claimMcpOffHome, mcpOffHomeDir, settleMcpOffHome, MCP_OFF_KEEP, MCP_OFF_IDLE_MS } from '../../core/backends/mcp-off-home.mjs';
import { prepareDevinMcpOff, prepareDevinLaunch } from '../../core/backends/devin-config.mjs';

export const name = 'mcp-off-home';
export const title = 'Devin 自身の MCP を名前で止める設定の置き場の写し（本物は書き換えず、止める名前だけ写しに書く。ADR 0330）';

const read = p => fs.readFile(p, 'utf8');
const exists = p => fs.lstat(p).then(() => true, () => false);
const isLink = p => fs.lstat(p).then(s => s.isSymbolicLink(), () => false);

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-off-'));
  try {
    // ---- 写しの作り方（共通）
    const source = path.join(root, 'source'), target = path.join(root, 'overlay');
    await fs.mkdir(path.join(source, 'sub'), { recursive: true });
    await fs.writeFile(path.join(source, 'sub', 'inner.txt'), 'inner');
    await fs.writeFile(path.join(source, 'auth.json'), '{"a":1}');
    await fs.writeFile(path.join(source, 'config.toml'), 'x = 1\n');
    await fs.writeFile(path.join(source, 'gen.toml'), 'real');
    await fs.writeFile(path.join(source, 'worktrees.db'), 'db');
    await fs.writeFile(path.join(source, 'worktrees.db-wal'), 'wal');
    await fs.symlink(path.join(source, 'missing.txt'), path.join(source, 'dangling.txt'), 'file').catch(() => {});
    const sourceBefore = (await fs.readdir(source)).sort().join();
    await syncMcpOffHome({ source, target, generated: { 'gen.toml': 'generated' }, skip: n => n === 'config.toml' });
    t.ok('ディレクトリとファイルはリンクで写し、生成するファイルは写しにだけ書く（本物は元のまま）',
      await isLink(path.join(target, 'sub')) && await read(path.join(target, 'sub', 'inner.txt')) === 'inner' && await isLink(path.join(target, 'auth.json'))
      && !(await isLink(path.join(target, 'gen.toml'))) && await read(path.join(target, 'gen.toml')) === 'generated' && await read(path.join(source, 'gen.toml')) === 'real');
    t.ok('写さないもの: skip の名前・SQLite の DB とその付属・先の無いリンク',
      !(await exists(path.join(target, 'config.toml'))) && !(await exists(path.join(target, 'worktrees.db'))) && !(await exists(path.join(target, 'worktrees.db-wal')))
      && !(await exists(path.join(target, 'dangling.txt'))));
    await fs.writeFile(path.join(target, 'auth.json'), '{"a":2}');
    t.ok('写しのリンクを通した書き込み（認証情報の更新など）は本物に届く', await read(path.join(source, 'auth.json')) === '{"a":2}');
    // エージェントが写しの中で一時ファイルからの rename でリンクを普通のファイルに置き換えた → kept を渡さないそろえでは消さずに残す（運ぶのは下の settle）
    await fs.rm(path.join(target, 'auth.json')); await fs.writeFile(path.join(target, 'auth.json'), 'replaced');
    await fs.writeFile(path.join(target, 'agent-made.db'), 'mine');
    await fs.writeFile(path.join(source, 'new.txt'), 'new');
    await syncMcpOffHome({ source, target, generated: { 'gen.toml': 'generated' }, skip: n => n === 'config.toml' });
    t.ok('そろえ直し: 普通のファイルに置き換わった本物と同じ名前は消さない（中身を失わない）。本物に増えたものを写し、写しだけのものは残す',
      !(await isLink(path.join(target, 'auth.json'))) && await read(path.join(target, 'auth.json')) === 'replaced' && await read(path.join(source, 'auth.json')) === '{"a":2}' && await isLink(path.join(target, 'new.txt'))
      && await read(path.join(target, 'agent-made.db')) === 'mine');
    await fs.rm(path.join(source, 'new.txt'));
    await syncMcpOffHome({ source, target, generated: { 'gen.toml': 'generated' }, skip: n => n === 'config.toml' });
    t.ok('そろえ直し: 本物から消えたもののリンクを外す', !(await exists(path.join(target, 'new.txt'))));
    t.ok('本物の置き場のファイルは増えも減りもしない（生成するファイルを本物に書かない）',
      (await fs.readdir(source)).sort().join() === sourceBefore && await read(path.join(source, 'gen.toml')) === 'real');

    // ---- 写しの中で置き換わったファイルを本物へ運ぶ（settle。ADR 0330 の再レビュー A・F）
    const s2 = path.join(root, 'settle-src'), t2 = path.join(root, 'settle-overlay'), kept = path.join(root, 'kept');
    await fs.mkdir(s2, { recursive: true });
    await fs.writeFile(path.join(s2, 'auth.json'), '{"v":1}');
    await fs.writeFile(path.join(s2, 'gen.toml'), 'real');
    const o2 = { source: s2, target: t2, generated: { 'gen.toml': 'generated' }, kept };
    const age = async (p, ms) => { const d = new Date(Date.now() - ms); await fs.utimes(p, d, d); };
    const replace = async (name, text) => { const tmpFile = path.join(t2, `${name}.tmp-1`); await fs.writeFile(tmpFile, text); await fs.rename(tmpFile, path.join(t2, name)); };
    const keptTexts = async () => Promise.all((await fs.readdir(kept).catch(() => [])).map(n => read(path.join(kept, n))));
    await syncMcpOffHome(o2);
    t.ok('settle: そろえた写しには、本物の置き場・kept・Pleiad が書いた中身の指紋の記録を写しの隣に置く（写しの中には置かない）',
      await exists(`${t2}.pleiad.json`) && !(await exists(path.join(t2, 'pleiad.json'))) && JSON.parse(await read(`${t2}.pleiad.json`)).generated['gen.toml'].length === 64);
    // Devin が写しの中で一時ファイルからの rename で auth.json を置き換えた（リンクが普通のファイルになり、書いた中身は写しにだけある）
    await replace('auth.json', '{"v":2}');
    await age(path.join(s2, 'auth.json'), 60_000); await age(path.join(t2, 'auth.json'), 10_000);
    await syncMcpOffHome(o2);
    t.ok('settle: rename で置き換わったファイルは、写しのほうが新しければ本物へ運び、リンクに戻す（中身を失わない）',
      await read(path.join(s2, 'auth.json')) === '{"v":2}' && await isLink(path.join(t2, 'auth.json')) && !(await keptTexts()).length);
    await replace('auth.json', '{"v":3}');
    await syncMcpOffHome(o2);
    t.ok('settle: 書いた直後（MCP_OFF_SETTLE_IDLE_MS 未満）のファイルは運ばず、消さずに写しに残す（書きかけを運ばない）',
      await read(path.join(s2, 'auth.json')) === '{"v":2}' && !(await isLink(path.join(t2, 'auth.json'))) && await read(path.join(t2, 'auth.json')) === '{"v":3}');
    await age(path.join(s2, 'auth.json'), 60_000); await age(path.join(t2, 'auth.json'), 10_000);
    await settleMcpOffHome(t2);
    t.ok('settle: 次の機会（settleMcpOffHome）に運ぶ', await read(path.join(s2, 'auth.json')) === '{"v":3}' && await isLink(path.join(t2, 'auth.json')));
    await replace('auth.json', 'stale');
    await age(path.join(t2, 'auth.json'), 60_000);
    await fs.writeFile(path.join(s2, 'auth.json'), '{"v":4}'); // 写しの外で本物が新しくなった（ほかの会話・Devin を直に使った）
    await syncMcpOffHome(o2);
    t.ok('settle: 本物のほうが新しければ本物を正とし、写しの中身は kept に残してリンクに戻す（どちらも消さない）',
      await read(path.join(s2, 'auth.json')) === '{"v":4}' && await isLink(path.join(t2, 'auth.json')) && (await keptTexts()).includes('stale'));
    await fs.writeFile(path.join(t2, 'notes.json'), 'new-file'); await age(path.join(t2, 'notes.json'), 10_000);
    await fs.writeFile(path.join(t2, 'draft.tmp'), 'temp'); await age(path.join(t2, 'draft.tmp'), 10_000);
    await fs.writeFile(path.join(t2, 'own.db'), 'db'); await age(path.join(t2, 'own.db'), 10_000);
    await syncMcpOffHome(o2);
    t.ok('settle: 写しの中で新しく作られたファイルは本物へ写してリンクにする。一時ファイルらしい名前・SQLite の DB は運ばず写しに残す',
      await read(path.join(s2, 'notes.json')) === 'new-file' && await isLink(path.join(t2, 'notes.json'))
      && !(await exists(path.join(s2, 'draft.tmp'))) && await read(path.join(t2, 'draft.tmp')) === 'temp' && !(await exists(path.join(s2, 'own.db'))) && await read(path.join(t2, 'own.db')) === 'db');
    await fs.writeFile(path.join(t2, 'gen.toml'), 'agent-edit'); await age(path.join(t2, 'gen.toml'), 10_000);
    await syncMcpOffHome(o2);
    t.ok('settle: Pleiad が書くファイルを Devin が書き換えたら、本物へは運ばず kept に残し、写しは書き直す',
      await read(path.join(s2, 'gen.toml')) === 'real' && await read(path.join(t2, 'gen.toml')) === 'generated' && (await keptTexts()).includes('agent-edit'));
    await fs.writeFile(path.join(t2, 'gen.toml'), 'agent-edit-2');
    await syncMcpOffHome(o2);
    t.ok('settle: 書いた直後でも、Pleiad が書き直すファイルの書き換えは kept に残してから書き直す', await read(path.join(t2, 'gen.toml')) === 'generated' && (await keptTexts()).includes('agent-edit-2'));
    const noKeep = path.join(root, 'nokeep-overlay');
    await syncMcpOffHome({ source: s2, target: noKeep });
    await fs.rm(path.join(noKeep, 'auth.json')); await fs.writeFile(path.join(noKeep, 'auth.json'), 'only-here'); await age(path.join(noKeep, 'auth.json'), 60_000);
    await syncMcpOffHome({ source: s2, target: noKeep });
    t.ok('settle: kept を渡さないそろえは、置き換わったファイルを運ばず消さない（写しに残す）', await read(path.join(noKeep, 'auth.json')) === 'only-here' && await read(path.join(s2, 'auth.json')) === '{"v":4}');
    // 古い写しを消す前にも運ぶ
    const pr2 = path.join(root, 'prune-settle'), ps2 = path.join(root, 'prune-src');
    await fs.mkdir(ps2, { recursive: true }); await fs.writeFile(path.join(ps2, 'cred.toml'), 'old');
    const oldDirs = [];
    for (let i = 0; i < MCP_OFF_KEEP + 1; i++) {
      const dir = await claimMcpOffHome(pr2, ps2, [`p${i}`]);
      await syncMcpOffHome({ source: ps2, target: path.join(dir, 'devin'), kept });
      oldDirs.push(dir);
    }
    await age(path.join(ps2, 'cred.toml'), MCP_OFF_IDLE_MS + 600_000);
    const victim = path.join(oldDirs[0], 'devin', 'cred.toml');
    await fs.rm(victim); await fs.writeFile(victim, 'carried'); await age(victim, MCP_OFF_IDLE_MS + 300_000);
    for (const [i, dir] of oldDirs.entries()) await age(dir, MCP_OFF_IDLE_MS + 60_000 + (i === 0 ? 60_000 : 0));
    await claimMcpOffHome(pr2, ps2, ['fresh']);
    t.ok('settle: 古い写しを片付けるときも、消す前に置き換わったファイルを本物へ運ぶ', !(await exists(oldDirs[0])) && await read(path.join(ps2, 'cred.toml')) === 'carried');

    // ---- 置き場の場所と片付け
    t.ok('写しの場所は本物の置き場 × 止める名前の組で決まる（順・重なりは問わない）',
      mcpOffHomeDir(root, source, ['b', 'a', 'a']) === mcpOffHomeDir(root, source, ['a', 'b']) && mcpOffHomeDir(root, source, ['a']) !== mcpOffHomeDir(root, source, ['b']));
    const pruneRoot = path.join(root, 'prune'), keepSrc = path.join(root, 'keep-src');
    await fs.mkdir(path.join(keepSrc, 'dir'), { recursive: true }); await fs.writeFile(path.join(keepSrc, 'dir', 'precious.txt'), 'precious');
    const old = new Date(Date.now() - MCP_OFF_IDLE_MS - 60_000);
    const made = [];
    for (let i = 0; i < MCP_OFF_KEEP + 2; i++) {
      const dir = await claimMcpOffHome(pruneRoot, keepSrc, [`n${i}`]);
      await syncMcpOffHome({ source: keepSrc, target: dir });
      await fs.utimes(dir, old, old);
      made.push(dir);
    }
    const fresh = await claimMcpOffHome(pruneRoot, keepSrc, ['fresh']);
    const left = await fs.readdir(pruneRoot);
    t.ok(`片付け: 新しい ${MCP_OFF_KEEP} 個を超え、使っていない古い写しを消す（リンクの先の本物は消さない）`,
      left.length === MCP_OFF_KEEP && left.includes(path.basename(fresh)) && await read(path.join(keepSrc, 'dir', 'precious.txt')) === 'precious', JSON.stringify({ left: left.length }));
    const recentRoot = path.join(root, 'recent');
    for (let i = 0; i < MCP_OFF_KEEP + 2; i++) await claimMcpOffHome(recentRoot, keepSrc, [`r${i}`]);
    t.ok('片付け: 最近使った写しは数を超えても消さない（いま走っている会話の写しを消さない）', (await fs.readdir(recentRoot)).length === MCP_OFF_KEEP + 2 && made.length === MCP_OFF_KEEP + 2);

    // ---- Devin
    const devinRoot = path.join(root, 'devin-cfg'), devinDir = path.join(devinRoot, 'devin');
    await fs.mkdir(devinDir, { recursive: true });
    const realMcp = '{\n  // user\n  "mcpServers": { "user1": { "command": "u1" }, "keep": { "command": "k" } },\n  "other": 1\n}\n';
    await fs.writeFile(path.join(devinDir, 'mcp_config.json'), realMcp);
    await fs.writeFile(path.join(devinDir, 'config.json'), JSON.stringify({ model: 'x', mcpServers: { legacy: { command: 'l' } } }));
    await fs.writeFile(path.join(devinDir, 'credentials.toml'), 'secret-fixture');
    const devinTarget = await prepareDevinMcpOff({ root: path.join(root, 'devin-mcp-off'), source: devinDir, suppress: ['user1', 'legacy', 'fromclaude'] });
    const outMcp = JSON.parse(await read(path.join(devinTarget, 'devin', 'mcp_config.json')));
    const outConfig = JSON.parse(await read(path.join(devinTarget, 'devin', 'config.json')));
    t.ok('Devin: 写しの mcp_config.json は止める名前に disabled: true を付け、本物に無い名前（取り込みの名前）は disabled だけの項目を足す',
      outMcp.mcpServers.user1.disabled === true && outMcp.mcpServers.user1.command === 'u1' && !outMcp.mcpServers.keep.disabled
      && JSON.stringify(outMcp.mcpServers.fromclaude) === '{"disabled":true}' && outMcp.other === 1, JSON.stringify(outMcp));
    t.ok('Devin: config.json に残る mcpServers は写しの mcp_config.json へ移し、写しの config.json からは外す（本物の config.json は書き換えない）',
      outMcp.mcpServers.legacy.disabled === true && outMcp.mcpServers.legacy.command === 'l' && !('mcpServers' in outConfig) && outConfig.model === 'x'
      && JSON.parse(await read(path.join(devinDir, 'config.json'))).mcpServers.legacy.command === 'l', JSON.stringify(outConfig));
    t.ok('Devin: 本物の mcp_config.json は元のまま。ほかのファイル（認証情報など）はリンク',
      await read(path.join(devinDir, 'mcp_config.json')) === realMcp && await isLink(path.join(devinTarget, 'devin', 'credentials.toml')));
    await fs.writeFile(path.join(devinDir, 'mcp_config.json'), '{ broken');
    let broken = null;
    try { await prepareDevinMcpOff({ root: path.join(root, 'devin-mcp-off'), source: devinDir, suppress: ['user1'] }); } catch (e) { broken = e; }
    t.ok('Devin: 本物の mcp_config.json が読めないときは止めずに知らせる', broken?.code === 'MCP_OFF_UNSUPPORTED');
    await fs.writeFile(path.join(devinDir, 'mcp_config.json'), realMcp);
    const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
    const env = { DEVIN_CONFIG_HOME: devinRoot, KEEP: '1' };
    const plain = await prepareDevinLaunch({ command: ['devin'], cwd, env, dataDir: path.join(root, 'data') });
    const none = await prepareDevinLaunch({ command: ['devin'], cwd, env, dataDir: path.join(root, 'data'), mcpOff: [] });
    t.ok('Devin: 止める名前が無いターンは今までと同じ起動（同じ引数・環境変数。写しを作らない）',
      JSON.stringify(plain) === JSON.stringify(none) && none.env.DEVIN_CONFIG_HOME === devinRoot && !(await exists(path.join(root, 'data', 'devin', 'mcp-off'))));
    const off = await prepareDevinLaunch({ command: ['devin'], cwd, env, dataDir: path.join(root, 'data'), mcpOff: ['user1'] });
    t.ok('Devin: 止める名前があるターンは DEVIN_CONFIG_HOME だけを写しに替える（引数・ほかの環境変数・入力の env は変えない）',
      off.env.DEVIN_CONFIG_HOME.startsWith(path.join(root, 'data', 'devin', 'mcp-off')) && JSON.stringify(off.command) === JSON.stringify(none.command)
      && off.env.KEEP === '1' && off.env.DEVIN_SESSIONS_DIR === none.env.DEVIN_SESSIONS_DIR && env.DEVIN_CONFIG_HOME === devinRoot);
    const meta = await prepareDevinLaunch({ command: ['devin'], cwd, env, dataDir: path.join(root, 'data'), metadata: true, mcpOff: ['user1'] });
    t.ok('Devin: モデル一覧の取得（metadata）は止める名前に関わらず固定の置き場', meta.env.DEVIN_CONFIG_HOME === path.join(root, 'data', 'devin', 'metadata-config'));
    // 止めたターンの写しの中で Devin が認証情報を置き換えた → 止める名前を on に戻した次のターンの起動で本物へ運ぶ
    const inOverlay = path.join(off.env.DEVIN_CONFIG_HOME, 'devin', 'credentials.toml');
    await fs.rm(inOverlay); await fs.writeFile(inOverlay, 'refreshed-fixture');
    const past = new Date(Date.now() - 60_000), older = new Date(Date.now() - 120_000);
    await fs.utimes(inOverlay, past, past); await fs.utimes(path.join(devinDir, 'credentials.toml'), older, older);
    const back = await prepareDevinLaunch({ command: ['devin'], cwd, env, dataDir: path.join(root, 'data'), mcpOff: [] });
    t.ok('Devin: 写しの中で置き換わった認証情報は、止める名前の無い次のターンの起動でも本物へ運び、写しはリンクに戻す（今までと同じ起動のまま）',
      back.env.DEVIN_CONFIG_HOME === devinRoot && await read(path.join(devinDir, 'credentials.toml')) === 'refreshed-fixture' && await isLink(inOverlay));
    t.ok('Devin: 運べない中身を残す場所はデータ置き場の devin/mcp-off-kept（写しの外）', JSON.parse(await read(`${path.join(off.env.DEVIN_CONFIG_HOME, 'devin')}.pleiad.json`)).kept === path.join(root, 'data', 'devin', 'mcp-off-kept'));
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
