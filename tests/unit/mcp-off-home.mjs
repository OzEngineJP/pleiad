import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncMcpOffHome, claimMcpOffHome, mcpOffHomeDir, MCP_OFF_KEEP, MCP_OFF_IDLE_MS } from '../../core/backends/mcp-off-home.mjs';
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
    // エージェントが写しの中で一時ファイルからの rename でリンクを普通のファイルに置き換えた → 次のそろえで本物へのリンクに戻す
    await fs.rm(path.join(target, 'auth.json')); await fs.writeFile(path.join(target, 'auth.json'), 'replaced');
    await fs.writeFile(path.join(target, 'agent-made.db'), 'mine');
    await fs.writeFile(path.join(source, 'new.txt'), 'new');
    await syncMcpOffHome({ source, target, generated: { 'gen.toml': 'generated' }, skip: n => n === 'config.toml' });
    t.ok('そろえ直し: 普通のファイルに置き換わった本物と同じ名前はリンクに戻し、本物に増えたものを写し、写しだけのものは残す',
      await isLink(path.join(target, 'auth.json')) && await read(path.join(source, 'auth.json')) === '{"a":2}' && await isLink(path.join(target, 'new.txt'))
      && await read(path.join(target, 'agent-made.db')) === 'mine');
    await fs.rm(path.join(source, 'new.txt'));
    await syncMcpOffHome({ source, target, generated: { 'gen.toml': 'generated' }, skip: n => n === 'config.toml' });
    t.ok('そろえ直し: 本物から消えたもののリンクを外す', !(await exists(path.join(target, 'new.txt'))));
    t.ok('本物の置き場のファイルは増えも減りもしない（生成するファイルを本物に書かない）',
      (await fs.readdir(source)).sort().join() === sourceBefore && await read(path.join(source, 'gen.toml')) === 'real');

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
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
