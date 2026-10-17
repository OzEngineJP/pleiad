// TOML の解析。smol-toml 1.9 からは表を prototype の無いオブジェクトで返すので、JSON.parse と同じ形の
// 普通のオブジェクトに直して返す（isDeepStrictEqual の比較と、表の展開・JSON との突き合わせを今のままにする）。
// Object.fromEntries は `__proto__` のようなキーも自前のプロパティとして置くので、prototype を汚さない。
import { parse } from 'smol-toml';

const plain = v => {
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

export const parseToml = (text, options) => plain(parse(text, options));
