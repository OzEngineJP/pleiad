// 送れなかった発言の行（docs/design-system.md「エージェントの行」の「送れなかったとき」）。
// 送れなかった原因が「エージェントがまだ使えない」ことなら、原因の一文と、設定と同じ形の行（ロゴの列なし）をその場に出す。
// 直したら「再送する」が塗りになる（自動では送らない。押したときに、同じ発言を送り直す）。
//   本体も SDK も残る: 原因 = 本体の段（見つかりません / ログインが要る）。行は 2 つ並び、塗りは本体の一歩・SDK は静かなボタン
//   本体が済んで SDK が残る: SDK の一文と、SDK の行（「取得する」が塗り）
//   SDK を持たないエージェントの未ログイン: 原因 1 行と、塗りの「ログイン」（待つ間は「ログインを待っている」と「やめる」）
//   どちらも済んだ: 「再送する」が塗り
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { bodyButton, sdkKey } from './agent-row.mjs';

/** 直せる原因か（usableReport の levels の 1 件）。分からない・使えるものは触らない */
export const fixable = (lv) => Boolean(lv) && (lv.level === 'no' || lv.reason === 'sdkFetching') && lv.reason !== 'unconfirmed' && lv.reason !== 'checkFailed';

/**
 * status（.outbox-status）の中身を描く。何度でも呼べる（状態が変わるたびに描き直す）。
 * o: { agent, st, kit, level, on: { resend, cancel } }
 */
export function paintSendFailure(status, { agent, st, kit, level, on }) {
  const body = kit.bodyOf(agent);
  const sdk = sdkKey(st);
  const usable = level.level === 'usable';
  const cancel = el('button', 'btn', t('chat.sendFail.cancel'));
  cancel.type = 'button'; cancel.dataset.fix = 'cancel';
  cancel.onclick = () => on.cancel?.();
  const acts = el('div', 'acts');
  const parts = [el('div', 'fail-head', t('chat.delivery.failed'))];
  const cause = (text) => parts.push(el('div', 'fail-cause', text));
  const rowsOf = (sdkOnly, near) => { const w = el('div', 'fail-rows'); w.append(kit.build(agent, { logo: false, near, sdkOnly })); parts.push(w); };
  if (usable) {
    const b = el('button', 'btn btn-primary', t('chat.sendFail.resend'));
    b.type = 'button'; b.dataset.fix = 'resend';
    b.onclick = () => on.resend?.(b);
    acts.append(b, cancel);
  } else if (st?.sdk && body === 'ok') {
    cause(t('chat.sendFail.sdkNeed', { version: st.sdk.version ?? '' }));
    rowsOf(true, { id: agent.id, step: 'sdk' });
    acts.append(cancel);
  } else if (st?.sdk || body === 'noinst' || body === 'waiting-install') {
    cause(body === 'noinst' || body === 'waiting-install' ? t('chat.sendFail.notFound', { agent: agent.label }) : t('app.authNeed', { agents: agent.label }));
    rowsOf(false, ['noinst', 'nologin', 'expired'].includes(body) ? { id: agent.id, step: 'body' } : null);
    acts.append(cancel);
  } else {
    cause(t('app.authNeed', { agents: agent.label }));
    if (body === 'pending') { const run = el('div', 'fix-run'); const s = el('span', 'st wait'); s.append(runMark(), t('settings.agents.loginPending')); run.append(s); parts.push(run); }
    const b = bodyButton(agent, body, { primary: true, on: kit.on });
    if (b) acts.append(b);
    acts.append(cancel);
  }
  parts.push(acts);
  status.replaceChildren(...parts);
}
