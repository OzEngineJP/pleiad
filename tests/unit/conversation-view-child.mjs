// 会話の本文の面（web/conversation-view.mjs）の子の会話の役（role: 'child'）の設定（ADR 0319 段 6-5）。
// 事実は、今の作業のダイアログが描く筋（client.mjs の readonlyThread・web/history-pane.mjs の historyRow の readonly）から取った:
//   - 発言者の語: 最初は「依頼」、人が子へ直接送った発言は「あなた」、それ以外は「追加の指示」（古い分を省いた筋の最初は追加の指示）
//   - 分岐・編集・再送・git の印は出さない。発言のメニューは CHILD_MENU。git・作業ブランチの提示は出さない
//   - 追加の指示の行は 4 つの状態（差し込み待ち・待機・届かず終わった・届いた）で変わる。待機は時計の印、次のターンまで届かないなら字を添える
//   - 走っている子は末尾に稼働表示（弧だけ）。ホストに届かない間・承認を待つ間は言い方が替わる
// 段 6-6 から、作業のダイアログの「委譲の子」の本文はこの実例が描く（読み直しの経路は childThreadRenderer: 'reread' で残る）。ここでは設定と、設定が決める行の形・項目の足し引きを確かめる。
import { createConversationView } from "../../web/conversation-view.mjs";
import { readConversationView, readLiveTurn, readHistoryPane } from "../lib/cut-source.mjs";
import { CHILD_MENU } from "../../web/message-actions.mjs";
import { t as tr } from "../../web/i18n.mjs";
import { N } from "../lib/dom-stub.mjs";

export const name = "conversation-view-child";
export const title = "会話の本文の面の子の会話の役: 発言者の語・出さないもの・追加の指示の行・稼働表示（作業のダイアログと同じ事実）。本文の 3 つの部品が主の値を直に読まない（走査）";

/** `.who > span` を引ける人の発言の作りもの（本物は web/client.mjs の userMsg） */
class Row extends N {
  constructor(tag, cls) { super(tag); if (cls) this.className = cls; }
  /** 複合の指定（.a.b・:not(.c)・[attr]）。web/conversation-view.mjs の wrap が使う */
  matches(sel) {
    const tokens = sel.trim().match(/:not\([^)]*\)|\.[\w-]+|\[[\w-]+\]|[a-z]+/gi) ?? [];
    return tokens.every(tok => {
      if (tok.startsWith(":not(")) return !this.matches(tok.slice(5, -1));
      if (tok.startsWith(".")) return this._classes().includes(tok.slice(1));
      if (tok.startsWith("[")) return tok.slice(1, -1) in this.attrs;
      return this.tagName === tok.toUpperCase();
    });
  }
  querySelector(sel) {
    if (sel === ".who > span") return this.children.find(c => c.matches?.(".who"))?.children.find(c => c.tagName === "SPAN") ?? null;
    return super.querySelector(sel);
  }
}
function userMsg(text, { at } = {}) {
  const m = new Row("div", "m user");
  const who = new Row("div", "who");
  const span = new Row("span", "name");
  span.textContent = "あなた";
  who.append(span);
  const body = new Row("div", "body");
  body.textContent = text;
  m.append(who, body);
  m.dataset.at = at ?? "";
  return m;
}

function makeView(role, extra = {}) {
  const thread = new Row("div", "thread"), log = new Row("div", "log"), frame = new Row("div", "frame");
  const hooks = {
    userMsg, isBusy: () => false, isLoadingSession: () => false, currentSession: () => "main-session",
    backendVocab: () => null, ...extra,
  };
  return { view: createConversationView({ sessionId: role === "child" ? "child-1" : null, log, thread, frame, role, hooks }), thread };
}

const words = row => row.querySelector(".who > span").textContent;

/** コメントと文字列を除いた原稿（走査の誤検出を避ける） */
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

export default async function (t) {
  // ---------------------------------------------------------------- 主の値を直に読まない（別の会話の実例が主を壊さないための条件）
  const parts = { "conversation-view.mjs": readConversationView(), "live-turn.mjs": readLiveTurn(), "history-pane.mjs": readHistoryPane() };
  for (const [file, source] of Object.entries(parts)) {
    const code = codeOnly(source);
    // state（client.mjs の画面全体の状態）の項目・主の会話の値・画面全体の DOM・保存先。出来事の ev.state・指示の instruction.state は別物（. の後）
    const direct = [...code.matchAll(/(^|[^.\w$])(state[.[]|localStorage|sessionStorage|document\.(getElementById|querySelector|title|body|documentElement)|getElementById)/g)].map(m => m[2]);
    t.ok(`${file}: 主の state・画面全体の DOM・保存先を直に読まない`, direct.length === 0, direct.join(","));
  }

  const main = makeView("main").view;
  const child = makeView("child").view;

  // ---------------------------------------------------------------- 設定
  t.ok("子の会話の設定: 分岐・編集・再送・git の印は出さない", child.config.branches === false && child.config.edit === false && child.config.resend === false && child.config.gitBadge === false);
  t.ok("子の会話の設定: 読むだけの履歴の行（readonly）・発言のメニューは CHILD_MENU（分岐・編集なし）",
    child.config.readonly === true && child.config.menu === CHILD_MENU && CHILD_MENU.canFork === false && CHILD_MENU.editable === false);
  t.ok("子の会話の設定: git・作業ブランチの提示は出さない", [...child.config.skipPresent].sort().join() === "git,worktree");
  t.ok("子の会話の設定: 発言者の語・追加の指示の行・末尾の稼働表示を持つ", child.config.nameTags && child.config.instructions && child.config.liveActivity);
  t.ok("主の設定は今の動きのまま（分岐あり・編集あり・再送あり・git の印あり・読むだけにしない）",
    main.config.branches && main.config.edit && main.config.resend && main.config.gitBadge && !main.config.readonly && main.config.menu === null && !main.config.nameTags && main.config.skipPresent.length === 0);
  t.ok("子の実例は自分の会話を示す。主は今の会話を hooks に問う", child.sessionId === "child-1" && main.sessionId === "main-session" && child.role === "child" && main.role === "main");

  // ---------------------------------------------------------------- 発言者の語
  const [request, you, instruction] = [tr("dialog.work.request"), tr("chat.message.you"), tr("dialog.work.instruction")];
  t.ok("（前提）3 つの語は互いに違う", new Set([request, you, instruction]).size === 3, `${request}/${you}/${instruction}`);
  t.ok("最初の発言は「依頼」", child.userWord({ text: "x" }, { index: 0, base: 0 }) === request);
  t.ok("人が子へ直接送った発言は「あなた」（最初の発言だけは、人が送っていても依頼）",
    child.userWord({ text: "x", sentByHuman: true }, { index: 3 }) === you && child.userWord({ text: "x", sentByHuman: true }, { index: 0 }) === request);
  t.ok("それ以外の 2 件目以降は「追加の指示」", child.userWord({ text: "x" }, { index: 2 }) === instruction);
  t.ok("古い分を省いた筋（base > 0）の最初の発言は会話の途中: 依頼ではなく追加の指示", child.userWord({ text: "x" }, { index: 0, base: 40 }) === instruction);
  t.ok("主は発言者の語を替えない（null）", main.userWord({ text: "x" }, { index: 0 }) === null);

  // 履歴の行を描く渡し物
  const optsChild = child.historyRowOptions({ backend: "codex", base: 0 }, { mi: 0 });
  t.ok("履歴の行の渡し物: readonly・backend・自分の会話の id", optsChild.readonly === true && optsChild.backend === "codex" && optsChild.sessionId === "child-1");
  t.ok("履歴の行の渡し物の user が、発言者の語を替えた吹き出しを返す", words(optsChild.user({ text: "調べて", at: "2026-01-01T00:00:00Z" })) === request
    && words(child.historyRowOptions({ backend: "codex" }, { mi: 4 }).user({ text: "あと一つ", sentByHuman: true })) === you
    && words(child.historyRowOptions({ backend: "codex" }, { mi: 4 }).user({ text: "あと一つ" })) === instruction);
  const optsMain = main.historyRowOptions({ backend: "claude" });
  t.ok("主の渡し物は読むだけにせず、user も替えない（今のメインパネルの描き方のまま）", optsMain.readonly === false && optsMain.user === undefined && optsMain.sessionId === "main-session");

  // ---------------------------------------------------------------- 出さない提示
  t.ok("git・作業ブランチの提示は読むだけの筋に出さない。ほかの提示は出す", child.skipsPresent({ kind: "git" }) && child.skipsPresent({ kind: "worktree" })
    && !child.skipsPresent({ kind: "html" }) && !child.skipsPresent({ kind: "image" }) && !child.skipsPresent(undefined));
  t.ok("主は何も省かない", !main.skipsPresent({ kind: "git" }) && !main.skipsPresent({ kind: "worktree" }));

  // ---------------------------------------------------------------- 追加の指示の行
  const row = (state, extra = {}, opts) => child.instructionRow({ id: "i1", text: "もう一つ", at: "2026-01-01T00:00:00Z", state, ...extra }, opts);
  const inner = w => w.querySelector(".m");
  const sending = row("sending");
  t.ok("差し込み待ち: 弧の印と「まだ渡っていない」の字、筋の節は付いたまま、key は instruction:<id>",
    inner(sending).dataset.instructionId === "i1" && sending.dataset.key === "instruction:i1" && sending.classList.contains("node")
    && inner(sending).querySelector(".outbox-status-mark")?.shown.includes(tr("chat.delivery.pending")) && words(inner(sending)) === instruction);
  const queued = row("queued", {}, { live: true });
  t.ok("待機: 時計の印（title・読み上げ名つき）と queued の印。筋の節は付けない",
    inner(queued).classList.contains("queued") && inner(queued).querySelector(".who-queued")?.getAttribute("title") === tr("dialog.work.instructionQueued")
    && inner(queued).querySelector(".who-queued")?.getAttribute("aria-label") === tr("dialog.work.instructionQueued") && !queued.classList.contains("node"));
  t.ok("待機で、途中で渡せない子（steer が偽）が走っている間は「次のターンで届く」の字を添える",
    row("queued", {}, { live: true, steer: false }).querySelector(".outbox-status")?.textContent === tr("dialog.work.instructionNextTurn"));
  t.ok("待機でも、設定の変更と一緒に積んだ指示（nextTurn）は字を添える", row("queued", { nextTurn: true }, { live: true }).querySelector(".outbox-status")?.textContent === tr("dialog.work.instructionNextTurn"));
  t.ok("待機で、子が走っていない（すぐ新しいターンで渡す）ときは字を添えない", row("queued", {}, { live: false, steer: false }).querySelector(".outbox-status") === null);
  t.ok("走っていて途中で渡せる子の待機にも字を添えない", row("queued", {}, { live: true, steer: true }).querySelector(".outbox-status") === null);
  t.ok("届かず終わった指示は弱い字で理由を書く", row("dropped").querySelector(".outbox-status")?.textContent === tr("dialog.work.instructionDropped"));
  const delivered = row("delivered");
  t.ok("届いた指示は何も付けない（発言そのものが配送の記録）。待機の印も付けない",
    inner(delivered).querySelector(".outbox-status") === null && inner(delivered).querySelector(".who-queued") === null && !inner(delivered).classList.contains("queued"));

  // ---------------------------------------------------------------- 末尾の稼働表示
  const act = child.activityRow();
  t.ok("稼働表示: key は activity・弧の印（走っている）・字は無い",
    act.dataset.key === "activity" && act.querySelector(".m")?.classList.contains("activity") && act.querySelector(".activity-tip")?.children[0]?.getAttribute("aria-label") === tr("activity.turnRunning")
    && act.querySelector(".txt") === null);
  t.ok("承認を待つ間は、その字を添える", child.activityRow({ waiting: true }).querySelector(".txt")?.textContent === tr("activity.waitingApproval"));
  const offline = child.activityRow({ hostOffline: { time: "12:34" } });
  t.ok("ホストに届かない間: 衛星の印と、どこまで追えているかの時刻つきの字",
    offline.querySelector(".txt")?.textContent === tr("dialog.work.hostOfflineThread") && offline.querySelector(".el")?.textContent === tr("dialog.work.hostOfflineCatchUp", { time: "12:34" })
    && offline.querySelector(".activity-tip")?.children[0]?.getAttribute("aria-label") === tr("dialog.work.hostOfflineMark"));
  t.ok("ホストに届かず時刻も無いときは、時刻なしの言い方", child.activityRow({ hostOffline: {} }).querySelector(".el")?.textContent === tr("dialog.work.hostOfflineCatchUpNoTime"));

  // ---------------------------------------------------------------- 項目の足し引き（子の会話の履歴を描く前）
  const msgs = [
    { role: "user", text: "調べて", at: "2026-01-01T00:00:00Z", uuid: "u1" },
    { role: "assistant", text: "はい", at: "2026-01-01T00:00:10Z", uuid: "a1" },
    { role: "user", text: "もう一つ", at: "2026-01-01T00:01:00Z", uuid: "n1" },
    { role: "assistant", text: "了解", at: "2026-01-01T00:01:10Z", uuid: "a2" },
  ];
  const itemsOf = (messages, base = 0) => messages.map((m, i) => ({ kind: "msg", m, mi: base + i }));
  const kinds = (items) => items.map(it => (it.kind === "msg" ? `m${it.mi}` : it.kind === "instruction" ? `i:${it.instruction.id}` : it.kind));
  const c1 = makeView("child").view;
  t.ok("指示も依頼の欠けも無ければ、発言の項目のまま", kinds(c1.childItems(itemsOf(msgs), msgs, 0)).join() === "m0,m1,m2,m3");
  const c2 = makeView("child").view;
  c2.setChild({ prompt: "調べて" });
  t.ok("最初の発言が人の発言でないとき（記録に依頼が無い）、依頼の行を先頭に足す。base > 0 では足さない",
    kinds(c2.childItems(itemsOf(msgs.slice(1)), msgs.slice(1), 0)).join() === "request,m0,m1,m2"
    && kinds(c2.childItems(itemsOf(msgs.slice(1), 5), msgs.slice(1), 5)).join() === "m5,m6,m7");
  const c3 = makeView("child").view;
  c3.setInstructions([{ id: "i1", text: "もう一つ", at: Date.parse("2026-01-01T00:01:00Z"), state: "delivered", nativeId: "n1" }]);
  t.ok("届いた指示の履歴の行（nativeId が一致して本文も同じ）は省き、指示の行が受付の位置に出る",
    kinds(c3.childItems(itemsOf(msgs), msgs, 0)).join() === "m0,m1,i:i1,m3");
  const c4 = makeView("child").view;
  c4.setInstructions([{ id: "i2", text: "続けて", at: Date.parse("2026-01-01T00:05:00Z"), state: "sending" }]);
  t.ok("まだ渡っていない指示は、受付時刻の位置（末尾）に出る", kinds(c4.childItems(itemsOf(msgs), msgs, 0)).join() === "m0,m1,m2,m3,i:i2");
  t.ok("git の要約の提示は出さず、ほかの提示は残す", kinds(c1.childItems([...itemsOf(msgs), { kind: "present", p: { kind: "git" }, pi: 0, anchorMi: -1 }, { kind: "present", p: { kind: "html" }, pi: 1, anchorMi: -1 }], msgs, 0)).join() === "m0,m1,m2,m3,present");
  t.ok("実例を閉じても落ちない（取り置き・仕事を止める）", (() => { c1.dispose(); return true; })());
}
