import { t } from './i18n.mjs';

// A synchronous lease prevents new work between the idle check and shutdown.
export function createUpdateGate() {
  let active = 0, turns = 0, lease;
  return {
    enter({ blocking = true, turn = false } = {}) {
      if (lease !== undefined) throw new Error(t('update.preparing'));
      // Reads may be waiting on an unresponsive agent. They have no pending
      // write to protect, but must still respect a lease already acquired.
      if (!blocking) return () => {};
      if (turn) turns++;
      else active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (turn) turns--;
        else active--;
      };
    },
    acquire(busy = false, { preservedTurns = 0, owner = null } = {}) {
      if (lease !== undefined || active || turns > preservedTurns || busy) return false;
      lease = owner;
      return true;
    },
    release(owner = null) { if (lease === owner) lease = undefined; },
    get locked() { return lease !== undefined; },
  };
}
