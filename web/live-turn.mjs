// 進行中のターン（走っている AI の発言）を描く部品。web/client.mjs から動かしただけ（ADR 0319 段 6-3）。
// 稼働表示・本文の流し込み・思考・ツールのまとまり（束）・発言の入れ物を持つ。
// 後の段で、子の会話の 2 つ目の実例を作れるようにするための土台。今は主の会話の 1 つだけが使う。
import { el } from "./dom.mjs";
import { t, fmt } from "./i18n.mjs";
import { renderAssistantMarkdown } from "./render.mjs";
import { RunningTools } from "./running-tools.mjs";
import { Bundle, bundleOf, clock } from "./tool-bundle.mjs";
import { runMark, satMark } from "./arc.mjs";

export const ACTIVITY_LABEL = {
  thinking: t("activity.thinking"),
  writing: t("activity.writing"),
  compacting: t("activity.compacting"),
  waiting: t("activity.waiting"),
  running: t("activity.running"),
  stopping: t("activity.stopping"),   // 中断を受け付けた。バックエンドが止まり終えるまで（server の abort が出す）
};

/**
 * 進行中のターンの描画と、その状態（turnEl・bundle・streamEl・thinkEl・pendingUuid・endedWithText・turnClosed・toolCards）。
 * 状態はこの中が持ち、外へは返す実例の getter / setter で出す（client は state の同名の項目をそこへつなぐ）。
 * この部品は主の会話の値（state.current など）を直に読まない。必要なものは次の hooks で受ける。
 *   thread, log                    会話の筋とその外枠（DOM）
 *   isRunning() / stopping()       この会話の AI が走っているか / 中断を頼んだ後か
 *   behind() / backgroundCounts()  裏（subagent・端末など）を待っているか / 待てない裏の数
 *   turnStart()                    走っているターンの始まりの時刻（分からなければ null）
 *   aiMsg(opts)                    AI の発言の行を作る（名札・バックエンドの印は呼ぶ側が決める）
 *   placeRow(node, key)            筋の中へ行を置く（履歴との並びは呼ぶ側が決める）
 *   atBottom() / followBottom(ms)  末尾を見ているか / 末尾へ追う
 *   relayout()                     分岐の印などの再配置
 *   onActivity()                   稼働表示が出入りした（作業の入口の更新）
 *   stopComputer(bundle)           コンピューター操作の束の「止める」
 *   replaying() / painting()       履歴の再生中か / 履歴を描いている最中か（読むだけの印）
 *   nextSeq()                      履歴でない行（live:N）の通し番号
 */
export function createLiveTurn(hooks) {
  const {
    thread, log, isRunning, stopping, behind, backgroundCounts, turnStart,
    aiMsg, placeRow, atBottom, followBottom, relayout, onActivity, stopComputer,
    replaying, painting, nextSeq,
  } = hooks;

  // 状態
  let turnEl = null;          // 追記中の AI の発言（.m.ai）
  let bundle = null;          // 走っているツールのまとまり（本文・委譲・ターンの終わりで閉じる。web/tool-bundle.mjs）
  let pendingUuid = null;     // 見せるものが無いまま確定した発言（thinking だけ）の id。次に発言の入れ物を作るときに使う
  let endedWithText = false;  // 直前に確定した発言（text.end）が本文を持っていたか
  let turnClosed = false;     // text.end が来た。続くツール呼び出しは同じ発言に入り、次の本文は新しい発言になる
  let streamEl = null;        // 追記中の本文
  let thinkEl = null;         // 追記中の thinking 要素（平文が来たときだけ作る）
  const toolCards = new Map();   // tool_use_id -> 描いたカード（結果を後から差し込む）

  // ---------------------------------------------------------------- 稼働表示
  // 「動いているのか分からない」を無くす。何をしているかと、経過時間を出し続ける。
  // 置き場は会話の筋の末尾の節（走っている間だけ存在し、新しい発言が来るとその下へ移る）。
  // 印は本文列に置き、実行中のツール行を優先する（ADR 0267）。


  const runningTools = new RunningTools(() => activity.toolsChanged(), { before: () => atBottom(), after: stick => { relayout(); if (stick && !painting()) followBottom(); } });
  const activity = {
    t0: 0,         // 経過の起点。走っているターンの始まり（turnStartHere）。分からなければ出し始めた時刻
    timer: null,
    markTimer: null,
    el: null,          // .m.activity
    text: "",
    behind: null,      // behindOf() の結果。裏を待っている間だけ
    idleTimer: null,   // ツールが終わってから稼働表示を戻すまでの短い待ち（afterTool）
    suspended: false,  // ツールの行が今の状態を語っている間。汎用の activity 事象（passive）は出さない
    shape: "",         // 今の印（run / sat:N / none）。変わったときだけ差し替える
    /** ターンは終わり、待てない裏の作業（端末・裏のコマンド）だけが残っている。印も経過時間も出さない（§6.1） */
    idleOnly() {
      return !this.behind && !isRunning() && backgroundCounts().live > 0;
    },
    shapeNow() {
      if (this.behind) return `sat:${this.behind.n}`;
      if (!stopping() && [t("activity.waitingApproval"), t("activity.waitingAnswer"), t("activity.waitingChrome")].includes(this.text)) return "none";
      return this.idleOnly() ? "none" : "run";
    },
    mark() {
      this.shape = this.shapeNow();
      if (this.shape === "none") return el("span", "activity-none");
      if (this.behind) return satMark(this.behind.n, t("activity.behindCount", { count: this.behind.n }));
      return runMark(t("activity.turnRunning"));
    },
    toolsChanged() {
      if (runningTools.size) this.show(this.text || ACTIVITY_LABEL.running);
      else { runningTools.el.remove(); this.suspend(); this.afterTool(); }
    },
    paint() {
      const tools = runningTools.size > 0 && !stopping();
      this.el.classList.toggle("tools-active", tools);
      if (tools) { if (runningTools.el.parentNode !== this.el) this.el.append(runningTools.el); } else runningTools.el.remove();
      this.el.querySelector(".txt").textContent = this.behind ? this.behind.label : this.idleOnly() ? t("activity.backgroundOnly") : this.text;
      this.el.querySelector(".el").hidden = this.idleOnly();
    },
    /** 印を今の状態（弧 / 衛星 / なし）に差し替える */
    remark() {
      this.el?.querySelector(".activity-tip")?.replaceChildren(this.mark());
    },
    /** 承認・回答の決着後。親のターンが終わっていても、残った子の結果待ちに戻す。 */
    afterPermission(text = t("activity.continuing"), { suspend = false } = {}) {
      if (isRunning()) { if (suspend) this.suspend(); else this.show(text); }
      else if (behind()) this.show(t("activity.waitingBackground"));
    },
    /**
     * 汎用表示を抑える。実行中のツールがあれば同じ末尾の節に残し、承認カードだけなら節を外す。
     * 経過の起点は次の表示まで保持する。親のツールが無いときは子の結果待ちの衛星を残す。
     */
    suspend() {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.suspended = true;
      if (!this.t0) this.t0 = turnStart() ?? Date.now();
      if (runningTools.size || behind()) return this.show(this.text || ACTIVITY_LABEL.running, { keepSuspended: true });
      clearTimeout(this.markTimer);
      this.markTimer = null;
      this.behind = null;
      this.shape = "";
      this.el?.closest(".mw")?.remove();
      this.el = null;
      relayout();
    },
    /** ツールの結果が届いた。すぐ次のツールが始まらず、走っている行も無いなら、行に出ていない待ちとして稼働表示を戻す */
    afterTool() {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        // 走っている・承認を待っている行が今のまとまりに無いときだけ（前のターンの残骸や他の会話の行は見ない）
        const busy = [...toolCards.values()].some((c) => c.classList.contains("tc-running") || c.classList.contains("tc-waiting"));
        if (isRunning() && !busy) this.show(ACTIVITY_LABEL.running);
      }, 600);
    },
    show(text, { delayMark = false, passive = false, keepSuspended = false } = {}) {
      // 汎用の事象（動いている・待っている）は、ツールの行が語っている間は出さない
      if (passive && this.suspended && !runningTools.size && !behind()) return;
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (!keepSuspended) this.suspended = false;
      // 中断を頼んだ後は、止まり終えるまで何が流れてきても「中断している」のまま出す
      if (stopping()) text = ACTIVITY_LABEL.stopping;
      this.text = text;
      if (!this.t0) this.t0 = turnStart() ?? Date.now();
      this.behind = runningTools.size || stopping() ? null : behind();
      // ターンが終わって裏だけが残った、またはその逆。出ている節の印を差し替える
      if (this.el?.isConnected && this.shape !== this.shapeNow()) this.remark();
      if (!this.el?.isConnected) {
        // 筋の末端の点は溝（CSS）が描く。印と文言はほかの発言の本文と同じ列に並べる
        const m = el("div", "m activity");
        const tip = el("span", "activity-tip");
        if (!delayMark) tip.append(this.mark());
        m.append(tip, el("span", "txt"), el("span", "el"));
        placeRow(m, "activity");
        if (!replaying() && !matchMedia("(prefers-reduced-motion: reduce)").matches && m.animate) m.animate([
          { transform: "translateY(6px)", opacity: .3 }, { transform: "none", opacity: 1 },
        ], { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" });
        this.el = m;
      }
      const tip = this.el.querySelector('.activity-tip');
      if (delayMark) {
        if (!tip.children.length && !this.markTimer) this.markTimer = setTimeout(() => {
          this.markTimer = null;
          if (this.el?.isConnected && !tip.children.length) tip.append(this.mark());
        }, 150);
      } else {
        clearTimeout(this.markTimer);
        this.markTimer = null;
        if (!tip.children.length) tip.append(this.mark());
      }
      this.paint();
      relayout();
      onActivity();
      this.timer ??= setInterval(() => {
        const e = this.el?.querySelector(".el");
        if (e && !thread.classList.contains("activity-offline")) e.textContent = clock(Math.round((Date.now() - this.t0) / 1000));
      }, 1000);
    },
    /** running が変わった。裏を待っているかどうかで印と見出しを差し替える（表示中のときだけ） */
    sync() {
      // 開き直した直後は running の放送より先に出ることがある。ターンの始まりが分かったら、そこからの経過に直す
      const start = turnStart();
      if (this.t0 && start != null && start < this.t0) this.t0 = start;
      if (!this.el?.isConnected) return;
      const was = this.behind;
      this.behind = runningTools.size || stopping() ? null : behind();
      if (this.shape !== this.shapeNow()) this.remark();
      // 待っている間に覚えた text は subagent 側のもの。main が戻ったら一旦中立の語にする
      if (was && !this.behind) this.text = ACTIVITY_LABEL.running;
      this.paint();
      onActivity();
    },
    hide() {
      runningTools.clear();
      clearInterval(this.timer);
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.suspended = false;
      clearTimeout(this.markTimer);
      this.timer = null;
      this.markTimer = null;
      this.t0 = 0;
      this.text = "";
      this.behind = null;
      this.shape = "";
      this.el?.closest(".mw")?.remove();
      this.el = null;
    },
  };

  // ---------------------------------------------------------------- thinking
  // 既定は閉じておく。読みたいときだけ開ける（畳んだままでも「考えた」ことは見える）。

  function thinkBox() {
    if (thinkEl) return thinkEl;
    const d = document.createElement("details");
    d.className = "think live";
    const s = document.createElement("summary");
    s.textContent = ACTIVITY_LABEL.thinking;
    const body = el("div", "think-body");
    d.append(s, body);
    openTurnEl().append(d);
    thinkEl = d;
    return d;
  }

  function closeThink() {
    if (!thinkEl) return;
    const d = thinkEl;
    d.classList.remove("live");
    const n = d.querySelector(".think-body").textContent.length;
    d.querySelector("summary").textContent = t("chat.thought", { count: n, chars: fmt.number(n) });
    thinkEl = null;
  }

  /** 履歴から復元するときの thinking。最初から閉じた状態で作る。 */
  function thinkFromText(text) {
    const d = document.createElement("details");
    d.className = "think";
    const s = document.createElement("summary");
    s.textContent = t("chat.thought", { count: text.length, chars: fmt.number(text.length) });
    const body = el("div", "think-body", text);
    d.append(s, body);
    return d;
  }

  // ---------------------------------------------------------------- ターンの流れ
  // core が正規化して送ってくる（プロトコル v3）。エージェントごとの差は core で吸収済み。

  // 本文の描き直しは 1 コマに 1 回。デルタは文字を貯めるだけにする（正本は本文の要素の dataset.raw）。
  // デルタごとに返答の全体を Markdown から作り直し、会話全体のレイアウトを強制すると、スマホの CPU では
  // デルタの間隔に追いつかず、数秒〜十数秒コマが出なかった（issue #37）。
  // 流れが終わる所（text.end・ツール・thinking・発言を閉じる・中断・会話の切り替え）では、貯めた分を同期で描き切る（endStream・closeTurnEl）。
  let streamFrame = 0, streamTarget = null;

  /** 貯めた分を今描く。末尾を見ていたときだけ末尾へ追う（読み返している人を引き戻さない） */
  function flushStream() {
    if (streamFrame) cancelAnimationFrame(streamFrame);
    streamFrame = 0;
    const target = streamTarget;
    streamTarget = null;
    if (!target) return;
    const stick = target.isConnected && atBottom();
    target.innerHTML = renderAssistantMarkdown(target.dataset.raw);
    if (!target.isConnected) return;
    relayout();
    if (stick) log.scrollTop = log.scrollHeight;
  }

  /** 筋ごと捨てるとき（会話の切り替え）。貯めた分は捨てる本文の要素の中にあり、別の会話には描かない */
  function cancelStream() {
    if (streamFrame) cancelAnimationFrame(streamFrame);
    streamFrame = 0;
    streamTarget = null;
  }

  /** 追記中の本文を終える。貯めた分を描き切ってから、次の本文・ツール・発言に移る */
  function endStream() {
    flushStream();
    streamEl = null;
  }

  function appendText(text) {
    closeThink();
    // 稼働表示は文言が変わったときだけ更新する（show は行の置き直し・筋の貼り直し・作業の入口の更新まで行う）
    const label = stopping() ? ACTIVITY_LABEL.stopping : ACTIVITY_LABEL.writing;
    if (!activity.el?.isConnected || activity.text !== label) activity.show(ACTIVITY_LABEL.writing);
    if (!streamEl) {
      // 閉じた発言の後は streamEl がリセットされるため、本文を作る前に開く。
      const turn = openTurnEl();
      closeBundle();
      streamEl = el("div", "body");
      streamEl.dataset.raw = "";
      turn.append(streamEl);
    }
    streamEl.dataset.raw += text;
    streamTarget = streamEl;
    streamFrame ||= requestAnimationFrame(flushStream);
  }

  /** 直前の発言が AI なら、続きとして見出しと節を繰り返さない */
  const lastIsAi = () => thread.querySelector(".mw:last-of-type .m")?.classList.contains("ai") ?? false;

  /**
   * ライブで AI の発言の入れ物。無ければ作る。text.end で閉じた後でも、続くツール呼び出しは
   * 同じ発言のもの（履歴では 1 メッセージ = 本文 + ツール呼び出し）なのでここへ入る。
   */
  function ensureTurnEl() {
    if (turnEl) return turnEl;
    const m = aiMsg({ at: new Date().toISOString(), cont: lastIsAi(), uuid: pendingUuid });
    pendingUuid = null;
    placeRow(m, `live:${nextSeq()}`);
    turnEl = m;
    return m;
  }

  /** 本文や thinking が始まる。閉じた発言の後なら新しい発言になる */
  function openTurnEl() {
    if (turnClosed) closeTurnEl();
    return ensureTurnEl();
  }

  /** 走っているまとまりを閉じて見出し 1 行にする（本文が来た・委譲が始まった・ターンが終わった） */
  function closeBundle() {
    const b = bundle;
    bundle = null;
    if (!b) return;
    b.close();
  }

  /**
   * 今のまとまり。無ければ今の発言の末尾に作る。コンピューターの操作の連続は別の種類の塊（kind: "computer"）で、種類が替わればそこで切れる。
   * since は新しく作るときの見出しの起点（最初のツールが始まった時刻。toolStartedAt）
   */
  function liveBundle(kind = "tools", since = null) {
    const turn = ensureTurnEl();
    if (bundle && bundle.el.parentNode === turn && bundle.kind === kind) return bundle;
    closeBundle();
    bundle = new Bundle({ live: true, kind, since, ...(kind === "computer" ? { onStop: stopComputer } : {}) });
    turn.append(bundle.el);
    return bundle;
  }

  function closeTurnEl() {
    closeThink();
    closeBundle();
    endStream();
    turnEl = null;
    turnClosed = false;
    endedWithText = false;
    pendingUuid = null;
  }

  /**
   * ターンが終わった。結果を持たないまま残った行（中断・エラーで tool.result が来なかった）から、走っている印と承認カードを外す。
   * 弧と経過が回り続けたり、閉じた見出しの中で押せない承認が残ったりしないように
   */
  function settleStrays() {
    for (const row of thread.querySelectorAll(".tc.tc-running, .tc.tc-waiting")) {
      row.restoreToolRow?.();
      row.classList.remove("tc-running", "tc-waiting");
      const res = row.querySelector(".tc-res");
      if (res) { res.paint = null; res.replaceChildren(); }
      row.querySelector(".tc-appr")?.remove();
      row.querySelector(".tc-lockwait")?.remove();
      const shell = row.querySelector(".tc-details");
      if (shell) shell.hidden = false;
      bundleOf(row)?.paint();
    }
  }

  /** 走っているターンの描きかけ（稼働表示・本文・思考・発言の入れ物）を捨てる。走っている分は履歴の再生で描き直す */
  function resetLiveTurn() {
    activity.hide();
    cancelStream();
    streamEl = null;
    thinkEl = null;
    turnEl = null;
    bundle = null;
    turnClosed = false;
  }

  return {
    activity, runningTools, toolCards,
    ensureTurnEl, openTurnEl, closeBundle, liveBundle, closeTurnEl, settleStrays, resetLiveTurn,
    thinkBox, closeThink, thinkFromText,
    flushStream, cancelStream, endStream, appendText,
    // 状態の読み書き（client の state の同名の項目がここへつながる）
    get turnEl() { return turnEl; }, set turnEl(v) { turnEl = v; },
    get bundle() { return bundle; }, set bundle(v) { bundle = v; },
    get pendingUuid() { return pendingUuid; }, set pendingUuid(v) { pendingUuid = v; },
    get endedWithText() { return endedWithText; }, set endedWithText(v) { endedWithText = v; },
    get turnClosed() { return turnClosed; }, set turnClosed(v) { turnClosed = v; },
    get streamEl() { return streamEl; }, set streamEl(v) { streamEl = v; },
    get thinkEl() { return thinkEl; }, set thinkEl(v) { thinkEl = v; },
  };
}
