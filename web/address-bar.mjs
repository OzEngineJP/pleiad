// 右の欄のアドレスバー（ADR 0291 の 2）。web/browser-unify.mjs が組む。S0 では何もしない。中身は B1 が置く（文言は tabs:address.*）。

/** @returns {{ show(tab: object | null): void }} */
export function createAddressBar(deps = {}) {
  void deps;
  return { show() {} };
}
