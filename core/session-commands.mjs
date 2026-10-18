// 普通の会話（委譲の子でない会話）の長いコマンドを、その会話自身へ知らせる（ADR 0225 §2）。止めない。
//
// - 見るもの: ネイティブのシェルのツール（core/shell-tools.mjs の isShellToolCall）の tool.start〜tool.result と、
//   Pleiad のシェルのツール（ply_shell）の run・start のジョブ（track / untrack）
// - N 分（minutes）を超えたら、コマンドごとに 1 回 deliver する。承認待ちの時間は数えない。待つためのコマンド（ADR 0138）は数えない。
//   同じ会話の同じコマンドは、やり直しても繰り返し知らせない（commandKey。会話ごとに NOTICED_MAX まで覚える）
// - deliver の答え: 'ok'（渡した。受け取りは accept で後から知らせる）・'requeue'（今は渡せない。次の見回りでやり直す）・'error'（やり直さない）
// - 会話が知らせを受け取らない（最初に渡そうとしてから fallbackMs たっても accept が来ない）ときは、人へ知らせる（raise）。
//   コマンドが終わったら、人への知らせを決着させる（settle）
// - ターンの終わり（turnResult）で、そのターンのネイティブのコマンドは忘れる（ツールは終わったか、止められた）。ply_shell のジョブは忘れない
// - 委譲の子は対象にしない（親へ知らせる。ADR 0048。core/agent-tasks.mjs）
// 記録はメモリだけ（再起動で忘れる。走っていたツールは付け直しの再生で見直す）
import { redactForPeer } from './redact.mjs';
import { isShellToolCall } from './shell-tools.mjs';
import { commandKey, isWaitingCommand } from './task-commands.mjs';

export const SESSION_COMMAND_MINUTES = 5;
/** 知らせを渡そうとしてから、受け取られないまま人へ知らせるまで */
export const FALLBACK_MS = 3 * 60_000;
const NOTICED_MAX = 50;
const TICK_MS = 15_000;

/**
 * @param {{
 *   minutes?: number, fallbackMs?: number, now?: () => number, tickMs?: number | null,
 *   delegated: (sessionId: string) => boolean,
 *   waiting: (sessionId: string) => boolean,
 *   deliver: (sessionId: string, command: object, hooks: { accept: () => void, requeue: () => void }) => Promise<'ok'|'requeue'|'error'>,
 *   raise?: (sessionId: string, command: object) => void,
 *   settle?: (sessionId: string, command: object) => void,
 * }} options
 */
export function createSessionCommands({ minutes = Number(process.env.AGENT_HOST_SESSION_COMMAND_MINUTES ?? SESSION_COMMAND_MINUTES),
  fallbackMs = Number(process.env.AGENT_HOST_SESSION_COMMAND_FALLBACK_MS) || FALLBACK_MS, now = Date.now, tickMs = null,
  delegated, waiting, deliver, raise = () => {}, settle = () => {} }) {
  const limitMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  // 見回りの間隔は、上限の 5 分の 1（試験で上限を短くしたとき用）と 15 秒の小さい方。0 は見回らない（tick を呼ぶ側が回す）
  tickMs ??= Math.min(TICK_MS, Math.max(100, limitMs / 5));
  const commands = new Map();   // `${sessionId}\n${id}` -> 控え
  const noticed = new Map();    // sessionId -> 知らせたコマンドの commandKey（古い順）
  const key = (sessionId, id) => `${sessionId}\n${id}`;
  let timer = null;

  function add(sessionId, row) {
    if (!limitMs || !sessionId || delegated(sessionId)) return;
    if (isWaitingCommand(row.command)) return;
    const k = key(sessionId, row.id);
    if (commands.has(k)) return;
    commands.set(k, { sessionId, ...row, pausedMs: 0, pausedAt: null, notified: false, attemptAt: null, acceptedAt: null, raised: false, delivering: false });
    arm();
  }
  function remove(sessionId, id) {
    const k = key(sessionId, id);
    const c = commands.get(k);
    if (!c) return;
    commands.delete(k);
    if (c.raised) settle(sessionId, view(c));
    if (!commands.size) disarm();
  }
  const elapsed = (c, at) => Math.max(0, at - c.startedAt - c.pausedMs - (c.pausedAt != null ? at - c.pausedAt : 0));
  const view = (c) => ({ id: c.id, source: c.source, command: c.command, cwd: c.cwd, startedAt: c.startedAt, elapsedMinutes: Math.floor(elapsed(c, now()) / 60_000) });
  const remember = (sessionId, text) => {
    const list = noticed.get(sessionId) ?? [];
    list.push(commandKey(text));
    noticed.set(sessionId, list.slice(-NOTICED_MAX));
  };
  const wasNoticed = (sessionId, text) => (noticed.get(sessionId) ?? []).includes(commandKey(text));

  function observe(sessionId, event) {
    if (!sessionId || !event?.type) return;
    if (event.type === 'tool.start' && event.id && isShellToolCall(event) && !event.input?.rejected) {
      const input = event.input ?? {};
      const started = Number.isFinite(event.startedAt) ? event.startedAt : Number.isFinite(event.at) ? event.at : now();
      add(sessionId, { id: event.id, source: 'native', command: redactForPeer(String(input.command ?? input.CommandLine ?? input.cmd ?? ''), 2000),
        cwd: redactForPeer(String(input.cwd ?? input.Cwd ?? input.workdir ?? ''), 1000), startedAt: started });
      return;
    }
    if (event.type === 'tool.result' && event.id) { remove(sessionId, event.id); return; }
    // 裏へ回ったコマンド（Claude の run_in_background など）は、エージェントが待っていないので知らせない
    if (event.type === 'task.command' && event.id && ['background', 'completed', 'failed', 'stopped', 'killed', 'declined'].includes(event.state)) {
      remove(sessionId, event.id); return;
    }
    if (event.type === 'turnResult') {
      for (const c of [...commands.values()]) if (c.sessionId === sessionId && c.source === 'native') remove(sessionId, c.id);
    }
  }

  /** ply_shell のジョブ（run の待ち・start の裏）を見張る */
  function track(sessionId, { id, command, cwd = '', startedAt = now() }) {
    add(sessionId, { id, source: 'ply', command: redactForPeer(String(command ?? ''), 2000), cwd: redactForPeer(String(cwd ?? ''), 1000), startedAt });
  }
  const untrack = (sessionId, id) => remove(sessionId, id);

  async function attempt(c) {
    if (c.delivering) return;
    c.delivering = true;
    c.attemptAt ??= now();
    const hooks = {
      accept: () => { c.acceptedAt ??= now(); if (c.raised) { c.raised = false; settle(c.sessionId, view(c)); } },
      requeue: () => { c.notified = false; },
    };
    let result;
    try { result = await deliver(c.sessionId, view(c), hooks); }
    catch { result = 'error'; }
    finally { c.delivering = false; }
    if (result === 'requeue') c.notified = false;
  }

  function tick() {
    const at = now();
    for (const c of commands.values()) {
      const blocked = waiting(c.sessionId);
      if (blocked && c.pausedAt == null) c.pausedAt = at;
      if (!blocked && c.pausedAt != null) { c.pausedMs += at - c.pausedAt; c.pausedAt = null; }
      if (blocked) continue;
      if (!c.notified && elapsed(c, at) >= limitMs) {
        if (c.attemptAt == null && wasNoticed(c.sessionId, c.command)) { c.notified = true; c.acceptedAt = at; continue; }
        c.notified = true;
        if (c.attemptAt == null) remember(c.sessionId, c.command);
        void attempt(c);
      }
      if (c.attemptAt != null && c.acceptedAt == null && !c.raised && at - c.attemptAt >= fallbackMs) {
        c.raised = true;
        raise(c.sessionId, view(c));
      }
    }
  }
  function arm() { if (!timer && tickMs > 0) { timer = setInterval(tick, tickMs); timer.unref?.(); } }
  function disarm() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    observe, track, untrack, tick,
    /** 会話のいま見張っているコマンド（試験・診断用） */
    list: (sessionId) => [...commands.values()].filter((c) => !sessionId || c.sessionId === sessionId).map(view),
    /** 会話を消した・閉じた */
    forget(sessionId) { for (const c of [...commands.values()]) if (c.sessionId === sessionId) remove(sessionId, c.id); noticed.delete(sessionId); },
    close() { disarm(); commands.clear(); noticed.clear(); },
  };
}
