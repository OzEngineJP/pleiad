// 声で確定した発言を Chats の会話へ送る（承認済み 2026-10-07。docs/voice-call.md「送信」）。
//
// 入力欄を通さない。入力欄に書いて submit() を呼ぶやり方は、送信中（submittingMessages）なら黙って return して 2 通目が入力欄に残り、
// 1 通目は await のあとで入力欄を読むので 2 通目が混ざり、書きかけの文にも触れていた。ここでは本文を直に sendMessage へ渡し、
// 受理された発言を会話の中の行に置く（状態は web/voice/delivery.mjs の 3 つの言い方）。呼ぶ側（index.mjs）が直列に呼ぶので、順番は守られる。
// 送り先は呼ぶ側が発言の確定の時に決めた会話（話していた会話）。キューの順番を待つ間に画面が別の会話へ移っても、その会話へ送る（ADR 0347）。
import { t } from '../i18n.mjs';

/**
 * @param {object} o
 * @param {{ current: string|null, busy: boolean, loadingSession: string|null, cwd: string, mode: string }} o.state
 * @param {(command: string, args?: object) => Promise<any>} o.cmd
 * @param {() => string} o.randomId
 * @param {() => string|null} o.freshId  作ったばかりの会話を開いている間の id（client.mjs の freshSessionId）
 * @param {() => Promise<string|null>} o.ensureSession  会話がまだ無い（作っている途中）なら作って、できた id を返す。できなければ null
 * @param {(sessionId: string) => Promise<void>} o.settingsSettled  設定の保存が済むまで待つ（押した時の設定を添えられないときだけ）
 * @param {(sessionId: string) => object|undefined} [o.captureSettings]  その会話を開いて落ち着いているときの、入力欄の今の設定（sendMessage の settings）
 * @param {(sessionId: string, messageId: string, text: string) => void} o.place  受理された発言を会話の行に置く（送信中の一行つき）
 * @param {ReturnType<import('./delivery.mjs').createVoiceDelivery>} o.delivery
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export function createChatVoiceSender({ state, cmd, randomId, freshId, ensureSession, settingsSettled, captureSettings = () => undefined, place, delivery }) {
  const writable = (id) => {
    if (state.sessions?.find(s => s.id === id)?.deletedBot) throw new Error(t('ui:deletedBotReadOnly'));
  };
  const notSent = () => new Error(t('voice.note.notSent'));

  /**
   * 送る。受理されたら返る。送れなかったら投げる（発言は入力欄へ戻さない。画面は失敗の一行を出す）。
   * to = { sessionId, fresh? }: 話していた会話（発言を確定した時に決めたもの）。fresh は新しい会話の欄で話したとき（まだ会話が無いので作る）。
   * 省くと、いま開いている会話。送った後、その会話をまだ開いていれば会話の行に置く（移っていれば行・入力欄には触れない）
   */
  return async function send(text, to = null) {
    to ??= { sessionId: state.current && state.current !== freshId() ? state.current : null, fresh: true };
    let sessionId = to.sessionId;
    if (!sessionId) {
      // 新しい会話の欄で話した。まだその欄を開いているときだけ会話を作る（ほかの会話へ移っていたら、そこへは送らない）
      if (!to.fresh || (state.current && state.current !== freshId())) throw notSent();
      sessionId = await ensureSession();
      if (!sessionId) throw notSent();
    }
    writable(sessionId);
    // その会話を開いて落ち着いていれば、入力欄の今の設定を一緒に送る（サーバーが届ける前に会話を整える。メインの送信と同じ）。
    // 開いていなければ設定は添えず、その会話の保存済みの設定で届ける（保存が済むのを待つ）
    const settings = captureSettings(sessionId);
    if (!settings) {
      await settingsSettled(sessionId).catch(() => {});
      writable(sessionId);
    }
    const messageId = randomId();
    const shown = state.current === sessionId;
    if (shown) delivery.claim(messageId);
    try {
      await cmd('sendMessage', { sessionId, messageId, prompt: text, ...(settings ? { settings } : {}) });
    } catch (e) { if (shown) delivery.release(messageId); throw e; }
    if (shown && state.current === sessionId) place(sessionId, messageId, text);
    else if (shown) delivery.release(messageId);
    return { sessionId, messageId };
  };
}
