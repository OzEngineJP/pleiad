import fs from 'node:fs/promises';
import path from 'node:path';
import { definePerAgentMap } from './backends/agents.mjs';

const MAX_BYTES = 64 * 1024;
// 会話ログの形を読む実装があるのは claude・codex・antigravity だけ。ほかのエージェントは、空（null・空の集合）を明示する
const VERIFIED = definePerAgentMap('VERIFIED', {
  codex: '0.160.0', claude: '2.1.303', antigravity: '1.4.5',
  opencode: null, devin: null, grok: null,
});
const KINDS = definePerAgentMap('KINDS', {
  codex: new Set(['rollout-unreadable', 'rollout-session-meta', 'rollout-turn-id']),
  // cost-state-*: 使用量の開始時点（transcript の cost-state。core/backends/claude-cost-state.mjs）が読めない
  claude: new Set(['transcript-shape', 'transcript-unreadable', 'transcript-slim-leak', 'subagent-shape', 'subagent-unreadable', 'subagent-slim-leak', 'subagent-meta', 'cost-state-shape', 'cost-state-missing']),
  antigravity: new Set(['stream-json-shape']),
  opencode: new Set(), devin: new Set(), grok: new Set(),
});
const queues = new Map();
const versions = value => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:alpha|beta|rc)\.\d{1,5})?$/.test(value) ? value : 'unknown';

/** 非公開形式の変化だけを記録する。入力本文・ファイル名・例外は受け取らない。 */
export function recordBackendShapeMismatch({ dataDir, backend, kind, detectedVersion }) {
  // 表の外の id（試験用の fake など）は記録しない
  if (!dataDir || !Object.hasOwn(KINDS, backend) || !KINDS[backend].has(kind)) return Promise.resolve();
  const file = path.join(dataDir, 'backend-shape-errors.log');
  const version = versions(detectedVersion);
  const key = `${backend}/${kind}/${version}`;
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const old = await fs.readFile(file, 'utf8').catch(() => '');
    if (old.split('\n').some(line => {
      try { const row = JSON.parse(line); return `${row.backend}/${row.kind}/${row.detectedVersion}` === key; }
      catch { return false; }
    })) return;
    const row = { backend, kind, detectedVersion: version, verifiedVersion: VERIFIED[backend], at: new Date().toISOString() };
    const appended = old + JSON.stringify(row) + '\n';
    const bytes = Buffer.from(appended);
    const clipped = bytes.length > MAX_BYTES ? bytes.subarray(bytes.length - MAX_BYTES / 2).toString('utf8').replace(/^[^\n]*\n/, '') : appended;
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, clipped);
  });
  queues.set(file, next);
  return next.catch(() => {});
}
