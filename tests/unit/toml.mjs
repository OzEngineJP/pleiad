import { isDeepStrictEqual } from 'node:util';
import { parseToml } from '../../core/toml.mjs';
export const name = 'toml';
export const title = 'TOML の解析: JSON.parse と同じ普通のオブジェクトで返し、__proto__ のキーで prototype を汚さない';
export default async function(t) {
  const v = parseToml('a = [1, { b = 2 }]\n[t]\nx = 1\n[t.u]\nz = "s"\n[[arr]]\ny = 2\n');
  const protos = [v, v.t, v.t.u, v.a[1], v.arr[0]].map(o => Object.getPrototypeOf(o));
  t.ok('表・インラインの表・表の配列の要素は Object.prototype を持つ', protos.every(p => p === Object.prototype));
  t.ok('同じ内容の普通のオブジェクトと isDeepStrictEqual で等しい', isDeepStrictEqual(v, { a: [1, { b: 2 }], t: { x: 1, u: { z: 's' } }, arr: [{ y: 2 }] }));
  const p = parseToml('"__proto__" = { polluted = true }\n');
  t.ok('__proto__ は自前のプロパティとして残り、prototype は変わらない', Object.hasOwn(p, '__proto__') && Object.getPrototypeOf(p) === Object.prototype && p.polluted === undefined && ({}).polluted === undefined);
  t.ok('JSON.parse の結果と同じ形', isDeepStrictEqual(p, JSON.parse('{"__proto__":{"polluted":true}}')));
}
