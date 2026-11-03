// `codex app-server` の起動引数 `-c key=value` の値を作る（直接起動する launch と保持役の子に載せる 2 経路の共通。issue #157）。
// codex は -c の値を TOML のインライン値として読み、読めなければ文字列として扱う。値が配列・map のとき
// JSON（"key":value）で書くと TOML として読めず文字列になり、skills.config（sequence）や mcp_servers（map）で起動直後に落ちる
export function tomlValue(v) {
  if (Array.isArray(v)) return '[' + v.map(tomlValue).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k,s]) => JSON.stringify(k) + '=' + tomlValue(s)).join(',') + '}';
  return JSON.stringify(v);
}

/** config（{ 'skills.config': [...], 'mcp_servers': {...} } など）を `-c key=value` の引数列にする */
export function codexConfigArgs(config = {}) {
  return Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${tomlValue(v)}`]);
}
