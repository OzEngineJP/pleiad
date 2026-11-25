// 送った発言の表示（承認済み 2026-11-24、docs/design-system.md「送信の表示」）。
// 送った発言は押した瞬間に会話の中の吹き出しとして出て、下の 1 行（.outbox-status）に今の状態を 1 つだけ出す。
//   送信中（［取り消す］なし）／送信待ち（薄い面・会話の一番下・理由と［取り消す］）／保留・結果不明・送れなかった（［再送する］［取り消す］）
// ここでは、行の描き（web/outbox.mjs の paintUnsent）と、会話の本文の面（web/conversation-view.mjs）が送信待ちの一覧（outbox）をどう吹き出しにするかを確かめる。
// 画面の組み立て（押した瞬間の吹き出し・入力欄を空にする・新しい会話）は tests/unit/composer-new-session.mjs、ブラウザーでは tests/browser/messages.cjs。
import { createConversationView } from "../../web/conversation-view.mjs";
import { paintUnsent } from "../../web/outbox.mjs";
import { t as tr } from "../../web/i18n.mjs";
import { N } from "../lib/dom-stub.mjs";

export const name = "send-display";
export const title = "送った発言の表示: 吹き出しの下の 1 行（送信中・送信待ち・保留・結果不明・送れなかった）と、送信待ちの吹き出しの並び";

/** 複合の指定（.a.b・:not(.c)・[attr]）を読み、親から外れたら外れたと答える作りもの（web/conversation-view.mjs の並べ替えが使う） */
class Row extends N {
  constructor(tag, cls) { super(tag); if (cls) this.className = cls; }
  get isConnected() { let x = this; while (x.parent) x = x.parent; return x.root === true; }
  matches(sel) {
    const tokens = sel.trim().match(/:not\([^)]*\)|\.[\w-]+|\[[\w-]+\]|[a-z]+/gi) ?? [];
    return tokens.every(tok => {
      if (tok.startsWith(":not(")) return !this.matches(tok.slice(5, -1));
      if (tok.startsWith(".")) return this._classes().includes(tok.slice(1));
      if (tok.startsWith("[")) return tok.slice(1, -1) in this.attrs;
      return this.tagName === tok.toUpperCase();
    });
  }
  append(...n) { for (const c of n) if (c instanceof Row) c.remove(); super.append(...n); }
  before(...n) { for (const c of n) if (c instanceof Row) c.remove(); super.before(...n); }
  remove() { super.remove(); this.parent = null; }
}

function userMsg(text) {
  const m = new Row("div", "m user");
  const body = new Row("div", "body");
  body.textContent = text;
  m.append(body);
  return m;
}

function makeView(extra = {}) {
  const thread = new Row("div", "thread"); thread.root = true;
  const log = new Row("div", "log"), frame = new Row("div", "frame");
  const calls = [];
  const hooks = {
    userMsg, isBusy: () => false, isLoadingSession: () => false, currentSession: () => "s1", backendVocab: () => null,
    outbox: () => [], paintOutbox: () => { calls.push("paint"); }, markSentBy() {},
    messageAction: async (id, action) => { calls.push(`${action}:${id}`); },
    ...extra,
  };
  const view = createConversationView({ sessionId: null, log, thread, frame, role: "main", hooks });
  return { view, thread, calls };
}

const buttons = status => status.children.filter(c => c.tagName === "BUTTON");
const labels = status => buttons(status).map(b => b.textContent);
const order = thread => thread.children.map(w => w.dataset.messageId);
const statusOf = row => row.querySelector(".outbox-status");
const item = (id, status, extra = {}) => ({ id, status, args: { prompt: `本文 ${id}` }, at: "2026-11-24T00:00:00Z", ...extra });

export default async function (t) {
  // 本物の document の作りもの（dom-stub）に無い createTextNode を足す。文字列のまま append すれば文字の節になる
  const saved = { createElement: document.createElement, createTextNode: document.createTextNode };
  document.createElement = tag => new Row(tag);
  document.createTextNode = s => String(s);
  try {
    const [retry, cancel, edit] = [tr("outbox.retry"), tr("outbox.cancel"), tr("schedule.rowEdit")];
    t.ok("（前提）3 つの操作の語は互いに違う", new Set([retry, cancel, edit]).size === 3, `${retry}/${cancel}/${edit}`);

    // ---------------------------------------------------------------- 吹き出しの下の 1 行（paintUnsent）
    {
      const line = (kind, o) => { const s = new Row("div", "outbox-status"); paintUnsent(s, kind, o); return s; };
      const act = { retry: async () => {}, cancel: async () => {}, edit: async () => {} };

      const failed = line("failed", { error: "未接続", act });
      t.ok("送れなかった: 「✕ 送れませんでした · 理由」と［再送する］［取り消す］", failed.textContent.startsWith(tr("chat.delivery.failed")) && failed.textContent.includes(" · 未接続")
        && labels(failed).join() === [retry, cancel].join() && failed.classList.contains("outbox-status-failed"));
      t.ok("送れなかったの理由が空なら「 · 」を付けない", !line("failed", { act }).textContent.includes(" · "));
      const unknown = line("unknown", { act });
      t.ok("結果不明: 強い字の「送信結果を確認できません」と注意の一文、［再送する］［取り消す］", unknown.textContent.includes(tr("outbox.status.unknown")) && unknown.textContent.includes(tr("outbox.unknownHint"))
        && unknown.children[0].tagName === "B" && labels(unknown).join() === [retry, cancel].join());
      const paused = line("paused", { act });
      t.ok("保留: 「送信を保留中」と［再送する］［取り消す］", paused.textContent.includes(tr("outbox.status.paused")) && labels(paused).join() === [retry, cancel].join());

      const waits = [
        [{ reason: "turn" }, tr("outbox.waitTurn")], [{ reason: "turn", detail: "reserved" }, tr("outbox.waitReply")], [{ reason: "order" }, tr("outbox.waitOrder")],
        [{ reason: "preparing" }, tr("outbox.preparing")],
      ];
      for (const [waiting, text] of waits) {
        const s = line("queued", { waiting, act: { cancel: act.cancel } });
        t.ok(`送信待ち（${waiting.reason}${waiting.detail ? `・${waiting.detail}` : ""}）: 理由の文と［取り消す］だけ（再送は出さない）`, s.textContent.includes(text) && labels(s).join() === cancel);
      }
      t.ok("送信待ちで［編集］の動きがあれば［編集］［取り消す］の順（スレッド・子の入力欄）", labels(line("queued", { act })).join() === [edit, cancel].join());
      t.ok("待つ理由が無い送信待ち（受け付けたばかり）は「送信中」と読む", line("queued", { act: { cancel: act.cancel } }).textContent.includes(tr("chat.delivery.sending")));
      t.ok("動きを渡さなければボタンを出さない", buttons(line("failed", { error: "x" })).length === 0);

      // 押したら動きを呼ぶ。失敗したら行の最後に理由を出す。押している間は押せない
      let ran = 0;
      const ok = line("failed", { act: { retry: async () => { ran++; } } });
      await buttons(ok)[0].click();
      t.ok("［再送する］を押すと動きを呼ぶ。終われば押せる", ran === 1 && buttons(ok)[0].disabled === false);
      const bad = line("failed", { act: { retry: async () => { throw new Error("まだ未接続です"); } } });
      await buttons(bad)[0].click();
      t.ok("動きが失敗したら、行の最後に理由を出す", bad.children[bad.children.length - 1].textContent === "まだ未接続です" && bad.children[bad.children.length - 1].className === "hint err");
    }

    // ---------------------------------------------------------------- 送信中 → 渡った
    {
      const { view, thread } = makeView();
      const row = view.ensureMessageRow("m1", "こんにちは", "2026-11-24T00:00:00Z");
      view.markDelivery(row, "sending");
      view.clearDeliveryTimer(row);
      t.ok("送信中: 吹き出しの下に「送信中」だけ。［取り消す］は出さない", statusOf(row).textContent === tr("chat.delivery.sending") && buttons(statusOf(row)).length === 0 && statusOf(row).classList.contains("outbox-status-mark"));
      t.ok("送信中の吹き出しは普通の行（薄い面にせず、会話の一番下に固定もしない）", !row.classList.contains("notyet") && row.dataset.unsent === undefined && row.parent === thread);
      view.markDelivery(row, "sent");
      t.ok("渡ったら 1 行ごと消える", statusOf(row).textContent === "" && !statusOf(row).classList.contains("outbox-status-mark") && row.dataset.deliverySending === undefined);
      view.markDelivery(row, "sending"); view.clearDeliveryTimer(row);
      view.settleSending();
      t.ok("ターンが終わっても「送信中」のまま残った吹き出しは片付く（渡った合図が来なかったとき）", statusOf(row).textContent === "");
    }

    // ---------------------------------------------------------------- 送信待ち: 薄い面・会話の一番下・後から渡った発言はその手前
    {
      const { view, thread, calls } = makeView();
      const row = view.ensureMessageRow("q1", "あとで送る", "2026-11-24T00:00:00Z", null, null, true);
      view.paintUnsentRow(row, "queued", { waiting: { reason: "turn" }, act: { cancel: () => calls.push("act-cancel") } });
      t.ok("送信待ち: 一段薄い面（notyet）・印（unsent=queued）・理由の文・［取り消す］", row.classList.contains("notyet") && row.dataset.unsent === "queued"
        && statusOf(row).textContent.includes(tr("outbox.waitTurn")) && labels(statusOf(row)).join() === cancel);
      const later = view.ensureMessageRow("d1", "渡った発言", "2026-11-24T00:00:01Z");
      view.markDelivery(later, "sent");
      t.ok("あとから渡った発言は、送信待ちの吹き出しの手前に入る（送信待ちは会話の一番下のまま）", order(thread).join() === "d1,q1", order(thread).join());
      const second = view.ensureMessageRow("q2", "もう 1 つ", "2026-11-24T00:00:02Z", null, null, true);
      view.paintUnsentRow(second, "queued", { waiting: { reason: "order" }, act: { cancel: () => {} } });
      t.ok("送信待ちが複数あれば送った順に一番下へ並ぶ", order(thread).join() === "d1,q1,q2", order(thread).join());
      view.markDelivery(row, "sent");
      t.ok("渡ったら薄い面をやめ、渡った位置（送信待ちの手前）へ移り、行は消える", !row.classList.contains("notyet") && row.dataset.unsent === undefined && order(thread).join() === "d1,q1,q2"
        && statusOf(row).textContent === "");
      await buttons(statusOf(second))[0].click();
      t.ok("［取り消す］を押すと動きを呼び、吹き出しを会話から下げる", order(thread).join() === "d1,q1" && !second.isConnected);
    }

    // ---------------------------------------------------------------- 送信待ちの一覧（outbox）から吹き出しを組む
    {
      const { view, thread, calls } = makeView();
      view.syncOutboxRows([
        item("a", "queued", { waiting: { reason: "turn" } }),
        item("b", "paused"),
        item("c", "unknown"),
        item("d", "failed", { error: "接続が切れました" }),
        item("e", "queued"),
      ]);
      const rowOf = id => thread.children.find(w => w.dataset.messageId === id);
      t.ok("送信待ち: 薄い面・理由の文・［取り消す］（吹き出しの本文は送った文）", rowOf("a").classList.contains("notyet") && statusOf(rowOf("a")).textContent.includes(tr("outbox.waitTurn"))
        && labels(statusOf(rowOf("a"))).join() === cancel && rowOf("a").querySelector(".body").textContent === "本文 a");
      t.ok("保留: 薄い面・［再送する］［取り消す］", rowOf("b").classList.contains("notyet") && statusOf(rowOf("b")).textContent.includes(tr("outbox.status.paused")) && labels(statusOf(rowOf("b"))).join() === [retry, cancel].join());
      t.ok("結果不明: 薄い面にはしない・「送信結果を確認できません」・［再送する］［取り消す］", !rowOf("c").classList.contains("notyet") && rowOf("c").dataset.unsent === "unknown"
        && statusOf(rowOf("c")).textContent.includes(tr("outbox.status.unknown")) && labels(statusOf(rowOf("c"))).join() === [retry, cancel].join());
      t.ok("送れなかった（サーバーが失敗にした）: 本文は吹き出しに残り、「✕ 送れませんでした · 理由」・［再送する］［取り消す］",
        rowOf("d").dataset.unsent === "failed" && statusOf(rowOf("d")).textContent.includes(` · 接続が切れました`) && labels(statusOf(rowOf("d"))).join() === [retry, cancel].join() && rowOf("d").querySelector(".body").textContent === "本文 d");
      t.ok("受け付けたばかり（待つ理由なし）は「送信中」の吹き出し（薄い面にせず・ボタンなし）", statusOf(rowOf("e")).textContent === tr("chat.delivery.sending") && !rowOf("e").classList.contains("notyet") && buttons(statusOf(rowOf("e"))).length === 0);
      t.ok("送信待ちと保留は、渡ったものより下（会話の一番下）に並ぶ", order(thread).slice(-2).join() === "a,b" && order(thread).slice(0, 3).join() === "c,d,e", order(thread).join());
      t.ok("一覧を反映したあと、入力欄まわりを描き直す（hooks.paintOutbox）", calls.includes("paint"));

      // 渡った・取り消した
      view.syncOutboxRows([item("a", "sending")]);
      t.ok("渡し始めた（sending）: 薄い面をやめて「送信中」へ戻る", !rowOf("a").classList.contains("notyet") && statusOf(rowOf("a")).textContent === tr("chat.delivery.sending"));
      view.syncOutboxRows([item("b", "cancelled")]);
      t.ok("取り消した（cancelled）: 吹き出しを会話から下げる", rowOf("b") === undefined);

      // 押したときの動き
      await buttons(statusOf(rowOf("c")))[0].click();
      await buttons(statusOf(rowOf("c")))[1].click();
      t.ok("［再送する］［取り消す］は messageAction に流れる。［取り消す］のあと吹き出しは下がる", calls.includes("retry:c") && calls.includes("cancel:c") && rowOf("c") === undefined, calls.join());
    }

    // ---------------------------------------------------------------- 主と子の違い
    {
      // 主: AI 側の失敗の行は今の描き（markFailedMessage）に任せる。子: 理由と［再送する］［取り消す］だけ
      const seen = [];
      const main = makeView({ markFailedMessage: (row, it) => seen.push(`${it.id}:${row.dataset.messageId}`) });
      main.view.syncOutboxRows([item("f", "failed", { error: "x" })]);
      t.ok("主の失敗は markFailedMessage（直す入口まで描く今の経路）に渡す。吹き出しの本文は残る", seen.join() === "f:f" && main.thread.children[0].querySelector(".body").textContent === "本文 f");
      const child = makeView({ editQueued: async () => {} });
      child.view.syncOutboxRows([item("g", "queued", { waiting: { reason: "turn" } })]);
      t.ok("子の送信待ちは［編集］［取り消す］（編集は入力欄へ戻す）", labels(statusOf(child.thread.children[0])).join() === [edit, cancel].join());
      const plain = makeView();
      plain.view.syncOutboxRows([item("h", "queued", { waiting: { reason: "turn" } })]);
      t.ok("主の送信待ちには［編集］を出さない（［取り消す］だけ）", labels(statusOf(plain.thread.children[0])).join() === cancel);
    }

    // ---------------------------------------------------------------- 会話を読み込んでいる間は吹き出しを足さない
    {
      const { view, thread, calls } = makeView({ isLoadingSession: () => true });
      view.syncOutboxRows([item("l", "queued", { waiting: { reason: "turn" } })]);
      t.ok("履歴を読み込んでいる間は吹き出しを足さず、入力欄まわりの描き直しだけ呼ぶ（読み終えたあとの描きが組む）", thread.children.length === 0 && calls.includes("paint"));
    }
  } finally {
    document.createElement = saved.createElement;
    if (saved.createTextNode === undefined) delete document.createTextNode; else document.createTextNode = saved.createTextNode;
  }
}
