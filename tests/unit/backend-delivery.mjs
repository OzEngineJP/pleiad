// 配達物（runArgs の機能の渡し物）が、全エージェントで実際に届くことを確かめる（issue #146）。
// エージェントごとの偽のプロセス・プロトコル（tests/lib/fake-*.mjs・SDK の query の身代わり・app-server の身代わり）に 1 ターン流し、
// 起動の引数・環境変数・MCP の登録・発言に足した指示のどこで受け取ったかを見る（tests/lib/backend-delivery.mjs）。
// 能力の印が対応（または補う）なのに届いていなければ落ちる。印が todo・impossible のエージェントには要求しない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadNatives } from '../lib/backend-matrix.mjs';
import { DELIVERY_CAPABILITIES, DELIVERY_HINTS, DELIVERY_PROBES, deliveryRequired } from '../lib/backend-delivery.mjs';

export const name = 'backend-delivery';
export const title = '配達物（runArgs）が全エージェントに届く: 能力の印ごとに、偽のプロセス・プロトコルで受け取ったかを見る';

export default async function (t) {
  const natives = await loadNatives(Object.keys(DELIVERY_PROBES));
  for (const [id, probe] of Object.entries(DELIVERY_PROBES)) {
    const caps = natives[id]?.capabilities ?? {};
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `pleiad-delivery-${id}-`));
    let result = null, error = null;
    try { result = await probe({ scratch, caps }); }
    catch (e) { error = e; }
    finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }
    if (error) {
      t.ok(`${id}: 配達物の確かめを最後まで流せる`, false, `${error.stack ?? error}`);
      continue;
    }
    for (const key of DELIVERY_CAPABILITIES) {
      if (!deliveryRequired(caps[key])) continue;
      t.ok(`${id}: 印 ${key} は対応なので、渡し物が届く（${DELIVERY_HINTS[key]}）`, Boolean(result.evidence?.[key]),
        JSON.stringify(result.seen ?? null));
    }
  }
}
