// fake ACP 越しに runTurn のモデル・思考の強さの設定を確かめる（ADR 0356）。実機（3000.14.30821）と同じく、
// thought_level の有無と選択肢はモデルで変わる。Pleiad は名前を読み替えず、選択肢に無いものは送らずに断る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { createDevinBackend } from '../../core/backends/devin.mjs';

export const name = 'devin-variants';
export const title = 'Devin: ACP の選択肢のモデルと段をそのまま送り、選択肢に無い名前・段は送らずに kind: model で断る';

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-variants-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const saved = process.env.FAKE_DEVIN_MODELS;
  try {
    const calls = [];
    class Recorder extends DevinAcp {
      async call(method, params, options) { calls.push({ method, params }); return super.call(method, params, options); }
    }
    const command = () => [process.execPath, path.join(ROOT, 'tests/lib/fake-devin.mjs')];
    const backend = createDevinBackend({ Acp: Recorder, command, dataDir: path.join(root, 'data') });
    const turn = async (prompt, selection) => {
      const events = [], mark = calls.length;
      const result = await backend.runTurn({ cwd, prompt, mode: 'ask', emit: e => events.push(e), ...selection }).catch(e => e);
      const sets = calls.slice(mark).filter(c => c.method === 'session/set_config_option').map(c => [c.params.configId, c.params.value]);
      return { result, sets, prompted: calls.slice(mark).some(c => c.method === 'session/prompt'), final: events.findLast(e => e.type === 'turnResult') };
    };

    // ---- 一覧は ACP の model の選択肢そのまま。強さは裏で読む
    const listed = await backend.models(cwd);
    t.ok('一覧は ACP の選択肢の値そのまま（swe-2-high が既定）', listed[''].resolvesTo === 'swe-2-high' && ['swe-2-high', 'glm-5-2', 'kimi-k2-6', 'paid-exact'].every(id => Object.hasOwn(listed, id))
      && !Object.hasOwn(listed, 'swe-2-max-lightning'), JSON.stringify(Object.keys(listed)));
    await backend.requireModelCatalog(cwd, 'glm-5-2');
    const probed = await backend.models(cwd);
    t.ok('待ったモデルの強さは、そのモデルの thought_level の選択肢と既定', JSON.stringify(probed['glm-5-2'].efforts) === JSON.stringify(['none', 'high', 'max']) && probed['glm-5-2'].defaultEffort === 'high'
      && JSON.stringify(probed[''].efforts) === JSON.stringify(['medium', 'high', 'max']), JSON.stringify(probed['glm-5-2']));
    await backend.requireModelCatalog(cwd, 'kimi-k2-6');
    t.ok('段の軸が無いモデルは強さの候補が空', JSON.stringify((await backend.models(cwd))['kimi-k2-6'].efforts) === '[]');

    // 一覧の取り直し: TTL の間は直近の値、refresh で新しい選択肢を読む
    process.env.FAKE_DEVIN_MODELS = 'swe-2-high,glm-5-2,gpt-6-2-sol-xhigh';
    t.ok('取り直す前は TTL の一覧、refresh 後は新しい選択肢を含む',
      !(await backend.models(cwd))['gpt-6-2-sol-xhigh'] && Boolean((await backend.models(cwd, { refresh: true }))['gpt-6-2-sol-xhigh']));
    if (saved === undefined) delete process.env.FAKE_DEVIN_MODELS; else process.env.FAKE_DEVIN_MODELS = saved;

    // ---- ターン: モデル → 段の順に、そのままの値を送る（speed は送らない）
    for (const [label, selection, expected] of [
      ['既定（何も送らない）', {}, []],
      ['モデルだけ', { model: 'glm-5-2' }, [['model', 'glm-5-2']]],
      ['モデルと段', { model: 'claude-opus-5-5-medium', effort: 'xhigh' }, [['model', 'claude-opus-5-5-medium'], ['thought_level', 'xhigh']]],
      ['段の軸が無いモデル', { model: 'kimi-k2-6' }, [['model', 'kimi-k2-6']]],
      ['既定のモデルの段', { effort: 'max' }, [['thought_level', 'max']]],
    ]) {
      const run = await turn(`select ${label}`, selection);
      t.ok(`${label}: ACP の値をそのまま送って走る`, !(run.result instanceof Error) && run.final?.outcome === 'ok' && JSON.stringify(run.sets.slice(1)) === JSON.stringify(expected),
        JSON.stringify({ sets: run.sets, final: run.final, error: run.result?.message }));
    }

    // ---- 選択肢に無い名前・段: 送らずに断り、委譲の振り分けが次の候補へ回せる印を付ける
    for (const [label, selection, sentSets] of [
      ['古いカタログの名前（swe-2-1-high）', { model: 'swe-2-1-high' }, []],
      ['Lightning の版（ACP に無い）', { model: 'swe-2-max-lightning' }, []],
      ['そのモデルに無い段', { model: 'glm-5-2', effort: 'medium' }, [['model', 'glm-5-2']]],
    ]) {
      const run = await turn(`reject ${label}`, selection);
      t.ok(`${label}: prompt を送らず、未配達のまま kind: model・pristine で断る`, run.result instanceof Error && run.result.undelivered === true && !run.prompted
        && run.final?.outcome === 'error' && run.final.kind === 'model' && run.final.pristine === true && JSON.stringify(run.sets.slice(1)) === JSON.stringify(sentSets),
        JSON.stringify({ sets: run.sets, final: run.final, undelivered: run.result?.undelivered }));
    }
  } finally {
    if (saved === undefined) delete process.env.FAKE_DEVIN_MODELS; else process.env.FAKE_DEVIN_MODELS = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
}
