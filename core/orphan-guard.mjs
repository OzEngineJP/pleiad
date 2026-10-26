// main が切断された後、作業が無い状態が続いたら server を通常終了させる。
export const ORPHAN_IDLE_MS = 3 * 60 * 1000;
export const ORPHAN_CHECK_MS = 5000;

/**
 * @param isBusy    () => Promise<boolean>|boolean  作業（ターン・承認待ち・委譲など）が 1 件でもあるか
 * @param onExpire  ({ reason }) => void  作業が無いまま上限を過ぎた。サーバーを終わらせる
 */
export function createOrphanGuard({ isBusy, onExpire, idleMs = ORPHAN_IDLE_MS, checkMs = ORPHAN_CHECK_MS,
  now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval, log = () => {} } = {}) {
  let away = false;
  let idleSince = null;
  let timer = null;
  let checking = false;

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  async function check() {
    if (!away || checking) return;
    checking = true;
    try {
      if (await isBusy()) { idleSince = null; return; }
      if (!away) return;
      idleSince ??= now();
      if (now() - idleSince >= idleMs) {
        stop();
        away = false;
        log(`no main for ${Math.round((now() - idleSince) / 1000)}s with no work (lost): shutting down`);
        onExpire({ reason: 'lost' });
      }
    } catch (error) {
      log(`orphan check failed: ${error?.message ?? error}`);
    } finally { checking = false; }
  }

  return {
    /** main が切れた。見張りを始める */
    disconnected() {
      away = true;
      idleSince = null;
      stop();
      timer = setTimer(() => { void check(); }, checkMs);
      timer?.unref?.();
    },
    connected() {
      away = false;
      idleSince = null;
      stop();
    },
    check,
    get away() { return away; },
  };
}
