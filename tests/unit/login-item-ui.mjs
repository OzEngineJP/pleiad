// サインイン時の起動の画面（設定 › アプリ情報・更新 › 常駐）の表示の決め方。DOM を持たない部分（web/login-item-view.mjs）を確かめる
import { loginItemView } from '../../web/login-item-view.mjs';

export const name = 'login-item-ui';
export const title = 'サインイン時の起動の画面: OS の実際の状態で表示し、使えない構成は出さない';

export default async function(t) {
  const on = { supported: true, enabled: true, blocked: false };
  const off = { supported: true, enabled: false, blocked: false };
  const blocked = { supported: true, enabled: false, blocked: true };

  t.ok('状態が無い（まだ読めていない）・使えない構成は出さない',
    loginItemView(null).visible === false && loginItemView(undefined).visible === false
    && loginItemView({ supported: false, reason: 'dev', enabled: false, blocked: false }).visible === false);
  t.ok('オンは OS の状態どおりスイッチが入る', (v => v.visible && v.checked === true && v.blocked === false)(loginItemView(on)));
  t.ok('オフは OS の状態どおりスイッチが切れる', (v => v.visible && v.checked === false && v.blocked === false)(loginItemView(off)));
  t.ok('OS 側で無効にされていたら blocked（スイッチは切れたまま。どこで有効にするかを言う）',
    (v => v.visible && v.checked === false && v.blocked === true)(loginItemView(blocked)));
}
