// `claude auth login` の偽物（core/claude-login.mjs のテスト用）。本物の CLI もネットワークも使わない。
//
// 本物（2026-09-23 に観察した範囲）に似せて、ANSI の色・OSC 8 のハイパーリンク・折り返し（\r\n）付きで認可 URL を出し、
// `Paste code here if prompted >` でコードを待つ。
//   コード "bad"  … エラーを出してもう一度聞く
//   コード "exit" … 終了コード 1 で終わる
//   それ以外      … CLAUDE_CONFIG_DIR/.credentials.json（accessToken は FAKE_CLAUDE_LOGIN_ACCESS か 'fake-access'。FAKE_CLAUDE_ORG があれば .claude.json も）を書いて終了コード 0
// FAKE_CLAUDE_LOG があれば、受け取った env の要点（トークンの有無・CLAUDE_CONFIG_DIR・BROWSER）を JSON で書く。
import fs from 'node:fs';
import path from 'node:path';

const [, , ...args] = process.argv;
const known = args[0] === 'auth' && args[1] === 'login';
const out = s => process.stdout.write(s);

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args, hasOauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null, browser: process.env.BROWSER ?? null,
  }) + '\n');
}
if (!known) { out('unknown command\n'); process.exit(2); }

const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abcDEF123_-xyz&code_challenge_method=S256&state=STATE_fake-123';
// 80 桁で折り返し、色とハイパーリンクで包む（本物の PTY 出力に似せる）
const wrapped = url.match(/.{1,80}/g).join('\r\n');
out('\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;claude\x07\x1b[?25h');
out('Opening browser to sign in…\r\n');
out(`Browser didn't open? Use the url below to sign in:\r\n\r\n\x1b[94m\x1b]8;id=1;${url}\x1b\\${wrapped}\x1b[m\x1b]8;;\x1b\\\r\n\r\n`);
const prompt = () => out('Paste code here if prompted > ');
prompt();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\r\n|\r|\n/);
  buffer = lines.pop();
  for (const line of lines) handle(line.trim());
});

function handle(code) {
  if (!code) return;
  if (code === 'bad') { out('\r\n\x1b[31mOAuth error: Invalid code\x1b[39m\r\n'); prompt(); return; }
  if (code === 'exit') { out('\r\nOAuth error: request failed with status 400\r\n'); process.exit(1); }
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: process.env.FAKE_CLAUDE_LOGIN_ACCESS || 'fake-access', scopes: ['user:profile'] } }));
  // 本物は認可したアカウントを CLAUDE_CONFIG_DIR/.claude.json の oauthAccount に書く（FAKE_CLAUDE_ORG があれば真似る）
  if (dir && process.env.FAKE_CLAUDE_ORG) {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: process.env.FAKE_CLAUDE_ORG, emailAddress: process.env.FAKE_CLAUDE_EMAIL ?? 'fake@example.com' } }));
  }
  out('\r\nLogin successful.\r\n');
  process.exit(0);
}
