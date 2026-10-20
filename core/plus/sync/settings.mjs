// 同期で運ぶ設定の口（targets.mjs の settings）。defineSetting の定義（core/ops/settings.mjs）の read・normalize・write を通す。
//
//   運ぶのは sync の設定（sync: false・読むだけのものは運ばない）のうち、既定の値でないものだけ
//   受けた値は画面や AI からの変更と同じ検査（schema・normalize）を通してから書く。通らない値（この PC に無いエージェント・モデルなど）は書かない
//   既定に戻す（消した項目を受けた）: 既定の値を書く。それで戻らない設定（足し合わせて書くもの）は null で消す
import { stableStringify } from '../../ops/registry.mjs';

const same = (a, b) => stableStringify(a) === stableStringify(b);

/**
 * @param {object} o
 * @param {object[]} o.settings  defineSetting の結果の一覧
 * @param {() => object} o.ctx   設定の read・write に渡す ctx（server.mjs の opsDeps と同じ形）
 * @param {(keys: string[]) => void} [o.onWritten] 書いたあと（画面へ配る）
 * @param {(line: string) => void} [o.log]
 */
export function createSyncSettings({ settings, ctx, onWritten = () => {}, log = () => {} }) {
  const synced = new Map(settings.filter(s => s.sync && !s.readOnly).map(s => [s.key, s]));

  const read = async (s, c) => (await s.read(c)) ?? s.default;

  async function list() {
    const c = ctx();
    const out = [];
    for (const s of synced.values()) {
      let value;
      try { value = await s.read(c); } catch { continue; }
      if (value === undefined || value === null || same(value, s.default)) continue;
      out.push({ key: s.key, value });
    }
    return out;
  }

  /** 検査して書く。通らなければ false */
  async function apply(s, c, value) {
    const schema = s.writeSchema ?? (s.normalize ? null : s.schema);
    if (schema) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return false;
      value = parsed.data;
    }
    const before = await read(s, c);
    const done = s.normalize ? await s.normalize(c, value, { before }) : { after: value };
    await s.write(c, done.arg ?? done.after, { before });
    return true;
  }

  async function write(key, value) {
    const s = synced.get(key);
    if (!s) return false;
    const c = ctx();
    try {
      if (!(await apply(s, c, value))) { log(`sync: setting not applied (${key})`); return false; }
    } catch (e) {
      log(`sync: setting not applied (${key}: ${e?.code ?? 'error'})`);
      return false;
    }
    onWritten([key]);
    return true;
  }

  async function reset(key) {
    const s = synced.get(key);
    if (!s) return false;
    const c = ctx();
    try {
      await apply(s, c, s.default);
      if (!same(await read(s, c), s.default)) await apply(s, c, null);
    } catch (e) {
      log(`sync: setting not reset (${key}: ${e?.code ?? 'error'})`);
      return false;
    }
    onWritten([key]);
    return true;
  }

  return { list, write, reset, has: key => synced.has(key) };
}
