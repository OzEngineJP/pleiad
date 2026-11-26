// 全エージェントに共通の試験 1 本（宣言 core/backends/agents.mjs・能力の印から回す）。
//   1. 共通の流れ: 全エージェント（fake を含む）を、エージェントごとの身代わり（LLM を呼ばない）で起こしたサーバーに流す。
//      1 ターン・履歴の形と uuid・続き・タイトル・分岐・イベントの形（checkConformance）/ 中断（checkAbort）/ エラー（checkError）/ 再起動の後の続き（checkResume）
//   2. 配達物: runArgs の渡し物が、エージェントごとの偽のプロセス・プロトコルに実際に届く（issue #146）。
//      能力の印が対応（または補う）なのに届いていなければ落ちる。印が todo・impossible のエージェントには要求しない。
//      証拠の取りこぼし（要る証拠が無い・偽）と、宣言との食い違い（宣言が対応でない印の証拠が出る・知らない証拠）も落とす（probeVerdict）。
// 道具は tests/lib/backend-common.mjs。能力の印の絞り込み（gateRunArgs）の単体の試験は tests/unit/backend-contract.mjs。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';
import {
  DELIVERY_HINTS, DELIVERY_PROBES, RIGS, checkAbort, checkConformance, checkError, checkResume, loadNatives, probeVerdict,
} from '../lib/backend-common.mjs';

export const name = 'backend-common';
export const title = '全エージェントの共通の試験: 基本の流れ（1 ターン・履歴・続き・分岐・中断・エラー・再起動の後の続き）と、配達物（runArgs）が届くこと';

export default async function (t) {
  for (const id of Object.keys(AGENTS)) await lifecycle(t, id);

  const natives = await loadNatives(Object.keys(DELIVERY_PROBES));
  for (const [id, probe] of Object.entries(DELIVERY_PROBES)) await delivery(t, id, probe, natives[id]?.capabilities ?? {});
}

async function lifecycle(t, id) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `pleiad-common-${id}-`));
  const rig = await RIGS[id](scratch);
  const dataDir = path.join(scratch, 'data');
  const state = { server: await startServer({ dataDir, env: rig.env, timeoutMs: 60_000 }), c: null };
  state.c = await open({ port: state.server.port, token: state.server.token, autoAllow: true });
  let error = null;
  try {
    const backends = await state.c.cmd('backends');
    t.ok(`${id}: 有効になり、画面へ渡す記述（短い名前・ロゴ・圧縮の行）が付く`, backends.length === 1 && backends[0].id === id
      && 'shortLabel' in backends[0] && 'brand' in backends[0] && 'idleCompaction' in backends[0], JSON.stringify(backends[0] ?? null));
    const { sessionId } = await checkConformance(t, state.c, { id, cwd: ROOT, prompt: rig.prompt });
    await checkAbort(t, state.c, { id, cwd: ROOT, rig });
    await checkError(t, state.c, { id, cwd: ROOT, rig });
    await checkResume(t, state, { id, cwd: ROOT, rig, sessionId, dataDir });
  } catch (e) {
    error = e;
  } finally {
    state.c.close();
    try { await state.server.stop(); } catch (e) { t.ok(`${id}: バックエンドのイベントが契約に外れない`, false, String(e.message)); }
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  if (error) t.ok(`${id}: 共通の契約を最後まで確かめられる`, false, `${error.stack ?? error}\n${state.server.tail()}`);
}

async function delivery(t, id, probe, caps) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `pleiad-delivery-${id}-`));
  let result = null, error = null;
  try { result = await probe({ scratch, caps }); }
  catch (e) { error = e; }
  finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }
  if (error) {
    t.ok(`${id}: 配達物の確かめを最後まで流せる`, false, `${error.stack ?? error}`);
    return;
  }
  const verdict = probeVerdict({ id, caps, result });
  const seen = JSON.stringify(result.seen ?? null);
  for (const key of verdict.required) {
    t.ok(`${id}: 印 ${key} は対応なので、渡し物が届く（${DELIVERY_HINTS[key]}）`, !verdict.missing.includes(key) && !verdict.notDelivered.includes(key),
      verdict.missing.includes(key) ? `証拠が無い（probe が ${key} を返していない）。${seen}` : seen);
  }
  t.ok(`${id}: 宣言と証拠が食い違わない（知らない証拠・対応でない印の証拠が無い）`, !verdict.unknown.length && !verdict.stale.length,
    JSON.stringify({ unknown: verdict.unknown, stale: verdict.stale }));
}
