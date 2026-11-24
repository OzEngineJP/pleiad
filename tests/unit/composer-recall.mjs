// 入力欄の ↑ の呼び出し（web/composer/recall.mjs）の「送ったとき」。
//   - 送ったときは並びを読み直さない（sessions.sentMessages は重く、送信の準備と取り合って送信が会話に出るまでを 1〜14 秒待たせていた）
//   - 読み込み済みなら、送った文が ↑ の先頭に出る・同じ文は新しい 1 つだけ。読み込み前なら、次の ↑・フォーカスの読み込みが足す
//   - 会話を替えたときは今までどおり読み直す（reset → prefetch）
import { N } from '../lib/dom-stub.mjs';
import { createRecall } from '../../web/composer/recall.mjs';

export const name = 'composer-recall';
export const title = '入力欄の ↑ の呼び出し（送ったときは読み直さず、送った文を先頭に足す）';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({ list = [], shell = false } = {}) {
  const box = new N('div'), prompt = new N('textarea');
  prompt.value = ''; prompt.selectionStart = 0; prompt.selectionEnd = 0; prompt.readOnly = false;
  prompt.setSelectionRange = (a, b) => { prompt.selectionStart = a; prompt.selectionEnd = b; };
  prompt.insertAdjacentElement = (_where, node) => { node.parent = box; box.children.push(node); };
  box.append(prompt);
  const loads = [];
  const state = { shell, current: 's1' };
  const r = createRecall({
    prompt, box, t: (k) => `[${k}]`, enabled: () => true, shell: () => state.shell, current: () => state.current,
    load: async (o) => { loads.push(o); return list.map((x) => ({ sessionId: 's1', title: '', at: '', ...x })); },
    take: () => ({ text: prompt.value }), restore: (draft) => { prompt.value = draft?.text ?? ''; }, put: (item) => { prompt.value = item.text; },
  });
  const up = async () => { prompt.setSelectionRange(0, 0); const taken = r.keydown({ key: 'ArrowUp', preventDefault() {} }); await tick(); return taken; };
  const pos = () => r.row.querySelector('.recall-pos').textContent;
  return { r, prompt, box, loads, state, up, pos };
}

/** setTimeout を溜めて手で流す（prefetch の 250ms を待たない） */
function holdTimers() {
  const real = globalThis.setTimeout;
  let timers = [];
  globalThis.setTimeout = (fn) => { const h = { fn }; timers.push(h); return h; };
  return {
    pending: () => timers.length,
    flush: () => { const run = timers; timers = []; for (const h of run) h.fn(); },
    restore: () => { globalThis.setTimeout = real; },
  };
}

export default async function (t) {
  {
    const s = setup({ list: [{ text: 'b' }, { text: 'a' }] });
    await s.up();
    t.ok('最初の ↑ で読み、いちばん新しいものが入る', s.loads.length === 1 && s.prompt.value === 'b' && s.pos() === '1 / 2');
    const timers = holdTimers();
    try {
      s.r.sent({ sessionId: 's1', title: '', uuid: '', at: '', text: 'new', shell: false });
      t.ok('送っても読み直さず、先読みの命令も予約しない', s.loads.length === 1 && timers.pending() === 0);
      timers.flush();
      t.ok('先読みの時刻が過ぎても読みに行かない', s.loads.length === 1);
    } finally { timers.restore(); }
    t.ok('送ったら呼び出しは終わり（行を消す）', !s.r.active && !s.r.row.classList.contains('on'));
    s.prompt.value = '';
    await s.up();
    t.ok('送った文が ↑ の先頭に出る（並びは 3 件）', s.prompt.value === 'new' && s.pos() === '1 / 3');
    await s.up();
    t.ok('その次は今までの並びの順', s.prompt.value === 'b' && s.pos() === '2 / 3');
    await s.up();
    t.ok('今までの並びは欠けない', s.prompt.value === 'a' && s.pos() === '3 / 3' && s.loads.length === 1);
  }
  {
    const s = setup({ list: [{ text: 'b' }, { text: 'a' }] });
    await s.up();
    s.r.sent({ sessionId: 's1', title: '', uuid: '', at: '', text: ' a ', shell: false });
    s.prompt.value = '';
    await s.up();
    t.ok('同じ文は新しい 1 つだけ（前後の空白は見ない）', s.prompt.value === ' a ' && s.pos() === '1 / 2');
    await s.up();
    t.ok('古い同じ文は並びから消える', s.prompt.value === 'b' && s.pos() === '2 / 2');
  }
  {
    const s = setup({ list: [{ text: 'b' }] });
    await s.up();
    s.r.sent({ sessionId: 's1', title: '', uuid: '', at: '', text: 'cmd', shell: true });
    s.prompt.value = '';
    await s.up();
    t.ok('`!` で送ったコマンドは、文の並びに足さない（形が違う）', s.prompt.value === 'b' && s.pos() === '1 / 1');
  }
  {
    const s = setup({ list: [{ text: 'b' }], shell: true });
    await s.up();
    s.r.sent({ sessionId: 's1', title: '', uuid: '', at: '', text: 'ls', shell: true });
    s.prompt.value = '';
    await s.up();
    t.ok('`!` の形では、送ったコマンドを先頭に足す', s.prompt.value === 'ls' && s.pos() === '1 / 2' && s.loads.length === 1);
  }
  {
    // 読む前に送った: 何も読みに行かない。次の ↑ の読み込みが送った分を足す（client.mjs の loadSentMessages が手元の分を合わせる）
    const s = setup({ list: [{ text: 'b' }] });
    const timers = holdTimers();
    try {
      s.r.sent({ sessionId: 's1', title: '', uuid: '', at: '', text: 'new', shell: false });
      t.ok('読み込み前に送っても、命令は出さない', s.loads.length === 0 && timers.pending() === 0);
    } finally { timers.restore(); }
    s.r.sent(null);
    t.ok('送った文が無くても（添付だけの送信）落ちない', s.loads.length === 0);
    await s.up();
    t.ok('読み込み前に送ったあとの ↑ は、そこで初めて読む', s.loads.length === 1 && s.prompt.value === 'b');
  }
  {
    // 呼び出した文をそのまま送る・直して送る: どちらも呼び出しは終わり、書きかけは戻さない
    const s = setup({ list: [{ text: 'b' }, { text: 'a' }] });
    await s.up();
    t.ok('呼び出している', s.r.active);
    s.r.sent({ sessionId: 's1', title: '', uuid: '', at: '', text: 'b', shell: false });
    t.ok('呼び出した文を送ったら呼び出しは終わる', !s.r.active);
    s.prompt.value = '';
    await s.up();
    t.ok('並びの先頭は 1 つだけ（呼び出した文と同じ文は重ならない）', s.prompt.value === 'b' && s.pos() === '1 / 2');
  }
  {
    // 会話を替えたときは今までどおり読み直す
    const s = setup({ list: [{ text: 'b' }] });
    await s.up();
    const timers = holdTimers();
    const doc = globalThis.document;
    doc.activeElement = s.prompt;
    try {
      s.r.reset();
      t.ok('会話を替えたら、欄にフォーカスがあれば先読みを予約する', timers.pending() === 1);
      timers.flush();
      await tick();
      t.ok('先読みで読み直す', s.loads.length === 2);
    } finally { timers.restore(); delete doc.activeElement; }
  }
}
