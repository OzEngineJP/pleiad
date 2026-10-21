// 端末のコマンドで入るログイン（OpenCode・Antigravity・Devin・Grok）の見張りを、やめられるようにする（authCancel。ADR 0243）。
// 見張りは「少し待って、ログインが済んだか確かめる」の繰り返し。begin() で 1 回分を始め、pause(ms) で次の確かめまで待つ。
// cancel() は待ちをすぐ起こし、見張りは CANCELLED の失敗で返る（確かめている最中なら、確かめ終えたところで返る）
import { t } from '../i18n.mjs';

/** やめたログインの失敗（authLogin はこの code で返り、画面は失敗として出さない） */
export const loginCancelledError = agent => Object.assign(new Error(t('accounts.backend.loginCancelled', { agent })), { code: 'CANCELLED' });

/** 時間切れの失敗（画面は「時間切れになりました」をカードに出す） */
export const loginTimeoutError = message => Object.assign(new Error(message), { code: 'TIMEOUT' });

export function createLoginWatch(agent) {
  const runs = new Set();
  return {
    begin() {
      const run = { cancelled: false, wake: null };
      runs.add(run);
      return {
        /** やめられていたら CANCELLED で投げる */
        check() { if (run.cancelled) throw loginCancelledError(agent); },
        async pause(ms) {
          if (!run.cancelled) await new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            timer.unref?.();
            run.wake = () => { clearTimeout(timer); resolve(); };
          });
          run.wake = null;
          this.check();
        },
        end() { runs.delete(run); },
      };
    },
    /** 待っているログインをやめる（同時に待っているものは全部）。待っていなければ何もしない */
    cancel() {
      if (!runs.size) return { cancelled: false };
      for (const run of runs) { run.cancelled = true; run.wake?.(); }
      runs.clear();
      return { cancelled: true };
    },
  };
}
