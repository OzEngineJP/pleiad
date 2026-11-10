// 偽の Claude Code CLI（ログインを切り替えられる版）。FAKE_CLAUDE_LOGIN_FLAG のファイルがあればログイン済み、無ければ未ログイン。
// auth status 以外は tests/lib/fake-claude-cli.mjs に任せる（試験が「あとからログインした」を作るため）
import fs from 'node:fs';
const argv = process.argv.slice(2);
const loggedIn = Boolean(process.env.FAKE_CLAUDE_LOGIN_FLAG) && fs.existsSync(process.env.FAKE_CLAUDE_LOGIN_FLAG);
if (argv[0] === 'auth') {
  process.stdout.write(`${JSON.stringify(loggedIn ? { loggedIn: true, authMethod: 'fake', email: 'fake@example.invalid' } : { loggedIn: false })}\n`);
  process.exit(0);
}
// ログインしていない間は会話を始められない（本物の CLI は「ログインしてください」で終わる）
if (!loggedIn && !argv.includes('--version')) {
  process.stderr.write('Not logged in - Please run /login\n');
  process.exit(1);
}
await import('./fake-claude-cli.mjs');
