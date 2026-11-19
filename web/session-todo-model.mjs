// 会話の ToDo の面の、DOM に触れない計算（承認済みのモック temporary/mockups/session-todo.html の配置の式を移したもの。ADR 0342）。
// 項目は core/todos.mjs の形（{ id, text, status, waiting, after, links, ... }。並び = 先に終える順）。
// - 依存（after）が無い・並びどおりの 1 本道なら「リスト」、枝分かれ・合流があれば「フロー」（上から下への流れ図）
// - 画面の編集は、依存の表（id → 先に終える id の配列）を組み替えて正規化し、todos.update の差分へ直す

/** id → 先に終える id（今ある項目だけ。自分と重なりは外す） */
export function afterMap(items) {
  const ids = new Set(items.map(i => i.id));
  return new Map(items.map(i => [i.id, [...new Set((i.after ?? []).filter(d => ids.has(d) && d !== i.id))]]));
}

/** 並びどおりの 1 本道（先頭以外が直前の 1 つだけを待つ）か */
function isOrderChain(items, deps) {
  return items.every((it, i) => {
    const d = deps.get(it.id) ?? [];
    return i ? d.length === 1 && d[0] === items[i - 1].id : d.length === 0;
  });
}

/** フローで見せるか。依存が無い、または並びどおりの 1 本道ならリスト */
export function isFlowGraph(items) {
  if (items.length < 2) return false;
  const deps = afterMap(items);
  if (![...deps.values()].some(d => d.length)) return false;
  return !isOrderChain(items, deps);
}

/** 依存の表。フローなら after、リストなら並びの 1 本道 */
export function materialize(items, flow = isFlowGraph(items)) {
  if (flow) return afterMap(items);
  return new Map(items.map((it, i) => [it.id, i ? [items[i - 1].id] : []]));
}

/** 先に終える項目から並べ直す（安定。輪になった残りは元の順で後ろへ） */
export function topoOrder(items, deps) {
  const out = [], seen = new Set(), rest = [...items];
  while (rest.length) {
    const k = rest.findIndex(i => (deps.get(i.id) ?? []).every(d => seen.has(d)));
    if (k < 0) break;
    const [x] = rest.splice(k, 1);
    out.push(x); seen.add(x.id);
  }
  return [...out, ...rest];
}

/**
 * 依存の表を正規化する（モックの normalize）: 今ある項目だけにし、先に終える順に並べ、
 * 1 本道（根が 1 つで、どの項目も待つ・待たれるのが 1 つ以下）なら依存を全部外してリストへ戻す。
 * 返すのは新しい並び（id）と after の表
 */
export function normalizeAfter(items, deps) {
  const ids = new Set(items.map(i => i.id));
  const clean = new Map(items.map(i => [i.id, [...new Set((deps.get(i.id) ?? []).filter(d => ids.has(d) && d !== i.id))]]));
  const ordered = topoOrder(items, clean);
  const cnt = new Map();
  for (const d of clean.values()) for (const x of d) cnt.set(x, (cnt.get(x) ?? 0) + 1);
  const roots = ordered.filter(i => !clean.get(i.id).length).length;
  const chain = ordered.length < 2 || (roots === 1 && ordered.every(i => clean.get(i.id).length <= 1 && (cnt.get(i.id) ?? 0) <= 1));
  return { order: ordered.map(i => i.id), after: chain ? new Map(ordered.map(i => [i.id, []])) : clean };
}

/** a は b を（間を挟んでも）先に必要とするか */
export function reaches(a, b, deps) {
  const seen = new Set();
  const go = (x) => {
    if (x === b) return true;
    if (seen.has(x)) return false;
    seen.add(x);
    return (deps.get(x) ?? []).some(go);
  };
  return go(a);
}

/** 印の種類。待ち（先の項目が残っている）はフローのときだけ */
export function kindOf(item, flow) {
  if (item.status === 'done') return 'done';
  if (item.status === 'doing') return 'doing';
  return flow && item.waiting ? 'wait' : 'todo';
}

/** 末端（どの項目からも待たれていない）の id。フローで足す項目の after */
export function leaves(items, deps = afterMap(items)) {
  const used = new Set();
  for (const d of deps.values()) for (const x of d) used.add(x);
  return items.filter(i => !used.has(i.id)).map(i => i.id);
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/**
 * 並びと after の変更を、todos.update の items へ直す。並びが変わったら新しい並びの順に全部を末尾へ送る
 * （core は項目ごとに順に当てるので、終わると新しい並びになる）
 */
export function changesFor(items, order, after) {
  const byId = new Map(items.map(i => [i.id, i]));
  const now = items.map(i => i.id);
  const out = new Map();
  const put = (id, patch) => out.set(id, { ...(out.get(id) ?? { id }), ...patch });
  if (!sameList(now, order)) for (const id of order) put(id, { before: null });
  for (const [id, d] of after) {
    const old = byId.get(id)?.after ?? [];
    if (byId.has(id) && !sameSet(old, d)) put(id, { after: [...d] });
  }
  const list = order.filter(id => out.has(id)).map(id => out.get(id));
  for (const [id, c] of out) if (!order.includes(id)) list.push(c);
  return list;
}

/** リストの配置（幅は 640px まで、真ん中に寄せる） */
export function layoutList(items, W, rowH, gap) {
  const R = new Map(), lw = Math.min(W, 640), ox = (W - lw) / 2;
  let y = 0;
  for (const it of items) { const h = rowH(it, lw); R.set(it.id, { x: ox, y, w: lw, h, o: 1 }); y += h + gap; }
  const H = Math.max(0, y - gap);
  return { R, E: [], H, CW: W, stack: 0, B: { x0: ox, x1: ox + lw, y0: 0, y1: H } };
}

/**
 * フローの配置（モックの layout）。最長路で段に分け、段を跨ぐ線には見えない点を置き、親の位置の平均で段の中を並べる。
 * 項目が 8 を超えて畳んでよいなら、先頭から続く完了（3 つ以上）を 1 つの束（#done）にまとめる
 */
export function layoutFlow(items, deps, W, K, expand = false) {
  const R = new Map(), E = [];
  const depsOf = id => deps.get(id) ?? [];
  const order = topoOrder(items, deps);
  let C = new Set();
  if (!expand && items.length > 8) {
    for (const it of order) if (it.status === 'done' && depsOf(it.id).every(d => C.has(d))) C.add(it.id);
    if (C.size < 3) C = new Set();
  }
  const nodes = [];
  if (C.size) nodes.push({ id: '#done', deps: [] });
  for (const it of order) if (!C.has(it.id)) nodes.push({ id: it.id, deps: [...new Set(depsOf(it.id).map(d => (C.has(d) ? '#done' : d)))] });
  const lay = new Map();
  for (const n of nodes) lay.set(n.id, n.deps.length ? 1 + Math.max(...n.deps.map(d => lay.get(d) ?? 0)) : 0);
  const nL = Math.max(0, ...lay.values()) + 1, Ls = Array.from({ length: nL }, () => []), par = new Map();
  for (const n of nodes) { par.set(n.id, []); Ls[lay.get(n.id)].push({ id: n.id }); }
  for (const n of nodes) for (const d of n.deps) {
    const e = { key: `${d}>${n.id}`, a: d, b: n.id, via: [] };
    E.push(e);
    let prev = d;
    for (let k = lay.get(d) + 1; k < lay.get(n.id); k++) { const id = `~${e.key}:${k}`; par.set(id, [prev]); Ls[k].push({ id, dummy: e }); prev = id; }
    par.get(n.id).push(prev);
  }
  const pos = new Map();
  Ls.forEach((L, k) => {
    if (k) {
      const key = new Map(L.map((n, i) => { const p = par.get(n.id); return [n.id, [p.length ? p.reduce((s, x) => s + (pos.get(x) ?? 0), 0) / p.length : 0, i]]; }));
      L.sort((a, b) => key.get(a.id)[0] - key.get(b.id)[0] || key.get(a.id)[1] - key.get(b.id)[1]);
    }
    L.forEach((n, i) => pos.set(n.id, (i + 0.5) / L.length));
  });
  const step = K.NH + K.GY;
  const tot = L => L.reduce((s, n) => s + (n.dummy ? 10 : K.NW), 0) + K.GX * (L.length - 1);
  const cross = Math.max(...Ls.map(tot)), H = nL * step - K.GY, CW = Math.max(W, cross), ox = (CW - cross) / 2;
  Ls.forEach((L, k) => {
    let c = (cross - tot(L)) / 2;
    for (const n of L) {
      const s = n.dummy ? 10 : K.NW;
      if (n.dummy) n.dummy.via.push({ x: ox + c + s / 2, y: k * step + K.NH / 2 });
      else R.set(n.id, { x: ox + c, y: k * step, w: K.NW, h: K.NH, o: 1 });
      c += s + K.GX;
    }
  });
  if (C.size) for (const id of C) R.set(id, { ...R.get('#done'), o: 0 });
  return { R, E, H, CW, stack: C.size, B: { x0: ox, x1: ox + cross, y0: 0, y1: H } };
}

/** 成果物の 1 件を、名前と場所に分ける（ファイルのリンク .file-where と同じ分け方） */
export function linkParts(link) {
  if (link.kind === 'url') {
    const u = String(link.url ?? '').replace(/^https?:\/\//i, '');
    return { name: link.title || u, where: link.title ? u.split('/')[0] : '' };
  }
  const p = String(link.path ?? '').replace(/[\\/]+$/, ''), i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return { name: p.slice(i + 1) || p, where: i > 0 ? p.slice(0, i) : '' };
}

/** 入力欄の 1 行を、todos.update の addLinks の 1 件へ（種類は core が決める） */
export function linkInput(text) {
  const v = String(text ?? '').trim();
  return /^https?:\/\//i.test(v) ? { url: v } : { path: v };
}
