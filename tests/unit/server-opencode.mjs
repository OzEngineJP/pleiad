// OpenCode のバックエンド（core/backends/opencode.mjs）を、身代わりの opencode serve（tests/lib/fake-opencode.mjs）で動かして確かめる:
// 記述と語彙・ツール・承認（1 回・常に・拒否の理由）・質問・Pleiad の MCP の中継（会話の口へ振り分ける）・会話のシェルの環境変数・
// 途中送信と渡った合図・中断・失敗・サブエージェント・圧縮・分岐。全体の共通の契約は backend-conformance
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { loadSqlite } from '../../core/db.mjs';

export const name = 'server-opencode';
export const title = 'OpenCode: 語彙・ツール・承認・質問・Pleiad の MCP の中継・シェルの環境変数・途中送信・中断・失敗・サブエージェント・圧縮';

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-opencode-'));
  // OpenCode の側に前からある会話（TUI で作ったもの）。サーバーが動いていない間は、この DB から一覧に出す
  const ocData = path.join(dataDir, 'oc-data');
  await fs.mkdir(ocData, { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const seed = new DatabaseSync(path.join(ocData, 'opencode.db'));
  seed.exec('create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer)');
  seed.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?)').run('ses_tui0001', null, ROOT, 'made in the TUI', 1000, 2000, null);
  seed.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?)').run('ses_tui0002', 'ses_tui0001', ROOT, 'a subagent', 1000, 2000, null);
  seed.exec('create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)');
  seed.exec('create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)');
  seed.prepare('insert into message values (?, ?, ?, ?, ?)').run('msg_tui01', 'ses_tui0001', 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }));
  seed.prepare('insert into message values (?, ?, ?, ?, ?)').run('msg_tui02', 'ses_tui0001', 1100, 1200, JSON.stringify({ role: 'assistant', time: { created: 1100 } }));
  seed.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run('prt_tui01', 'msg_tui01', 'ses_tui0001', 1000, 1000, JSON.stringify({ type: 'text', text: 'hello from the TUI' }));
  seed.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run('prt_tui02', 'msg_tui02', 'ses_tui0001', 1100, 1200, JSON.stringify({ type: 'text', text: 'answered in the TUI' }));
  seed.close();
  await fs.writeFile(path.join(ocData, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'secret-value', refresh:'refresh', expires:2000000000000 } }));
  const started = path.join(dataDir, 'oc-started.txt');
  const fakeState = path.join(dataDir, 'oc-state');
  const server = await startServer({ dataDir, timeoutMs: 60_000, env: { AGENT_HOST_BACKENDS: 'opencode', AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests/lib/fake-opencode.mjs')}"`,
    AGENT_HOST_OPENCODE_DATA: ocData, FAKE_OPENCODE_STARTED_FILE: started, FAKE_OPENCODE_STATE_DIR: fakeState } });
  const answers = [];   // 承認・質問の答え方（先頭から使う）
  const asked = [];
  const c = await open({ port: server.port, token: server.token, onEvent: async (ev, self) => {
    if (ev.type !== 'permission') return;
    asked.push(ev);
    const next = answers.shift() ?? { allow: true };
    await self.cmd('resolvePermission', { id: ev.id, ...next }).catch(() => {});
  } });
  const text = (r) => r.events.filter((e) => e.type === 'text.delta' && e.sessionId === r.sessionId).map((e) => e.text).join('');
  try {
    // ---- まだ使っていない間は、一覧とログインの状態のために OpenCode のサーバー（約 760 MB）を起こさない
    const early = (await c.cmd('listSessions')).find((x) => x.id === 'ses_tui0001');
    const auth = await c.cmd('authStatus', { backend: 'opencode' });
    const tuiHistory = await c.cmd('loadSession', { sessionId: 'ses_tui0001' });
    t.ok('起こす前: 会話の発言も DB から読む（全文検索の索引作りが全部の会話を読むため）', tuiHistory.messages.map((m) => `${m.role}:${m.text}`).join('|') === 'user:hello from the TUI|assistant:answered in the TUI', JSON.stringify(tuiHistory.messages));
    const startedEarly = await fs.readFile(started, 'utf8').catch(() => '');
    t.ok('起こす前: OpenCode の会話の DB から一覧に出す（子の会話は出さない）', early?.title === 'made in the TUI' && early.backend === 'opencode'
      && !(await c.cmd('listSessions')).some((x) => x.id === 'ses_tui0002'), JSON.stringify(early));
    t.ok('起こす前: ログインの状態は資格情報のファイルの接続先の名前だけで答える（値は出さない）', auth.loggedIn === true && /openai/.test(auth.account ?? '') && !JSON.stringify(auth).includes('secret-value'), JSON.stringify(auth));
    t.ok('起こす前: 一覧・ログインの状態・発言の読み出しでは OpenCode のサーバーを起こさない', startedEarly === '', startedEarly);
    const [b] = await c.cmd('backends');
    t.ok('記述: 短い名前・ロゴ・自動の圧縮の行が付く', b.id === 'opencode' && b.shortLabel === 'OpenCode' && b.brand?.logo === 'opencode.svg' && b.idleCompaction === 'opencode', JSON.stringify(b));
    t.ok('能力: 分岐・サブエージェント・承認・圧縮・委譲の橋・コンピューターの操作', b.capabilities.fork && b.capabilities.subagents && b.capabilities.alwaysAllow
      && b.capabilities.compact && b.capabilities.plyAgents && b.capabilities.computerUse?.images === 'inline' && b.capabilities.shell === 'host');
    const vocab = await c.cmd('models', { backend: 'opencode' });
    t.ok('モデル: 既定と接続先のモデル。エフォートはモデルの variants', vocab[''] && vocab['fake/echo']?.efforts?.join() === 'low,high' && vocab['fake/tiny']?.efforts?.length === 0, JSON.stringify(vocab));
    t.ok('モデル: 既定の行にも、実際に当たるモデルの段を写す', vocab['']?.resolvesTo === 'fake/echo' && vocab['']?.efforts?.join() === 'low,high', JSON.stringify(vocab['']));
    const ocEfforts = await c.cmd('efforts', { backend: 'opencode', model: '', cwd: ROOT });
    t.ok('エフォート: 既定のモデルでも段が選べる（OpenCode は既定の variant を返さないので「既定」の段は作らない）',
      Object.keys(ocEfforts).join() === ',low,high' && !ocEfforts[''].resolvesTo, JSON.stringify(ocEfforts));
    const modes = await c.cmd('modes', { backend: 'opencode' });
    t.ok('承認モード: 都度確認が先頭で、全部自動・Bypass は聞かない', Object.keys(modes).join() === 'ask,edit,full,yolo,plan' && modes.full.autonomy === 'never' && modes.yolo.scope === 'full', JSON.stringify(Object.keys(modes)));

    // ---- ログイン（端末の opencode auth login を案内して見張る）を［やめる］（ADR 0243）
    const loginMark = c.mark();
    const abandoned = c.cmd('authLogin', { backend: 'opencode' }).then(() => null, (e) => e);
    const guide = await c.waitFor((e) => e.type === 'auth' && e.phase === 'url', { ms: 10_000, from: loginMark }).catch(() => null);
    const cancel = await c.cmd('authCancel', { backend: 'opencode' });
    const stopped = await abandoned;
    t.ok('ログイン: 端末のコマンドを案内し、［やめる］で見張りを止めて CANCELLED で返る', /auth login/.test(guide?.url ?? '') && cancel.cancelled === true && stopped?.code === 'CANCELLED',
      `${guide?.url} ${JSON.stringify(cancel)} ${stopped?.code} ${stopped?.message}`);
    t.ok('ログイン: やめたものは失敗のイベントを出さない', !c.events.slice(loginMark).some((e) => e.type === 'auth' && e.phase === 'error'));

    // ---- 1 ターン（system に Pleiad の指示が入る）とツール
    const first = await c.runTurn({ backend: 'opencode', cwd: ROOT, prompt: 'tool please', mode: 'full', model: 'fake/echo', effort: 'high' });
    const sid = first.sessionId;
    t.ok('ツールの始まりと結果が流れ、本文で終わる', first.outcome === 'ok' && first.tools.includes('bash')
      && first.events.some((e) => e.type === 'tool.result' && e.text === 'hello\n' && e.isError === false) && text(first).includes('ran the tool'), JSON.stringify(first.events.map((e) => e.type)));
    t.ok('Pleiad の指示を system で渡す（委譲の橋の指示）', text(first).startsWith('[system]'));
    t.ok('考え（thinking）と使用量・文脈の量が流れる', first.events.some((e) => e.type === 'thinking.delta') && first.events.some((e) => e.type === 'contextWindow' && e.windowTokens === 100_000));

    // ---- 承認: 1 回・常に・拒否の理由
    answers.push({ allow: true });
    const once = await c.runTurn({ sessionId: sid, prompt: 'ask once', mode: 'ask' });
    t.ok('承認: 許可で once を返す', text(once).includes('allowed (once)') && asked.at(-1)?.toolName === 'bash' && asked.at(-1)?.canAlways === true, text(once));
    answers.push({ allow: true, always: true });
    const always = await c.runTurn({ sessionId: sid, prompt: 'ask always' });
    t.ok('承認: 常に許可で always を返す', text(always).includes('allowed (always)'), text(always));
    answers.push({ allow: false, message: 'not now' });
    const denied = await c.runTurn({ sessionId: sid, prompt: 'ask denied' });
    t.ok('承認: 拒否は理由を添えて reject で返し、ツールは error', text(denied).includes('rejected: not now')
      && denied.events.some((e) => e.type === 'tool.result' && e.isError === true), text(denied));

    // ---- 質問
    answers.push({ allow: true, answers: { 'Which color?': 'Blue' } });
    const q = await c.runTurn({ sessionId: sid, prompt: 'question' });
    const card = asked.at(-1);
    t.ok('質問: 質問のカードに選択肢が載り、答えが OpenCode に返る', card?.kind === 'question' && card.questions?.[0]?.options?.map((o) => o.label).join() === 'Red,Blue'
      && text(q).includes('answers: [["Blue"]]'), JSON.stringify({ card, text: text(q) }));

    // ---- Pleiad の MCP の中継（ply_agents）: この会話の口へ振り分ける
    const mcp = await c.runTurn({ sessionId: sid, prompt: `mcp:${JSON.stringify({ server: 'ply_agents', tool: 'ply_task_list', arguments: {} })}`, mode: 'full' });
    const call = mcp.events.find((e) => e.type === 'tool.start' && e.sessionId === sid);
    t.ok('ply_agents のツールは中継を通ってこの会話の橋へ届き、名前は mcp__ply_agents__* にそろう', call?.name === 'mcp__ply_agents__ply_task_list'
      && text(mcp).includes('{"tasks":[]}'), JSON.stringify({ name: call?.name, text: text(mcp) }));
    // 結び付けていない会話の id では、口は断る（ほかの会話の橋を使わせない）
    const stray = await c.runTurn({ backend: 'opencode', cwd: ROOT, prompt: 'plain', mode: 'full' });
    t.ok('別の会話も同じ作業場所の中継を使える（会話ごとに結び付く）', stray.outcome === 'ok' && stray.sessionId !== sid);

    // ---- 会話のシェルの環境変数（プラグインの shell.env と同じ口）
    const env = await c.runTurn({ sessionId: sid, prompt: 'env', mode: 'full' });
    t.ok('会話のシェルに操作の一覧の CLI の接続先が入る', /PLEIAD_CONTROL_URL/.test(text(env)), text(env));

    // ---- 途中送信
    const mark = c.mark();
    const holding = c.runTurn({ sessionId: sid, prompt: 'hold on' });
    await c.waitFor((e) => e.type === 'activity' && e.sessionId === sid, { ms: 30_000, from: mark });
    await c.cmd('sendMessage', { sessionId: sid, messageId: 'oc-steer-0001', prompt: 'steer-me' });
    const held = await holding;
    t.ok('途中送信が同じ実行で読まれ、渡った合図が出る', text(held).includes('受け取った: steer-me')
      && c.since(mark).some((e) => e.type === 'userMessage.delivered' && e.messageId === 'oc-steer-0001'), text(held));

    // ---- 中断・失敗
    const am = c.mark();
    c.cmd('runTurn', { sessionId: sid, prompt: 'slow' }).catch(() => {});
    await c.waitFor((e) => e.type === 'tool.start' && e.sessionId === sid, { ms: 30_000, from: am });
    await c.cmd('abort', { sessionId: sid });
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sid, { ms: 30_000, from: am });
    t.ok('中断は turnResult aborted', c.since(am).some((e) => e.type === 'turnResult' && e.sessionId === sid && e.outcome === 'aborted'));
    const failed = await c.runTurn({ sessionId: sid, prompt: 'fail' });
    t.ok('session.error は turnResult error（文を添える）', failed.outcome === 'error' && failed.events.some((e) => e.type === 'turnResult' && /fake failure/.test(e.error ?? '')));
    const providerFailed = await c.runTurn({ sessionId: sid, prompt: 'provider-fail' });
    t.ok('プロバイダーの 4xx（step.failed → execution.failed）も turnResult error（原因の文を添える）', providerFailed.outcome === 'error'
      && providerFailed.events.some((e) => e.type === 'turnResult' && /region not allowed/.test(e.error ?? '')), JSON.stringify(providerFailed.events.filter((e) => e.type === 'turnResult')));

    // ---- サブエージェント（task）
    const task = await c.runTurn({ sessionId: sid, prompt: 'task' });
    t.ok('task のツールは delegate の形で流れ、子の会話の本文は親に混ざらない', task.events.some((e) => e.type === 'tool.start' && e.name === 'task') && !text(task).includes('hi from the child'), text(task));
    const history = await c.cmd('loadSession', { sessionId: sid });
    t.ok('履歴: 自分の発言・返答・ツールの結果が読める', history.messages.some((m) => m.role === 'user' && m.text === 'tool please')
      && history.messages.some((m) => m.toolCalls?.some((x) => x.name === 'bash' && x.result?.text === 'hello\n')), JSON.stringify(history.messages.map((m) => [m.role, m.text])));

    // ---- 圧縮
    const cm = c.mark();
    await c.cmd('compactConversation', { sessionId: sid });
    const done = await c.waitFor((e) => e.type === 'compaction' && e.sessionId === sid && (e.phase === 'complete' || e.phase === 'failed'), { ms: 30_000, from: cm });
    t.ok('手動の圧縮は summarize で終わり、要約を持つ', done.phase === 'complete' && /Summary/.test(done.summary ?? ''), JSON.stringify(done));

    // ---- 実行中のモデル・承認モード変更（OpenCode v2 の session API）
    const liveMark = c.mark();
    const liveTurn = c.runTurn({ sessionId: sid, prompt: 'hold on', mode: 'full', model: 'fake/echo' });
    await c.waitFor((e) => e.type === 'activity' && e.sessionId === sid, { ms: 30_000, from: liveMark });
    const modelLive = await c.cmd('setModel', { sessionId: sid, model: 'fake/tiny' });
    const modeLive = await c.cmd('setMode', { sessionId: sid, mode: 'plan' });
    await c.cmd('sendMessage', { sessionId: sid, messageId: 'oc-live-0001', prompt: 'release' });
    const liveDone = await liveTurn;
    const liveState = JSON.parse(await fs.readFile(path.join(fakeState, 'sessions.json'), 'utf8'))[sid];
    t.ok('実行中のモデル変更は OpenCode の v2 session API で届く', modelLive?.live === true
      && liveState?.model?.providerID === 'fake' && liveState?.model?.id === 'tiny', JSON.stringify({ modelLive, model: liveState?.model }));
    t.ok('実行中の承認モード変更はセッション権限を書き換え、実行は完了する', modeLive?.live === true
      && liveState?.permission?.some(p => p.permission === 'edit' && p.action === 'deny') && liveDone.outcome === 'ok', JSON.stringify({ modeLive, outcome: liveDone.outcome }));
    await c.cmd('setMode', { sessionId: sid, mode: 'full' });
    await c.cmd('setModel', { sessionId: sid, model: 'fake/echo' });
  } finally {
    c.close();
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
