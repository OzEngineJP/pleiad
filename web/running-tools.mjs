// The same tool row moves between its original history position and the final activity node (ADR 0267).
import { el } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { runMark } from "./arc.mjs";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const move = (node, mutate) => {
  const before = node.isConnected ? node.getBoundingClientRect() : null;
  const focus = node.contains(document.activeElement) ? document.activeElement : null;
  mutate();
  focus?.focus({ preventScroll: true });
  if (!before || reduced() || !node.isConnected) return;
  const after = node.getBoundingClientRect();
  node.animate([
    { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)`, opacity: .65 },
    { transform: "none", opacity: 1 },
  ], { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" });
};

export class RunningTools {
  constructor(changed, { before, after } = {}) {
    this.changed = changed;
    this.before = before;
    this.after = after;
    this.cards = new Set();
    this.el = el("div", "running-tools");
    this.rows = el("div", "running-tool-rows");
    this.more = el("button", "running-tools-more");
    this.more.type = "button";
    this.more.onclick = () => {
      const stick = this.before?.();
      this.expanded = !this.expanded; this.layout();
      this.after?.(stick);
    };
    this.status = el("span", "visually-hidden");
    this.status.setAttribute("role", "status");
    this.el.append(this.rows, this.more, this.status);
  }
  get size() { return this.cards.size; }
  add(card) {
    if (this.cards.has(card)) return;
    const stick = this.before?.();
    card.resumeToolRow = () => this.add(card);
    card.restoreToolRow = () => this.remove(card);
    card.toolHome = el("span", "tool-home");
    card.before(card.toolHome);
    this.cards.add(card);
    const label = card.querySelector(".tc-label");
    card.historyVerb = label?.textContent;
    if (label) label.textContent = card.runningVerb ?? t("activity.tool.run");
    card.classList.add("tc-at-end");
    const mark = el("span", "running-tool-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.append(runMark());
    card.querySelector(".tc-line")?.prepend(mark);
    move(card, () => this.rows.append(card));
    card.toolBundle?.paint();
    this.layout();
    this.changed();
    this.after?.(stick);
  }
  remove(card) {
    if (!this.cards.delete(card)) return;
    const stick = this.before?.();
    const focused = card.contains(document.activeElement);
    const open = card.querySelector(".tc-details")?.open;
    move(card, () => {
      card.toolHome.replaceWith(card);
      card.toolHome = null;
      card.classList.remove("tc-at-end");
      card.querySelector(".running-tool-mark")?.remove();
      card.hidden = false;
      const label = card.querySelector(".tc-label");
      if (label) label.textContent = card.historyVerb;
      card.toolBundle?.paint();
      if (open || focused) card.toolBundle?.reveal(card);
    });
    if (!this.size) this.expanded = false;
    this.layout();
    this.changed();
    this.after?.(stick);
  }
  layout() {
    [...this.cards].forEach((card, i) => { card.hidden = !this.expanded && i >= 3; });
    const n = Math.max(0, this.size - 3);
    this.more.hidden = !n;
    this.more.textContent = this.expanded ? t("activity.toolsLess") : t("activity.toolsMore", { count: n });
    this.more.setAttribute("aria-expanded", String(Boolean(this.expanded)));
    this.status.textContent = [...this.cards].map(card => `${card.querySelector(".tc-label")?.textContent ?? ""} ${card.querySelector(".tc-main")?.textContent ?? ""}`).join("; ");
  }
  clear() {
    for (const card of [...this.cards]) {
      this.remove(card);
      card.classList.remove("tc-running");
      const res = card.querySelector(".tc-res");
      if (res) { res.paint = null; res.replaceChildren(); }
      card.toolBundle?.paint();
    }
  }
}
