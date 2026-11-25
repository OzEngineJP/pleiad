// 一覧と強さを読む ACP の会話を Devin 側に溜めない・CLI の版が変わったら強さを読み直す（ADR 0356）。
// 偽物の Devin（tests/lib/fake-devin.mjs）は会話を DEVIN_SESSIONS_DIR に devin-fixture-<id>.json で残すので、その数を数える
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { createDevinBackend } from '../../core/backends/devin.mjs';

export const name = 'devin-metadata-sessions';
export const title = 'Devin: 一覧と強さを読む会話を読むたびに消し（溜めない）、CLI の版が変わったら強さを読み直す';

const ENV = ['FAKE_DEVIN_VERSION', 'FAKE_DEVIN_THOUGHT', 'FAKE_DEVIN_MODELS'];

async function walk(dir) {
  const entries = await fs.readdir(dir, { recursive: true }).catch(() => []);
  return entries.map(String);
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-metadata-'));
  const cwd = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  const metaDir = path.join(dataDir, 'devin', 'metadata-sessions');
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  try {
    await fs.mkdir(cwd);
    for (const k of ENV) delete process.env[k];
    process.env.FAKE_DEVIN_VERSION = '3000.14.1';
    // 前の版が 1 つの置き場に溜めた会話（metadata-sessions/cli）。使っていなければ次の読み取りで消す
    const legacy = path.join(metaDir, 'cli');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'sessions.db'), 'old');
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(legacy, old, old);

    const calls = [];
    class Recorder extends DevinAcp {
      async call(method, params, options) { calls.push({ method, params }); return super.call(method, params, options); }
    }
    const command = () => [process.execPath, path.join(ROOT, 'tests/lib/fake-devin.mjs')];
    const backend = createDevinBackend({ Acp: Recorder, command, dataDir });
    const created = () => calls.filter(c => c.method === 'session/new').length;
    const efforts = async id => (await backend.models(cwd))[id]?.efforts;
    // 裏の強さの読み取りが終わるまで待つ（読んでいる間は effortReason が付く）
    const idle = async () => {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        if (!Object.values(await backend.models(cwd)).some(m => m.effortReason)) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    };
    const fixtures = async () => (await walk(metaDir)).filter(name => /devin-fixture-[\w-]+\.json$/.test(name));
    // 会話を閉じる（Windows は taskkill でプロセスの木を止める）のに 1〜2 秒かかる。閉じ終えて置き場が空になるまで待つ（溜まるなら空にならない）
    const emptied = async () => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        if ((await walk(metaDir)).length === 0) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    };

    // ---- 何度読んでも、読み終えたら会話は残らない
    for (let i = 0; i < 3; i++) {
      await backend.models(cwd, { refresh: true });
      await backend.requireModelCatalog(cwd, 'glm-5-2');
    }
    const settled = await idle() && await emptied();
    const left = await fixtures();
    t.ok('一覧を 3 回取り直して強さも読んだ後、偽物が作った会話は 1 つも残らない（置き場ごと消える）',
      settled && created() >= 3 && left.length === 0,
      JSON.stringify({ settled, created: created(), left, entries: await walk(metaDir) }));
    t.ok('前の版が溜めた置き場（metadata-sessions/cli）も消す', !(await fs.stat(legacy).catch(() => null)));
    t.ok('同じ版のうちは読んだ強さを使う', JSON.stringify(await efforts('glm-5-2')) === JSON.stringify(['none', 'high', 'max']));

    // ---- 一覧の取り直しで CLI の版が変わったと分かったら、覚えた強さを忘れて読み直す
    process.env.FAKE_DEVIN_VERSION = '3000.15.0';
    process.env.FAKE_DEVIN_THOUGHT = JSON.stringify({ 'glm-5-2': ['low', 'high'] });
    t.ok('取り直すまでは前の版の強さ', JSON.stringify(await efforts('glm-5-2')) === JSON.stringify(['none', 'high', 'max']));
    await backend.models(cwd, { refresh: true });
    await backend.requireModelCatalog(cwd, 'glm-5-2');
    t.ok('版が上がった一覧を読んだら、強さを新しい版の選択肢で読み直す', JSON.stringify(await efforts('glm-5-2')) === JSON.stringify(['low', 'high']),
      JSON.stringify(await backend.models(cwd)));

    // ---- ターンの起動で版の変化に気付いたときも、次の一覧で読み直す（TTL を待たない）
    process.env.FAKE_DEVIN_VERSION = '3000.16.0';
    process.env.FAKE_DEVIN_THOUGHT = JSON.stringify({ 'glm-5-2': ['max'] });
    const turn = await backend.runTurn({ cwd, prompt: 'hello', mode: 'ask', emit: () => {} }).catch(e => e);
    await backend.requireModelCatalog(cwd, 'glm-5-2');
    t.ok('ターンの CLI の版が違えば、覚えた強さを忘れて読み直す', !(turn instanceof Error) && JSON.stringify(await efforts('glm-5-2')) === JSON.stringify(['max']),
      JSON.stringify({ error: turn?.message, glm: (await backend.models(cwd))['glm-5-2'] }));

    const finalIdle = await idle() && await emptied();
    t.ok('版が変わって読み直した後も、一覧と強さの会話は残らない', finalIdle && (await fixtures()).length === 0,
      JSON.stringify(await walk(metaDir)));
  } finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
