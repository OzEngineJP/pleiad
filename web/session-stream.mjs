// Only display events are replayed: settings, permissions and other commands
// keep their ordinary delivery path. Shared with the server's live snapshot.
export const streamEvents = new Set([
  // 配達の合図も replay する（開き直したときに、渡り終えた発言が「渡していない」まま固まらないように）
  "userMessage", "userMessage.delivered", "userMessage.dropped", "taskInstruction", "text.delta", "text.end", "thinking.start", "thinking.delta",
  "tool.start", "tool.result", "activity", "present", "turnResult", "turnEnd", "taskNotice", "interruptionNote", "compaction", "contextRebuild", "contextWindow",
]);

/** Keep events until the history has been painted (branch junctions are placed afterwards). */
export function createSessionLoads() {
  const pending = new Set();
  return {
    /** 持っている読み込みを全部捨てる（実例を閉じるとき。流し直しは active() が偽になって止まる） */
    cancel() { pending.clear(); },
    begin(id) {
      const load = { id, events: [] };
      pending.add(load);
      return load;
    },
    capture(event, current) {
      if (!streamEvents.has(event.type)) return false;
      let defer = false;
      for (const load of pending) {
        if (load.id !== event.sessionId) continue;
        load.events.push(event);
        if (current === load.id) defer = true;
      }
      return defer;
    },
    finish(load, data) {
      pending.delete(load);
      return [...(data.stream?.events ?? []),
        ...load.events.filter(e => e.streamSeq > data.streamCursor)];
    },
    /** Restore in bounded tasks while new display events stay behind the snapshot. */
    async replay(load, data, { apply, paint = fn => fn(), current = () => true,
      yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)), now = () => performance.now(), budget = 8 } = {}) {
      const snapshot = data.stream?.events ?? [];
      let head = 0, received = 0;
      const active = () => pending.has(load) && current();
      try {
        if (snapshot.length > 64) await yieldTask();
        while (active()) {
          paint(() => {
            const started = now();
            let count = 0;
            while (active()) {
              let event;
              if (head < snapshot.length) event = snapshot[head++];
              else if (received < load.events.length) {
                event = load.events[received++];
                if (!(event.streamSeq > data.streamCursor)) continue;
              } else break;
              apply(event);
              // A count bound also protects against coarse or stubbed clocks.
              if (++count >= 64 || now() - started >= budget) break;
            }
          });
          if (!active()) return false;
          if (head === snapshot.length && received === load.events.length) return true;
          await yieldTask();
        }
        return false;
      } finally { pending.delete(load); }
    },
    isPending(load) { return pending.has(load); },
    cancel(load) { pending.delete(load); },
  };
}
