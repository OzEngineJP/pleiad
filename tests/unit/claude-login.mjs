// Claude のアカウントの認可を Pleiad から回す（core/claude-login.mjs）。本物の Claude Code もネットワークも使わない。
// 出力の読み取り（ANSI・OSC 8・折り返し）、トークンを伏せること、疑似端末の偽物での進み方（URL → コード → 完了 / 失敗 / 時間切れ / 取り消し）、
// 新しいアカウントを済んだときだけ載せること（ADR 0352）、使用量の設定フォルダの env を確かめる。node-pty が読めれば、偽の CLI（tests/lib/fake-claude-login.mjs）を本物の疑似端末でも回す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripAnsi, findAuthUrl, redactSecrets, outputTail, normalizeCode, loginEnv, createClaudeLogin, ptySpawner, loadPty, pipeSpawner,
} from '../../core/claude-login.mjs';
import { usageEnv, readClaudeAccountsUsage, NEEDS_USAGE_LOGIN } from '../../core/backends/claude-usage.mjs';

export const name = 'claude-login';
export const title = 'Claude のアカウントの認可: 出力の読み取り・トークンを伏せる・疑似端末での進み方・新しいアカウントの登録・使用量の設定フォルダ';

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'fake-claude-login.mjs');
const TOKEN = 'sk-ant-oat01-' + 'Ab3_-'.repeat(18) + 'xyz';
const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=c5pB1vM5&code_challenge_method=S256&state=IrIZK6KP';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return false;
}

/** 疑似端末の偽物。テストから出力を流し込み、書かれた入力を見る */
function fakePty() {
  const procs = [];
  const spawn = (argv, args, opts) => {
    const p = { argv, args, opts, written: [], killed: false, dataFns: [], exitFns: [] };
    p.api = {
      onData: fn => p.dataFns.push(fn), onExit: fn => p.exitFns.push(fn),
      write: s => p.written.push(s), kill: () => { p.killed = true; },
    };
    p.emit = s => p.dataFns.forEach(fn => fn(s));
    p.exit = code => p.exitFns.forEach(fn => fn({ code }));
    procs.push(p);
    return p.api;
  };
  return { spawn, procs, last: () => procs.at(-1) };
}

export default async function (t) {
  // ---- 出力の読み取り
  // 2026-09-23 に node-pty の下で見た `claude auth login` の出力そのままの形（OSC 8 のハイパーリンク付き）
  const observed = `\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;claude\x07\x1b[?25hOpening browser to sign in…\r\nIf the browser didn't open, visit: \x1b[94m\x1b]8;id=41360-1;${URL_}\x1b\\${URL_}\x1b[m\x1b]8;;\x1b\\\r\nPaste code here if prompted > `;
  t.ok('OSC 8 のハイパーリンクを外して URL を 1 つだけ読む', findAuthUrl(observed) === URL_, findAuthUrl(observed));
  t.ok('制御文字を落とすと本文だけが残る', stripAnsi(observed).includes('Paste code here if prompted >') && !stripAnsi(observed).includes('\x1b'));
  const wrappedUrl = `Browser didn't open? Use the url below to sign in:\r\n\r\n\x1b[94m${URL_.match(/.{1,70}/g).join('\x1b[m\r\n\x1b[94m')}\x1b[m\r\n\r\nPaste code here if prompted > `;
  t.ok('折り返された URL を行をまたいでつなげる', findAuthUrl(wrappedUrl) === URL_, findAuthUrl(wrappedUrl));
  const positioned = `${URL_.slice(0, 100)}\x1b[5;1H${URL_.slice(100)}\x1b[7;1HPaste code here if prompted >`;
  t.ok('カーソル位置の指定で折り返されていてもつなげる', findAuthUrl(positioned) === URL_);
  t.ok('認可以外の URL は拾わない', findAuthUrl('see https://code.claude.com/docs/en/setup for help') === null);
  t.ok('次の行の文章は URL につなげない', findAuthUrl(`${URL_}\r\nPaste code here`) === URL_);

  // ---- 伏せる
  t.ok('出力からトークンを伏せる', !redactSecrets(`bad ${TOKEN} x`).includes('sk-ant-') && redactSecrets(`bad ${TOKEN}`).includes('[トークン]'));
  t.ok('貼ったコードも伏せる', redactSecrets('invalid code abcd#efgh', ['abcd#efgh']) === 'invalid code [伏せ字]');
  const tail = outputTail(`${observed}\r\nOAuth error: ${TOKEN} rejected\r\n`);
  t.ok('失敗の末尾は制御文字・URL・トークンを含まない', tail.includes('OAuth error') && !tail.includes('sk-ant-') && !tail.includes('https://') && !tail.includes('\x1b'), tail);
  t.ok('コードの前後の空白は落とす', normalizeCode('  abc#def \n') === 'abc#def');
  let bad = null; try { normalizeCode('abc\ndef'); } catch (e) { bad = e; }
  t.ok('改行を含むコードは断る（別の入力を送らせない）', Boolean(bad));

  // ---- env
  const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-api', CLAUDE_CONFIG_DIR: '/shared', CLAUDECODE: '1' };
  const env = loginEnv(base, { configDir: '/data/claude-usage/acct-1' });
  t.ok('ログインの env から会話用のトークン・API キーを外す', !env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.CLAUDECODE && env.PATH === '/bin');
  t.ok('ログインは指定した設定フォルダで回す', env.CLAUDE_CONFIG_DIR === '/data/claude-usage/acct-1');
  t.ok('CLI 自身にはブラウザーを開かせない（BROWSER を存在しないパスに）', typeof env.BROWSER === 'string' && env.BROWSER.includes('ply-no-browser'));
  t.ok('base は書き換えない', base.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && base.CLAUDE_CONFIG_DIR === '/shared');
  const uenv = usageEnv(base, { configDir: '/data/claude-usage/acct-1' });
  t.ok('使用量はアカウントの設定フォルダで読み、会話用のトークンは渡さない', uenv.CLAUDE_CONFIG_DIR === '/data/claude-usage/acct-1' && !('CLAUDE_CODE_OAUTH_TOKEN' in uenv));
  const plainEnv = usageEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/shared' }, {});
  t.ok('ログイン中のアカウントの使用量は今までどおり（設定フォルダを変えない）', plainEnv.CLAUDE_CONFIG_DIR === '/shared' && !plainEnv.CLAUDE_CODE_OAUTH_TOKEN);

  // ---- 使用量の並べ方
  const reads = [];
  const read = async ({ configDir, token } = {}) => {
    reads.push({ configDir: configDir ?? null, token: token ?? null });
    if (configDir === '/u/broken') throw new Error(`denied ${TOKEN}`);
    return { plan: configDir ? 'max' : 'pro', windows: [{ label: '5時間', usedPercent: 10 }] };
  };
  const single = await readClaudeAccountsUsage({ accounts: [], read });
  t.ok('登録が無ければ今までどおりログイン中の値だけ', single.plan === 'pro' && !single.accounts && reads.length === 1);
  reads.length = 0;
  const many = await readClaudeAccountsUsage({ read, accounts: [
    { id: 'a1', name: '仕事用', configDir: '/u/a1', usageLogin: true },
    { id: 'a2', name: '個人用', configDir: '/u/a2', usageLogin: false },
    { id: 'a3', name: '壊れた', configDir: '/u/broken', usageLogin: true }] });
  t.ok('アカウントごとに見出しを付けて並べる', many.accounts.map(a => a.label).join() === 'ログイン中のアカウント,仕事用,個人用,壊れた');
  t.ok('認可済みのアカウントはその設定フォルダで読む（トークンは使わない）', reads.some(r => r.configDir === '/u/a1') && reads.every(r => r.token === null) && many.accounts[1].plan === 'max');
  t.ok('未認可のアカウントは読みに行かず、認可を促す', !reads.some(r => r.configDir === '/u/a2') && many.accounts[2].needsUsageLogin === true
    && many.accounts[2].message === NEEDS_USAGE_LOGIN && many.accounts[2].accountId === 'a2');
  t.ok('一般の失敗はログイン切れにせず、理由を残してトークンは伏せる', many.accounts[3].reauth !== true && many.accounts[3].reason === 'error'
    && many.accounts[3].message.includes('denied') && !many.accounts[3].message.includes(TOKEN));

  // ---- セッション（疑似端末の偽物）
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-login-'));
  try {
    const events = [];
    const marked = [];
    const discarded = [];
    const opened = [];
    const pty = fakePty();
    let seq = 0;
    const login = createClaudeLogin({
      command: () => ['/bin/claude'], emit: e => events.push(e), spawn: pty.spawn,
      usageDir: id => path.join(dir, 'claude-usage', id), markUsageLogin: async (id, add) => { marked.push({ id, add }); },
      newAccountId: () => `acct-new${++seq}`, discardNew: async id => { discarded.push(id); },
      openExternal: url => opened.push(url), env: base,
    });
    const of = id => events.filter(e => e.loginId === id);

    // 新しいアカウント: 名前で始め、済んだときだけ載せる
    const { loginId: a } = login.start({ name: '仕事用', open: true });
    const pa = pty.last();
    t.ok('新しいアカウントも auth login を、先に決めた id の設定フォルダで回す', pa.args.join(' ') === 'auth login --claudeai'
      && pa.opts.env.CLAUDE_CONFIG_DIR === path.join(dir, 'claude-usage', 'acct-new1') && !pa.opts.env.CLAUDE_CODE_OAUTH_TOKEN && !pa.opts.env.ANTHROPIC_API_KEY);
    t.ok('設定フォルダを作る', await fs.stat(path.join(dir, 'claude-usage', 'acct-new1')).then(s => s.isDirectory(), () => false));
    pa.emit(observed.slice(0, 120));
    t.ok('URL が揃うまでは知らせない', of(a).length === 0);
    pa.emit(observed.slice(120));
    t.ok('URL を知らせ、続けてコードを待つ', of(a).map(e => e.phase).join() === 'url,code' && of(a)[0].url === URL_);
    t.ok('載せる前の新しいアカウントの id は画面に渡さない', of(a).every(e => e.accountId === null));
    t.ok('open なら既定のブラウザーで開くよう頼む', opened.length === 1 && opened[0] === URL_);
    let early = null; try { login.submitCode('login-nope', 'x'); } catch (e) { early = e; }
    t.ok('終わった・知らない認可にはコードを送れない', Boolean(early));
    login.submitCode(a, ' abc#def ');
    await sleep(200);
    t.ok('コードと Enter を分けて書く', pa.written.join('|') === 'abc#def|\r');
    t.ok('確認中を知らせる', of(a).at(-1).phase === 'verifying');
    // 失敗の文面とともにもう一度聞かれた
    pa.emit('abc#def\r\n\x1b[31mOAuth error: Invalid code abc#def\x1b[39m\r\nPaste code here if prompted > ');
    const retry = of(a).at(-1);
    t.ok('受け付けられなかったらもう一度コードを待ち、理由を添える（コードは伏せる）', retry.phase === 'code' && retry.message.includes('Invalid code') && !retry.message.includes('abc#def'));
    login.submitCode(a, 'good#code');
    await sleep(200);
    pa.emit('good#code\r\n');
    t.ok('入力欄がコードを表示し直すだけでは失敗にしない', of(a).at(-1).phase === 'verifying');
    pa.emit('\r\nLogin successful.\r\n');
    pa.exit(0);
    await until(() => of(a).some(e => e.phase === 'done'));
    t.ok('終了コード 0 で、名前を添えて載せる', marked.length === 1 && marked[0].id === 'acct-new1' && marked[0].add?.name === '仕事用');
    t.ok('完了を知らせ、作ったアカウントの id を返す', of(a).at(-1).phase === 'done' && of(a).at(-1).accountId === 'acct-new1');
    t.ok('済んだ新しいアカウントは片付けない', (await sleep(600), !discarded.includes('acct-new1')));

    // 新しいアカウント: 失敗したら何も残さない
    const { loginId: b } = login.start({ name: '個人用' });
    const pb = pty.last();
    pb.emit(observed);
    pb.emit('\r\nOAuth error: request failed with status 400 (code abc#def)\r\n');
    pb.exit(1);
    const failed = of(b).at(-1);
    t.ok('失敗を知らせる（終了コードと末尾）', failed.phase === 'error' && failed.message.includes('終了コード 1') && failed.message.includes('status 400'), JSON.stringify(failed));
    t.ok('失敗した新しいアカウントは載せず、設定フォルダを片付ける', marked.length === 1 && await until(() => discarded.includes('acct-new2'), 2000));

    // 登録済みのアカウントのログインし直し
    const { loginId: c } = login.start({ accountId: 'acct-1' });
    const pc = pty.last();
    t.ok('登録済みのアカウントはその設定フォルダで回す', pc.args.join(' ') === 'auth login --claudeai'
      && pc.opts.env.CLAUDE_CONFIG_DIR === path.join(dir, 'claude-usage', 'acct-1'));
    t.ok('open でなければブラウザーを開かない', (pc.emit(observed), opened.length === 1));
    t.ok('登録済みのアカウントの id は初めから画面に渡す', of(c).every(e => e.accountId === 'acct-1'));
    login.submitCode(c, 'ok#code');
    pc.emit('\r\nLogin successful.\r\n');
    pc.exit(0);
    await until(() => of(c).some(e => e.phase === 'done'));
    t.ok('終了コード 0 で認可済みの印を付ける（名前は渡さない）', marked.at(-1).id === 'acct-1' && marked.at(-1).add === undefined && of(c).at(-1).phase === 'done');

    // 成功を出したまま終わらない
    const { loginId: c2 } = login.start({ accountId: 'acct-2' });
    const pc2 = pty.last();
    pc2.emit(observed); login.submitCode(c2, 'ok#code'); pc2.emit('\r\nLogin successful.\r\n');
    t.ok('成功の表示だけではすぐには完了にしない（終了を待つ）', !of(c2).some(e => e.phase === 'done'));

    // 取り消し・1 つだけ
    const { loginId: d } = login.start({ accountId: 'acct-3' });
    t.ok('新しく始めると前のものは取り消す', of(c2).at(-1).phase === 'cancelled' && pc2.killed);
    login.cancel(d);
    t.ok('取り消すと CLI を止めて知らせる', of(d).at(-1).phase === 'cancelled' && pty.last().killed);
    let gone = null; try { login.submitCode(d, 'x'); } catch (e) { gone = e; }
    t.ok('取り消したものにはコードを送れない', Boolean(gone));
    const { loginId: e5 } = login.start({ name: '途中で' });
    login.cancel(e5);
    t.ok('取り消した新しいアカウントは載せず、設定フォルダを片付ける', await until(() => discarded.includes('acct-new3'), 2000) && !marked.some(m => m.id === 'acct-new3'));
    login.start({ accountId: 'acct-4' });
    const p4 = pty.last();
    login.cancelAccount('acct-4');
    t.ok('アカウントを消すと、その認可を止める', p4.killed && login.active().length === 0);

    // 起動できない
    let noKind = null; try { login.start({ kind: 'setup-token', name: 'x' }); } catch (e) { noKind = e; }
    t.ok('setup-token など知らない種類は断る（ADR 0352）', Boolean(noKind));
    let noName = null; try { login.start({ name: '  ' }); } catch (e) { noName = e; }
    t.ok('新しいアカウントは名前が要る', Boolean(noName));
    const noCli = createClaudeLogin({ command: () => null, emit: () => {}, spawn: pty.spawn, usageDir: () => dir, newAccountId: () => 'x' });
    let missing = null; try { noCli.start({ name: 'x' }); } catch (e) { missing = e; }
    t.ok('Claude Code が無ければ理由を返す', missing?.message.includes('Claude Code'));
    const noPty = createClaudeLogin({ command: () => ['/bin/claude'], emit: () => {}, spawn: null, pipe: pty.spawn, usageDir: id => path.join(dir, id), newAccountId: () => 'acct-pipe' });
    const before = pty.procs.length;
    noPty.start({ name: 'パイプ' });
    t.ok('疑似端末が無くてもパイプで回す', pty.procs.length === before + 1);
    noPty.cancelAll();

    // 時間切れ
    const quick = createClaudeLogin({ command: () => ['/bin/claude'], emit: e => events.push(e), spawn: pty.spawn, timeoutMs: 50,
      usageDir: id => path.join(dir, id), newAccountId: () => 'acct-quick' });
    const { loginId: q } = quick.start({ accountId: 'acct-q' });
    await until(() => of(q).some(e => e.phase === 'error'), 2000);
    t.ok('時間切れで止めて知らせる', of(q).at(-1)?.phase === 'error' && of(q).at(-1).message.includes('時間切れ') && pty.last().killed);

    // ---- 本物の疑似端末（node-pty）で偽の CLI を回す
    const realPty = loadPty();
    if (!realPty) t.note('node-pty を読めないので、本物の疑似端末での確認はとばす');
    for (const [label, spawner] of [['疑似端末', realPty ? ptySpawner(realPty) : null], ['パイプ', pipeSpawner()]]) {
      if (!spawner) continue;
      const log = path.join(dir, `fake-${label}.log`);
      const realEvents = [];
      const real = createClaudeLogin({
        command: () => [process.execPath, FAKE_CLI], emit: e => realEvents.push(e), spawn: spawner,
        usageDir: id => path.join(dir, 'claude-usage', id), markUsageLogin: async () => {}, newAccountId: () => 'acct-real',
        env: { ...process.env, FAKE_CLAUDE_LOG: log, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      });
      const { loginId } = real.start({ name: 'real' });
      const mine = () => realEvents.filter(e => e.loginId === loginId);
      const asked = await until(() => mine().some(e => e.phase === 'code'), 20_000);
      t.ok(`${label}: URL とコード待ちを読む`, asked && mine().find(e => e.phase === 'url')?.url?.startsWith('https://claude.com/cai/oauth/authorize?code=true'), JSON.stringify(mine()));
      if (asked) {
        real.submitCode(loginId, 'bad');
        const retried = await until(() => mine().filter(e => e.phase === 'code').length >= 2, 10_000);
        t.ok(`${label}: 受け付けられなかったコードを知らせる`, retried && mine().filter(e => e.phase === 'code').at(-1).message?.includes('Invalid code'), JSON.stringify(mine().at(-1)));
        real.submitCode(loginId, 'good#1');
        const done = await until(() => mine().some(e => ['done', 'error'].includes(e.phase)), 20_000);
        t.ok(`${label}: 最後まで進める`, done && mine().at(-1).phase === 'done', JSON.stringify(mine().at(-1)));
      } else real.cancelAll();
      const seen = (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      t.ok(`${label}: CLI に会話用のトークン・API キーを渡さず、BROWSER を差し替える`, seen.length === 1 && seen.every(s => !s.hasOauthToken && !s.hasApiKey && s.browser?.includes('ply-no-browser')));
      t.ok(`${label}: アカウントの設定フォルダに資格情報を残す`, await fs.access(path.join(dir, 'claude-usage', 'acct-real', '.credentials.json')).then(() => true, () => false));
      await fs.rm(path.join(dir, 'claude-usage', 'acct-real'), { recursive: true, force: true });
    }
  } finally {
    await sleep(300);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
