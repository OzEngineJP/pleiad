// スマホで映像の上に重ねる入力欄（ADR 0293 の 2）。web/browser-unify.mjs が組む。S0 では何もしない。中身は B2 が置く（文言は control:*）。

/** @returns {{ focus(field: object | null): void }} */
export function createPhoneInput(deps = {}) {
  void deps;
  return { focus() {} };
}
