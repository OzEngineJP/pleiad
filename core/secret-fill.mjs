// ply_browser の fill_secret（ADR 0215「サイトで入力する」）。登録したログイン情報を、会話の Chrome の今のタブの入力欄に入れる。
//
// 1. 会話の今のタブに中継自身のセッションを付ける（core/chrome/relay.mjs の view.attach。エージェントのセッションとは別）
// 2. selector があればその要素に、無ければ今フォーカスのある要素に。ページの origin と、入力できる要素かを読む
// 3. origin がログイン情報のサイト（https・同じホストかサブドメイン）に合うときだけ値を読む（core/secrets.mjs の loginFor）
// 4. 欄の中身を選んでから Input.insertText で入れる。入らなければ（独自の部品など）値の setter と input・change で入れる
// 返りは「入れた・入れなかった理由」の文だけ。値はエージェント・ログ・イベントに出さない。
import { agentT } from './i18n.mjs';

/** 要素を選び（selector があればフォーカスを移す）、origin と入力できるかを返す式 */
export function probeExpression(selector) {
  return `(() => {
  const sel = ${JSON.stringify(selector ?? null)};
  if (sel) { const target = document.querySelector(sel); if (!target) return { origin: location.origin, missing: true }; target.focus(); }
  const el = document.activeElement;
  const tag = el ? el.tagName : '';
  const type = el && tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
  const textInput = tag === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'file', 'hidden', 'image', 'reset', 'range', 'color'].includes(type);
  return { origin: location.origin, frame: tag === 'IFRAME' || tag === 'FRAME', editable: Boolean(el && !el.disabled && !el.readOnly && (textInput || tag === 'TEXTAREA' || el.isContentEditable)), type: type || tag.toLowerCase() };
})()`;
}
const SELECT_EXPRESSION = `(() => { const el = document.activeElement; if (el && typeof el.select === 'function') el.select(); else if (el && el.isContentEditable) document.execCommand('selectAll'); return true; })()`;
const LENGTH_EXPRESSION = `(() => { const el = document.activeElement; if (!el) return -1; return el.isContentEditable ? el.textContent.length : String(el.value ?? '').length; })()`;
const SETTER = `function (value) {
  const proto = Object.getPrototypeOf(this);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(this, value); else if (this.isContentEditable) this.textContent = value; else this.value = value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

const evaluate = async (tab, expression) => (await tab.send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

/**
 * @param {object} o
 * @param {() => object|null} o.relay  core/chrome/relay.mjs の中継（無ければ null）
 * @param {ReturnType<import('./secrets.mjs').createSecrets>} o.secrets
 */
export function createSecretFill({ relay, secrets, log = () => {} }) {
  return async function fillSecret(sessionId, { item, field, selector = null }, locale) {
    // i18n-dynamic: agent:browserBridge.fillSecret.
    const say = (ok, key, params) => ({ ok, text: agentT(locale, `browserBridge.fillSecret.${key}`, params) });
    const known = secrets.known(item);
    if (!known) return say(false, 'notFound', { item });
    if (known.kind !== 'login') return say(false, 'notLogin', { label: known.label });
    const r = relay?.();
    const targetId = r?.view?.current(sessionId);
    if (!targetId) return say(false, 'noTab');
    let tab;
    try { tab = await r.view.attach(sessionId, targetId, () => {}); }
    catch { return say(false, 'noTab'); }
    try {
      const page = await evaluate(tab, probeExpression(selector));
      if (!page?.origin || page.origin === 'null') return say(false, 'noOrigin');
      if (page.missing) return say(false, 'missing', { selector });
      let login;
      try { login = await secrets.loginFor(item, page.origin); }
      catch (e) {
        if (e?.code === 'SITE_MISMATCH') return say(false, 'mismatch', { label: known.label, origin: page.origin, sites: known.sites.join(', ') });
        throw e;
      }
      if (page.frame) return say(false, 'frame');
      if (!page.editable) return say(false, 'notEditable');
      const value = field === 'username' ? login.username : login.password;
      if (!value) return say(false, field === 'username' ? 'noUsername' : 'noValue', { label: known.label });
      await evaluate(tab, SELECT_EXPRESSION);
      await tab.send('Input.insertText', { text: value });
      if (await evaluate(tab, LENGTH_EXPRESSION) !== value.length) {
        // 入らなかった（キーボードの入力を受けない独自の部品など）。値の setter と input・change で入れる（値は CDP の引数で渡し、式の文字列には入れない）
        const { result } = await tab.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false });
        if (result?.objectId) await tab.send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: SETTER, arguments: [{ value }], returnByValue: true });
      }
      await secrets.recordUse(item, { sessionId, site: login.site });
      return say(true, field === 'username' ? 'doneUsername' : 'donePassword', { label: known.label, site: login.site });
    } catch (e) {
      log('secrets.fill_failed', { code: String(e?.code ?? '') });
      return say(false, 'failed');
    } finally {
      await tab.detach().catch(() => {});
    }
  };
}
