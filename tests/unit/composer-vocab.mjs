// 入力欄のモデル・エフォートの一覧が、いま選んでいるものの一覧かの判定と、エフォートの取得の相乗り（web/composer-vocab.mjs）。
// エージェントを切り替えた直後に前のエージェントの一覧を出さない・同じ鍵の取得は 1 本・古い取得は新しい鍵へ混ざらない、を確かめる。
import { vocabKey, vocabReady, defaultModelOf, effortRequest, effortsKeyOf, createEffortsLoader, createEffortsView } from '../../web/composer-vocab.mjs';

export const name = 'composer-vocab';
export const title = '入力欄の一覧: 切り替えた直後は前の一覧を出さず、同じ取得は 1 本にまとめる';

const gate = () => { const g = {}; g.promise = new Promise((resolve, reject) => { g.resolve = resolve; g.reject = reject; }); return g; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

export default async function (t) {
  // ---- 一覧の鍵: エージェントとアカウントで決まる。接続先を選んでいる間はアカウントを見ない ----
  const claude = vocabKey({ backend: 'claude', account: '' });
  t.ok('エージェントが違えば鍵が違う', claude !== vocabKey({ backend: 'codex', account: '' }));
  t.ok('アカウントが違えば鍵が違う', claude !== vocabKey({ backend: 'claude', account: 'work' }));
  t.ok('接続先を選んでいるときはアカウントを鍵に入れない', vocabKey({ backend: 'claude', account: 'work', endpoint: 'ep1' }) === vocabKey({ backend: 'claude', account: '', endpoint: 'ep2' }));
  t.ok('取れていない・別の鍵の一覧は、いまの一覧として扱わない', !vocabReady(null, claude) && !vocabReady(undefined, claude) && !vocabReady(vocabKey({ backend: 'codex' }), claude) && vocabReady(claude, claude));

  // ---- 切り替えて戻した場合: 取ってあった一覧がそのままいまの一覧になる ----
  {
    let loaded = claude;                                     // Claude の一覧を表示中
    const wanted = vocabKey({ backend: 'codex', account: '' });
    t.ok('Codex に切り替えた直後は、Claude の一覧を出さない', !vocabReady(loaded, wanted));
    t.ok('取得が終わる前に Claude へ選び直せば、Claude の一覧がすぐ出る', vocabReady(loaded, claude));
  }

  t.ok('一覧に空の行があれば既定は空、無ければ先頭', defaultModelOf({ '': {}, a: {} }) === '' && defaultModelOf({ a: {}, b: {} }) === 'a' && defaultModelOf({}) === '' && defaultModelOf(null) === '');
  const request = effortRequest({ backend: 'claude', account: 'work', model: 'opus', cwd: '' });
  t.ok('エフォートの問い合わせは作業場所が空なら送らず、接続先ならアカウントを送らない',
    request.cwd === undefined && request.account === 'work' && effortRequest({ backend: 'claude', account: 'work', endpoint: 'ep' }).account === '' && effortRequest({ backend: 'claude', endpoint: 'ep' }).endpoint === 'ep');

  // ---- エフォートの取得: 同じ鍵は取得中も取得済みも 1 本 ----
  {
    const calls = [];
    const slow = gate();
    const loader = createEffortsLoader({ cmd: async (op, args) => { calls.push({ op, args }); if (calls.length === 1) await slow.promise; return { '': {}, high: {} }; } });
    const sel = { backend: 'claude', account: '', model: 'opus', cwd: '/w' };
    const a = loader.load(sel);
    const b = loader.load({ ...sel });
    await tick();
    t.ok('同じ鍵の取得中は 1 本に相乗りする', calls.length === 1 && calls[0].op === 'efforts');
    slow.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    t.ok('相乗りした呼び出しは同じ結果を受け取る', ra === rb && 'high' in ra);
    await loader.load(sel);
    t.ok('取得済みの鍵は取り直さない', calls.length === 1);
    await loader.load({ ...sel, model: 'sonnet' });
    t.ok('モデルが違えば別の取得', calls.length === 2 && calls[1].args.model === 'sonnet');
    await loader.load({ ...sel, cwd: '/other' });
    await loader.load({ ...sel, account: 'work' });
    t.ok('作業場所・アカウントが違っても別の取得', calls.length === 4);
    loader.invalidate();
    await loader.load(sel);
    t.ok('invalidate の後は取り直す', calls.length === 5);
  }

  // ---- 失敗は覚えない。捨てた世代の古い応答は、取り直した結果を上書きしない ----
  {
    let n = 0;
    const loader = createEffortsLoader({ cmd: async () => { n += 1; if (n === 1) throw new Error('down'); return { '': {}, low: {} }; } });
    const sel = { backend: 'codex', model: 'm' };
    const failed = await loader.load(sel).then(() => 'ok', (e) => e.message);
    const again = await loader.load(sel);
    t.ok('失敗した取得は覚えず、次の呼び出しで取り直す', failed === 'down' && 'low' in again && n === 2);
  }
  {
    const first = gate();
    let n = 0;
    const loader = createEffortsLoader({ cmd: async () => { n += 1; if (n === 1) { await first.promise; return { '': {}, old: {} }; } return { '': {}, fresh: {} }; } });
    const sel = { backend: 'codex', model: 'm' };
    const stale = loader.load(sel);
    await tick();
    loader.invalidate();
    const fresh = await loader.load(sel);
    first.resolve();
    await stale;
    const cached = await loader.load(sel);
    t.ok('捨てる前に始まった取得の応答は、取り直した結果を上書きしない', 'fresh' in fresh && 'fresh' in cached && !('old' in cached));
  }

  // ---- 表示している段の鍵は問い合わせの全キー: 同じエージェントでもモデル・作業場所・接続先が違えば前の段を出さない ----
  {
    const base = { backend: 'claude', account: '', model: 'opus', cwd: '/w' };
    t.ok('モデル・作業場所・接続先・アカウントのどれが違っても段の鍵は違う',
      new Set([base, { ...base, model: 'sonnet' }, { ...base, cwd: '/o' }, { ...base, endpoint: 'ep' }, { ...base, account: 'work' }].map(effortsKeyOf)).size === 5);
    t.ok('同じ選択は同じ鍵（接続先を選んでいるときアカウントは鍵に入れない）', effortsKeyOf(base) === effortsKeyOf({ ...base }) && effortsKeyOf({ ...base, endpoint: 'ep', account: 'a' }) === effortsKeyOf({ ...base, endpoint: 'ep', account: 'b' }));

    const gates = new Map();
    const loader = createEffortsLoader({ cmd: async (op, args) => { const g = gate(); gates.set(args.model, g); return g.promise; } });
    const view = createEffortsView({ loader });
    let want = { ...base, model: 'opus' };
    const opus = view.adopt(want, () => want, {});
    await tick();
    t.ok('取得が終わるまでは、何も選んでいるものの段として扱わない', !view.ready(want) && Object.keys(view.efforts).length === 0);

    // 取得中にモデルを選び直す。後から選んだ段が先に届き、前の段が遅れて届く（逆順）
    want = { ...base, model: 'sonnet' };
    const sonnet = view.adopt(want, () => want, {});
    await tick();
    gates.get('sonnet').resolve({ '': {}, low: {} });
    t.ok('後から選んだモデルの段は採る', await sonnet === true && view.ready(want) && 'low' in view.efforts);
    gates.get('opus').resolve({ '': {}, max: {} });
    t.ok('遅れて届いた前のモデルの段は、後から選んだモデルの段を上書きしない', await opus === false && view.ready(want) && 'low' in view.efforts && !('max' in view.efforts));
    t.ok('前のモデルの段は、いまの選択では出さない（選び直す前のモデルでは表示が準備できていない扱い）', !view.ready({ ...base, model: 'opus' }));

    // 取得中に、別のモデルへ選び直したまま届く（遅延）: 選び直した先が決まっていれば、届いた段は採らない
    gates.clear();
    let moved = { ...base, model: 'haiku' };
    const haiku = view.adopt(moved, () => moved, {});
    await tick();
    moved = { ...base, model: 'sonnet' };   // 待っている間に Sonnet へ戻した
    gates.get('haiku').resolve({ '': {}, haiku: {} });
    t.ok('待っている間に選び直されたら、届いた段は採らない（Sonnet の段を保つ）', await haiku === false && view.ready(moved) && 'low' in view.efforts);

    // 同じ段を取っている最中の呼び出しは同じ約束
    gates.clear();
    const target = { ...base, model: 'gpt' };
    const one = view.adopt(target, () => target, {}), two = view.adopt(target, () => target, {});
    await tick();
    gates.get('gpt').resolve({ '': {}, mid: {} });
    t.ok('同じ段の取得中の呼び出しは同じ約束で、両方とも採る', one === two && await one === true && await two === true && view.ready(target));

    // 取得に失敗したら、渡した代わりの段を採る（読み込み中のまま止めない）
    const failing = createEffortsView({ loader: createEffortsLoader({ cmd: async () => { throw new Error('down'); } }) });
    const sel = { ...base, model: 'x' };
    t.ok('取得に失敗しても、代わりの段で準備できた状態にする', await failing.adopt(sel, () => sel, { '': { label: 'x' } }) === true && failing.ready(sel) && '' in failing.efforts);
  }

  // ---- loader を捨てたら、表示側も同じ鍵の段を取り直す（古い段・空の段を採ったまま止まらない） ----
  {
    const sel = { backend: 'claude', account: '', model: 'opus', cwd: '/w' };
    let n = 0;
    const loader = createEffortsLoader({ cmd: async () => { n += 1; return { '': {}, [`gen${n}`]: {} }; } });
    const view = createEffortsView({ loader });
    t.ok('最初は取り直しが要る', !view.fresh(sel));
    await view.adopt(sel, () => sel, {});
    t.ok('取得に成功した段は、そのまま使える', view.fresh(sel) && view.ready(sel) && 'gen1' in view.efforts);
    loader.invalidate();
    t.ok('loader を捨てたら、同じ鍵でも取り直しが要る（表示は途切れさせない）', !view.fresh(sel) && view.ready(sel) && 'gen1' in view.efforts);
    await view.adopt(sel, () => sel, {});
    t.ok('取り直した段に入れ替わる', view.fresh(sel) && 'gen2' in view.efforts && !('gen1' in view.efforts));
  }
  {
    // 取得中に捨てられ、捨てられた約束が空（undefined）で解ける: 空の段を採らず、取り直す
    const first = gate();
    let n = 0;
    const loader = createEffortsLoader({ cmd: async () => { n += 1; if (n === 1) { await first.promise; return { '': {}, old: {} }; } return { '': {}, fresh: {} }; } });
    const view = createEffortsView({ loader });
    const sel = { backend: 'codex', model: 'm' };
    const adopting = view.adopt(sel, () => sel, { '': { label: 'fallback' } });
    await tick();
    loader.invalidate();
    first.resolve();
    t.ok('取得中に捨てられても、取り直して採る', await adopting === true);
    t.ok('空（undefined）の段を採らず、新しい世代の段を採る', 'fresh' in view.efforts && !('old' in view.efforts) && Object.keys(view.efforts).length > 0 && view.fresh(sel), JSON.stringify(view.efforts));
  }
  {
    // 失敗して代わりの段を採った鍵は、固定しない（次の adopt が取り直す）
    let n = 0;
    const loader = createEffortsLoader({ cmd: async () => { n += 1; if (n === 1) throw new Error('down'); return { '': {}, high: {} }; } });
    const view = createEffortsView({ loader });
    const sel = { backend: 'codex', model: 'm' };
    await view.adopt(sel, () => sel, { '': { label: 'fallback' } });
    t.ok('失敗した取得は、代わりの段を出すが、取り直しは要るまま', view.ready(sel) && !view.fresh(sel) && 'label' in view.efforts['']);
    await view.adopt(sel, () => sel, {});
    t.ok('次の adopt で取り直して、成功した段に入れ替わる', view.fresh(sel) && 'high' in view.efforts);
  }
  {
    // 捨てる操作が続いても、取り直しは上限で止まり、表示を決める
    let n = 0;
    let loader;
    loader = createEffortsLoader({ cmd: async () => { n += 1; loader.invalidate(); return { '': {}, x: {} }; } });
    const view = createEffortsView({ loader });
    const sel = { backend: 'codex', model: 'm' };
    const done = await Promise.race([view.adopt(sel, () => sel, { '': { label: 'fallback' } }), new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000))]);
    t.ok('捨てる操作が続いても、取り直しは上限で止まって表示を決める', done === true && view.ready(sel) && n <= 5, `${done} ${n}`);
  }
  {
    // 草稿の作業場所は問い合わせにも鍵にも入る（その場所のプロジェクト設定が段を変える）
    const calls = [];
    const loader = createEffortsLoader({ cmd: async (op, args) => { calls.push(args.cwd); return { '': {} }; } });
    await loader.load({ backend: 'codex', model: 'm', cwd: '/a' });
    await loader.load({ backend: 'codex', model: 'm', cwd: '/b' });
    t.ok('作業場所が違えば別の取得で、cwd を送る', calls.join() === '/a,/b');
  }
}
