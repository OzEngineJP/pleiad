import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextSettings } from '../../core/context-settings.mjs';
import { MAX_FILE, MAX_CLAUDE_JSON, scanContext } from '../../core/context-scan.mjs';
export const name = 'context-claude-json-size';
export const title = '~/.claude.json が 256 KB を超えても会話を止めない';
// Claude Code は ~/.claude.json に履歴・機能フラグのキャッシュを溜める。256 KB を超えると全会話の送信が止まった（2026-11-19）
export default async function(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-json-')));
  const home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo');
  try {
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const filler = 'x'.repeat(MAX_FILE + 64 * 1024);
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({
      cachedFeatureFlags: { big: filler },
      mcpServers: { fromUser: { command: 'node' } },
      projects: { [repo]: { mcpServers: { fromProject: { command: 'node' } } } },
    }));
    const settings = createContextSettings(path.join(tmp, 'data'), home);
    const effective = await settings.get(repo);
    const scan = await scanContext(effective, { home, runtime: true });
    t.ok('大きな ~/.claude.json でも探索の問題にならない', scan.diagnostics.length === 0 && !scan.limited, JSON.stringify(scan.diagnostics));
    const names = scan.entries.filter(e => e.kind === 'mcp').map(e => e.name).sort();
    t.ok('大きな ~/.claude.json から全体と作業場所の MCP を読む', names.includes('fromUser') && names.includes('fromProject'), names.join(','));
    const claude = scan.configs.find(c => c.path === path.join(home, '.claude.json'));
    t.ok('画面へは MCP の登録だけを出し、キャッシュの本文を出さない', !JSON.stringify(scan.configs).includes(filler.slice(0, 1000)) && (!claude || !String(claude.text ?? '').includes('cachedFeatureFlags')));

    // 上限（16 MB）を超えたら今までどおり問題として返す
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ big: 'y'.repeat(MAX_CLAUDE_JSON + 1) }));
    const over = await scanContext(effective, { home, runtime: true });
    t.ok('16 MB を超える ~/.claude.json は読まない', over.diagnostics.some(d => d.path === path.join(home, '.claude.json')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
