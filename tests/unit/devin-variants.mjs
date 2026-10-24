// fake ACP 越しに runTurn のモデル読み替えを確認する。実機（3000.11.92）と同じく、
// 系ごとに代表の model・thought_level・speed の対応が違い、ACP に表せない版は送らず止まる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { createDevinBackend } from '../../core/backends/devin.mjs';

export const name = 'devin-variants';
export const title = 'Devin: 系ごとの variant の代表・思考・速度への読み替えと、表せない版の停止';

// fake-devin.mjs の既定カタログと同じ形
const catalogue = async () => ({ families: [
  { family_uid: 'swe-2', variants: [{ model_uid: 'swe-2-high', cost_tier: 'Free' }, { model_uid: 'swe-2-max-lightning', cost_tier: 'High cost' }] },
  { family_uid: 'deepseek-v4-1-flash-1017', variants: ['none', 'low', 'high', 'max'].map(level => ({ model_uid: `deepseek-v4-1-flash-1017-${level}`, cost_tier: 'Low cost' })) },
  { family_uid: 'glm-5.2', variants: ['glm-5-2', 'glm-5-2-max', 'glm-5-2-1m', 'glm-5-2-max-1m'].map(id => ({ model_uid: id, cost_tier: 'Low cost' })) },
  { family_uid: 'claude-opus-5-5', variants: ['medium', 'high'].flatMap(level => [{ model_uid: `claude-opus-5-5-${level}`, cost_tier: 'High cost' }, { model_uid: `claude-opus-5-5-${level}-fast`, cost_tier: 'High cost' }]) },
  { family_uid: 'gpt-6-astra', variants: [{ model_uid: 'gpt-6-astra-medium', cost_tier: 'High cost' }, { model_uid: 'gpt-6-astra-high', cost_tier: 'High cost' }, { model_uid: 'gpt-6-astra-low-priority', cost_tier: 'High cost' }] },
  { family_uid: 'kimi-k2.6', variants: [{ model_uid: 'kimi-k2-6', cost_tier: 'Low cost' }] },
  { family_uid: 'catalogue-only', variants: [{ model_uid: 'catalogue-only', cost_tier: 'High cost' }] },
] });

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-variants-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  try {
    const calls = [];
    class Recorder extends DevinAcp {
      async call(method, params, options) { calls.push({ method, params }); return super.call(method, params, options); }
    }
    const command = () => [process.execPath, path.join(ROOT, 'tests/lib/fake-devin.mjs')];
    const backend = createDevinBackend({ Acp: Recorder, catalogue, command, dataDir: path.join(root, 'data') });

    t.ok('ACP の選択肢をまだ見ていなければ、カタログの版を振り分けから外さない', backend.runnableModel('catalogue-only') === true && backend.runnableModel('gpt-6-astra-low-priority') === true);
    const unlisted = await backend.runTurn({ cwd, prompt: 'not runnable', model: 'catalogue-only', mode: 'ask', emit: () => {} }).catch(e => e);
    t.ok('ACP に無い版は送る前に設定の誤りで止まる', unlisted?.code === 'DEVIN_MODEL_CONFIG_UNAVAILABLE' && !calls.some(c => c.method === 'session/prompt'), String(unlisted?.code ?? unlisted));
    t.ok('ACP の選択肢が分かれば、読み替えられる系は選べて表せない版は外れる',
      backend.runnableModel('catalogue-only') === false && backend.runnableModel('swe-2-max-lightning') === true
      && backend.runnableModel('deepseek-v4-1-flash-1017-max') === true && backend.runnableModel('kimi-k2-6') === true
      && backend.runnableModel('glm-5-2-max-1m') === true && backend.runnableModel('gpt-6-astra-low-priority') === false);

    // 系ごとの読み替え: 代表 + 思考（+ 速度）。model 切替後の軸で確認する
    for (const [model, expected] of [
      ['swe-2-max-lightning', [['model', 'swe-2-high'], ['thought_level', 'max'], ['speed', 'fast']]],
      ['deepseek-v4-1-flash-1017-max', [['model', 'deepseek-v4-1-flash-1017-high'], ['thought_level', 'max']]],
      ['deepseek-v4-1-flash-1017-high', [['model', 'deepseek-v4-1-flash-1017-high'], ['thought_level', 'high']]],
      ['glm-5-2', [['model', 'glm-5-2']]],
      ['glm-5-2-max-1m', [['model', 'glm-5-2-1m'], ['thought_level', 'max']]],
      ['kimi-k2-6', [['model', 'kimi-k2-6']]],
      ['claude-opus-5-5-high-fast', [['model', 'claude-opus-5-5-medium'], ['thought_level', 'high'], ['speed', 'fast']]],
      ['gpt-6-astra-high', [['model', 'gpt-6-astra-medium'], ['thought_level', 'high']]],
    ]) {
      const mark = calls.length;
      const turn = await backend.runTurn({ cwd, prompt: `variant ${model}`, model, mode: 'ask', emit: () => {} });
      const sets = calls.slice(mark).filter(c => c.method === 'session/set_config_option').map(c => [c.params.configId, c.params.value]);
      t.ok(`${model} を系の代表・思考・速度に読み替えて走る`, turn.outcome !== 'error' && JSON.stringify(sets.slice(1)) === JSON.stringify(expected),
        JSON.stringify({ outcome: turn.outcome, sets }));
    }
    // 対応軸の無い -priority は prompt を送らず止まる
    const mark = calls.length;
    const priority = await backend.runTurn({ cwd, prompt: 'must not run', model: 'gpt-6-astra-low-priority', mode: 'ask', emit: () => {} }).catch(e => e);
    t.ok('-priority は ACP に対応軸が無いので送る前に止まる', priority?.code === 'DEVIN_MODEL_CONFIG_UNAVAILABLE'
      && !calls.slice(mark).some(c => c.method === 'session/prompt'), String(priority?.code ?? priority));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
