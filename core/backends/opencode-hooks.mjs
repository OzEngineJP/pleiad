// OpenCode の会話で、Pleiad がそろえる Hooks を走らせる（docs/multi-backend.md §2.10「Hooks」）。
//
// OpenCode にはコマンドの Hooks の形が無い（フックは JS のプラグイン）。Pleiad は登録を Claude Code の形（core/hooks-config.mjs の HOOK_EMULATED）で受け取り、
// Claude と同じコールバック（core/hooks-unify.mjs の claudeHookCallbacks）で走らせる。発火のきっかけ:
//   PreToolUse・PostToolUse  Pleiad のプラグインの tool.execute.before / after が中継の口（/mcp/opencode/hook）を呼ぶ
//   SessionStart・UserPromptSubmit・Stop  バックエンド（core/backends/opencode.mjs）がターンの始め・発言の前・終わりに呼ぶ
// ツール名と入力は Claude の形へ写す（bash -> Bash、filePath -> file_path など）。書き換えた入力（updatedInput）は OpenCode の形へ戻す
import { claudeHookCallbacks } from '../hooks-unify.mjs';
import { toolName as displayName } from './opencode-normalize.mjs';

/** OpenCode の組み込みのツール -> Claude Code のツール名 */
const TOOL_NAMES = { bash: 'Bash', shell: 'Bash', subagent: 'Task', read: 'Read', write: 'Write', edit: 'Edit', patch: 'Edit', glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch',
  websearch: 'WebSearch', task: 'Task', todowrite: 'TodoWrite', todoread: 'TodoRead', skill: 'Skill', question: 'AskUserQuestion' };
/** 入力のキー（OpenCode -> Claude）。ほかのキーはそのまま */
const KEYS = { filePath: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' };
const BACK = Object.fromEntries(Object.entries(KEYS).map(([a, b]) => [b, a]));

/** OpenCode のツール名 -> Claude Code の形の名前（Pleiad の MCP は mcp__<サーバー>__<ツール>） */
export const claudeToolName = (name) => TOOL_NAMES[name] ?? displayName(name);
const rename = (obj, map) => (obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [map[k] ?? k, v])) : {});
export const toClaudeInput = (args) => rename(args, KEYS);
export const fromClaudeInput = (input) => rename(input, BACK);

/** Claude の matcher（空・* は全部。ほかはツール名に丸ごと当たる正規表現、形が壊れていれば同じ名前だけ） */
export function matches(matcher, tool) {
  const m = String(matcher ?? '').trim();
  if (!m || m === '*') return true;
  try { return new RegExp(`^(?:${m})$`).test(tool); } catch { return m === tool; }
}

const reasonOf = (o) => String(o?.hookSpecificOutput?.permissionDecisionReason ?? o?.reason ?? o?.stopReason ?? '').trim();
const contextOf = (outs) => outs.map((o) => o?.hookSpecificOutput?.additionalContext).filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
const blocked = (o) => o?.decision === 'block' || o?.decision === 'deny' || o?.continue === false;

/**
 * hooksRuntime（core/hooks-unify.mjs の prepareHooksTurn の runtime）から、イベントごとに走らせる口を作る。
 * onRun は発火の記録（hookRun の中身）。base は Claude の入力の共通の部分（session_id・cwd）
 */
export function createHookRunner(runtime, { onRun = () => {}, run, base = {} } = {}) {
  const table = claudeHookCallbacks(runtime, { onRun, ...(run ? { run } : {}) });
  async function fire(event, input = {}, { tool = null, signal } = {}) {
    const outs = [];
    for (const group of table[event] ?? []) {
      if (tool !== null && !matches(group.matcher, tool)) continue;
      for (const callback of group.hooks) {
        const out = await callback({ ...base, transcript_path: '', ...input, hook_event_name: event }, null, { signal }).catch(() => ({}));
        outs.push(out ?? {});
      }
    }
    return outs;
  }
  return {
    has: (event) => Boolean(table[event]?.length),
    /** ツールの前。{ block?: 理由, args?: 書き換えた入力（OpenCode の形） } */
    async beforeTool({ tool, args }, opts) {
      const name = claudeToolName(tool);
      const outs = await fire('PreToolUse', { tool_name: name, tool_input: toClaudeInput(args) }, { ...opts, tool: name });
      const deny = outs.find((o) => o?.hookSpecificOutput?.permissionDecision === 'deny' || blocked(o));
      if (deny) return { block: reasonOf(deny) || 'Blocked by hook' };
      const updated = outs.map((o) => o?.hookSpecificOutput?.updatedInput).filter((x) => x && typeof x === 'object').at(-1);
      return updated ? { args: fromClaudeInput(updated) } : {};
    },
    /** ツールの後。{ append?: ツールの結果に足す文（止める理由・足す文脈） } */
    async afterTool({ tool, args, output }, opts) {
      const name = claudeToolName(tool);
      const outs = await fire('PostToolUse', { tool_name: name, tool_input: toClaudeInput(args), tool_response: output ?? '' }, { ...opts, tool: name });
      const lines = [...outs.filter(blocked).map(reasonOf).filter(Boolean), contextOf(outs)].filter(Boolean);
      return lines.length ? { append: lines.join('\n') } : {};
    },
    /** 会話の始め。足す文脈（無ければ ''） */
    async sessionStart(opts) {
      return contextOf(await fire('SessionStart', { source: 'startup' }, opts));
    },
    /** 発言の前。{ block?: 理由, context?: 足す文脈 } */
    async promptSubmit(prompt, opts) {
      const outs = await fire('UserPromptSubmit', { prompt }, opts);
      const stop = outs.find(blocked);
      if (stop) return { block: reasonOf(stop) || 'Blocked by hook' };
      const context = contextOf(outs);
      return context ? { context } : {};
    },
    /** 終わりの前。続けさせる理由（止めないなら null） */
    async stop(active, opts) {
      const stop = (await fire('Stop', { stop_hook_active: Boolean(active) }, opts)).find(blocked);
      return stop ? reasonOf(stop) || 'Continue' : null;
    },
  };
}
