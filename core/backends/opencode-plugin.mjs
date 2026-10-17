// Pleiad が OpenCode に読ませるプラグイン（docs/multi-backend.md §2.10）。本文はデータ置き場の opencode/pleiad-plugin.mjs に書き出し、
// OPENCODE_CONFIG_CONTENT の plugin に file URL で渡す（パッケージ版の asar の中は OpenCode から読めない）。
//
// プラグインの仕事は 2 つ（どちらも実機の opencode 1.19.3 で確かめた形）:
//   - tool.execute.before: Pleiad の MCP のツール（ply_*）の引数に、OpenCode の会話の id（_pleiadSession）を足す。
//     MCP の呼び出しには会話の id が載らないので、Pleiad の中継（core/opencode-relay.mjs）はこれで会話を見分ける。
//     引数はその場で書き足す（output.args を置き換えると MCP に届かない）
//   - shell.env: 会話のシェルに、その会話の環境変数（ブラウザー・操作の一覧・秘密情報）を足す。中継の /env から取る
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGIN_FILE = 'pleiad-plugin.mjs';

// OpenCode の中で動く本文。Node の組み込みも使わない（fetch と process.env だけ）
export const PLUGIN_SOURCE = `// Written by Pleiad (core/backends/opencode-plugin.mjs). Do not edit: Pleiad rewrites it when the source changes
const ENV_URL = process.env.PLEIAD_OPENCODE_ENV_URL ?? '';
const SECRET = process.env.PLEIAD_OPENCODE_SECRET ?? '';
const PLY_TOOL = /^ply_(agents|control|computer|browser|context)_/;

export const PleiadPlugin = async () => ({
  'tool.execute.before': async (input, output) => {
    if (!PLY_TOOL.test(String(input?.tool ?? '')) || !output?.args || typeof output.args !== 'object') return;
    Object.assign(output.args, { _pleiadSession: String(input.sessionID ?? '') });
  },
  'shell.env': async (input, output) => {
    if (!ENV_URL || !SECRET || !input?.sessionID || !output?.env) return;
    try {
      const res = await fetch(ENV_URL + '?session=' + encodeURIComponent(input.sessionID), { headers: { authorization: 'Bearer ' + SECRET }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const env = await res.json();
      for (const [k, v] of Object.entries(env ?? {})) if (typeof v === 'string') output.env[k] = v;
    } catch {}
  },
});
`;

/** データ置き場にプラグインを書き出し、OpenCode に渡す file URL を返す（中身が同じなら書かない） */
export function writePlugin(dataDir) {
  const dir = path.join(dataDir, 'opencode');
  const file = path.join(dir, PLUGIN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  let now = null;
  try { now = fs.readFileSync(file, 'utf8'); } catch {}
  if (now !== PLUGIN_SOURCE) fs.writeFileSync(file, PLUGIN_SOURCE);
  return pathToFileURL(file).href;
}
