// 右の欄のタブの列（ADR 0291 の 2）。web/browser-unify.mjs が組む。S0 では何もしない。中身は B1 が置く（文言は tabs:strip.*）。

/** @returns {{ update(tabs: object[]): void }} */
export function createTabStrip(deps = {}) {
  void deps;
  return { update() {} };
}
