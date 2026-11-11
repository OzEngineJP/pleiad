// 「インストール」の行に出す 1 行は、公式が案内している入れ方を、サーバーの OS に合わせて出す（確かめられないものは出さない）。
import { installCommandOf } from '../../core/cli-installation.mjs';

export const name = 'install-command';
export const title = 'Install command shown in the agent row: official one-liner per server OS, none when unconfirmed';
export default async function (t) {
  t.ok('Claude Code on macOS/Linux uses the native installer (not npm)', installCommandOf('claude', 'darwin') === 'curl -fsSL https://claude.ai/install.sh | bash' && installCommandOf('claude', 'linux') === 'curl -fsSL https://claude.ai/install.sh | bash');
  t.ok('Claude Code on Windows uses the PowerShell installer', installCommandOf('claude', 'win32') === 'irm https://claude.ai/install.ps1 | iex');
  t.ok('Codex on macOS/Linux uses the standalone installer', installCommandOf('codex', 'linux') === 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  t.ok('Codex on Windows shows no command (not confirmed)', installCommandOf('codex', 'win32') === null);
  t.ok('an agent without an official one-liner shows none', installCommandOf('antigravity', 'linux') === null && installCommandOf('no-such-agent') === null);
  t.ok('no npm one-liner is shown for any agent on any OS', ['claude', 'codex'].every((id) => ['win32', 'darwin', 'linux'].every((p) => !/npm/.test(installCommandOf(id, p) ?? ''))));
}
