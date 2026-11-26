// 項目 3 の土台: agy（ACP。agy acp）を保持役の身代わりで起動し、1 ターンのイベントの形と時間を見る。
// 実際の LLM を呼ぶ（既定の安いモデル 1 回）。会話は ~/.gemini/antigravity-cli に作られるので、sessionId を最後に表示する。
// agy は AGENT_HOST_AGY_BIN で身代わり（node tests/lib/fake-agy.mjs）に替えられる（段取りだけの確かめ）。
import { HolderSim } from './holder-sim.mjs';
import { Rpc, log, sleep } from './lib.mjs';
import { agyLaunch, desc, parse, promptParams, replyText, setModel, startSession } from '../agy/acp-probe.mjs';
import fs from 'node:fs'; import path from 'node:path';
const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'agy-work-'));
const model = process.env.PROBE_AGY_MODEL ?? 'gemini-3.8-flash-low';
const { command, args } = agyLaunch({ cwd: work, skipPermissions: true });
const h = new HolderSim(command, args, { cwd: work });
const rpc = new Rpc('agy', (s) => h.write(s));
const frames = [];
h.sink = (line, seq) => {
  const m = parse(line);
  if (!m) { log('non-json', line.slice(0, 120)); return; }
  frames.push(m); rpc.feed(`${line}\n`);
  log(`#${seq}`, desc(m));
};
log('spawned pid', h.child.pid, args.join(' '));
await sleep(3000);
log('after 3s idle: frames so far =', frames.length, 'alive =', h.exit === null, '(agy acp は initialize を待つので 0 のはず)');
let sessionId = null;
try {
  const t = Date.now();
  const started = await startSession(rpc, { cwd: work });
  sessionId = started.sessionId;
  log('initialize + session/new', `${Date.now() - t} ms`, 'session', sessionId, 'agent', JSON.stringify(started.init?.agentInfo ?? {}), 'model now', started.created?.models?.currentModelId);
  log('model applied:', await setModel(rpc, sessionId, model));
  const t1 = Date.now();
  const reply = await rpc.request('session/prompt', promptParams(sessionId, process.argv[2] ?? 'Reply with exactly: ok'), 90_000);
  log('session/prompt', `${Date.now() - t1} ms`, JSON.stringify(reply.result ?? reply).slice(0, 200));
  log('reply', JSON.stringify(replyText(frames)).slice(0, 120), 'notifications', rpc.notifications.length, 'server requests', rpc.serverRequests.length);
} finally {
  log('SESSION_ID(for cleanup):', sessionId, 'stderr:', h.err.slice(0, 300));
  try { h.child.stdin.end(); } catch {}
  await Promise.race([h.exited, sleep(15000)]);
  log('exit', JSON.stringify(h.exit));
  if (h.exit === null) h.kill();
  await sleep(500);
  fs.rmSync(work, { recursive: true, force: true });
}
