// 未実装（todo('#Issue')）の件数のラチェット（ADR 0273）。
//
// 未実装は減る方向にしか動かせない。基準（tests/backend-todos.json）に無い todo が増えたら落とし、
// 減ったら基準を下げるよう促す。基準を下げる（Issue を直す・消えた分を消す）更新だけを許す。
//
//   node tests/lib/backend-todos.mjs --update-baseline
//
// npm test の backend-contract が checkTodos を呼ぶ。基準の形は { todos: { <agent>: { <capability>: '#Issue' } } }。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CAPABILITY_KEYS, isCapabilityState } from '../../core/backends/contract.mjs';
import { DEFAULT_AGENT_IDS } from '../../core/backends/agents.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE_FILE = path.join(ROOT, 'tests', 'backend-todos.json');
const UPDATE_COMMAND = 'node tests/lib/backend-todos.mjs --update-baseline';

/** 各バックエンドの todo（agent -> { capability: Issue }）。試験用の fake と対応を終えたものは数えない */
export function collectTodos(natives, ids = DEFAULT_AGENT_IDS) {
  const todos = {};
  for (const id of ids) {
    const caps = natives[id]?.capabilities ?? {};
    const row = {};
    for (const key of CAPABILITY_KEYS) {
      const value = caps[key];
      if (isCapabilityState(value) && value.state === 'todo') row[key] = value.issue;
    }
    if (Object.keys(row).length) todos[id] = row;
  }
  return todos;
}

export function readTodosBaseline(file = BASELINE_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { todos: {} };
}

/**
 * 基準との比べ。問題の配列 { rule: 'increased'|'decreased'|'changed', agent, key, message }。
 * 増えた・Issue が変わった・減った（基準を下げる）を別々に返す。
 */
export function checkTodos(todos, baseline = {}) {
  const problems = [];
  const base = baseline.todos ?? {};
  for (const [id, keys] of Object.entries(todos)) {
    for (const [key, issue] of Object.entries(keys)) {
      const was = base[id]?.[key];
      if (was === undefined) {
        problems.push({ rule: 'increased', agent: id, key, message: `未実装が増えた: ${id}.${key}（${issue}）。未実装は増やせない。対応するか impossible('理由') にする。どうしても要るなら ${path.relative(ROOT, BASELINE_FILE)} を手で直し、レビューで理由を書く` });
      } else if (was !== issue) {
        problems.push({ rule: 'changed', agent: id, key, message: `未実装の Issue が変わった: ${id}.${key}（${was} → ${issue}）。基準を更新してください（${UPDATE_COMMAND}）` });
      }
    }
  }
  for (const [id, keys] of Object.entries(base)) {
    for (const [key, issue] of Object.entries(keys)) {
      if (todos[id]?.[key] === undefined) {
        problems.push({ rule: 'decreased', agent: id, key, message: `未実装が減った: ${id}.${key}（${issue}）。基準を下げてください（${UPDATE_COMMAND}）` });
      }
    }
  }
  return problems;
}

export function formatTodos(todos) {
  const sorted = Object.fromEntries(Object.entries(todos).sort(([a], [b]) => a.localeCompare(b)).map(([id, keys]) => [
    id, Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b))),
  ]));
  return JSON.stringify({
    _comment: '未実装（todo）の基準（tests/lib/backend-todos.mjs）。増やせない。減らしたら node tests/lib/backend-todos.mjs --update-baseline で下げる',
    todos: sorted,
  }, null, 2) + '\n';
}

/** 基準を下げる（増える・新しく出る todo があれば拒む）。file が無いときは作る */
export function updateTodosBaseline(todos, { file = BASELINE_FILE } = {}) {
  const existed = existsSync(file);
  const base = readTodosBaseline(file).todos ?? {};
  const raised = [];
  for (const [id, keys] of Object.entries(todos)) {
    for (const [key, issue] of Object.entries(keys)) if (base[id]?.[key] === undefined) raised.push({ agent: id, key, issue });
  }
  if (existed && raised.length) return { ok: false, raised };
  writeFileSync(file, formatTodos(todos));
  return { ok: true, raised: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.argv.includes('--update-baseline')) {
    console.error(`使い方: ${UPDATE_COMMAND}`);
    process.exit(2);
  }
  // バックエンドを読み込むと core の置き場の道具も読み込まれる。利用者の本物のデータ置き場（~/.agent-host）を開かないよう、一時の置き場へ向ける
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  process.env.AGENT_HOST_DATA = mkdtempSync(path.join(os.tmpdir(), 'pleiad-backend-todos-'));
  const { loadNatives } = await import('./backend-matrix.mjs');
  const result = updateTodosBaseline(collectTodos(await loadNatives(DEFAULT_AGENT_IDS)));
  if (!result.ok) {
    console.error('未実装は増やせない:', result.raised.map(({ agent, key, issue }) => `${agent}.${key}（${issue}）`).join(' '));
    process.exit(1);
  }
  console.log('未実装の基準を更新した:', path.relative(ROOT, BASELINE_FILE));
}
