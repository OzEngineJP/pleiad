import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncMcpOffHome, claimMcpOffHome, mcpOffHomeDir, MCP_OFF_KEEP, MCP_OFF_IDLE_MS } from '../../core/backends/mcp-off-home.mjs';
import { grokConfigWithDisabled, prepareGrokMcpOff } from '../../core/backends/grok-mcp-off.mjs';
import { parseToml } from '../../core/toml.mjs';
import { prepareDevinMcpOff, prepareDevinLaunch } from '../../core/backends/devin-config.mjs';

export const name = 'mcp-off-home';
export const title = 'Grok・Devin 自身の MCP を名前で止める設定の置き場の写し（本物は書き換えず、止める名前だけ写しに書く。ADR 0330）';

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

    // ---- Grok
    const NOTE = ' # Added by Pleiad for this conversation (MCP servers turned off for Grok)';
    const realToml = 'model = "m"\n\n[mcp_servers.a]\ncommand = "a"\n';
    t.ok('Grok: 本物の config.toml の先頭（最上位の表）に disabled_mcp_servers を足す（名前は並べ直し・重ねない。表の中に入れない）',
      grokConfigWithDisabled(realToml, ['z', 'y', 'z']) === `disabled_mcp_servers = ["y","z"]${NOTE}\n${realToml}`
      && grokConfigWithDisabled('', ['q"x']) === `disabled_mcp_servers = ["q\\"x"]${NOTE}\n`
      && JSON.stringify(parseToml(grokConfigWithDisabled('[mcp_servers.a]\ncommand = "a"\n', ['a'])).mcp_servers) === '{"a":{"command":"a"}}');
    t.ok('Grok: 本物にある 1 行の disabled_mcp_servers は、本物の名前と合わせて置き換える',
      grokConfigWithDisabled('# top\ndisabled_mcp_servers = ["x"] # mine\nmodel = "m"\n[t]\nk = 1\n', ['b']) === `# top\ndisabled_mcp_servers = ["b","x"]${NOTE}\nmodel = "m"\n[t]\nk = 1\n`);
    const refused = text => { try { grokConfigWithDisabled(text, ['b']); return null; } catch (e) { return e.code; } };
    t.ok('Grok: 本物の書き方を読み違えうるとき（複数行の配列・名前でない値・TOML として読めない）は、止めずに知らせる',
      refused('disabled_mcp_servers = [\n  "x",\n]\n') === 'MCP_OFF_UNSUPPORTED' && refused('disabled_mcp_servers = "x"\n') === 'MCP_OFF_UNSUPPORTED'
      && refused('model = \n') === 'MCP_OFF_UNSUPPORTED' && refused('[t]\ndisabled_mcp_servers = ["x"]\n') === null);
    const grokHome = path.join(root, 'grok-home');
    await fs.mkdir(grokHome);
    await fs.writeFile(path.join(grokHome, 'config.toml'), '[mcp_servers.gone]\ncommand = "gone"\n');
    await fs.writeFile(path.join(grokHome, 'managed_config.toml'), 'org = true\n');
    await fs.writeFile(path.join(grokHome, 'managed_config.lock'), '');
    const grokTarget = await prepareGrokMcpOff({ root: path.join(root, 'grok-mcp-off'), source: grokHome, suppress: ['gone'] });
    const offConfig = await read(path.join(grokTarget, 'config.toml'));
    t.ok('Grok: 写しの config.toml は止める名前＋本物の中身。本物の config.toml は元のまま。managed_config.toml はリンク、ロックは写さない',
      offConfig === `disabled_mcp_servers = ["gone"]${NOTE}\n[mcp_servers.gone]\ncommand = "gone"\n` && !(await isLink(path.join(grokTarget, 'config.toml')))
      && await read(path.join(grokHome, 'config.toml')) === '[mcp_servers.gone]\ncommand = "gone"\n'
      && await isLink(path.join(grokTarget, 'managed_config.toml')) && !(await exists(path.join(grokTarget, 'managed_config.lock'))));
    // 前の版の写し・Grok の同期が写しに残した普通の managed_config.toml: 本物に無ければ消し、あればリンクに戻す
    const staleHome = path.join(root, 'grok-home-2');
    await fs.mkdir(staleHome);
    const staleTarget = await claimMcpOffHome(path.join(root, 'grok-mcp-off'), staleHome, ['gone']);
    await fs.writeFile(path.join(staleTarget, 'managed_config.toml'), '[[denied_mcp_servers]]\nserver_name = "gone"\n');
    await prepareGrokMcpOff({ root: path.join(root, 'grok-mcp-off'), source: staleHome, suppress: ['gone'] });
    await fs.rm(path.join(grokTarget, 'managed_config.toml')); await fs.writeFile(path.join(grokTarget, 'managed_config.toml'), 'synced');
    await prepareGrokMcpOff({ root: path.join(root, 'grok-mcp-off'), source: grokHome, suppress: ['gone'] });
    t.ok('Grok: 写しにだけある managed_config.toml は消し、本物にあるものはリンクに戻す（本物と違う管理の設定で起動しない）',
      !(await exists(path.join(staleTarget, 'managed_config.toml'))) && await isLink(path.join(grokTarget, 'managed_config.toml'))
      && await read(path.join(grokHome, 'managed_config.toml')) === 'org = true\n' && (await fs.readdir(staleHome)).every(n => n !== 'managed_config.toml'));
    t.ok('Grok: 会話の記録（sessions）は本物に作って写しからリンクする（止める名前の有無で記録が分かれない）',
      await exists(path.join(grokHome, 'sessions')) && await isLink(path.join(grokTarget, 'sessions')));

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
