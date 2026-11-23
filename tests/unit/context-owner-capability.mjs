// Pleiad のコンテキスト（ply_context）を受け取れるかは、バックエンドの能力と担当の組み合わせで決まる。
// 会話の右パネルで担当を選ぶ面は ADR 0348 で無くした（場所ごとの設定は設定 › プラグインの範囲で変える）ので、ここでは実行時の判定だけを確かめる。
import { createGrokBackend } from '../../core/backends/grok.mjs';
import { acceptsPlyContext } from '../../core/context-runtime.mjs';

export const name = 'context-owner-capability';
export const title = 'Pleiad のコンテキストを受け取れるかを、バックエンドの能力と担当から決める';

export default async function (t) {
  const grok = createGrokBackend({ command: () => null });
  t.ok('Grok は指示・Skills の担当によらず ply_context を受け取れる',
    acceptsPlyContext(grok, { owners: { instruction: 'ply', skill: 'native', mcp: 'ply' } })
    && acceptsPlyContext(grok, { owners: { instruction: 'native', skill: 'ply', mcp: 'ply' } })
    && acceptsPlyContext(grok, { owners: { instruction: 'native', skill: 'native', mcp: 'ply' } }));
}
