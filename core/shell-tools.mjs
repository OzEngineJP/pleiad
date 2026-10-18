// シェルのコマンドを走らせるネイティブのツールの見分け。正本はエージェントの記述（core/backends/agents.mjs）の shellTools。
// 長いコマンドの知らせ（core/task-commands.mjs）・声の待ちの案内（core/voice/wait-voice.mjs）が、ここだけを見る。
// エージェントを足すときは、記述に名前を書く。名前で見分けられないもの（ACP の自由な題）は、バックエンドが tool.start に shell: true を付ける。
import { AGENTS } from './backends/agents.mjs';

/** 全エージェントのシェルのツールの名前（大文字と小文字を区別する） */
export const SHELL_TOOL_NAMES = Object.freeze([...new Set(Object.values(AGENTS).flatMap((a) => a.shellTools ?? []))]);
const NAMES = new Set(SHELL_TOOL_NAMES);

/** tool.start（か、その名前と印を持つもの）がシェルのコマンドか */
export const isShellToolCall = (event) => event?.shell === true || NAMES.has(String(event?.name ?? ''));
