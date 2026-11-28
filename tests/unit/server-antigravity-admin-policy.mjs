// 組織の管理ポリシー（Gemini Enterprise の「ターミナル自動実行モード」が要審査・「MCP サーバー」が無効）で動く agy を、
// 黙って普通の完了にせず、画面・控え・委譲の結果に出す（docs/multi-backend.md §2.8「組織の管理ポリシー」・issue #169）。
// 本物の agy は使わない（tests/lib/fake-agy.mjs の FAKE_AGY_ADMIN_REVIEW・FAKE_AGY_MCP_DISABLED と admin-denied の台本。形は実機 1.5 系の観測）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mcpContacted, noteMcpContact } from '../../core/mcp-contact.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-antigravity-admin-policy';
export const title = 'antigravity: 組織の管理ポリシーで拒否されたツール・要確認のモード・Pleiad の MCP が使えないことを画面と記録に出す';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const FAKE_AGY = `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"`;
const textOf = turn => turn.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');

export default async function (t) {
  // ---- 接続の写し（純粋な関数）
  const token = 'Bearer ' + 'a'.repeat(64);
  t.ok('形の合わない Authorization は覚えない', (noteMcpContact('Bearer short'), !mcpContacted('Bearer short')) && !mcpContacted(token));
  noteMcpContact(token);
  t.ok('口に来たトークンを覚える', mcpContacted(token));
  for (let i = 0; i < 600; i++) noteMcpContact('Bearer ' + i.toString(16).padStart(64, '0'));
  t.ok('上限を超えたら古いものから捨てる', !mcpContacted(token) && mcpContacted('Bearer ' + (599).toString(16).padStart(64, '0')));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-admin-'));
  const cwd = path.join(tmp, 'work');
  await fs.mkdir(cwd, { recursive: true });
  let host = null, client = null, dataDir = path.join(tmp, 'data');
  try {
    const acpLog = path.join(tmp, 'acp.log');
    host = await startServer({ dataDir, timeoutMs: 30_000, env: {
      AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: FAKE_AGY,
      FAKE_AGY_ADMIN_REVIEW: '1', FAKE_AGY_MCP_DISABLED: '1', FAKE_AGY_ACP_LOG: acpLog,
    } });
    client = await open({ ...host, autoAllow: true });

    // ---- 返答の無いまま拒否だけが残ったターン
    const denied = await client.runTurn({ prompt: 'admin-denied', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    const frames = (await fs.readFile(acpLog, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const sessionNew = frames.find(f => f.method === 'session/new');
    t.ok('ACP の session/new に作業ディレクトリと、Pleiad の MCP（中継）を渡す', sessionNew?.params?.cwd === cwd && Array.isArray(sessionNew.params.mcpServers) && sessionNew.params.mcpServers.length > 0, JSON.stringify(sessionNew?.params));
    const result = denied.events.find(e => e.type === 'turnResult');
    t.ok('空の SUCCESS と denied_actions は普通の完了にせず失敗にし、拒否された操作と管理者に頼む設定と値を書く', result?.outcome === 'error'
      && result.error.includes('RunCommand') && result.error.includes('「ターミナル自動実行モード」を「常に続行」') && result.error.includes('「ファイル アクセス ポリシーの外部」を「許可」')
      && result.error.includes('Gemini Enterprise › 設定 › AI デベロッパー ツール › セキュリティ'), JSON.stringify(result));
    const tool = denied.events.find(e => e.type === 'tool.result');
    t.ok('ERROR のツールの段を失敗したツールとして出し、agy の文面に案内を添える', tool?.isError === true && tool.text.includes('permission check failed')
      && tool.text.includes('組織の管理ポリシー') && tool.text.includes('「ターミナル自動実行モード」'), JSON.stringify(tool));
    t.ok('拒否として集める印（rejection）を付ける', tool?.rejection?.kind === 'policy' && tool.rejection.via === 'antigravity' && tool.rejection.tool === 'run_command'
      && tool.rejection.command === 'echo hi' && tool.rejection.raw.startsWith('permission check failed'), JSON.stringify(tool?.rejection));
    const body = textOf(denied);
    t.ok('Pleiad の MCP に接続が無いことを、最初の result の後ろに知らせる（「MCP サーバー」と許可するサーバーの構成を名前で）', body.includes('Pleiad からの知らせ')
      && body.includes('「MCP サーバー」を有効に') && body.includes('許可するサーバーの構成') && !body.includes('プレビュー') && denied.events.findIndex(e => e.type === 'text.delta') < denied.events.findIndex(e => e.type === 'turnResult'), body);
    t.ok('拒否で失敗にしたターンには、要確認のモードの知らせを重ねない', !body.includes('request-review'), body);
    const loaded = await client.cmd('loadSession', { sessionId: denied.sessionId });
    const assistant = loaded.messages.find(m => m.role === 'assistant');
    t.ok('控えに失敗したツールと知らせが残る', assistant?.toolCalls?.[0]?.name === 'run_command' && assistant.toolCalls[0].result?.isError === true
      && assistant.text?.includes('「MCP サーバー」'), JSON.stringify(assistant));

    const again = await client.runTurn({ prompt: 'こんにちは', sessionId: denied.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('知らせは同じ agy で 1 度だけ（次のターンには足さない）', again.outcome === 'ok' && !textOf(again).includes('Pleiad からの知らせ'), textOf(again));

    // ---- 返答のあるターン: 失敗にはせず、要確認のモードと MCP の両方を知らせる
    const fresh = await client.runTurn({ prompt: 'こんにちは', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    const freshBody = textOf(fresh);
    t.ok('返答の後ろに、要確認のモード（request-review）と MCP の知らせを足す', fresh.outcome === 'ok' && freshBody.startsWith('了解: こんにちは')
      && freshBody.includes('request-review') && freshBody.includes('「ターミナル自動実行モード」') && freshBody.includes('「MCP サーバー」'), freshBody);
    const replied = await client.runTurn({ prompt: 'admin-denied-reply', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('拒否の後に返答があれば、ターンは普通の完了のまま（拒否はツールの失敗で出る）', replied.outcome === 'ok'
      && replied.events.some(e => e.type === 'tool.result' && e.rejection?.kind === 'policy'), JSON.stringify(replied.events.find(e => e.type === 'turnResult')));

    // ---- 委譲の子: 依頼元へ返す結果に拒否として集める
    const parent = (await client.runTurn({ backend: 'fake', cwd, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'antigravity', task: 'admin-denied-reply' }) }, { ms: 30_000 })).sessionId;
    let task;
    for (let i = 0; i < 1200; i++) {
      task = (await client.cmd('agentTasks')).find(x => x.parentSessionId === parent || x.backend === 'antigravity');
      if (task?.status === 'completed' && task.notification === 'sent') break;
      await sleep(50);
    }
    for (let i = 0; i < 1200 && (await client.cmd('running')).turns.some(r => r.sessionId === parent); i++) await sleep(50);
    const status = JSON.parse((await client.runTurn({ sessionId: parent, prompt: prompt('ply_task_status', { taskId: task?.taskId }) }, { ms: 30_000 }))
      .events.find(e => e.type === 'tool.result' && e.sessionId === parent).text);
    t.ok('ply_task_status の rejections に、組織の管理ポリシーの拒否が載る', status.status === 'completed' && status.rejections?.length === 1
      && status.rejections[0].kind === 'policy' && status.rejections[0].via === 'antigravity' && status.rejections[0].command === 'echo hi', JSON.stringify(status));
    const notice = (await client.cmd('loadSession', { sessionId: parent })).messages.find(m => m.internalTaskNotice)?.text ?? '';
    t.ok('完了通知に拒否の件数を載せる（組織の管理ポリシーを例に挙げる）', notice.includes('組織の管理ポリシー') && notice.includes('echo hi'), notice.slice(-600));

    // ---- 空 end_turn（本文なし・ツールなし）: mcpMissing を早まって出さず、次ターンの実応答で 1 度だけ出す
    const emptyDisabled = await client.runTurn({ prompt: 'empty-turn', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('空 end_turn（本文なし・ツールなし）では管理ポリシーの知らせを早まって出さない', emptyDisabled.outcome === 'ok' && textOf(emptyDisabled) === '', textOf(emptyDisabled));
    const afterEmptyDisabled = await client.runTurn({ prompt: 'こんにちは', sessionId: emptyDisabled.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    const afterEmptyBody = textOf(afterEmptyDisabled);
    t.ok('空 end_turn の次の実応答ターンで MCP 未接続なら mcpMissing を出す', afterEmptyDisabled.outcome === 'ok'
      && afterEmptyBody.startsWith('了解: こんにちは') && afterEmptyBody.includes('「MCP サーバー」') && afterEmptyBody.includes('request-review'), afterEmptyBody);
    const afterEmptyThird = await client.runTurn({ prompt: 'もう一度', sessionId: emptyDisabled.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('実応答で出した後は次のターンで繰り返さない', afterEmptyThird.outcome === 'ok' && !textOf(afterEmptyThird).includes('Pleiad からの知らせ'), textOf(afterEmptyThird));

    client.close(); client = null;
    await host.stop(); host = null;
    await cleanupTestHolder(dataDir);

    // ---- 管理ポリシーの無い agy: MCP を起こしたので何も足さない
    dataDir = path.join(tmp, 'data-plain');
    // 確認が要るか分からない permission_mode（「サンドボックスで続行」のときの実機の値は見ていない）では、モードの知らせを出さない。
    // FAKE_AGY_MCP_ON_TURN=1 で空ターンでは未接続・実応答ターンで接続する挙動を再現する
    host = await startServer({ dataDir, timeoutMs: 30_000, env: { AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: FAKE_AGY, FAKE_AGY_PERMISSION_MODE: 'proceed-in-sandbox', FAKE_AGY_MCP_ON_TURN: '1' } });
    client = await open({ ...host, autoAllow: true });
    const plain = await client.runTurn({ prompt: 'こんにちは', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('MCP に接続があり、確認の要ると分かっているモードでなければ、知らせを足さない', plain.outcome === 'ok' && textOf(plain) === '了解: こんにちは', textOf(plain));

    // ---- 空 end_turn の後に次ターンで MCP 接続が到達した場合
    const emptyConnected = await client.runTurn({ prompt: 'empty-turn', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('MCP 未接続のまま空 end_turn が返っても、この時点では mcpMissing を出さない', emptyConnected.outcome === 'ok' && textOf(emptyConnected) === '', textOf(emptyConnected));
    const afterEmptyConnected = await client.runTurn({ prompt: 'こんにちは', sessionId: emptyConnected.sessionId, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('次ターンの実応答で MCP に接続済みなら mcpMissing を出さない', afterEmptyConnected.outcome === 'ok' && textOf(afterEmptyConnected) === '了解: こんにちは', textOf(afterEmptyConnected));

    // ---- ステア合流: 1 回目が空 end_turn で即返却され、ステア実行中に MCP 接続が到達した場合
    const { sessionId: steerSid } = await client.cmd('newSession', { backend: 'antigravity', cwd });
    const steerMark = client.mark();
    await client.cmd('sendMessage', { sessionId: steerSid, messageId: 'agy-steer-1', prompt: 'steer-merge', mode: 'yolo' });
    await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'agy-steer-1', { from: steerMark, ms: 30_000 });
    await client.cmd('sendMessage', { sessionId: steerSid, messageId: 'agy-steer-2', prompt: '追伸です', mode: 'yolo' });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === steerSid, { from: steerMark, ms: 60_000 });
    const steerEvents = client.since(steerMark).filter(e => e.sessionId === steerSid);
    const steerBody = steerEvents.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const lastDeltaAt = steerEvents.findLastIndex(e => e.type === 'text.delta');
    const textEndAt = steerEvents.findIndex(e => e.type === 'text.end');
    const turnResultAt = steerEvents.findIndex(e => e.type === 'turnResult');
    t.ok('ステア合流で 1 回目が空 end_turn を返してもステア完了と MCP 接続を待ち、mcpMissing を誤検知しない',
      steerEvents[turnResultAt]?.outcome === 'ok' && steerBody === '了解: 追伸です' && !steerBody.includes('Pleiad からの知らせ'),
      JSON.stringify({ outcome: steerEvents[turnResultAt]?.outcome, steerBody }));
    t.ok('ステア側の text.delta がすべて出た後に text.end が出る',
      lastDeltaAt >= 0 && textEndAt > lastDeltaAt && turnResultAt > textEndAt,
      JSON.stringify({ lastDeltaAt, textEndAt, turnResultAt }));
  } finally {
    client?.close();
    await host?.stop();
    await cleanupTestHolder(dataDir);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
