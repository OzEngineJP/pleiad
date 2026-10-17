// 次の発言の候補と、入力欄の ↑ の呼び出しをサーバー越しに（fake バックエンド。LLM は呼ばない。ADR 0211）。
//   - ターンが成功で終わると、候補を作って promptSuggestion の出来事で流す（fake は要約の最後の「suggest:<文>」を返す）
//   - 候補が無ければ（null）流さない
//   - 設定 composer.suggestions をオフにすると作らない。composer.historyRecall と並んで設定の一覧にあり、既定はどちらもオン
//   - sessions.sentMessages: 指定の会話の送信済みのメッセージを先に、新しい順に返す
//   - 画面の配線（client.mjs）: 出来事を受ける・送ったら捨てる・↑ の呼び出しと候補をキーに足す・設定 › 入力のページ
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import * as P from '../../core/protocol.mjs';

export const name = 'server-prompt-suggestions';
export const title = '次の発言の候補（ターンの後に作って流す・オフなら作らない）と、送信済みのメッセージの呼び出し（sessions.sentMessages）';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default async function (t) {
  t.ok('promptSuggestion は EVENTS に登録されている', P.EVENTS.has('promptSuggestion'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-prompt-suggestions-'));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-prompt-suggestions-work-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: scratch });
  const c = await open({ port: server.port, token: server.token });
  try {
    const recall = await c.cmd('invoke', { op: 'settings.get', args: { key: 'composer.historyRecall' } });
    const suggest = await c.cmd('invoke', { op: 'settings.get', args: { key: 'composer.suggestions' } });
    t.ok('設定の一覧に ↑ の呼び出しと候補があり、既定はどちらもオン', recall.value === true && recall.default === true && suggest.default === true, JSON.stringify({ recall, suggest }));
    // 試験のサーバーは候補を止めて起動する（tests/lib/server.mjs）。ここでオンにする
    t.ok('試験のサーバーは候補を止めて起動している', suggest.value === false);
    await c.cmd('setPref', { key: 'composer.suggestions', value: true });

    const first = await c.runTurn({ cwd: work, prompt: 'echo:直しました suggest:テストを流して' }, { ms: 20_000 });
    const sessionId = first.sessionId;
    t.ok('ターンが成功で終わる', first.outcome === 'ok' && Boolean(sessionId), JSON.stringify(first.outcome));
    const hit = await c.waitFor((e) => e.type === 'promptSuggestion' && e.sessionId === sessionId, { ms: 10_000 }).catch(() => null);
    t.ok('ターンの後に候補を作って流す', hit?.text === 'テストを流して', JSON.stringify(hit));

    let from = c.mark();
    const plain = await c.runTurn({ sessionId, prompt: 'echo:候補なし' }, { ms: 20_000 });
    await sleep(800);
    t.ok('候補が無ければ流さない', plain.outcome === 'ok' && !c.since(from).some((e) => e.type === 'promptSuggestion'));

    await c.cmd('setPref', { key: 'composer.suggestions', value: false });
    t.ok('設定でオフにできる（prefs の composerSuggestions）', (await c.cmd('invoke', { op: 'settings.get', args: { key: 'composer.suggestions' } })).value === false);
    from = c.mark();
    const off = await c.runTurn({ sessionId, prompt: 'echo:オフ suggest:出ないはず' }, { ms: 20_000 });
    await sleep(800);
    t.ok('オフの間は作らない', off.outcome === 'ok' && !c.since(from).some((e) => e.type === 'promptSuggestion'));
    await c.cmd('setPref', { key: 'composer.suggestions', value: true });
    await c.cmd('setPref', { key: 'composer.historyRecall', value: false });
    t.ok('↑ の呼び出しもオフにできる（prefs の composerHistoryRecall）', (await c.cmd('prefs')).composerHistoryRecall === false);

    // 送信済みのメッセージ（検索の写しはターンの終わりに裏で読み直す。追いつくまで待つ）
    let items = [];
    for (let i = 0; i < 60; i++) {
      items = (await c.cmd('invoke', { op: 'sessions.sentMessages', args: { sessionId } })).items;
      if (items.length >= 3) break;
      await sleep(100);
    }
    const texts = items.map((r) => r.text);
    t.ok('sessions.sentMessages は送信済みのメッセージを新しい順に返す', JSON.stringify(texts.slice(0, 3)) === JSON.stringify(['echo:オフ suggest:出ないはず', 'echo:候補なし', 'echo:直しました suggest:テストを流して']), JSON.stringify(texts));
    t.ok('会話の id と時刻を添える', items.every((r) => r.sessionId === sessionId && typeof r.at === 'string'));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }

  // ---- 画面の配線
  const client = read('web/client.mjs');
  t.ok('画面は promptSuggestion を会話ごとに覚え、開いている会話なら出す', client.includes("ev.type === 'promptSuggestion'") && client.includes('suggestions.set(ev.sessionId, ev.text)'));
  t.ok('送ったら候補を捨て、↑ の並びを読み直す', /noteSent\(id, text\);\s*dropSuggestion\(id\);\s*chatRecall\.reset\(\);/.test(client));
  t.ok('候補の Tab と ↑ の呼び出しは、`!`・「/」の候補の後にキーを取る', client.includes('(e) => slashSkills.keydown(e), (e) => chatSuggestion.keydown(e), (e) => chatRecall.keydown(e)'));
  t.ok('Esc で消した候補は、会話ごとの候補からも捨てる（次の返答まで出さない）', client.includes('dismiss: () => suggestions.delete(state.current)'));
  t.ok('タッチの履歴のボタンは、候補のボタンが出ている間は譲り、候補の出し入れのたびに決め直す', client.includes('covered: () => chatSuggestion.visible') && client.includes('painted: () => chatRecall.refresh()'));
  t.ok('会話を替える前に、呼び出し中なら下書きへ戻してから保存する',/chatRecall\.release\(\);\s*if \(!fresh\) saveDraft\(\)/.test(client));
  const html = read('web/index.html');
  t.ok('設定に「入力」のページがあり、外観の次に並ぶ', /id="appearanceTab"[^\n]*\n\s*<button type="button" id="inputTab"/.test(html) && html.includes('id="inputPanel"') && read('web/onboarding.mjs').includes("['input', 'inputTab', 'inputPanel']"));
}
