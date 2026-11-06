// Chrome が無いときのページの iframe と postMessage の受け口（ADR 0291 の 3・0292 の 2）。web/browser-unify.mjs が組む。S0 では何もしない。中身は B3 が置く（文言は pages:*）。

/** @returns {{ open(url: string): void, close(): void }} */
export function createPageFrame(deps = {}) {
  void deps;
  return { open() {}, close() {} };
}
