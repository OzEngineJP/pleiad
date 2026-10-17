// 秘密情報の値を、画面・リモート・AI への返りに出す前に伏せる（ADR 0217「値を外に出さない」）。
//
// エージェントがシェルで値を表示すると、値はツールの結果としてイベントに乗る。登録した秘密の値（8 文字以上）と完全に一致する部分だけを
// MASK に置き換える。形で伏せる core/redact.mjs とは別で、値を知っているものだけを確実に伏せる。変数（秘密でない値）は伏せない
// （Cursor の「Redacted」で、伏せた印をモデルがファイルに書き戻す事故が報告されている）。
export const SECRET_MASK = '***';

/**
 * 流れで届く文（エージェントの返答の text.delta・思考の thinking.delta・`!` の行の shell.output）の伏せ方。
 * 値は小さな切れ端にまたがって届くので、1 通ずつ伏せるだけでは漏れる。会話（と行・流れ）ごとに、値の書き出しに当たる末尾だけを持ち越し、
 * 次の切れ端とつないでから伏せる。同じ会話のほかの出来事（text.end・tool.start・shell.done など）が来たら、持ち越した分を先に出す。
 * process(event) は、送る出来事の列を返す（持ち越して空になった切れ端は出さない）
 */
export const STREAM_TYPES = Object.freeze(['text.delta', 'thinking.delta', 'shell.output']);
export function createStreamMasker(masker, { types = STREAM_TYPES } = {}) {
  const held = new Map();   // 流れの鍵 -> { text, template }
  const keyOf = ev => [ev.sessionId ?? '', ev.type, ev.runId ?? '', ev.stream ?? ''].join('\0');
  return {
    process(event) {
      if (!masker.size && !held.size) return [event];
      if (types.includes(event?.type) && typeof event.text === 'string') {
        const key = keyOf(event);
        const before = held.get(key);
        const text = masker.text((before?.text ?? '') + event.text);
        const keep = masker.size ? masker.partial(text) : 0;
        if (keep) held.set(key, { text: text.slice(text.length - keep), template: event }); else held.delete(key);
        const now = text.slice(0, text.length - keep);
        return now ? [{ ...event, text: now }] : [];
      }
      const out = [];
      if (event?.sessionId) {
        for (const [key, h] of held) {
          if (h.template.sessionId !== event.sessionId) continue;
          held.delete(key);
          out.push({ ...h.template, text: h.text });
        }
      }
      out.push(event);
      return out;
    },
    get holding() { return held.size; },
  };
}

/** 値を JSON の文字列の中に入れたときの形（"…" の中身） */
const jsonForm = value => JSON.stringify(value).slice(1, -1);

/**
 * 伏せる口。values() は伏せる値の一覧（長い順。core/secrets.mjs の maskValues）を返す。
 * 値は送るたびに読まず、refresh() で読み直したものを使う（送る口は同期で、待てない）
 */
export function createSecretMasker() {
  let plain = [];
  let encoded = [];
  return {
    /** 値の一覧を差し替える */
    set(values) {
      const list = [...new Set((values ?? []).filter(v => typeof v === 'string' && v.length >= 8))].sort((a, b) => b.length - a.length);
      plain = list;
      encoded = [...new Set(list.flatMap(v => [jsonForm(v), v]))].sort((a, b) => b.length - a.length);
    },
    get size() { return plain.length; },
    /** text の末尾が、どれかの値の書き出し（値そのものより短い）になっている長さ。無ければ 0（流れの続きで値が完成するかもしれない分） */
    partial(text) {
      let keep = 0;
      for (const v of plain) {
        for (let k = Math.min(v.length - 1, text.length); k > keep; k--) {
          if (text.endsWith(v.slice(0, k))) { keep = k; break; }
        }
      }
      return keep;
    },
    /** 素の文字列から伏せる */
    text(value) {
      if (!plain.length || typeof value !== 'string') return value;
      let out = value;
      for (const v of plain) if (out.includes(v)) out = out.split(v).join(SECRET_MASK);
      return out;
    },
    /** JSON に直した文字列から伏せる（WS へ送る前。値に " や \ が入っていても、JSON の中の形で探す） */
    json(serialized) {
      if (!encoded.length || typeof serialized !== 'string') return serialized;
      let out = serialized;
      for (const v of encoded) if (out.includes(v)) out = out.split(v).join(SECRET_MASK);
      return out;
    },
    /** 値（オブジェクト・配列・文字列）を深くたどって伏せる。変わらなければ同じものを返す */
    deep(value) {
      if (!plain.length) return value;
      if (typeof value === 'string') return this.text(value);
      if (Array.isArray(value)) { let changed = false; const out = value.map(v => { const m = this.deep(v); if (m !== v) changed = true; return m; }); return changed ? out : value; }
      if (value && typeof value === 'object') {
        let changed = false; const out = {};
        for (const [k, v] of Object.entries(value)) { const m = this.deep(v); if (m !== v) changed = true; out[k] = m; }
        return changed ? out : value;
      }
      return value;
    },
  };
}
