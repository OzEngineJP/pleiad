// Claude のログインの期限切れ（401。#53・ADR 0212）。
//   - normalize: assistant の error: 'authentication_failed' と、result の is_error・api_error_status: 401 から印（authFailed）を作る
//   - claude バックエンド: 失敗の turnResult に kind: 'auth' と pristine（ツールも本文もまだ出ていない）を付ける。印が無くても文面で拾う
//   - server（fake の台本 "fail-auth"）: auth（cli / token）と backend を添える。設定の行の expired・cliPath・cliVersion、印の消え方
// SDK の query は身代わりに差し替え（setClaudeSdkForTest）、server は fake バックエンドで流す。CLI も LLM も呼ばない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSdkMessage, isClaudeAuthError } from '../../core/backends/claude-normalize.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeAuth } from '../../core/auth/claude-cli.mjs';
import { authFailureMessage, shouldAutoResend } from '../../web/auth-expired.mjs';

export const name = 'claude-auth-expired';
export const title = 'Claude のログインの期限切れ: 401 の見分け（SDK の印・文面）・pristine・失敗の行に添える auth・設定の行の期限切れの印と CLI の在り処';

const SESSION = '11111111-2222-4333-8444-555555555556';
const MESSAGE = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';
const THROWN = `Claude Code returned an error result: ${MESSAGE}`;
const TOKEN = 'sk-ant-oat01-' + 'Q'.repeat(48);

const init = () => ({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-test' });
const authAssistant = () => ({ type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), error: 'authentication_failed',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: MESSAGE }] } });
const authResult = () => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: MESSAGE, session_id: SESSION, num_turns: 1, total_cost_usd: 0 });
const delta = (text) => ({ type: 'stream_event', parent_tool_use_id: null, session_id: SESSION, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const toolUse = (id) => ({ type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } });
const toolResult = (id) => ({ type: 'user', parent_tool_use_id: null, session_id: SESSION, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

/** 決まった並びを流してから、throws があればその例外で終わる SDK の query の身代わり */
function scriptedSdk(messages, throws = null) {
  const query = ({ prompt }) => {
    (async () => { for await (const _ of prompt) { /* 最初のプロンプト */ } })();
    return {
      interrupt: () => Promise.resolve({}), close() {},
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
        if (throws) throw new Error(throws);
      },
    };
  };
  return setClaudeSdkForTest({ query, executable: () => 'claude-fake', resumeGraceMs: 30 });
}

async function runClaude(messages, throws) {
  const restore = scriptedSdk(messages, throws);
  const events = [];
  try {
    await claude.runTurn({
      prompt: 'work', sessionId: null, cwd: process.cwd(), mode: 'bypass',
      emit: (ev) => events.push(ev), askPermission: async () => ({ allow: true }),
      signal: new AbortController(), control: {}, hostSessionId: 'host-auth-expired',
    }).catch(() => {});
  } finally { restore(); }
  return events;
}
const resultOf = (events) => events.filter((e) => e.type === 'turnResult');

export default async function (t) {
  // ---- 1. normalize
  {
    const a = normalizeSdkMessage(authAssistant());
    t.ok('assistant の error: authentication_failed から印を作る', a.some((e) => e.type === 'authFailed'), JSON.stringify(a));
    t.ok('合成の発言は本文を流さない（text.delta が無い）', !a.some((e) => e.type === 'text.delta'));
    const r = normalizeSdkMessage(authResult());
    t.ok('result の is_error・api_error_status: 401 から、文面つきの印を作る', r.some((e) => e.type === 'authFailed' && e.message === MESSAGE), JSON.stringify(r));
    t.ok('ふつうの成功の result には印を付けない', !normalizeSdkMessage({ type: 'result', subtype: 'success', num_turns: 1 }).some((e) => e.type === 'authFailed'));
    t.ok('ほかの失敗（rate_limit）には印を付けない', !normalizeSdkMessage({ type: 'assistant', error: 'rate_limit', message: { content: [] } }).some((e) => e.type === 'authFailed'));
    t.ok('文面の控え: SDK の例外の文を 401 と見分ける', isClaudeAuthError(THROWN));
    t.ok('文面の控え: ほかの失敗は見分けない', !isClaudeAuthError('Claude Code process exited with code 1') && !isClaudeAuthError('ENOENT: line 401 of file') && !isClaudeAuthError(''));
  }

  // ---- 1b. 失敗の行の一文と、自動でもう一度送る条件（web/auth-expired.mjs）
  {
    const login = authFailureMessage({ mode: 'cli', email: 'user@example.com' }, { agent: 'Claude Code' });
    t.ok('CLI のログイン: エージェントとアカウントを出す（CLI のパスは出さない）', login.includes('Claude Code') && login.includes('user@example.com') && !login.includes('/'), login);
    const unknown = authFailureMessage({ mode: 'cli', email: null }, { agent: 'Claude Code' });
    t.ok('アカウントが分からなければ括弧ごと省く', unknown.includes('Claude Code') && !/[（(]/.test(unknown), unknown);
    const token = authFailureMessage({ mode: 'token', accountId: 'acct-1', name: '仕事用' });
    t.ok('アカウントのトークン: 名前を出す', token.includes('仕事用'), token);
    t.ok('名前が添えられていなければ一覧の名前を使う', authFailureMessage({ mode: 'token', accountId: 'acct-1' }, { accountName: '私用' }).includes('私用'));
    const same = { fromRow: true, pristine: true, before: 'a@example.com', after: 'a@example.com' };
    t.ok('3 つがそろえば自動でもう一度送る', shouldAutoResend(same));
    t.ok('設定・ほかの窓からのログインでは自動で送らない', !shouldAutoResend({ ...same, fromRow: false }));
    t.ok('ツールの実行か返答が出た後の失敗は自動で送らない', !shouldAutoResend({ ...same, pristine: false }));
    t.ok('別のアカウントでログインし直したら自動で送らない', !shouldAutoResend({ ...same, after: 'b@example.com' }));
    t.ok('前のアカウントが分からなければ自動で送らない', !shouldAutoResend({ ...same, before: null }) && !shouldAutoResend({ ...same, after: undefined }));
  }

  // ---- 1c. claude auth login の取り消し（core/auth/claude-cli.mjs の cancel）
  {
    let loginChild = null;
    const auth = createClaudeAuth((args) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit('close', null));
      if (args[1] === 'login') loginChild = child;
      else queueMicrotask(() => { child.stdout.write(JSON.stringify({ loggedIn: true, email: 'a@example.com' })); child.emit('close', 0); });
      return child;
    });
    t.ok('待っていなければ cancel は何もしない', (await auth.cancel()).cancelled === false);
    const login = auth.login({ emit() {} }).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 5));
    const res = await auth.cancel();
    const error = await login;
    t.ok('cancel で claude auth login の子を止め、login は CANCELLED で返る', res.cancelled === true && loginChild && error?.code === 'CANCELLED', `${error?.code} ${error?.message}`);
    t.ok('取り消した後は次のログインを始められる（待ちが残らない）', (await auth.status()).pending !== true);
  }

  // ---- 2. claude バックエンドの turnResult
  {
    const events = await runClaude([init(), authAssistant(), authResult()], THROWN);
    const [res] = resultOf(events);
    t.ok('最初の API 呼び出しで 401: error の turnResult に kind: auth と pristine: true', resultOf(events).length === 1 && res.outcome === 'error' && res.kind === 'auth' && res.pristine === true && res.error.includes('401'), JSON.stringify(resultOf(events)));
    t.ok('印（authFailed）は外へ流さない', !events.some((e) => e.type === 'authFailed'));
  }
  {
    const events = await runClaude([init(), toolUse('toolu_1'), toolResult('toolu_1'), authAssistant(), authResult()], THROWN);
    const [res] = resultOf(events);
    t.ok('ツールが動いた後の 401 は pristine: false', res?.kind === 'auth' && res.pristine === false, JSON.stringify(res));
  }
  {
    const events = await runClaude([init(), delta('途中まで'), authAssistant(), authResult()], THROWN);
    t.ok('本文が出た後の 401 も pristine: false', resultOf(events)[0]?.pristine === false);
  }
  {
    const events = await runClaude([init()], THROWN);
    const [res] = resultOf(events);
    t.ok('SDK の印が無くても、例外の文面で kind: auth にする', res?.kind === 'auth' && res.pristine === true, JSON.stringify(res));
  }
  {
    const events = await runClaude([init(), authAssistant(), authResult()], null);
    const [res] = resultOf(events);
    t.ok('例外にならずに終わっても（is_error の result だけ）、成功ではなく auth の失敗で出す', resultOf(events).length === 1 && res.outcome === 'error' && res.kind === 'auth' && res.error === MESSAGE, JSON.stringify(resultOf(events)));
  }
  {
    const events = await runClaude([init()], 'Claude Code process exited with code 1');
    const [res] = resultOf(events);
    t.ok('ほかの失敗には kind を付けない（今のまま）', res?.outcome === 'error' && !('kind' in res) && !('pristine' in res), JSON.stringify(res));
  }

  // ---- 3. server（fake の台本 fail-auth）
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-auth-expired-'));
  const api = await startFakeAnthropicApi({ [TOKEN]: 'org-token' });
  const cliDir = path.join(scratch, 'cli-config');
  await fs.mkdir(cliDir, { recursive: true });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_ANTHROPIC_API: api.url, CLAUDE_CONFIG_DIR: cliDir }, dataDir: path.join(scratch, 'data') });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const status = () => c.cmd('authStatus', { backend: 'fake' });
  const failure = async (sessionId, prompt) => {
    const r = await c.runTurn({ sessionId, prompt });
    return r.events.find((e) => e.type === 'turnResult' && e.sessionId === sessionId);
  };
  try {
    const before = await status();
    t.ok('設定の行に CLI の在り処と版（cliInfo を持つバックエンド）', typeof before.cliPath === 'string' && before.cliPath.endsWith('fake.mjs') && before.cliVersion === '0.0.0-fake', JSON.stringify(before));
    t.ok('ホームの下の在り処は ~ で短くする', !ROOT.startsWith(os.homedir()) || before.cliPath.startsWith('~'), before.cliPath);
    await c.cmd('authLogin', { backend: 'fake' });
    t.ok('ログインした直後は期限切れではない', (await status()).loggedIn === true && !(await status()).expired);

    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const failed = await failure(sessionId, 'fail-auth');
    t.ok('401 の失敗に kind・pristine・backend・auth（mode: cli とメールアドレス）を添える', failed?.outcome === 'error' && failed.kind === 'auth' && failed.pristine === true
      && failed.backend === 'fake' && failed.auth?.mode === 'cli' && failed.auth.email === 'tester' && failed.error.includes('401'), JSON.stringify(failed));
    const expired = await status();
    t.ok('CLI はログイン済みのままでも、設定の行は期限切れ（expired）', expired.loggedIn === true && expired.expired === true, JSON.stringify(expired));
    const ok = await c.runTurn({ sessionId, prompt: 'echo:ok' });
    t.ok('次の CLI のログインのターンが通ると期限切れの印は消える', ok.outcome === 'ok' && !(await status()).expired);

    const midway = await failure(sessionId, 'fail-auth tool');
    t.ok('ツールが動いた後の失敗は pristine: false', midway?.kind === 'auth' && midway.pristine === false, JSON.stringify(midway));
    t.ok('ふたたび期限切れ', (await status()).expired === true);
    const relogin = await c.cmd('authLogin', { backend: 'fake' });
    t.ok('ログインし直すと期限切れの印は消える（応答にも出さない）', relogin.loggedIn === true && !relogin.expired && !(await status()).expired, JSON.stringify(relogin));

    const plain = await failure(sessionId, 'fail');
    t.ok('ほかの失敗には auth を添えず、期限切れにもしない', plain?.outcome === 'error' && !plain.kind && !plain.auth && !(await status()).expired, JSON.stringify(plain));

    // Pleiad の Claude のアカウント（トークン）を使う会話
    const saved = await c.cmd('saveClaudeAccount', { name: '仕事用', token: TOKEN });
    const { sessionId: tokenSession } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.cmd('setTurnSettings', { sessionId: tokenSession, account: saved.id });
    const tokenFailed = await failure(tokenSession, 'fail-auth');
    t.ok('アカウントのトークンの会話は auth: { mode: token, accountId, name }', tokenFailed?.kind === 'auth' && tokenFailed.auth?.mode === 'token'
      && tokenFailed.auth.accountId === saved.id && tokenFailed.auth.name === '仕事用' && !('email' in tokenFailed.auth), JSON.stringify(tokenFailed));
    t.ok('トークンの期限切れは CLI のログインの期限切れにしない', !(await status()).expired);

    // ログインの取り消し（会話の失敗の行の「キャンセル」）。待っていなければ何もしない
    const idle = await c.cmd('authCancel', { backend: 'fake' });
    t.ok('待っているログインが無ければ authCancel は何もしない', idle.supported === true && idle.cancelled === false, JSON.stringify(idle));
    await c.cmd('authLogout', { backend: 'fake' });
    t.ok('ログアウトしたら期限切れは出さない', (await status()).loggedIn === false && !(await status()).expired);
  } finally {
    c.close?.();
    await server.stop();
    await api.close?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // ---- 4. 待っているログインを取り消す（fake のログインを遅らせる）
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-auth-cancel-'));
    const slow = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_LOGIN_MS: '20000' }, dataDir: dir });
    const w = await open({ port: slow.port, token: slow.token, autoAllow: true });
    try {
      const login = w.cmd('authLogin', { backend: 'fake' }).then(() => null, (e) => e);
      let pending = false;
      for (let i = 0; i < 100 && !pending; i++) { pending = (await w.cmd('authStatus', { backend: 'fake' })).pending === true; if (!pending) await new Promise((r) => setTimeout(r, 20)); }
      t.ok('ログインを待っている間は pending', pending);
      const cancelled = await w.cmd('authCancel', { backend: 'fake' });
      const error = await login;
      t.ok('authCancel で待っているログインが CANCELLED の失敗で返る', cancelled.cancelled === true && error?.code === 'CANCELLED', `${JSON.stringify(cancelled)} ${error?.code} ${error?.message}`);
      t.ok('取り消した後はログインしていない', (await w.cmd('authStatus', { backend: 'fake' })).loggedIn === false);
    } finally {
      w.close?.();
      await slow.stop();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
