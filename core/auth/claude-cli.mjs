import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { t } from '../i18n.mjs';

export function createClaudeAuth(launch = (args) => spawnCli(cliCommand('claude'), args, { stdio: ['ignore', 'pipe', 'pipe'] })) {
  let pending = null;
  // 待っている `claude auth login` の子と、取り消しを頼まれたか（cancel。設定のカード・初回の案内・会話の失敗の行の［やめる］。ADR 0212・0243）
  let loginChild = null;
  let cancelled = false;
  function run(args, { emit, timeout = 15_000, onChild } = {}) {
    return new Promise((resolve, reject) => {
      const child = launch(args);
      onChild?.(child);
      let output = '';
      let stdout = '';
      let lastUrl = '';
      const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error(t('claude.auth.timeout')), { code: 'TIMEOUT' })); }, timeout);
      const read = data => {
        output = (output + data.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-64_000);
        const urls = output.match(/https:\/\/[^\s<>"\x1b]+/g) || [];
        for (const url of urls) {
          let parsed; try { parsed = new URL(url); } catch { continue; }
          // claude.com は Claude のアカウント（Pro・Max）の認可の入口（CLI 2.1.303 の同梱コードの CLAUDE_AI_AUTHORIZE_URL: https://claude.com/cai/oauth/authorize）
          if (!['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'].includes(parsed.hostname) || url === lastUrl) continue;
          lastUrl = url;
          emit?.({ type: 'auth', phase: 'url', url });
        }
      };
      child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-64_000); read(data); });
      child.stderr.on('data', read);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, output: stdout }); });
    });
  }
  return {
    async status() {
      if (pending) return { loggedIn: false, pending: true };
      const result = await run(['auth', 'status', '--json']);
      let value; try { value = JSON.parse(result.output); } catch {
        throw new Error(t('claude.auth.statusUnreadable'));
      }
      return { loggedIn: result.code === 0 && value.loggedIn === true, account: value.email || undefined, detail: value.authMethod || undefined };
    },
    async login({ emit }) {
      if (pending) throw new Error(t('claude.auth.loginPending'));
      cancelled = false;
      pending = run(['auth', 'login'], { emit, timeout: 10 * 60_000, onChild: child => { loginChild = child; } });
      try {
        const result = await pending.catch(error => { if (cancelled) return { code: null }; throw error; });
        if (cancelled) throw Object.assign(new Error(t('claude.auth.loginCancelled')), { code: 'CANCELLED' });
        if (result.code !== 0) throw new Error(t('claude.auth.loginFailed'));
        emit({ type: 'auth', phase: 'done', message: t('claude.auth.loggedIn') });
      } finally { pending = null; loginChild = null; cancelled = false; }
    },
    /** 待っているログインをやめる（子を止める）。待っていなければ何もしない。login は CANCELLED で返る */
    async cancel() {
      if (!pending || !loginChild) return { cancelled: false };
      cancelled = true;
      loginChild.kill();
      return { cancelled: true };
    },
    async logout() {
      if (pending) throw new Error(t('claude.auth.waitLogin'));
      const result = await run(['auth', 'logout']);
      if (result.code !== 0) throw new Error(t('claude.auth.logoutFailed'));
    },
  };
}

export const claudeAuth = createClaudeAuth();
