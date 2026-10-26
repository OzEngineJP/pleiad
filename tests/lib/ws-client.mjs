// core/server.mjs につなぐ WebSocket クライアント。
//
// 検証スクリプトが各自持っていた定型 —— ready 待ち・command の往復・
// イベントの溜め込み・承認の自動許可・turnEnd 待ち —— をここ1か所に集める。
// 依存は既存の ws だけ（グローバル WebSocket に頼らないので Node 20 でも動く）。
import WebSocket from "ws";
import { restartMode } from "./restart.mjs";

/** cmd の返事を待つ既定の上限（ミリ秒） */
export const CMD_TIMEOUT_MS = 60_000;

/**
 * 1本つないで ready を受け取るまで待つ。restartMode（tests/lib/restart.mjs）が入っていれば、
 * その口を通す（途中でサーバーを止めて起こし直しても、試験は同じ接続を使っているつもりのまま続けられる）。
 * 引数の意味は rawOpen と同じ。
 */
export async function open(options = {}) {
  const hook = restartMode();
  if (hook) return hook.open(options, rawOpen);
  return rawOpen(options);
}

/**
 * 1本つないで ready を受け取るまで待つ。
 * @param onEvent 受け取ったイベントごとに呼ばれる。第2引数はこの接続自身。
 * @param autoAllow 承認要求が来たら即 allow する（承認フロー自体を測らないテスト用）。
 *   fake-codex の既定の台本はコマンドの承認を求めるので、そのターンを走らせるなら付ける。
 *   引数は 1 つだけ: `open({ ...host, autoAllow: true })`（`open(host, { autoAllow: true })` は効かない）。
 * @param headers 接続の要求に足すヘッダー（端末の中継を通った接続を装う x-forwarded-for など）。
 */
async function rawOpen({ port, token, host = "127.0.0.1", onEvent, autoAllow = false, headers } = {}) {
  const ws = new WebSocket(`ws://${host}:${port}/ws?token=${token}`, headers ? { headers } : undefined);
  const pending = new Map();
  const events = [];
  const watchers = new Set();
  let seq = 0;
  let helloDone = false;
  let resolveHello, rejectHello;
  const hello = new Promise((res, rej) => {
    resolveHello = (m) => { helloDone = true; res(m); };
    rejectHello = rej;
  });

  // 返事が来ない cmd（接続が閉じた後に送った分・サーバーが答えない分）で、試験が黙って止まらない。上限を過ぎたら、コマンド名を入れて拒否する。
  // 長く待つ cmd だけ `cmd(name, args, { ms })` で延ばす（0 は上限なし）
  // onReply は返事を受けた同期点で呼ぶ（出来事の境界を取る用途）。
  const cmd = (command, args = {}, { ms = CMD_TIMEOUT_MS, onReply } = {}) =>
    new Promise((res, rej) => {
      // ws は、開いていない接続への送信を黙って捨てる（close で拒否されるのは、その時点で待っていた分だけ）。送れないものは待たせない
      if (ws.readyState !== WebSocket.OPEN) return rej(new Error(`cmd ${command} を送れない: 接続が開いていない（readyState ${ws.readyState}）`));
      const id = String(++seq);
      const timer = ms > 0 ? setTimeout(() => {
        if (pending.delete(id)) rej(new Error(`cmd ${command} の返事が ${ms}ms 来なかった`));
      }, ms) : null;
      timer?.unref?.();
      pending.set(id, { res: (v) => { clearTimeout(timer); onReply?.(); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      try { ws.send(JSON.stringify({ kind: "command", command, id, args })); }
      catch (e) { pending.delete(id); clearTimeout(timer); rej(e); }
    });

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.kind === "ready") return resolveHello(m);
    if (m.kind === "response") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.ok ? p?.res(m.result) : p?.rej(Object.assign(new Error(String(m.error)), { code: m.code, issues: m.issues }));
    }
    if (m.kind !== "event") return;
    const ev = m.event;
    events.push(ev);
    if (autoAllow && ev.type === "permission") {
      cmd("resolvePermission", { id: ev.id, allow: true }).catch(() => {});
    }
    // onEvent は非同期でもよい（承認を返してから次の指示を出す、など）
    const oops = (err) => console.log(`      onEvent で例外: ${err?.stack ?? err}`);
    try { Promise.resolve(onEvent?.(ev, api)).catch(oops); } catch (err) { oops(err); }
    for (const w of [...watchers]) if (w.pred(ev)) { watchers.delete(w); w.res(ev); }
  });

  // 切断の検証では意図的に切るので、待っている側には例外として伝えて握り潰す
  const fail = (err) => {
    const e = err ?? new Error("接続が閉じた");
    if (!helloDone) rejectHello(e);   // つなげなかった（401 など）ときに待ち続けない
    for (const p of pending.values()) p.rej(e);
    pending.clear();
  };
  ws.on("error", fail);
  ws.on("close", () => fail(new Error("接続が閉じた")));

  const api = {
    ws,
    cmd,
    events,
    /** いまのイベント数。ここから先だけを見たいときの目印にする。 */
    mark: () => events.length,
    since: (from) => events.slice(from),

    /**
     * 条件に合うイベントを待つ。既に来ていればそれを返す。
     * from を渡すと、その目印より後に来たものだけを見る
     * （前のターンの turnEnd を拾ってしまう事故を防ぐ）。
     */
    waitFor(pred, { ms = 300000, from = 0 } = {}) {
      const hit = events.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, res };
        watchers.add(w);
        setTimeout(() => {
          if (watchers.delete(w)) rej(new Error(`waitFor が ${ms}ms で timeout`));
        }, ms).unref?.();
      });
    },

    /**
     * 1ターン走らせて終わるまで待ち、そのターンのあいだに起きたことをまとめて返す。
     * runTurn の応答と turnEnd の両方を見る。断られたときに turnEnd を待ち続けないため。
     * 待つのはこの回の会話の turnEnd だけ。裏で別の会話のターン（委譲の完了通知など）が走っても、その終わりで返らない。
     * 新しい会話は、呼んだ時点までに見ていない ID の session をこの回の会話とする。
     * id が決まる前に終わったターンの turnEnd は sessionId が null なので、そのときは null の turnEnd で返る。
     * 開始が拒否されたら例外を返す。結果の選択と ms の待ちは、開始を受理した応答の後を対象にする。
     * events は準備中の通知（cwd など）も含め、呼び出し以降のものを返す。
     */
    async runTurn(args, { ms = 300000 } = {}) {
      const from = events.length;
      let acceptedFrom = null;
      const known = new Set(events.map((e) => e.sessionId).filter(Boolean));
      let own = args?.sessionId ?? null;
      const mine = (e) => {
        if (acceptedFrom === null) return false;
        if (!own && e.type === "session" && e.sessionId && !known.has(e.sessionId)) own = e.sessionId;
        return e.type === "turnEnd" && (e.sessionId ?? null) === own;
      };
      // 開始の応答より前に、同じ会話の前のターン（完了通知など）が終わることがある。
      // 応答の受信時に境界を取る。then で取ると、同じ受信バッチの今回の出来事まで飛ばしてしまう。
      // turnEnd が先に届いても、今回の開始要求の拒否を成功に変えない。
      await cmd("runTurn", args, { onReply: () => { acceptedFrom = events.length; } });
      await api.waitFor(mine, { ms, from: acceptedFrom });
      return { ...api.turnResult(acceptedFrom, { sessionId: own }), events: events.slice(from) };
    },

    /**
     * 目印から後のイベントを、よく見る形に畳んで返す。
     * sessionId を渡すと、会話の ID・モデル・結果はその会話のものを選ぶ（events・tools・permissions は目印から後の全部）。
     */
    turnResult(from, { sessionId } = {}) {
      const slice = events.slice(from);
      const scoped = sessionId === undefined ? slice : slice.filter((e) => e.sessionId === sessionId);
      // プロトコル v2 では生の SDK メッセージは来ない。正規化された tool.start を数える
      const tools = slice.filter((e) => e.type === "tool.start").map((e) => e.name);
      return {
        events: slice,
        tools,
        sessionId: sessionId !== undefined ? sessionId : slice.find((e) => e.type === "session")?.sessionId ?? null,
        permissions: slice.filter((e) => e.type === "permission"),
        // 実際に解決されたモデル。session イベントに乗ってくる（乗せられるバックエンドだけ）。
        // id が決まるのとモデルが分かるのは別のタイミングなので、model を持つ方を探す
        initModel: scoped.find((e) => e.type === "session" && e.model)?.model ?? null,
        outcome: scoped.find((e) => e.type === "turnResult")?.outcome ?? null,
      };
    },

    close() { try { ws.close(); } catch {} },
    /** 行儀よく閉じずに落とす。host が突然消えた状況を作る。 */
    terminate() { try { ws.terminate(); } catch {} },
  };

  api.ready = await hello;
  return api;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
