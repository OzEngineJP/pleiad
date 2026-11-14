// 文字列の 53 ビットの署名（cyrb53）。暗号用ではなく、同じ中身かを見分けるだけ。
// 画面（web/history-sync.mjs・web/outline.mjs）とサーバー（core/server.mjs が読む web/outline.mjs）が同じ計算を使う。
// UTF-16 のコード単位で数えるので、Node とブラウザーで同じ値になる。
export function hash53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
