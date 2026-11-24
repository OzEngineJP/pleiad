// 会話が何千件・合計で数 GB ある置き場でも、内部サーバーが起動後のヒープの上限で落ちないことを確かめる（Issue #225 の回帰）。
//
//   node tests/perf/server-heap.mjs [--conversations 3000] [--mb 1] [--cap-mb 512] [--watch 150] [--keep]
//
// 偽の置き場（会話の本文・presents・viz-blobs。本物のデータは使わない）を一時フォルダーに作り、
// 旧式の保存先を読む fake バックエンドだけで core/server.mjs を起こす（エージェントの CLI は起こさない）。
// node のヒープの上限を --cap-mb に絞って（NODE_OPTIONS=--max-old-space-size）--watch 秒の間見張り、
// 落ちる（OOM は終了コード 134）か、最後に応答しなければ失敗にする。
//   - 3 秒後: 検索の写しの事前読み込み（core/session-search.mjs の予算）
//   - 60 秒後: viz-blobs の片付け（core/viz-bundle.mjs の sweepVizBlobs）
// 直す前（0.43.0-beta.15 より前）は、どちらも置き場の大きさに比例してヒープを使い、上限で落ちた。
// 上限 512 MB は、直した後の実測（この置き場で 256 MB の上限でも通る）の 2 倍。直す前は 1 GB の上限でも、検索の写しは 5 秒・viz-blobs の片付けは約 63 秒で落ちた。
// これは push のたびの npm test には入れない（数 GB の置き場を作って数分かかる）。.github/workflows/server-heap.yml が回す。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, waitForTestHolders } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { blobDir } from '../../core/viz-bundle.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const CONVERSATIONS = arg('conversations', 3000);
const MB = arg('mb', 1);
const CAP_MB = arg('cap-mb', 512);
const WATCH_SEC = arg('watch', 150);
const KEEP = process.argv.includes('--keep');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = () => crypto.randomBytes(32).toString('hex');

/** 1 件分の本文（base64 の乱数。8 KB ずつの発言）。会話ごとに同じものを使い回して作る時間を抑える（メモリは会話ごとに別の文字として読まれる） */
function sharedTail() {
  const parts = [];
  for (let i = 1; i * 8 * 1024 < MB * 1024 * 1024; i++) {
    const role = i % 2 ? 'assistant' : 'user';
    parts.push(JSON.stringify({ role, text: crypto.randomBytes(6 * 1024).toString('base64'), uuid: `claude:n:${i}`, at: new Date(1_700_000_000_000 + i * 1000).toISOString(), backend: 'claude' }));
  }
  return Buffer.from(`,${parts.join(',')}]}`);
}

async function seed(dir, cwd) {
  await fs.mkdir(path.join(dir, 'conversations'), { recursive: true });
  await fs.mkdir(path.join(dir, 'presents'), { recursive: true });
  await fs.mkdir(blobDir(dir), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const tail = sharedTail();
  const records = {}, sessions = {};
  const now = Date.now();
  // 束（viz-blobs）の名前は、会話ではなく presents が指す。会話の本文には、どの束にも無い 64 桁の 16 進だけが入る
  const blobs = Array.from({ length: 200 }, hex);
  for (const hash of blobs) await fs.writeFile(path.join(blobDir(dir), hash), `blob ${hash}`);
  for (let i = 0; i < blobs.length; i += 4) {
    const lines = blobs.slice(i, i + 4).map((hash, n) => JSON.stringify({ id: `p${i + n}`, title: 'present', bundle: { hash, entry: 'index.html', files: [] }, pad: 'x'.repeat(100_000) }));
    await fs.writeFile(path.join(dir, 'presents', `heap-p${i}.jsonl`), `${lines.join('\n')}\n`);
  }
  let bytes = 0;
  for (let i = 0; i < CONVERSATIONS; i++) {
    const id = `heap-${i}`;
    const at = now - i * 60_000;
    const head = Buffer.from(`{"messages":[${JSON.stringify({ role: 'user', text: `heap test conversation ${i} ref ${hex()}`, uuid: 'claude:n:0', at: new Date(at).toISOString(), backend: 'claude' })}`);
    const file = await fs.open(path.join(dir, 'conversations', `${id}.json`), 'w');
    await file.write(head);
    await file.write(tail);
    await file.close();
    bytes += head.length + tail.length;
    const info = { sessionId: id, title: `heap ${i}`, cwd, createdAt: at, lastModified: at };
    records[id] = { segments: [{ backend: 'claude', nativeId: `n-${id}` }], info, backend: 'fake', nativeId: null, base: 1 };
    sessions[id] = { backend: 'fake', title: info.title, cwd, status: null, statusChangedAt: new Date(at).toISOString(), createdAt: at, lastModified: at };
  }
  await fs.writeFile(path.join(dir, 'conversations.json'), JSON.stringify(records));
  await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
  return bytes;
}

const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-server-heap-')));
let server = null, failure = null;
try {
  const dataDir = path.join(scratch, 'data');
  const t0 = Date.now();
  const bytes = await seed(dataDir, path.join(scratch, 'cwd'));
  console.log(`seeded ${CONVERSATIONS} conversations (${(bytes / 1024 ** 3).toFixed(2)} GiB) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${dataDir}`);

  server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', NODE_OPTIONS: `--max-old-space-size=${CAP_MB}` }, dataDir, timeoutMs: 60_000 });
  console.log(`server up (heap cap ${CAP_MB} MB); watching ${WATCH_SEC} s`);
  const started = Date.now();
  while (Date.now() - started < WATCH_SEC * 1000) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      failure = `server exited after ${Math.round((Date.now() - started) / 1000)} s (exit ${server.child.exitCode ?? server.child.signalCode})\n${server.tail(30)}`;
      break;
    }
    await sleep(1000);
  }
  if (!failure) {
    const client = await open({ port: server.port, token: server.token });
    try {
      const found = await client.cmd('invoke', { op: 'sessions.search', args: { query: 'heap test conversation 7' } });
      if (!(found.total > 0)) failure = `sessions.search returned no hit (total ${found.total})`;
      else console.log(`sessions.search ok (${found.total} hits, partial ${found.partial})`);
    } catch (error) { failure = `sessions.search failed: ${error.message}`; }
    client.close();
  }
} catch (error) {
  failure = String(error?.stack ?? error);
} finally {
  await server?.stop().catch(error => { failure ??= String(error.message ?? error); });
  await waitForTestHolders().catch(() => {});
  if (KEEP) console.log(`kept ${scratch}`);
  else await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
if (failure) { console.error(`FAIL: ${failure}`); process.exit(1); }
console.log('PASS: the server stayed up under the heap cap');
