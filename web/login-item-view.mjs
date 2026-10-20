// サインイン時の起動（設定 › アプリ情報・更新 › 常駐。ADR 0175）の表示の決め方。state は preload の plyDesktop.loginItem.get() の戻り
// （OS の登録を読み直した { supported, reason?, enabled, blocked }）。DOM は web/resident-settings.mjs が持つ。

/**
 * @param state { supported, enabled, blocked } か、読めていないとき null / undefined
 * @returns {{ visible:boolean, checked:boolean, blocked:boolean }}
 */
export function loginItemView(state) {
  if (!state?.supported) return { visible: false, checked: false, blocked: false };
  return { visible: true, checked: state.enabled === true, blocked: state.blocked === true };
}
