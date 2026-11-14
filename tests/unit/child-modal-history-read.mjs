// 作業のダイアログ（モーダル）の子の会話の履歴の読み方を、主の会話の画面にそろえる（ADR 0319 段 6-6 の追補）。
//   1. 差分の読み直し: syncModalChildHistory は今持っている窓の続きだけを頼む（from・check。ADR 0062）。つないだ結果が画面に描かれる
//   2. 大きい返事の圧縮（bulk。ADR 0179）: 読み込みを頼む前に取り置きを始めてあるので、返事が出来事より遅れても streamSeq で順に流し直せる（重複も欠けも無い）
//   3. 画面外の行を省く: style.css の content-visibility は、モーダルの子の実例の筋（.live-child）にも効く。読むだけの筋（readonlyThread）には付けない
//   4. 目次: モーダルの目次も、開くと窓の手前を全部読む（onOpen）。閉じた実例は読み足さず、つながらないときは窓を読み直す
// client.mjs・history-pane.mjs の関数を切り出して vm で走らせる（本物の画面の経路は tests/browser/child-modal-history-read.mjs が見る）。
import vm from "node:vm";
import fs from "node:fs";
import { readWeb, cutFunction, readHistoryPane } from "../lib/cut-source.mjs";
import { syncRequest, serveFrom, joinReply, WINDOW_MESSAGES, WINDOW_BYTES } from "../../web/history-sync.mjs";
import { createSessionLoads } from "../../web/session-stream.mjs";

export const name = "child-modal-history-read";
export const title = "モーダルの子の履歴の読み方: 差分・bulk（出来事との順序）・画面外の行を省く・目次の onOpen が主と同じ";

const at = n => new Date(Date.UTC(2026, 10, 15, 0, n)).toISOString();
const conv = n => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? { uuid: `u${i}`, role: "user", text: `質問 ${i}`, at: at(i) }
  : { uuid: `a${i}`, role: "assistant", text: `答え ${i}`, at: at(i) });
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async function (t) {
  const client = readWeb("client.mjs");
  const syncSource = cutFunction(client, "syncModalChildHistory", { withAsync: true });
  const loadSource = cutFunction(client, "loadHistory", { withAsync: true });
  t.ok("client.mjs に syncModalChildHistory と loadHistory がある", syncSource.length > 0 && loadSource.length > 0);
  if (!syncSource || !loadSource) return;

  /**
   * 子の実例の身代わり。server は子の会話の保存された履歴（先頭からの全量）。
   * cmd は serveFrom で応え、頼みと bulk の印を残す。gate を渡すと、返事をその Promise が解けるまで止める（bulk の返事が遅れる場面）
   */
  function build({ remote = [], pane = remote.slice(0, 40), live = true, gate = null, serve = serveFrom } = {}) {
    const calls = [], order = [], applied = [], paints = [];
    const loads = createSessionLoads();
    const realBegin = loads.begin;
    loads.begin = (id) => { order.push("begin"); return realBegin(id); };
    const historyPane = { messages: clone(pane), presents: [], base: 0, presentBase: 0 };
    const knobs = { live };
    const view = {
      loads, displayLoad: null, historyPane,
      thread: { querySelector: () => (knobs.live ? {} : null) },
      adopt(data) { order.push("adopt"); historyPane.messages = data.messages; historyPane.presents = data.presents ?? []; historyPane.base = data.base ?? 0; },
      async paint(data, opts) {
        order.push("paint");
        paints.push(opts);
        const restored = await loads.replay(opts.load, data, { current: () => true, apply: (ev) => { applied.push(ev.streamSeq); view.onApply?.(ev, opts); } });
        return restored ? { atEnd: true } : null;
      },
      finish() { order.push("finish"); },
    };
    const owner = {};
    const mc = { view, id: "child-1", ready: true, owner };
    const ctx = {
      modalChild: mc, bg: { view: owner }, $: () => ({ open: true }),
      settleModalChild: () => order.push("settle"), modalToc: { refresh: () => order.push("toc") },
      syncRequest, joinReply, WINDOW_MESSAGES, WINDOW_BYTES,
      cmd: async (command, args, opts = {}) => {
        order.push("cmd");
        calls.push({ command, args: clone(args), bulk: opts.bulk === true });
        if (gate) await gate.wait();
        return serve({ messages: clone(remote), presents: [], completedAt: 1, draft: null, streamCursor: 5, stream: { events: [{ type: "text.delta", sessionId: "child-1", streamSeq: 4 }, { type: "text.delta", sessionId: "child-1", streamSeq: 5 }] } }, args);
      },
    };
    vm.runInNewContext(`${loadSource}\n${syncSource}\nglobalThis.sync = syncModalChildHistory;`, ctx);
    return { ctx, mc, view, calls, order, applied, paints, loads, knobs };
  }
  const settle = (ms = 0) => new Promise(r => setTimeout(r, ms));
  /** 手動で開ける門。wait() は open() まで待つ */
  const makeGate = () => { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open }; };

  // ---------------------------------------------------------------- 1. 差分の読み直し
  {
    const remote = conv(42);
    const r = build({ remote });
    await r.ctx.sync(r.view);
    const a = r.calls[0]?.args;
    t.ok("差分: 今持っている窓の続きだけを頼む（from は持っている件数 − TAIL・check・窓の頼み・live）",
      r.calls.length === 1 && r.calls[0].command === "loadSession" && a.from === 38 && typeof a.check === "number" && a.lazy === true && a.tail === WINDOW_MESSAGES && a.live === true && a.sessionId === "child-1",
      JSON.stringify(a));
    t.ok("差分: 大きい返事は bulk で頼む（主の静かな読み直しと同じ）", r.calls[0].bulk === true);
    t.ok("差分: つないだ結果は全量と同じ発言になり、画面（adopt → paint）に渡る", same(r.view.historyPane.messages, remote));
    const p = r.paints[0];
    t.ok("描き方: 静かな読み直し（quiet）・描き替え（plan なし）・取り置きの読み込みを渡す", p.quiet === true && p.plan === undefined && p.id === "child-1" && p.load && r.loads.isPending(p.load) === false);
    t.ok("順序: 読み込みを始める（begin）→ 頼む（cmd）→ 持ち物にする（adopt）→ 描く（paint）→ 仕上げ（finish・settle・目次）",
      r.order.join() === "begin,cmd,adopt,paint,finish,settle,toc", r.order.join());
  }
  {
    // 手元の先頭がサーバーと違う: サーバーは全量を返し、全量に置き換える（差分の失敗の戻り先は主と同じ）
    const remote = conv(42);
    const pane = clone(remote.slice(0, 40)); pane[5] = { ...pane[5], text: "手元だけ違う" };
    const r = build({ remote, pane });
    await r.ctx.sync(r.view);
    t.ok("差分: 手元の履歴がサーバーと違えば全量を受けて置き換える（ライブで描いた仮の発言が混じった場合も同じ）", same(r.view.historyPane.messages, remote) && r.calls.length === 1);
  }
  {
    // 差分の件数が合わない: 全量を頼み直す（2 回目は頼みなし）
    const remote = conv(42);
    const r = build({ remote, serve: (body, args) => { const x = serveFrom(body, args); return "from" in x ? { ...x, total: x.total + 5 } : x; } });
    await r.ctx.sync(r.view);
    t.ok("差分: 件数が食い違えば、頼み直す（2 回目は from なし・bulk のまま）", r.calls.length === 2 && !("from" in r.calls[1].args) && r.calls[1].bulk === true && same(r.view.historyPane.messages, remote));
  }
  {
    // 持っている窓が空: 頼みは全量（from なし）
    const r = build({ remote: conv(10), pane: [] });
    await r.ctx.sync(r.view);
    t.ok("持っている窓が空なら、続きではなく窓を頼む", r.calls.length === 1 && !("from" in r.calls[0].args) && r.calls[0].args.lazy === true && r.calls[0].bulk === true);
  }
  {
    // 読み直す理由が無いとき（ライブで描いた行が無い）は頼まない。force は理由が無くても読む
    const quiet = build({ remote: conv(42), live: false });
    await quiet.ctx.sync(quiet.view);
    t.ok("ライブで描いた行も仮の発言も無ければ読み直さない", quiet.calls.length === 0 && quiet.order.length === 0);
    const forced = build({ remote: conv(42), live: false });
    await forced.ctx.sync(forced.view, { force: true });
    t.ok("force: ライブで描いた行が無くても読み直す（手前の読み足しがつながらなかったとき）", forced.calls.length === 1 && forced.calls[0].args.from === 38);
  }

  // ---------------------------------------------------------------- 2. bulk と出来事の順序
  {
    // 読み込みを頼んだ後、返事（bulk）が遅れて届く。その間に届いた出来事は取り置かれ、スナップショットの後に streamSeq の順で 1 回ずつ流される
    const gate = makeGate();
    const r = build({ remote: conv(42), gate });
    const running = r.ctx.sync(r.view);
    await settle();
    const ev = (n) => ({ type: "text.delta", sessionId: "child-1", streamSeq: n, text: String(n) });
    const deferred = [ev(5), ev(6), ev(7)].map(e => r.loads.capture(e, "child-1"));
    t.ok("返事が届く前の出来事は取り置かれる（routeModalChild の capture が true を返し、実例は描かない）", deferred.every(x => x === true) && r.applied.length === 0);
    gate.open();
    await running;
    t.ok("返事が遅れても、出来事は 1 回ずつ streamSeq の順に流れる（スナップショットの 4・5 の後に 6・7。取り置きの 5 は重ならない）", r.applied.join() === "4,5,6,7", r.applied.join());
  }
  {
    // 流し直しの最中に届いた出来事も、取り置かれて同じ流しの中で順に描かれる
    const r = build({ remote: conv(42) });
    r.view.onApply = (ev, opts) => { if (ev.streamSeq === 4) r.loads.capture({ type: "text.delta", sessionId: "child-1", streamSeq: 6 }, "child-1"); };
    await r.ctx.sync(r.view);
    t.ok("流し直しの間に届いた出来事も、取り置かれて同じ流しの最後に描かれる", r.applied.join() === "4,5,6", r.applied.join());
  }
  {
    // ターンが終わる出来事が流し直しの間にあった（displayLoad.syncHistory）: もう 1 回読む（主の loadAndPaint の後と同じ）
    const r = build({ remote: conv(42) });
    let first = true;
    r.view.onApply = (ev, opts) => { if (first) { first = false; opts.load.syncHistory = true; } };
    await r.ctx.sync(r.view);
    await settle();
    t.ok("流し直しの間にターンが終わったら、読み直しをもう 1 回する（2 回目は止まる）", r.calls.length === 2 && r.order.filter(x => x === "begin").length === 2);
    t.ok("2 回目は 1 回目の結果の続きだけを頼む（差分）", r.calls[1].args.from === 40 && r.calls[1].bulk === true, JSON.stringify(r.calls[1]?.args));
  }

  // ---------------------------------------------------------------- 重なって呼ばれたとき・閉じたとき
  {
    const gate = makeGate();
    const r = build({ remote: conv(42), gate });
    const first = r.ctx.sync(r.view);
    await settle();
    void r.ctx.sync(r.view);   // 読んでいる間の呼び出し: 重ねず、あとで 1 回だけやり直す
    void r.ctx.sync(r.view);
    t.ok("読んでいる間に呼ばれても重ねない（頼みは 1 つ）", r.calls.length === 1 && r.mc.syncAgain === true);
    gate.open();
    await first;
    await settle();
    t.ok("終わったあと、やり直しは 1 回だけ", r.calls.length === 2);
  }
  {
    // 強制の読み直しが、読んでいる最中に呼ばれた: ライブの行が無くなっていても、終わったあとにもう 1 回読む
    const gate = makeGate();
    const r = build({ remote: conv(42), gate });
    const first = r.ctx.sync(r.view);
    await settle();
    r.knobs.live = false;                  // ライブの行は 1 回目で履歴に変わる
    void r.ctx.sync(r.view, { force: true });
    gate.open();
    await first;
    await settle();
    t.ok("強制の読み直しは、重なっても落とさず、ライブの行が無くなっていても 1 回読む", r.calls.length === 2);
    void r.ctx.sync(r.view);
    await settle();
    t.ok("強制の印は 1 回で下りる（次の普通の呼び出しは、ライブの行が無ければ読まない）", r.calls.length === 2);
  }
  {
    // 実例を閉じた（modalChild が替わった）あと返事が届いても、描かない
    const gate = makeGate();
    const r = build({ remote: conv(42), gate });
    const running = r.ctx.sync(r.view);
    await settle();
    r.ctx.modalChild = null;
    gate.open();
    await running;
    t.ok("閉じたあとに届いた返事は描かない（adopt も paint もしない）", !r.order.includes("adopt") && !r.order.includes("paint"));
  }

  // ---------------------------------------------------------------- 配線（ソースの形）
  const clientCut = (name) => cutFunction(client, name, { withAsync: true });
  t.ok("配線: syncModalChildHistory は持っている窓を prev に渡し、bulk で頼み、描き替え（quiet・plan なし）にする",
    /loadHistory\(\{ sessionId: id, live: true \}, prev, \{ window: true, bulk: true \}\)/.test(syncSource) && /view\.paint\(data, \{ id, load, quiet: true \}\)/.test(syncSource) && !/\bplan\b/.test(syncSource));
  t.ok("配線: 読み込み（begin）を頼む（loadHistory）より前に始める（取り置きが返事より先に立つ）", syncSource.indexOf("view.loads.begin(id)") > 0 && syncSource.indexOf("view.loads.begin(id)") < syncSource.indexOf("await loadHistory("));
  t.ok("配線: syncModalChildHistory は主の syncHistory の呼び出し側（hooks.syncHistory）と select(reload) の両方から呼ばれる",
    /syncHistory: \(\) => \{ void syncModalChildHistory\(view\); \}/.test(client) && /select: \(_id, opts\) => \(opts\?\.reload \? syncModalChildHistory\(view, \{ force: true \}\) : undefined\)/.test(client));
  const openSource = clientCut("openLiveChild");
  t.ok("配線: 子の実例を開く読み込み（openLiveChild）も bulk（主の openConversation と同じ）", /loadHistory\(\{ sessionId: id, live: true \}, null, \{ window: true, bulk: true \}\)/.test(openSource));
  t.ok("配線: 取り置き（begin）は openLiveChild でも読み込みより前", openSource.indexOf("view.loads.begin(id)") > 0 && openSource.indexOf("view.loads.begin(id)") < openSource.indexOf("loadHistory("));
  t.ok("配線: 既存の bulk の配線は変えない（syncHistory 本体・全量の読み込みに bulk は付かない）", !/bulk/.test(clientCut("syncHistory")));

  // ---------------------------------------------------------------- 3. 画面外の行を省く
  const css = fs.readFileSync(new URL("../../web/style.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const rule = /(^|\n)([^\n{]*\.mw:not\(\.activity\):not\(\.height-ready\)[^\n{]*)\{([^}]*)\}/.exec(css);
  t.ok("style.css: 実寸が確定していない行の content-visibility:auto の規則がある", Boolean(rule) && /content-visibility:\s*auto/.test(rule[3]) && /contain-intrinsic-size:\s*auto 160px/.test(rule[3]));
  t.ok("style.css: 主の #thread と、モーダルの子の実例の筋（.thread.live-child）に効く", Boolean(rule) && /#thread/.test(rule[2]) && /\.thread\.live-child/.test(rule[2]), rule?.[2]);
  t.ok("style.css: 読むだけの筋（.bg-thread 単独）には効かない（実寸を確定する担当が無く、仮の高さのまま残るため）", Boolean(rule) && !/\.bg-thread/.test(rule[2]));
  t.ok("配線: 実例の筋に live-child を付ける（openLiveChild）。読むだけの筋（readonlyThread）には付けない",
    /el\('div', 'thread bg-thread live-child'\)/.test(openSource) && !/live-child/.test(cutFunction(client, "readonlyThread")));
  const heights = readWeb("history-heights.mjs");
  t.ok("history-heights.mjs: 実寸の確定は筋の中の行（:scope > .mw）を数える（主と実例で同じ部品）", /UNSETTLED = ":scope > \.mw:not\(\.activity\):not\(\.height-ready\)"/.test(heights) && /live-child/.test(heights));
  const pane = readHistoryPane();
  t.ok("配線: 履歴の面（createHistoryPane）は主にも子にも 1 つずつあり、表示のたびに実寸の確定を始める（finish → prepareHistoryHeights）",
    /historyPane\.prepareHistoryHeights\(\)/.test(readWeb("conversation-view.mjs")) && /createHeightSettler\(/.test(pane));

  // ---------------------------------------------------------------- 4. 目次
  const tocDecl = /const modalToc = createConversationToc\(\{[\s\S]*?\}\);\n/.exec(client)?.[0] ?? "";
  t.ok("配線: モーダルの目次も、開いたら窓の手前を全部読む（主の toc の onOpen: loadAllOlder と同じ）", /onOpen: \(\) => modalChild\?\.view\.historyPane\.loadAllOlder\(\)/.test(tocDecl), tocDecl.slice(0, 80));
  t.ok("配線: 主の目次の onOpen は変えない", /const toc = createConversationToc\(\{[^\n]*onOpen: loadAllOlder \}\);/.test(client));

  // 履歴の面の loadOlder / loadAllOlder（vm）: 閉じた実例は読み足さない・つながらないときは窓を読み直す
  const olderSource = `${cutFunction(pane, "loadOlder")}\n${cutFunction(pane, "loadAllOlder", { withAsync: true })}`;
  t.ok("history-pane.mjs に loadOlder と loadAllOlder がある", olderSource.includes("function loadOlder(") && olderSource.includes("function loadAllOlder("));
  const older = ({ total = 200, join = () => true } = {}) => {
    const log = { cmd: 0, reload: 0, painted: 0 };
    const ctx = {
      WINDOW_MESSAGES: 50, WINDOW_BYTES: 262144, anchorSig: () => 1,
      flushBackfill: () => {}, currentSession: () => "child-1", isLoadingSession: () => false, showOlder: () => {}, hideOlder: () => {},
      cmd: async () => { log.cmd++; await settle(20); return {}; },
      joinOlder: () => (join(log) ? { messages: [{}], presents: [], base: 0, presentBase: 0 } : false),
      paintOlder: () => { log.painted++; ctx.__set(Math.max(0, ctx.__base() - 50)); },
      select: async (id, opts) => { if (opts?.reload) log.reload++; },
    };
    vm.runInNewContext(`let olderBusy = null, base = ${total}, messages = [{}], presents = [], presentBase = 0, olderFail = null, disposed = false;
      globalThis.__set = (v) => { base = v; }; globalThis.__base = () => base; globalThis.__dispose = () => { disposed = true; };
      ${olderSource}\nglobalThis.loadOlder = loadOlder; globalThis.loadAllOlder = loadAllOlder;`, ctx);
    return { ctx, log };
  };
  {
    const o = older({ total: 200 });
    const done = await o.ctx.loadAllOlder();
    t.ok("loadAllOlder: 手前が無くなるまで 1 まとまりずつ読み足す（200 件の手前 → 4 回）", done === true && o.log.cmd === 4 && o.log.painted === 4 && o.ctx.__base() === 0);
  }
  {
    const o = older({ total: 200 });
    const running = o.ctx.loadAllOlder();
    await settle(5);
    o.ctx.__dispose();   // 目次を開いたまま実例を閉じた
    const done = await running;
    t.ok("閉じた実例は、読み足しの途中でも次の読み足しを頼まない（頼んだ 1 回の返事も描かない）", done === false && o.log.cmd === 1 && o.log.painted === 0, JSON.stringify(o.log));
    t.ok("閉じたあとの loadOlder は何もしない", (await o.ctx.loadOlder()) === false && o.log.cmd === 1);
  }
  {
    const o = older({ total: 200, join: () => false });
    const done = await o.ctx.loadAllOlder();
    t.ok("手前がつながらなければ、窓を読み直す（select の reload。子では syncModalChildHistory の強制の読み直し）", done === false && o.log.reload === 1 && o.log.painted === 0);
  }
}
