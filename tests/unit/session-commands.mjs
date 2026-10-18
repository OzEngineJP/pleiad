// 普通の会話の長いコマンドを、その会話自身へ知らせる（core/session-commands.mjs、ADR 0227 §2）。LLM は呼ばない。
//   - シェルのツール（記述の shellTools・shell: true）だけを見る。N 分で 1 回。承認待ちの時間は数えない。待つためのコマンドは数えない
//   - 今は渡せない（requeue）ならやり直す。受け取られないまま 3 分なら人へ知らせ、終わったら決着させる
//   - ターンの終わりでネイティブのコマンドは忘れる。ply_shell のジョブは忘れない。委譲の子は対象にしない
import { createSessionCommands } from '../../core/session-commands.mjs';

export const name = 'session-commands';
export const title = '普通の会話の長いコマンド: 会話自身へ 1 回知らせる・止めない・受け取られなければ人へ';

const minute = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 5));

function fixture({ answer = 'ok', delegated = () => false } = {}) {
  const f = { clock: 0, sent: [], raised: [], settled: [], waiting: new Set(), answer, hooks: [] };
  f.watch = createSessionCommands({
    minutes: 5, fallbackMs: 3 * minute, now: () => f.clock, tickMs: 0, delegated,
    waiting: (id) => f.waiting.has(id),
    deliver: async (sessionId, command, hooks) => { f.sent.push({ sessionId, command }); f.hooks.push(hooks); return typeof f.answer === 'function' ? f.answer() : f.answer; },
    raise: (sessionId, command) => f.raised.push({ sessionId, id: command.id }),
    settle: (sessionId, command) => f.settled.push({ sessionId, id: command.id }),
  });
  f.at = async (m) => { f.clock = m * minute; f.watch.tick(); await flush(); };
  f.start = (sessionId, id, name, command, extra = {}) => f.watch.observe(sessionId, { type: 'tool.start', id, name, input: { command }, at: f.clock, ...extra });
  return f;
}

export default async function (t) {
  {
    const f = fixture();
    f.start('s', 'a', 'bash', 'npm run dev');
    f.start('s', 'r', 'read', 'x');
    f.start('s', 'w', 'Bash', 'sleep 600');
    await f.at(4.9);
    t.ok('5 分未満は知らせない・シェルのツールだけを見る・待つためのコマンドは数えない', f.sent.length === 0 && f.watch.list('s').map((c) => c.id).join() === 'a');
    await f.at(5);
    t.ok('5 分で、その会話へ 1 回知らせる', f.sent.length === 1 && f.sent[0].sessionId === 's' && f.sent[0].command.id === 'a' && f.sent[0].command.elapsedMinutes === 5, JSON.stringify(f.sent));
    f.hooks[0].accept();
    await f.at(20);
    t.ok('止めずに、繰り返し知らせない', f.sent.length === 1 && f.watch.list('s').length === 1);
    t.ok('受け取られたら人へは知らせない', f.raised.length === 0);
    f.watch.observe('s', { type: 'tool.result', id: 'a', text: 'done' });
    t.ok('終わったら忘れる', f.watch.list('s').length === 0);
    f.watch.close();
  }
  {
    const f = fixture();
    f.start('s', 'a', 'PowerShell', 'Start-Process node');
    await f.at(1);
    f.waiting.add('s');
    await f.at(3);
    f.waiting.delete('s');
    await f.at(5);
    t.ok('承認待ちの時間は数えない', f.sent.length === 0);
    await f.at(7);
    t.ok('承認待ちを除いて 5 分で知らせる', f.sent.length === 1);
    f.watch.close();
  }
  {
    let n = 0;
    const f = fixture({ answer: () => (++n < 3 ? 'requeue' : 'ok') });
    f.start('s', 'a', 'bash', 'npm run dev');
    await f.at(5); await f.at(5.5);
    t.ok('今は渡せない（requeue）なら、次の見回りでやり直す', f.sent.length === 2);
    await f.at(6);
    t.ok('渡せたらやめる', f.sent.length === 3);
    await f.at(7.9);
    t.ok('受け取りが無くても 3 分までは人へ知らせない', f.raised.length === 0);
    await f.at(8);
    t.ok('最初に渡そうとしてから 3 分、受け取られなければ人へ知らせる（1 回）', f.raised.length === 1 && f.raised[0].id === 'a');
    await f.at(12);
    t.ok('人への知らせは繰り返さない', f.raised.length === 1);
    f.hooks.at(-1).accept();
    t.ok('後から受け取られたら、人への知らせを決着させる', f.settled.length === 1 && f.settled[0].id === 'a');
    f.watch.observe('s', { type: 'tool.result', id: 'a', text: 'x' });
    t.ok('決着させたものは、終わったときに重ねて決着させない', f.settled.length === 1);
    f.watch.close();
  }
  {
    const f = fixture();
    f.start('s', 'n', 'bash', 'npm run build');
    f.watch.track('s', { id: 'job-1', command: 'npm run dev', startedAt: 0 });
    f.watch.observe('s', { type: 'turnResult', outcome: 'ok' });
    t.ok('ターンの終わりでネイティブのコマンドは忘れ、ply_shell のジョブは残す', f.watch.list('s').map((c) => c.id).join() === 'job-1');
    await f.at(5);
    t.ok('ply_shell のジョブも 5 分で知らせる', f.sent.length === 1 && f.sent[0].command.source === 'ply');
    f.watch.untrack('s', 'job-1');
    f.start('s', 'again', 'bash', 'npm   run dev', {});
    await f.at(11);
    t.ok('同じ会話の同じコマンドは、やり直しても繰り返し知らせない', f.sent.length === 1);
    f.watch.observe('s', { type: 'task.command', id: 'again', state: 'background' });
    t.ok('裏へ回ったコマンドは知らせない（エージェントが待っていない）', f.watch.list('s').length === 0);
    f.watch.close();
  }
  {
    const f = fixture({ delegated: (id) => id === 'child' });
    f.start('child', 'a', 'bash', 'npm test');
    f.start('s', 'acp', 'Run tests', 'npm test', { shell: true });
    await f.at(5);
    t.ok('委譲の子は対象にしない（親へ知らせる）・名前で見分けられない呼び出しは shell: true で見る', f.sent.map((x) => x.sessionId).join() === 's');
    f.watch.close();
  }
}
