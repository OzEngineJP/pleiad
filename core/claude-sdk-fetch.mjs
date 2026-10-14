// 新しい版へ切り替える前に、その版が固定した Claude Agent SDK を取っておく（ADR 0206。無停止の更新の design.md §5.1）。
// 新しい main が、組み終えた実行場所の pleiad-node.exe で `app\<新>\core\claude-sdk-fetch.mjs` を走らせ、標準出力の最後の行の JSON を読む
// （desktop/switch.cjs の runClaudeSdkFetch）。走っている古いサーバーとデータ置き場を分け合うが、触るのは claude-sdk\<新しい版>\ だけで、
// 展開は一時フォルダーから名前を替えて置くので、古いサーバーが読んでいる版とはぶつからない。
// 出力 { fetch: 1, source, version, ready, consent, kind?, detail? }。
//   ready    新しい版のサーバーが、取得を待たずに SDK を読める（local か、置き場に固定の版がある）
//   consent  取得への同意がある。無ければ取らない（利用者が案内を見ていない。ready: false のまま返す）
//   kind     取れなかったときの理由（core/claude-sdk-install.mjs の ClaudeSdkFetchError の kind）
// 取れなくても終了コードは 0（切り替えは止めない。保持役に載った Claude のターンを引き継がず、終わるのを待つだけ）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_SDK_PIN, claudeSdkSource, claudeSdkStatus, ensureClaudeSdk } from './claude-sdk.mjs';

export const FETCH_VERSION = 1;

export async function prefetchClaudeSdk({ env = process.env } = {}) {
  const base = { fetch: FETCH_VERSION, source: claudeSdkSource(env), version: CLAUDE_SDK_PIN.version };
  const before = claudeSdkStatus({ env });
  if (before.ready || !before.consent) return { ...base, ready: before.ready, consent: before.consent };
  try {
    await ensureClaudeSdk({ env });
    return { ...base, ready: claudeSdkStatus({ env }).ready, consent: true };
  } catch (err) {
    return { ...base, ready: false, consent: true, kind: err?.kind ?? 'disk', detail: String(err?.detail ?? err?.message ?? err).slice(0, 500) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await prefetchClaudeSdk();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
