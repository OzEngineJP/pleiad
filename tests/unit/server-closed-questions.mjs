// 回答待ちの質問（Issue #231）。fake バックエンドのサーバー越し。LLM は呼ばない。
//   - 質問の待ちは waitingCards に kind: question で出る（一覧・会話の「回答待ち」の元）
//   - 人の回答以外（中断）で閉じた質問は、閉じた理由と質問の中身を会話に残す（questionsClosed のイベントと loadSession の closedQuestions）
//   - 答えた・「答えずに進める」で閉じた質問は残さない
//   - 画面の配線（client.mjs・side.mjs）と辞書
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import * as P from '../../core/protocol.mjs';

export const name = 'server-closed-questions';
export const title = '回答待ちの質問（#231）: running に question の印・回答以外で閉じた質問は理由と中身を会話に残す・答えた質問は残さない・画面の配線';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default async function (t) {
  t.ok('questionsClosed は EVENTS に登録されている', P.EVENTS.has('questionsClosed'));

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-closed-questions-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: scratch });
  const c = await open({ port: server.port, token: server.token });
  // 質問を出して、カードが出るまで待つ（ターンは答えを待って止まったまま）
  const ask = async (sid) => {
    const from = c.mark();
    await c.cmd('runTurn', { sessionId: sid, prompt: 'question', cwd: ROOT });
    return c.waitFor((e) => e.type === 'permission' && e.kind === 'question' && e.sessionId === sid, { from, ms: 20_000 });
  };
  const turnEnd = (sid, from) => c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sid, { from, ms: 20_000 });
  try {
    const sid = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:hi' }, { ms: 20_000 })).sessionId;

    // ---- 回答待ちの印
    const card = await ask(sid);
    const waiting = c.waitingCards.find((p) => p.id === card.id);
    t.ok('質問の待ちは waitingCards に kind: question で出る', waiting?.kind === 'question', JSON.stringify(waiting));

    // ---- 中断で閉じた質問は、理由と中身を残す
    const from = c.mark();
    await c.cmd('abort', { sessionId: sid });
    await turnEnd(sid, from);
    const closed = await c.waitFor((e) => e.type === 'questionsClosed' && e.sessionId === sid, { from, ms: 10_000 }).catch(() => null);
    const item = closed?.items?.[0];
    t.ok('中断で閉じた質問は questionsClosed で知らせる（理由 user・質問の中身・選択肢）', item?.reason === 'user' && item.id === card.id
      && item.questions?.[0]?.question === 'どれにする？' && item.questions[0].options?.map((o) => o.label).join() === 'A,B', JSON.stringify(closed));
    const idx = c.since(from).findIndex((e) => e.type === 'questionsClosed');
    const endIdx = c.since(from).findIndex((e) => e.type === 'turnEnd' && e.sessionId === sid);
    t.ok('知らせはターンの終わり（turnEnd）より前に届く', idx >= 0 && idx < endIdx, `${idx} / ${endIdx}`);
    const loaded = await c.cmd('loadSession', { sessionId: sid });
    t.ok('開き直しても closedQuestions に残る', loaded?.closedQuestions?.length === 1 && loaded.closedQuestions[0].reason === 'user'
      && loaded.closedQuestions[0].questions?.[0]?.header === '選択' && Number(loaded.closedQuestions[0].at) > 0, JSON.stringify(loaded?.closedQuestions));

    // ---- 答えた質問・「答えずに進める」（answers 空の allow）は残さない
    for (const answers of [{ 'どれにする？': 'A' }, {}]) {
      const q = await ask(sid);
      const f = c.mark();
      await c.cmd('resolvePermission', { id: q.id, allow: true, answers });
      await turnEnd(sid, f);
    }
    // 人が断った（ほかの窓から allow: false）質問も、人の判断なので残さない
    const denied = await ask(sid);
    const f2 = c.mark();
    await c.cmd('resolvePermission', { id: denied.id, allow: false, messageKey: 'userDenied' });
    await turnEnd(sid, f2);
    await sleep(200);
    const after = await c.cmd('loadSession', { sessionId: sid });
    t.ok('答えた・答えずに進めた・人が断った質問は残さない（中断の 1 件のまま）', after?.closedQuestions?.length === 1, JSON.stringify(after?.closedQuestions));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // ---- 画面の配線
  const client = read('web/client.mjs'), side = read('web/side.mjs');
  t.ok('画面は questionsClosed を受けて、閉じた質問のカードを描く', /case ['"]questionsClosed['"]/.test(client) && /closedQuestions/.test(client));
  t.ok('画面は待ち一覧から回答待ちの会話を集め、一覧へ渡す', /card\.kind === 'question'/.test(client) && /answerWaitIds/.test(client) && /answerWaitIds/.test(side));
  t.ok('一覧は回答待ちを「承認待ち」と分けて出す', /sidebar\.waitingAnswer/.test(side));
  for (const lng of ['ja', 'en']) {
    const ui = JSON.parse(read(`web/locales/${lng}/ui.json`));
    t.ok(`${lng}: 回答待ち・閉じた質問の辞書がある`, Boolean(ui.sidebar?.waitingAnswer && ui.chat?.closedQuestion?.heading
      && ui.chat.closedQuestion.reason?.restart && ui.chat.closedQuestion.send && ui.chat.closedQuestion.askAgain));
  }
}
