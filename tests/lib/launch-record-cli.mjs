// 起動の記録用の偽の Claude Code CLI（tests/lib/claude-launch-record.mjs）。起こされた argv・cwd・env を記録して終わる。LLM は呼ばない。
// 書き先は env の LAUNCH_RECORD_OUT（記録には入れない）。--version と auth は fake-claude-cli と同じ答え
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.288 (Claude Code)\n'); process.exit(0); }
if (argv[0] === 'auth') { process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'fake', email: 'fake@example.invalid' })}\n`); process.exit(0); }
const out = process.env.LAUNCH_RECORD_OUT;
if (out) {
  const env = { ...process.env }; delete env.LAUNCH_RECORD_OUT;
  const files = {};
  for (const a of argv) for (const m of [/^--(?:settings|mcp-config)=(.+)$/.exec(a)]) if (m) { try { files[m[1]] = fs.readFileSync(m[1], 'utf8'); } catch { /* 無い */ } }
  fs.writeFileSync(out, JSON.stringify({ argv, cwd: process.cwd(), env, files }));
}
process.exit(0);
