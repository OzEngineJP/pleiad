// .env の取り込み（設定 › 秘密情報と変数。ADR 0215）の読み方と、名前の決まり。画面と試験が同じものを使う（純粋な関数だけ）。
//
// 読む形: KEY=VALUE（前に export を付けてもよい）。# で始まる行と空行は飛ばす。値は "…"（\n \t \" \\ を解く）・'…'（そのまま）・裸（行末の # 以降の注記を外す）。
// = の無い行・名前の形が違う行は malformed に入れる（読めなかった行として数える）。

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_EXACT = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'ELECTRON_RUN_AS_NODE', 'CLAUDE_ENV_FILE']);
const RESERVED_PREFIXES = ['AGENT_HOST_', 'PLEIAD_', 'PLY_', 'AGENT_BROWSER_'];
/** 使えない名前（core/secrets.mjs の reservedEnvName と同じ。サーバーも断る） */
export const reservedName = name => {
  const upper = String(name ?? '').toUpperCase();
  return RESERVED_EXACT.has(upper) || RESERVED_PREFIXES.some(p => upper.startsWith(p));
};
/** 名前が秘密らしいか（取り込みで、最初から秘密に付ける。core/secrets.mjs の looksSecret と同じ） */
export const looksSecret = name => /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i.test(String(name ?? ''));

/** @returns {{ entries: Array<{ name: string, value: string }>, malformed: string[] }} 同じ名前は後の行が勝つ */
export function parseDotenv(text) {
  const byName = new Map();
  const malformed = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !ENV_NAME.test(m[1])) { malformed.push(line); continue; }
    let value = m[2];
    if (value.startsWith('"')) {
      // 閉じの " まで 1 文字ずつ読む（\ の後の文字は解く。閉じが無ければ次の行へ続ける）
      let out = '', j = 1, rest = value;
      for (;;) {
        if (j >= rest.length) {
          if (i + 1 < lines.length) { rest += '\n' + lines[++i]; continue; }
          break;
        }
        const c = rest[j];
        if (c === '\\' && j + 1 < rest.length) {
          const next = rest[j + 1];
          out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[next] ?? `\\${next}`;
          j += 2;
          continue;
        }
        if (c === '"') break;
        out += c; j++;
      }
      value = out;
    } else if (value.startsWith("'")) {
      const close = value.indexOf("'", 1);
      value = close < 0 ? value.slice(1) : value.slice(1, close);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    byName.set(m[1], value);
  }
  return { entries: [...byName].map(([name, value]) => ({ name, value })), malformed };
}
