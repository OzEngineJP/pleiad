// 作業のダイアログ（モーダル）の子の会話の実例への、出来事の振り分け（web/client.mjs の routeModalChild・MODAL_CHILD_EVENTS。ADR 0319 段 6-6）。
//   - 主が同じ会話を開いているときは主が描く（振り分けは false を返し、実例は何も描かない）
//   - 別の会話の出来事は、実例に描かない（false を返し、主の経路へ回る）
//   - 実例を閉じたあと（modalChild が null）は描かない・呼んでも落ちない
//   - 描く種類の出来事だけ流す。読み込みの間の出来事は取り置く（描かない）。承認は承認の置き場へ、追加の指示は一覧の読み直しへ
// client.mjs の最上位の関数を切り出して vm で走らせる（本物の画面の経路は tests/browser/child-modal-main-independence.mjs が見る）。
import vm from "node:vm";
import { readWeb, cutFunction } from "../lib/cut-source.mjs";

export const name = "modal-child-routing";
export const title = "モーダルの子の出来事の振り分け: 主が同じ会話なら主・別の会話は描かない・閉じたあとは描かない・読み込み中は取り置く";

export default async function (t) {
  const client = readWeb("client.mjs");
  const setHead = client.indexOf("const MODAL_CHILD_EVENTS");
  const setSource = client.slice(setHead, client.indexOf(");", setHead) + 2);
  const routeSource = cutFunction(client, "routeModalChild");
  t.ok("client.mjs に MODAL_CHILD_EVENTS と routeModalChild がある", setHead > 0 && routeSource.length > 0);
  if (!setSource || !routeSource) return;

  /** 呼び出しの記録つきの場。mc を替えて routeModalChild を呼ぶ */
  function build({ mc, current }) {
    const calls = [];
    const ctx = {
      modalChild: mc, state: { current }, calls,
      modalChildPermission: (ev) => calls.push(`permission:${ev.id}`),
      refreshModalInstructions: () => calls.push("instructions"),
    };
    vm.runInNewContext(`${setSource}\n${routeSource}\nglobalThis.route = routeModalChild; globalThis.kinds = MODAL_CHILD_EVENTS;`, ctx);
    return ctx;
  }
  /** 実例の作りもの: apply した出来事・取り置いた出来事を記録する */
  const makeMc = ({ id = "child-1", capture = false } = {}) => {
    const applied = [], captured = [];
    const view = {
      isInstructionEvent: (ev) => ev.type === "taskInstruction",
      loads: { capture: (ev) => { if (capture) captured.push(ev.type); return capture; } },
      apply: (ev, replay) => applied.push(`${ev.type}:${replay}`),
    };
    return { id, view, applied, captured };
  };

  // ---- 自分の会話の出来事は描く
  {
    const mc = makeMc();
    const c = build({ mc, current: "root-1" });
    const handled = c.route({ type: "text.delta", sessionId: "child-1", text: "あ" });
    t.ok("自分の会話の text.delta: 実例が描く（replay=false）・処理済み", handled === true && mc.applied.join() === "text.delta:false");
    t.ok("描く種類: 本文・ツール・稼働・ターンの終わりを含む", ["text.delta", "tool.start", "tool.result", "activity", "turnEnd", "userMessage"].every(k => c.kinds.has(k)));
  }
  // ---- 主が同じ会話を開いている: 主が描く
  {
    const mc = makeMc();
    const c = build({ mc, current: "child-1" });
    t.ok("主が同じ会話を開いている: false（主が描く）・実例は何も描かない", c.route({ type: "text.delta", sessionId: "child-1" }) === false && mc.applied.length === 0);
    t.ok("主が同じ会話を開いている: 承認も実例へ流さない", c.route({ type: "permission", id: "p1", sessionId: "child-1" }) === false && c.calls.length === 0);
    t.ok("主が同じ会話を開いている: 追加の指示の読み直しもしない", c.route({ type: "taskInstruction", sessionId: "child-1" }) === false && c.calls.length === 0);
  }
  // ---- 別の会話の出来事は描かない
  {
    const mc = makeMc();
    const c = build({ mc, current: "root-1" });
    for (const ev of [{ type: "text.delta", sessionId: "root-1" }, { type: "tool.start", sessionId: "child-2" }, { type: "turnEnd", sessionId: "child-2" }, { type: "permission", id: "p9", sessionId: "child-2" }, { type: "taskInstruction", sessionId: "child-2" }]) {
      t.ok(`別の会話（${ev.sessionId}）の ${ev.type}: 描かない・false`, c.route(ev) === false);
    }
    t.ok("別の会話の出来事は、実例にも承認の置き場にも指示の読み直しにも届かない", mc.applied.length === 0 && mc.captured.length === 0 && c.calls.length === 0);
  }
  // ---- 閉じたあと（modalChild が null）は描かない
  {
    const c = build({ mc: null, current: "root-1" });
    let threw = null, handled = null;
    try { handled = c.route({ type: "text.delta", sessionId: "child-1" }); } catch (e) { threw = e; }
    t.ok("実例を閉じたあと: 落ちず、false（描かない）", threw === null && handled === false, String(threw));
    // 閉じる途中で持ち主が替わった（別の子の実例になった）あとも、前の会話の出来事は描かない
    const next = makeMc({ id: "child-2" });
    const c2 = build({ mc: next, current: "root-1" });
    t.ok("別の子の実例に替わったあと: 前の子の出来事は描かない", c2.route({ type: "text.delta", sessionId: "child-1" }) === false && next.applied.length === 0);
  }
  // ---- 振り分けの中身
  {
    const mc = makeMc();
    const c = build({ mc, current: "root-1" });
    t.ok("承認: 承認の置き場へ（処理済み）", c.route({ type: "permission", id: "p1", sessionId: "child-1" }) === true && c.calls.join() === "permission:p1" && mc.applied.length === 0);
    c.calls.length = 0;
    t.ok("追加の指示の出来事: 一覧の読み直しへ（処理済み・本文へは描かない）", c.route({ type: "taskInstruction", sessionId: "child-1" }) === true && c.calls.join() === "instructions" && mc.applied.length === 0);
    t.ok("描かない種類の出来事（prefs など）: false（主の経路へ）", c.route({ type: "prefs", sessionId: "child-1" }) === false && mc.applied.length === 0);
  }
  // ---- 読み込みの間は取り置く
  {
    const mc = makeMc({ capture: true });
    const c = build({ mc, current: "root-1" });
    t.ok("読み込みの間の出来事: 取り置いて描かない（処理済み）", c.route({ type: "tool.start", sessionId: "child-1" }) === true && mc.captured.join() === "tool.start" && mc.applied.length === 0);
  }
}
