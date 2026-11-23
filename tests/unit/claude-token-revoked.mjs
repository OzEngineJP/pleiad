// コネクターの入口がオンのアカウント（ADR 0340 の方式 b1）の会話が、ターンの途中でトークンの失効・期限切れ（401）に当たったとき（#229）。
//   1. 出力の途中の 401: 新しいトークンで CLI を起動し直し、同じ会話を resume して続ける。依頼は送り直さず、内部の続きの文だけを送る
//   2. まだ何も出していない 401: これまでどおり同じ依頼を送り直す
//   3. 新しいトークンが取れない（前と同じトークン・取得の失敗）: 起動し直さず、ログイン切れ（kind: auth）として止める
//   4. 起動し直すのはターンごとに 2 回まで
//   5. 引き継いだターン（adoptTurn）: 期限のタイマーで止めず・新しいトークンも取りに行かず、401 に当たったら同じ立て直しで続ける
// SDK の query は身代わりに差し替え（setClaudeSdkForTest）。CLI も LLM も呼ばない
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { REFRESH_WINDOW_MS } from '../../core/claude-connectors-auth.mjs';
import fs from 'node:fs/promises';

export const name = 'claude-token-revoked';
export const title = 'Claude の方式 b1: ターンの途中のトークンの失効・期限切れで、新しいトークンで起動し直して同じ会話を続ける（#229）';

const SESSION = '11111111-2222-4333-8444-555555555557';
const MESSAGE = 'Failed to authenticate: OAuth token revoked';
const THROWN = `Claude Code returned an error result: ${MESSAGE}`;
const OLD = 'tok-old-' + 'A'.repeat(32);
const NEW = 'tok-new-' + 'B'.repeat(32);
const NEWER = 'tok-newer-' + 'C'.repeat(32);
const ENV = { CLAUDE_CONFIG_DIR: 'shared-config', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference' };

const init = () => ({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-test' });
const authAssistant = () => ({ type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), error: 'authentication_failed',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: MESSAGE }] } });
const authResult = () => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: MESSAGE, session_id: SESSION, num_turns: 1, total_cost_usd: 0 });
const okResult = () => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION, num_turns: 1, total_cost_usd: 0 });
const delta = (text) => ({ type: 'stream_event', parent_tool_use_id: null, session_id: SESSION, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const toolUse = (id) => ({ type: 'assistant', parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } });
const toolResult = (id) => ({ type: 'user', parent_tool_use_id: null, session_id: SESSION, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

const midway = { messages: [init(), toolUse('toolu_1'), toolResult('toolu_1'), delta('途中まで'), authAssistant(), authResult()], throws: THROWN };
const pristine = { messages: [init(), authAssistant(), authResult()], throws: THROWN };
const finish = { messages: [init(), delta('続きです'), okResult()] };

const textOf = (m) => typeof m?.message?.content === 'string' ? m.message.content
  : (m?.message?.content ?? []).map(b => b?.text ?? '').join('\n');

/** query を呼ぶたびに scripts の次の台本を流す SDK の身代わり。呼ばれた options と、受け取った入力（プロンプト）を控える */
function scriptedSdk(scripts) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const call = { options, prompts: [] };
    calls.push(call);
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    (async () => { for await (const m of prompt) call.prompts.push(m); })().catch(() => {});
    // 引き継ぎの身代わりの子（held の spawnClaudeCodeProcess）は、起こしておけば片付けで止まったことが伝わる
    options.spawnClaudeCodeProcess?.({ command: 'claude-fake', args: [], cwd: options.cwd, env: options.env, signal: options.abortController?.signal });
    return {
      interrupt: () => Promise.resolve({}), close() {},
      async *[Symbol.asyncIterator]() {
        if (script.waitMs) await new Promise(r => setTimeout(r, script.waitMs));
        // 次のメッセージを読む前に、入力（プロンプト）が届くのを待つ（本物の CLI は入力を受けてから答える）
        await new Promise(r => setTimeout(r, 5));
        for (const m of script.messages) yield m;
        if (script.throws) throw new Error(script.throws);
      },
    };
  };
  const restore = setClaudeSdkForTest({ query, executable: () => 'claude-fake', resumeGraceMs: 30 });
  return { calls, restore };
}

/** 方式 b1 のコネクター（core/claude-connectors-auth.mjs の resolveOn の connectors の形）。next が順に返すトークン */
function fakeConnectors(next) {
  const freshCalls = [];
  return {
    freshCalls,
    connectors: {
      identity: 'b1',
      expiredError: () => Object.assign(new Error('connectors expired'), { connectorsError: { code: 'connectors-expired' } }),
      async fresh(opts = {}) {
        freshCalls.push(opts);
        const value = next[Math.min(freshCalls.length - 1, next.length - 1)];
        if (value instanceof Error) throw value;
        return { token: value, env: ENV, expiresAt: Date.now() + 3600_000 };
      },
    },
  };
}

async function run({ scripts, next = [NEW], adopt = null, expiresAt = Date.now() + 3600_000 }) {
  const sdk = scriptedSdk(scripts);
  const { connectors, freshCalls } = fakeConnectors(next);
  const events = [];
  let error = null;
  let result = null;
  try {
    const args = {
      prompt: 'work', sessionId: adopt ? SESSION : null, cwd: process.cwd(), mode: 'bypass',
      emit: (ev) => events.push(ev), askPermission: async () => ({ allow: true }),
      signal: new AbortController(), control: {}, hostSessionId: 'host-token-revoked',
      connectors, ...(adopt ? {} : { oauthToken: OLD, connectorsEnv: ENV, connectorsExpiresAt: expiresAt }),
    };
    result = await claude.runTurn(args, adopt).catch((e) => { error = e; return null; });
  } finally { sdk.restore(); }
  return { events, error, result, calls: sdk.calls, freshCalls, results: events.filter((e) => e.type === 'turnResult') };
}

/** 付け直しの身代わり（core/adopt.mjs の holderSource の形のうち、claude.mjs と claude-held.mjs が使う分） */
function fakeAdoptSource() {
  let killed;
  const gone = new Promise((r) => { killed = r; });
  const client = { on() {}, off() {}, kill() { killed(); }, end() {}, label() {} };
  return {
    id: 'claude-adopted', client, attachedState: null,
    state: { id: 'rec-1', alive: true, marks: { turn: 1 }, acked: 0 },
    async replay() { return []; },
    async *attach() { await gone; yield { exit: { code: 0 } }; },
    write() {}, ack() {}, release() {}, dispose() {},
  };
}

export default async function (t) {
  // ---- 1. 出力の途中の 401
  {
    const r = await run({ scripts: [midway, finish] });
    const [first, second] = r.calls;
    t.ok('出力の途中の 401: 新しいトークンで CLI を起動し直す（query が 2 回）', r.calls.length === 2, `calls=${r.calls.length} ${JSON.stringify(r.results)}`);
    t.ok('起動し直す前に新しいトークンを取り、失効したトークンを stale で伝える', r.freshCalls.length === 1 && r.freshCalls[0].stale === OLD, JSON.stringify(r.freshCalls.map(c => ({ stale: c.stale === OLD }))));
    t.ok('最初の CLI は古いトークン・起動し直した CLI は新しいトークン', first?.options.env.CLAUDE_CODE_OAUTH_TOKEN === OLD && second?.options.env.CLAUDE_CODE_OAUTH_TOKEN === NEW);
    t.ok('同じ会話を resume する', second?.options.resume === SESSION, String(second?.options.resume));
    const sent = (second?.prompts ?? []).map(textOf);
    t.ok('依頼（work）は送り直さず、内部の続きの文（<pleiad-interruption reason="auth">）だけを送る',
      sent.length >= 1 && !sent.some(s => s.trim() === 'work' || /(^|\n)work$/.test(s)) && sent.some(s => s.includes('<pleiad-interruption reason="auth">')), JSON.stringify(sent));
    t.ok('ターンの結果は成功が 1 つだけ（ログイン切れの失敗を出さない）', r.results.length === 1 && r.results[0].outcome === 'ok' && !r.error, JSON.stringify(r.results));
    t.ok('起動し直したことを会話に 1 行で出す（interruptionNote reason: auth）', r.events.filter(e => e.type === 'interruptionNote' && e.reason === 'auth').length === 1);
    t.ok('トークンを会話の出来事に出さない', !JSON.stringify(r.events).includes(OLD) && !JSON.stringify(r.events).includes(NEW));
  }

  // ---- 2. まだ何も出していない 401
  {
    const r = await run({ scripts: [pristine, finish] });
    const sent = (r.calls[1]?.prompts ?? []).map(textOf);
    t.ok('何も出していない 401: 起動し直して、同じ依頼を送り直す（続きの文は送らない）',
      r.calls.length === 2 && sent.some(s => s.trim() === 'work') && !sent.some(s => s.includes('reason="auth"')), JSON.stringify(sent));
    t.ok('何も出していない 401: 結果は成功が 1 つだけ', r.results.length === 1 && r.results[0].outcome === 'ok', JSON.stringify(r.results));
  }

  // ---- 3. 新しいトークンが取れない
  {
    const r = await run({ scripts: [midway, finish], next: [OLD] });
    t.ok('前と同じトークンしか無い: 起動し直さず、ログイン切れ（kind: auth・pristine: false）で止める',
      r.calls.length === 1 && r.results.length === 1 && r.results[0].outcome === 'error' && r.results[0].kind === 'auth' && r.results[0].pristine === false, JSON.stringify(r.results));
  }
  {
    const failure = Object.assign(new Error('connectors expired'), { connectorsError: { code: 'connectors-expired' } });
    const r = await run({ scripts: [midway, finish], next: [failure] });
    t.ok('取り直しが失敗: 起動し直さず、理由（connectorsError）を添えてログイン切れで止める',
      r.calls.length === 1 && r.results.length === 1 && r.results[0].kind === 'auth' && r.results[0].connectorsError?.code === 'connectors-expired', JSON.stringify(r.results));
  }

  // ---- 4. 2 回まで
  {
    const r = await run({ scripts: [midway, midway, midway, finish], next: [NEW, NEWER, NEW + 'x', NEWER + 'y'] });
    t.ok('起動し直すのはターンごとに 2 回まで。3 回目の 401 はログイン切れで止める',
      r.calls.length === 3 && r.results.length === 1 && r.results[0].kind === 'auth', `calls=${r.calls.length} ${JSON.stringify(r.results)}`);
  }

  // ---- 5. 引き継いだターン
  {
    // 期限の 5 分前を過ぎ、すぐ期限が来る札。出力が続いている間はタイマーで止めず、新しいトークンも取りに行かない
    const card = { held: true, costBase: null, flag: null, envFile: null, mcpFile: null, steers: [], pushed: 0, connectorsExpiresAt: Date.now() + 80 };
    const r = await run({ scripts: [{ ...finish, waitMs: 250 }], adopt: { source: fakeAdoptSource(), card } });
    t.ok('引き継いだターン: 期限のタイマーで止めない・新しいトークンを取りに行かない（取ると子のトークンが失効する）',
      r.calls.length === 1 && r.freshCalls.length === 0 && r.results.length === 1 && r.results[0].outcome === 'ok', `calls=${r.calls.length} fresh=${r.freshCalls.length} ${JSON.stringify(r.results)}`);
  }
  {
    const card = { held: true, costBase: null, flag: null, envFile: null, mcpFile: null, steers: [], pushed: 0, connectorsExpiresAt: Date.now() - 1000 };
    const r = await run({ scripts: [midway, finish], adopt: { source: fakeAdoptSource(), card } });
    const sent = (r.calls[1]?.prompts ?? []).map(textOf);
    t.ok('引き継いだターン: 401 に当たったら新しいトークンで起動し直し、resume して続きの文だけを送る',
      r.calls.length === 2 && r.calls[1].options.env.CLAUDE_CODE_OAUTH_TOKEN === NEW && r.calls[1].options.resume === SESSION
        && sent.some(s => s.includes('reason="auth"')) && !sent.some(s => s.trim() === 'work'), `calls=${r.calls.length} ${JSON.stringify(sent)} ${JSON.stringify(r.results)}`);
    t.ok('引き継いだターン: 結果は成功が 1 つだけ', r.results.length === 1 && r.results[0].outcome === 'ok', JSON.stringify(r.results));
  }
  t.ok('REFRESH_WINDOW_MS は 5 分（期限のタイマーの前提）', REFRESH_WINDOW_MS === 5 * 60_000);

  // ---- 6. Pleiad の再起動の後に付け直したターン（server の restoreTurn）にも、取り直しの口を渡す
  {
    const server = await fs.readFile(new URL('../../core/server.mjs', import.meta.url), 'utf8');
    const start = server.indexOf('async function restoreTurn(');
    const restoreBody = server.slice(start, server.indexOf('const turn = {', start));
    const adoptBody = server.slice(server.indexOf('async function adoptTurn('), server.indexOf('backend.adoptTurn(ctx.runArgs)'));
    t.ok('付け直し: 方式 b1 のアカウントは、呼ばれたときに引き直す取り直しの口（lazyClaudeConnectors）を作る（付け直しの時点では取りに行かない）',
      /restoredConnectors = lazyClaudeConnectors\(backend, entry\.id\)/.test(restoreBody) && /config\.mode !== OWN_DIR/.test(restoreBody));
    t.ok('付け直し: その口を adoptTurn の runArgs（connectors）に載せる', /connectors: ctx\.connectors/.test(adoptBody));
  }
}
