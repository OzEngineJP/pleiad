import fs from "node:fs/promises";
import vm from "node:vm";
import { cutFunction, readClientAndLiveTurn, liveTurnStateDecl, bindLiveState } from "../lib/cut-source.mjs";
import { el } from "../../web/dom.mjs";
import { renderAssistantMarkdown } from "../../web/render.mjs";

export const name = "stream-prefix";
export const title = "閉じた発言の後もストリーミング本文の先頭を保持する";

export default async function (t) {
  // 実際のクライアント関数を実行し、状態遷移による先頭断片の消失を検出する。
  const source = readClientAndLiveTurn();   // 進行中のターンは web/live-turn.mjs（ADR 0319 段 6-3）
  const functions = ["appendText", "flushStream", "cancelStream", "endStream", "openTurnEl", "closeTurnEl"].map(name => {
    const body = cutFunction(source, name);
    if (!body) throw new Error(`Missing client function: ${name}`);
    return body;
  }).join("\n");

  for (const closed of [false, true]) {
    const bodies = [];
    const state = {};   // 状態の項目は vm の宣言へつなぐ（bindLiveState）
    const context = vm.createContext({
      state, el, renderAssistantMarkdown,
      closeBundle() {}, closeThink() {}, activity: { show() {} }, atBottom: () => false,
      ACTIVITY_LABEL: {},   // 稼働表示の文言（client.mjs）。このテストは見ない
      stopping: () => false,
      // 本文の描き直しは 1 コマに 1 回（client.mjs の flushStream）。コマは待たず、下で同期に描かせる
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, streamFrame: 0, streamTarget: null, relayout() {}, log: {},
      ensureTurnEl: () => ({ append: node => bodies.push(node) }),
    });
    bindLiveState(state, context);
    vm.runInContext(`${liveTurnStateDecl()}\n${functions}`, context);
    state.turnClosed = closed;
    context.chunk = "こんに";
    vm.runInContext("appendText(chunk)", context);
    context.chunk = "ちは！👋";
    vm.runInContext("appendText(chunk); flushStream()", context);
    t.ok(`先頭から全文を表示する（前の発言が閉じた状態: ${closed}）`,
      bodies.length === 1 && bodies[0]?.outerHTML.includes("こんにちは！👋")
      && state.streamEl.dataset.raw === "こんにちは！👋");

    // text.end と同じ状態から次の本文へ進む。前の本文を壊さず新しく作る。
    vm.runInContext("endStream()", context);
    state.turnClosed = true;
    context.chunk = "次の発言";
    vm.runInContext("appendText(chunk); flushStream()", context);
    t.ok("次の発言でも null を追加せず、前の全文を保持する",
      bodies.length === 2 && bodies.every(Boolean)
      && bodies[0].outerHTML.includes("こんにちは！👋")
      && bodies[1].outerHTML.includes("次の発言"));
  }
}
