// Devin・Grok のモデルの一覧の置き場（models() の TTL キャッシュ）:
// 起動に秒かかる一覧は直近の値と取りかけを分け合い、失敗した取得は成功した一覧として覚えない。
// refresh: true なら TTL の内でも取り直す（モデルの存在を確かめる道は、古い一覧に頼らない）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDevinBackend } from '../../core/backends/devin.mjs';
import { createGrokBackend } from '../../core/backends/grok.mjs';

export const name = 'backend-model-cache';
export const title = 'Devin・Grok のモデル一覧の置き場: 取りかけの分け合い・TTL・失敗は覚えない・強制の取り直し';

const catalogue = () => ({ families: [{ family_uid: 'swe-2', variants: [{ model_uid: 'swe-2-high', label: 'SWE-2 High', cost_tier: 'Free' }] }] });

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-model-cache-'));
  const dataDir = path.join(root, 'data'), other = path.join(root, 'other');
  const keep = { devin: process.env.AGENT_HOST_DEVIN_MODELS_TTL_MS, grok: process.env.AGENT_HOST_GROK_MODELS_TTL_MS };
  try {
    // ---- Devin: 一覧の取得は catalogue の注入で数える（CLI は起こさない）
    let devinCalls = 0, devinFail = false;
    const devin = createDevinBackend({ command: () => ['devin-fixture'], dataDir,
      catalogue: async () => { if (devinFail) throw new Error('catalogue down'); devinCalls++; await new Promise(r => setTimeout(r, 20)); return catalogue(); } });
    const [a, b] = await Promise.all([devin.models(), devin.models()]);
    t.ok('Devin: 同時の要求は 1 回の取得を分け合う', devinCalls === 1 && Object.hasOwn(a, 'swe-2-high') && Object.hasOwn(b, 'swe-2-high'));
    await devin.models();
    t.ok('Devin: TTL の内は取り直さない', devinCalls === 1);
    await devin.models(process.cwd(), { refresh: true });
    t.ok('Devin: 強制の取り直しは TTL の内でも一覧を引く', devinCalls === 2);
    devinFail = true;
    await devin.models(process.cwd(), { refresh: true }).catch(() => {});
    t.ok('Devin: 失敗した取得は成功した一覧として覚えない', devinCalls === 2);
    devinFail = false;
    await devin.models(process.cwd(), { refresh: true });
    t.ok('Devin: 失敗の次の要求は取り直して成功する', devinCalls === 3);
    process.env.AGENT_HOST_DEVIN_MODELS_TTL_MS = '0';
    await devin.models();
    t.ok('Devin: TTL を 0 にすると毎回取り直す', devinCalls === 4);
    delete process.env.AGENT_HOST_DEVIN_MODELS_TTL_MS;

    // ---- Grok: 一覧は ACP の initialize（start の呼ばれる回数で数える）
    let grokStarts = 0, grokFail = false;
    class FakeAcp {
      async start() {
        if (grokFail) throw new Error('init failed');
        grokStarts++; await new Promise(r => setTimeout(r, 20));
        this.init = { _meta: { modelState: { currentModelId: 'grok-x', availableModels: [{ modelId: 'grok-x' }] } } };
        return this.init;
      }
      async close() {}
    }
    const grok = createGrokBackend({ Acp: FakeAcp, command: () => ['grok-fixture'], dataDir });
    const [g1, g2] = await Promise.all([grok.models(dataDir), grok.models(dataDir)]);
    t.ok('Grok: 同時の要求は 1 回の取得を分け合う', grokStarts === 1 && Object.hasOwn(g1, 'grok-x') && Object.hasOwn(g2, 'grok-x'));
    await grok.models(dataDir);
    t.ok('Grok: TTL の内は取り直さない', grokStarts === 1);
    await grok.models(other);
    t.ok('Grok: 一覧は置き場ごとに覚える', grokStarts === 2);
    await grok.models(dataDir, { refresh: true });
    t.ok('Grok: 強制の取り直しは TTL の内でも一覧を引く', grokStarts === 3);
    grokFail = true;
    await grok.models(dataDir, { refresh: true }).catch(() => {});
    t.ok('Grok: 失敗した取得は成功した一覧として覚えない', grokStarts === 3);
    grokFail = false;
    await grok.models(dataDir, { refresh: true });
    t.ok('Grok: 失敗の次の要求は取り直して成功する', grokStarts === 4);
  } finally {
    for (const [key, value] of [['AGENT_HOST_DEVIN_MODELS_TTL_MS', keep.devin], ['AGENT_HOST_GROK_MODELS_TTL_MS', keep.grok]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
