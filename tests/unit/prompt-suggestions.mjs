// 次の発言の候補と、入力欄の ↑ の呼び出しの部品（core/prompt-suggestions.mjs・core/backends/antigravity-suggest.mjs・core/session-search.mjs。ADR 0211）。
// LLM は呼ばない。agy は身代わり（tests/lib/fake-agy.mjs）。
//   - 要約: 人と AI の本文だけ・最後が AI の返答でなければ作らない・件数と字数の上限
//   - 返りの読み取り: 前後の字・``` を許す・1 行に畳む・引用符を落とす・空・null・上限超え・JSON でないものは null
//   - 作りかけ: 同じ会話で始め直すと前のものは捨てる・止めたら知らせない・時間切れ
//   - Claude の予測（prompt_suggestion）を promptSuggestion の出来事にする
//   - Antigravity: 使い捨てのホーム（USERPROFILE・HOME）で起こし、その回の会話の置き場を消す。軽い Flash を選ぶ
//   - 送信済みの並び: 指定の会話が先・新しい順・同じ文は 1 つ・`!` のコマンドは別の並び
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUGGESTION_MAX, cleanSuggestion, createSuggestionJobs, parseSuggestion, suggestionGist, suggestionPrompt } from '../../core/prompt-suggestions.mjs';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { STALE_MS, forgetConversation, runAgySuggestion, suggestArgs, suggestHome, suggestModel, sweepStale, trimSummaries } from '../../core/backends/antigravity-suggest.mjs';
import { extractShellCommands, sentMessagesOf, extractMessages } from '../../core/session-search.mjs';

export const name = 'prompt-suggestions';
export const title = '次の発言の候補（要約・読み取り・作りかけ・Claude の予測・Antigravity の使い捨てのホーム）と、↑ の呼び出しの並び';

const FAKE_AGY = fileURLToPath(new URL('../lib/fake-agy.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (t) {
  // ---- 要約
  const talk = [
    { role: 'user', text: 'README を直して' },
    { role: 'assistant', text: '直しました。' },
    { role: 'user', kind: 'shell', text: '! npm test', command: 'npm test' },
    { role: 'system', kind: 'contextNote', text: '記憶' },
    { role: 'user', text: 'テストも流して' },
    { role: 'assistant', text: '412 件すべて通りました。' },
  ];
  const gist = suggestionGist(talk);
  t.ok('要約は人と AI の本文だけを古い順に並べる', gist === '[user]\nREADME を直して\n\n[agent]\n直しました。\n\n[user]\nテストも流して\n\n[agent]\n412 件すべて通りました。', JSON.stringify(gist));
  t.ok('最後が AI の返答でなければ要約を作らない', suggestionGist([...talk, { role: 'user', text: '次は？' }]) === null);
  t.ok('発言が無ければ作らない', suggestionGist([]) === null);
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `発言${i} ${'あ'.repeat(3000)}` }));
  const long = suggestionGist(many);
  t.ok('要約は新しい方から 8 件まで・1 件は 1500 字（最後の返答は 4000 字）で切る', (long.match(/^\[(user|agent)\]$/gm) ?? []).length <= 8 && long.includes('発言29') && !long.includes('発言0 ') && long.length < 13_000, String(long.length));
  const prompt = suggestionPrompt(gist);
  t.ok('指示は要約を <conversation> に包み、JSON の形を書く', prompt.includes('<conversation>\n[user]') && prompt.includes('Return only JSON matching this schema') && prompt.includes(String(SUGGESTION_MAX)));

  // ---- 返りの読み取り
  t.ok('JSON の候補を取り出す', parseSuggestion('{"suggestion":"コミットして"}') === 'コミットして');
  t.ok('前後の字と ``` を許す', parseSuggestion('```json\n{"suggestion": "PR を作って"}\n```') === 'PR を作って');
  t.ok('改行は 1 行に畳み、前後の引用符を落とす', parseSuggestion('{"suggestion":"「テストを\\n流して」"}') === 'テストを 流して');
  t.ok('null・空・JSON でないものは null', parseSuggestion('{"suggestion":null}') === null && parseSuggestion('{"suggestion":"  "}') === null && parseSuggestion('コミットして') === null && parseSuggestion('{oops}') === null);
  t.ok(`${SUGGESTION_MAX} 字を超えたら null`, parseSuggestion(JSON.stringify({ suggestion: 'あ'.repeat(SUGGESTION_MAX + 1) })) === null && cleanSuggestion('あ'.repeat(SUGGESTION_MAX)) !== null);

  // ---- 作りかけ
  const got = [];
  const errors = [];
  const jobs = createSuggestionJobs({ onSuggestion: (id, text) => got.push([id, text]), onError: (id, e) => errors.push([id, e.message]), timeoutMs: 200 });
  let firstSignal = null;
  const first = jobs.start('s1', async (signal) => { firstSignal = signal; await sleep(80); return '{"suggestion":"古い"}'; });
  const second = jobs.start('s1', async () => '{"suggestion":"新しい"}');
  await Promise.all([first, second]);
  t.ok('同じ会話で始め直すと、前の作りかけは止まり、新しい方だけ知らせる', firstSignal?.aborted === true && JSON.stringify(got) === JSON.stringify([['s1', '新しい']]), JSON.stringify(got));
  got.length = 0;
  const cancelled = jobs.start('s2', async () => { await sleep(50); return '{"suggestion":"要らない"}'; });
  t.ok('作りかけを覚えている', jobs.has('s2'));
  jobs.cancel('s2');
  await cancelled;
  t.ok('止めた作りかけは知らせない', got.length === 0 && !jobs.has('s2'));
  // 時間切れのタイマーは unref（サーバーの終わりを待たせない）。待つ間だけ事を生かしておく
  const alive = setInterval(() => {}, 50);
  await jobs.start('s3', (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))));
  clearInterval(alive);
  t.ok('時間切れで止まり、知らせもエラーも出さない', got.length === 0 && errors.length === 0 && jobs.size === 0);
  await jobs.start('s4', async () => { throw new Error('boom'); });
  t.ok('失敗は onError へ', JSON.stringify(errors) === JSON.stringify([['s4', 'boom']]));

  // ---- Claude の予測
  t.ok('prompt_suggestion を promptSuggestion の出来事にする', JSON.stringify(normalizeSdkMessage({ type: 'prompt_suggestion', suggestion: ' コミットして ', uuid: 'u', session_id: 's' })) === JSON.stringify([{ type: 'promptSuggestion', text: 'コミットして' }]));
  t.ok('空の予測は出さない', normalizeSdkMessage({ type: 'prompt_suggestion', suggestion: '' }).length === 0);

  // ---- Antigravity
  t.ok('軽い Flash の low を選ぶ（無ければ Flash、無ければ既定）', suggestModel({ 'gemini-3.1-pro-high': {}, 'gemini-3.8-flash-high': {}, 'gemini-3.8-flash-low': {} }) === 'gemini-3.8-flash-low'
    && suggestModel({ 'gemini-3.8-flash': {} }) === 'gemini-3.8-flash' && suggestModel({ 'claude-sonnet-5-5-low': {} }) === null);
  t.ok('引数は stream-json の --print と時間の上限・モデル', JSON.stringify(suggestArgs('m')) === JSON.stringify(['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '60s', '--model', 'm']));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-agy-suggest-'));
  const envFile = path.join(dir, 'env.json');
  const realHome = process.env.USERPROFILE;
  process.env.FAKE_AGY_ENV_FILE = envFile;
  try {
    const raw = await runAgySuggestion({ prompt: suggestionPrompt(gist), model: 'gemini-3.8-flash-low', dir, command: [process.execPath, FAKE_AGY] });
    t.ok('agy の返りを返す', parseSuggestion(raw) === 'テストを流して', String(raw));
    const seen = JSON.parse(fs.readFileSync(envFile, 'utf8'))[0];
    const home = suggestHome(dir);
    t.ok('使い捨てのホームで起こす（USERPROFILE・HOME を一時の場所へ。利用者のホームではない）', seen.USERPROFILE === home && seen.HOME === home && seen.USERPROFILE !== realHome, JSON.stringify(seen));
    t.ok('作業場所はホームの下の空のフォルダー', path.resolve(seen.cwd) === path.resolve(home, 'work'), seen.cwd);
    const base = path.join(home, '.gemini', 'antigravity-cli');
    t.ok('その回の会話の置き場は消す', fs.readdirSync(path.join(base, 'conversations')).length === 0 && fs.readdirSync(path.join(base, 'brain')).length === 0);
    const stopped = new AbortController();
    stopped.abort();
    t.ok('止めてあれば起こさない', await runAgySuggestion({ prompt: 'x', dir, command: [process.execPath, FAKE_AGY], signal: stopped.signal }) === null && JSON.parse(fs.readFileSync(envFile, 'utf8')).length === 1);
    const summaries = path.join(base, 'conversation_summaries.db');
    fs.writeFileSync(summaries, Buffer.alloc(64));
    t.ok('要約の DB は上限までは残す', trimSummaries(home, 1024) === false && fs.existsSync(summaries));
    fs.writeFileSync(summaries, Buffer.alloc(2048));
    t.ok('上限を超えたら要約の DB を消す', trimSummaries(home, 1024) === true && !fs.existsSync(summaries));
    const left = path.join(base, 'conversations', 'left.db');
    const fresh = path.join(base, 'conversations', 'fresh.db');
    fs.writeFileSync(left, '');
    fs.writeFileSync(fresh, '');
    const old = new Date(Date.now() - STALE_MS - 60_000);
    fs.utimesSync(left, old, old);
    t.ok('消せずに残った古い会話の置き場は消し、新しいもの（ほかの回が使っている）は残す', sweepStale(home) === 1 && !fs.existsSync(left) && fs.existsSync(fresh));
    forgetConversation(home, '../escape');
    t.ok('会話の id に見えないものでは何も消さない', fs.existsSync(base));
  } finally {
    delete process.env.FAKE_AGY_ENV_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 送信済みの並び（↑ の呼び出し）
  const copies = new Map([
    ['a', { msgs: extractMessages([{ role: 'user', uuid: 'a1', at: '2026-10-15T01:00:00Z', text: 'A の古い' }, { role: 'assistant', text: '返事' },
      { role: 'user', uuid: 'a2', at: '2026-10-15T03:00:00Z', text: '同じ文' }]), shells: extractShellCommands([{ role: 'user', kind: 'shell', uuid: 'a3', at: '2026-10-15T04:00:00Z', text: '! npm test', command: 'npm test' }]) }],
    ['b', { msgs: extractMessages([{ role: 'user', uuid: 'b1', at: '2026-10-15T05:00:00Z', text: 'B の新しい' }, { role: 'user', uuid: 'b2', at: '2026-10-15T02:00:00Z', text: '同じ文' }]), shells: [] }],
  ]);
  const titles = new Map([['a', 'A'], ['b', 'B']]);
  const order = sentMessagesOf({ ids: ['a', 'b'], first: 'a', copies, titles }).map((r) => `${r.sessionId}:${r.text}`);
  t.ok('指定の会話の分が先、ほかの会話は後、それぞれ新しい順。同じ文は新しい方の 1 つだけ', JSON.stringify(order) === JSON.stringify(['a:同じ文', 'a:A の古い', 'b:B の新しい']), JSON.stringify(order));
  t.ok('会話名と時刻を添える', sentMessagesOf({ ids: ['a', 'b'], first: 'a', copies, titles })[2].title === 'B');
  t.ok('`!` のコマンドは別の並び', JSON.stringify(sentMessagesOf({ ids: ['a', 'b'], first: 'a', copies, titles, shell: true }).map((r) => r.text)) === JSON.stringify(['npm test']));
  t.ok('件数の上限', sentMessagesOf({ ids: ['a', 'b'], first: null, copies, titles, limit: 2 }).length === 2);
}
