import { t } from './i18n.mjs';

// A synchronous lease prevents new work between the idle check and shutdown.
export function createUpdateGate() {
  let active = 0, locked = false;
  return {
    enter({ blocking = true } = {}) {
      if (locked) throw new Error(t('update.preparing'));
      // Reads may be waiting on an unresponsive agent. They have no pending
      // write to protect, but must still respect a lease already acquired.
      if (!blocking) return () => {};
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
    acquire(busy = false) { if (locked || active || busy) return false; locked = true; return true; },
    release() { locked = false; },
    get locked() { return locked; },
  };
}
