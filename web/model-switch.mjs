// 安全装置によるモデルの切り替えの行（承認済み 2026-11-13。docs/design-system.md「モデルの切り替え」）。
// 会話の中の出来事の行（.m.sys）で、会話の本文のどこにも置かれない切り替えの通知を、切り替わった所に弱い字の 1 行で出す。
// 開くと Claude Code の通知の原文が読める。ライブ（conversation-view.mjs）と履歴（client.mjs の systemHistoryNode）が同じ形を使う。
import { el } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { plainTextHtml } from "./render.mjs";

const FROM = "\u{E000}from\u{E001}";
const TO = "\u{E000}to\u{E001}";

/** 訳文の {from}・{to} の位置に、モデル名を太字で置く（訳文と名前を HTML で混ぜない） */
function withNames(parent, text, { from, to }) {
  for (const part of text.split(/(\u{E000}(?:from|to)\u{E001})/u)) {
    if (part === FROM) parent.append(el("b", null, from));
    else if (part === TO) parent.append(el("b", null, to));
    else if (part) parent.append(part);
  }
  return parent;
}

/**
 * @param m { phase: 'switched'|'stopped', from, to?, notice?, count?, at? }
 *   count は「この会話で何回目」（2 回目以降は短い 1 行にして、行動のボタンは開いた中へ入れる）
 * @param opts.name モデルの id -> 画面の名前
 * @param opts.onUse 「次のターンから X を使う」。(true) で使う、(false) で取り消し。入力欄のモデルを人が替えたのと同じ扱いにする
 * @param opts.onRetry 「モデルを選んで送り直す」（切り替え先が無く止まったとき）
 * @param opts.at 時刻の字
 */
export function modelSwitchNode(m, { name = (id) => id, onUse = null, onRetry = null, at = "" } = {}) {
  const from = name(m.from) || m.from || "", to = name(m.to) || m.to || "";
  if (m.phase === "stopped") {
    const node = el("div", "m sys turn-failed model-switch");
    const line = el("span");
    const head = el("b", null, t("chat.sys.modelSwitch.stoppedHead"));
    line.append(head, " ");
    withNames(line, t("chat.sys.modelSwitch.stopped", { from: FROM }), { from, to });
    node.append(line);
    if (onRetry) {
      const acts = el("div", "sw-acts");
      const retry = el("button", "btn btn-primary", t("chat.sys.modelSwitch.retry"));
      retry.type = "button";
      retry.dataset.act = "retry";
      retry.addEventListener("click", () => onRetry());
      acts.append(retry);
      node.append(acts);
    }
    return node;
  }

  const later = Number(m.count) > 1;
  const node = el("div", "m sys model-switch");
  const d = el("details", "sys-fold");
  const s = el("summary");
  const label = el("span");
  withNames(label, later
    ? t("chat.sys.modelSwitch.later", { to: TO, n: m.count })
    : t("chat.sys.modelSwitch.first", { from: FROM, to: TO }), { from, to });
  s.append(label);
  if (at) s.append(el("span", "t", at));
  const body = el("div", "sys-body");
  if (m.notice) body.innerHTML = plainTextHtml(m.notice, { paths: false });
  d.append(s, body);
  node.append(d);
  if (onUse && m.to) {
    const acts = el("div", "sw-acts" + (later ? " in-fold" : ""));
    const use = el("button", "btn lnk", t("chat.sys.modelSwitch.use", { to }));
    use.type = "button";
    use.dataset.act = "use";
    const done = el("span", "done", t("chat.sys.modelSwitch.using", { to }));
    const undo = el("button", "btn lnk", t("chat.sys.modelSwitch.undo"));
    undo.type = "button";
    undo.dataset.act = "undo";
    done.hidden = undo.hidden = true;
    const show = (on) => { use.hidden = on; done.hidden = undo.hidden = !on; };
    use.addEventListener("click", () => { onUse(true); show(true); });
    undo.addEventListener("click", () => { onUse(false); show(false); });
    acts.append(use, done, undo);
    // 2 回目以降は行を開いた中に置く（短い 1 行を保つ）
    (later ? d : node).append(acts);
  }
  return node;
}
