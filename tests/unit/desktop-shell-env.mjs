import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  RESOLVING_ENV, SWITCH_ENV, shouldResolve, loginShell, parseEnvBlock, resolveShellEnv, mergeShellEnv, applyLoginShellEnv,
} = require('../../desktop/shell-env.cjs');

export const name = 'desktop-shell-env';
export const title = 'デスクトップ版がサーバーを起こす前に、ログインシェルの環境（PATH など）を読み込む';

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** 偽のログインシェル。rc の代わりに PATH と変数を足し、rc の出力に見立てた文字を前後に出してから、最後の引数（-c のコマンド）を走らせる */
function fakeShell(dir, { body = '', name = 'fake-shell' } = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh
for last; do :; done
printf 'rc の挨拶\\n'
PATH="/opt/fake/bin:/opt/fake/sbin:$PATH"; export PATH
FROM_RC='a=b c'; export FROM_RC
ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE
printf 'args=%s %s %s\\n' "$1" "$2" "$3" >&2
${body}
eval "$last"
printf 'rc の後始末\\n'
`, { mode: 0o755 });
  return file;
}

export default async function(t) {
  // 読み込むかの判断
  t.ok('Windows は読まない（GUI でも利用者の環境変数を受け取る）', shouldResolve({ platform: 'win32', env: {} }) === false);
  t.ok('macOS・Linux は読む', shouldResolve({ platform: 'darwin', env: {} }) === true && shouldResolve({ platform: 'linux', env: {} }) === true);
  t.ok(`${SWITCH_ENV}=off なら読まない（戻し道）`, shouldResolve({ platform: 'darwin', env: { [SWITCH_ENV]: 'off' } }) === false);
  t.ok('読み込み中のシェルから起こされたら読まない（入れ子にしない）', shouldResolve({ platform: 'darwin', env: { [RESOLVING_ENV]: '1' } }) === false);

  // どのシェルを走らせるか
  t.ok('SHELL を使う', loginShell({ env: { SHELL: '/bin/zsh' } }) === '/bin/zsh');
  t.ok('SHELL が無ければ OS の利用者情報のシェル', loginShell({ env: {}, userInfo: () => ({ shell: '/bin/bash' }) }) === '/bin/bash');
  t.ok('絶対パスでないシェルは走らせない', loginShell({ env: { SHELL: 'zsh' } }) === null);
  t.ok('利用者情報が読めなければ null', loginShell({ env: {}, userInfo: () => { throw new Error('no user'); } }) === null);

  // env -0 の出力
  const parsed = parseEnvBlock('A=1\0B=x=y\0EMPTY=\0MULTI=one\ntwo\0broken\0');
  t.ok('NUL 区切りの KEY=VALUE を読む（値の = と改行・空の値を保つ。= の無い断片は捨てる）',
    JSON.stringify(parsed) === JSON.stringify({ A: '1', B: 'x=y', EMPTY: '', MULTI: 'one\ntwo' }), JSON.stringify(parsed));

  // 重ね方
  {
    const base = { PATH: `/pleiad/bin:${LAUNCHD_PATH}`, HOME: '/Users/u', KEEP: 'base', PWD: '/', ELECTRON_RUN_AS_NODE: '' };
    const shellEnv = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', KEEP: 'shell', NEW: '1', PWD: '/Users/u', SHLVL: '2', _: '/usr/bin/env', OLDPWD: '/x', ELECTRON_RUN_AS_NODE: '1', [RESOLVING_ENV]: '1' };
    const merged = mergeShellEnv(base, shellEnv, { delimiter: ':' });
    t.ok('PATH はシェルの並びを先にし、base にしか無い要素を後ろに残す（重複は前を残す）',
      merged.PATH === '/opt/homebrew/bin:/usr/bin:/bin:/pleiad/bin:/usr/sbin:/sbin', merged.PATH);
    t.ok('ほかの変数はシェルの値を優先し、シェルにしか無いものを足す', merged.KEEP === 'shell' && merged.NEW === '1' && merged.HOME === '/Users/u');
    t.ok('シェル自身の作業の印（PWD・OLDPWD・SHLVL・_）と読み込みの印は写さない',
      merged.PWD === '/' && !('OLDPWD' in merged) && !('SHLVL' in merged) && !('_' in merged) && !(RESOLVING_ENV in merged), JSON.stringify(merged));
    t.ok('ELECTRON_ で始まるものは写さない（rc の値で Electron の動き方を変えない）', merged.ELECTRON_RUN_AS_NODE === '');
    t.ok('base は書き換えない', base.KEEP === 'base' && base.PATH === `/pleiad/bin:${LAUNCHD_PATH}`);
    t.ok('シェルに PATH が無ければ base の PATH のまま', mergeShellEnv(base, { A: '1' }, { delimiter: ':' }).PATH === base.PATH);
  }

  // env をその場で書き換える
  {
    const env = { PATH: LAUNCHD_PATH, SHELL: '/bin/zsh' };
    const calls = [];
    const ok = await applyLoginShellEnv({ env, platform: 'darwin', resolve: async (args) => { calls.push(args); return { PATH: '/opt/homebrew/bin:/usr/bin', FROM_RC: '1' }; } });
    t.ok('読み込めたら env を書き換えて true', ok === true && env.PATH === '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' && env.FROM_RC === '1', JSON.stringify(env));
    t.ok('SHELL のシェルと今の env で読み込む', calls.length === 1 && calls[0].shell === '/bin/zsh' && calls[0].env === env);
  }
  {
    const env = { PATH: LAUNCHD_PATH, SHELL: '/bin/zsh' };
    const logs = [];
    const ok = await applyLoginShellEnv({ env, platform: 'darwin', resolve: async () => null, log: message => logs.push(message) });
    t.ok('読み込めなければ env をそのままにして false、理由をログに残す', ok === false && env.PATH === LAUNCHD_PATH && Object.keys(env).length === 2 && logs.length === 1 && logs[0].includes('/bin/zsh'), JSON.stringify(logs));
  }
  {
    const env = { PATH: LAUNCHD_PATH };
    let called = false;
    const ok = await applyLoginShellEnv({ env, platform: 'win32', resolve: async () => { called = true; return { PATH: '/x' }; } });
    t.ok('Windows ではシェルを走らせず env も変えない', ok === false && called === false && env.PATH === LAUNCHD_PATH);
  }

  t.ok('シェルが無ければ走らせず null', await resolveShellEnv({ shell: null }) === null);

  if (process.platform === 'win32') {
    t.skip('本物のシェルを走らせる確かめは macOS・Linux だけ');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-shell-env-'));
  try {
    const base = { PATH: LAUNCHD_PATH, HOME: dir };

    // rc の出力に紛れず、印のあいだの env -0 だけを読む
    {
      const shellEnv = await resolveShellEnv({ shell: fakeShell(dir), env: base });
      t.ok('ログインシェルの PATH と変数を読む（rc が出す文字に紛れない）',
        shellEnv?.PATH === `/opt/fake/bin:/opt/fake/sbin:${LAUNCHD_PATH}` && shellEnv.FROM_RC === 'a=b c', JSON.stringify(shellEnv));
      t.ok('読み込み中のシェルには印を付ける', shellEnv?.[RESOLVING_ENV] === '1');
    }

    // -i -l -c で起こす（~/.zprofile と ~/.zshrc の両方を読ませる）
    {
      const argsFile = path.join(dir, 'args.txt');
      const shell = fakeShell(dir, { name: 'args-shell', body: `printf '%s|%s|%s' "$1" "$2" "$3" > '${argsFile}'` });
      await resolveShellEnv({ shell, env: base });
      t.ok('対話のログインシェルとして起こす（-i -l -c）', fs.readFileSync(argsFile, 'utf8') === '-i|-l|-c', fs.readFileSync(argsFile, 'utf8'));
    }

    // 印まで届けば、rc が残した裏のプロセスが標準出力を持ち続けても待たない
    {
      const shell = fakeShell(dir, { name: 'lingering-shell', body: '(sleep 5; echo late) &' });
      const started = Date.now();
      const shellEnv = await resolveShellEnv({ shell, env: base, timeoutMs: 4_000 });
      t.ok('裏のプロセスが残っても、後ろの印が届いた時点で返す', shellEnv?.FROM_RC === 'a=b c' && Date.now() - started < 3_000, `${Date.now() - started}ms`);
    }

    // 止まったままの rc は時間切れで null
    {
      const pidFile = path.join(dir, 'stuck.pid');
      const shell = fakeShell(dir, { name: 'stuck-shell', body: `sleep 30 & echo $! > '${pidFile}'; wait` });
      const started = Date.now();
      const shellEnv = await resolveShellEnv({ shell, env: base, timeoutMs: 300 });
      t.ok('rc が止まったら時間切れで null（起動を待たせ続けない）', shellEnv === null && Date.now() - started < 3_000, `${Date.now() - started}ms`);
      const stuckPid = Number(fs.readFileSync(pidFile, 'utf8'));
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try { process.kill(stuckPid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch { alive = false; }
      }
      t.ok('時間切れでは rc が起こした子も止める', !alive, String(stuckPid));
    }

    // 印を出さずに終わったら null
    {
      const shell = path.join(dir, 'exit-shell');
      fs.writeFileSync(shell, '#!/bin/sh\necho "rc で失敗"\nexit 1\n', { mode: 0o755 });
      t.ok('コマンドを走らせずに終わったシェルは null', await resolveShellEnv({ shell, env: base }) === null);
    }

    t.ok('起こせないシェルは null', await resolveShellEnv({ shell: path.join(dir, 'missing-shell'), env: base }) === null);

    // 全体: env を書き換える
    {
      const env = { ...base, SHELL: fakeShell(dir, { name: 'apply-shell' }) };
      const ok = await applyLoginShellEnv({ env, platform: process.platform });
      t.ok('本物のシェルで env を書き換える（PATH はシェルの並びを先に）',
        ok === true && env.PATH === `/opt/fake/bin:/opt/fake/sbin:${LAUNCHD_PATH}` && env.FROM_RC === 'a=b c' && !(RESOLVING_ENV in env) && !('ELECTRON_RUN_AS_NODE' in env), JSON.stringify(env));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
