// server-devin から分けた、サーバーを使わない Devin の backend の試験（createDevinBackend + fake ACP）。
// 1 本の suite では、重い PC で suite の時間の上限（180 秒。tests/lib/runner-plan.mjs の suiteLimitMs）を超えたため、判定はそのままに分けた。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { createDevinBackend } from '../../core/backends/devin.mjs';

export const name = 'server-devin-backend';
export const title = 'Devin の backend（fake ACP）: 実行中の設定送信・ply_shell の受け渡し・ACP に無いモデル・恒常許可・close の失敗・cancel の期限・設定の確認・承認要求・送信前の上限';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-server-devin-backend-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  try {
    const command = () => [process.execPath, path.join(ROOT, 'tests/lib/fake-devin.mjs')];
    class SlowClient extends DevinAcp { constructor(options) { super({ ...options, env: { ...options.env, FAKE_DEVIN_SLOW_MS: '1800' } }); } }
    const liveBackend = createDevinBackend({ Acp: SlowClient, command, dataDir: path.join(root, 'live-settings') });
    let liveSessionId, deliveredResolve;
    const deliveredPromise = new Promise(resolve => { deliveredResolve = resolve; });
    const liveRun = liveBackend.runTurn({ cwd, prompt: '[slow] live settings', model: 'swe-2-high', mode: 'ask',
      emit: event => { if (event.type === 'session') liveSessionId = event.sessionId; }, onPromptDelivered: deliveredResolve });
    await deliveredPromise;
    const liveMode = await liveBackend.setModeLive({ sessionId: liveSessionId }, 'plan');
    const liveModel = await liveBackend.setModelLive({ sessionId: liveSessionId }, 'glm-5-2');
    const liveResult = await liveRun;
    t.ok('実行中のターンへ承認モードとモデルを送り、設定応答で反映を確かめる', liveMode && liveModel && liveResult.sessionId === liveSessionId);
    const suggestionBackend = createDevinBackend({ command, dataDir: path.join(root, 'suggestions') });
    // Devin は内部呼出しを分離できないので候補の口を持たない。通常会話の runTurn は server-devin の試験のまま
    t.ok('Devin は候補の内部呼出しを持たない（分離できない）', typeof suggestionBackend.suggestNext === 'undefined');
    const deliveryCalls = [];
    class DeliveryClient extends DevinAcp {
      async call(method, params, options) { deliveryCalls.push({ method, params }); return super.call(method, params, options); }
    }
    const deliveryBackend = createDevinBackend({ Acp: DeliveryClient, command, dataDir: path.join(root, 'delivery') });
    const shellRuntime = { url: 'http://127.0.0.1:1/shell', headers: { Authorization: 'Bearer fixture-shell' }, instructions: 'fixture-shell-instructions' };
    const deliveredShell = await deliveryBackend.runTurn({ cwd, prompt: 'shell first', model: 'swe-2-high', mode: 'ask', shellRuntime, emit: () => {} });
    await deliveryBackend.runTurn({ cwd, sessionId: deliveredShell.sessionId, prompt: 'shell next', model: 'swe-2-high', mode: 'ask', shellRuntime, emit: () => {} });
    t.ok('新規・再開の両方に認証付きply_shellとその指示を渡す',
      deliveryCalls.filter(c => ['session/new', 'session/load'].includes(c.method)).every(c => c.params.mcpServers.some(s => s.name === 'ply_shell' && s.type === 'http' && s.headers[0].value === 'Bearer fixture-shell'))
      && deliveryCalls.filter(c => c.method === 'session/prompt').every(c => c.params.prompt[0].text.includes('fixture-shell-instructions')));
    const deliveryMark = deliveryCalls.length;
    await deliveryBackend.runTurn({ cwd, prompt: 'no shell', model: 'swe-2-high', mode: 'ask', emit: () => {} });
    t.ok('別のターンにply_shellを持ち越さない', deliveryCalls.slice(deliveryMark).find(c => c.method === 'session/new').params.mcpServers.length === 0);

    // ACP の model に無い名前（2026-11、古いカタログの名前 swe-2-1-high で委譲が始まってすぐ止まった）は送らずに断る（ADR 0356）
    const runnableCalls = [];
    class RunnableClient extends DevinAcp {
      async call(method, params, options) { runnableCalls.push({ method, params }); return super.call(method, params, options); }
    }
    const runnable = createDevinBackend({ Acp: RunnableClient, command, dataDir: path.join(root, 'runnable') });
    t.ok('一覧による振り分けの事前除外は公開しない', runnable.runnableModel === undefined);
    const unlistedEvents = [];
    const unlisted = await runnable.runTurn({ cwd, prompt: 'not runnable', model: 'swe-2-1-high', mode: 'ask', emit: e => unlistedEvents.push(e) }).catch(e => e);
    const unlistedResult = unlistedEvents.findLast(e => e.type === 'turnResult');
    t.ok('ACP に無い名前は読み替えず・送らずに、未配達の kind: model で断る', unlisted?.undelivered === true && unlistedResult?.kind === 'model' && unlistedResult?.pristine === true
      && !runnableCalls.some(c => c.method === 'session/set_config_option' && c.params.configId === 'model') && !runnableCalls.some(c => c.method === 'session/prompt'),
      JSON.stringify({ undelivered: unlisted?.undelivered, unlistedResult }));

    let alwaysAnswer, canAlways;
    class AlwaysClient extends DevinAcp {
      constructor(options) { super({ ...options, onRequest: async (method, params, context) => {
        if (method === 'session/request_permission') params.options.push({ kind: 'allow_always', optionId: 'persistent', name: 'For this session' });
        const answer = await options.onRequest(method, params, context);
        if (method === 'session/request_permission') alwaysAnswer = answer;
        return answer;
      } }); }
    }
    const alwaysBackend = createDevinBackend({ Acp: AlwaysClient, command, dataDir: path.join(root, 'always') });
    await alwaysBackend.runTurn({ cwd, prompt: '[permission]', model: 'swe-2-high', mode: 'ask', emit: () => {},
      askPermission: async request => { canAlways = request.canAlways; return { allow: true, always: true }; } });
    t.ok('Devin: CLIが提示した恒常許可を画面の回答へ対応させる', canAlways && alwaysAnswer.outcome.optionId === 'persistent');

    class CloseFailure extends DevinAcp { async close() { await super.close(); throw new Error('fixture close failed'); } }
    const events = [];
    const backend = createDevinBackend({ Acp: CloseFailure, command, dataDir: path.join(root, 'close-data') });
    await assert.rejects(backend.runTurn({ cwd, prompt: 'done', model: 'swe-2-high', emit: e => events.push(e) }), /fixture close failed/);
    t.ok('close の失敗を成功にせず、一度だけ失敗として返す', events.filter(e => e.type === 'turnResult').length === 1 && events.find(e => e.type === 'turnResult').outcome === 'error' && events.find(e => e.type === 'turnResult').error.includes('fixture close failed'));
    t.ok('使用量の取得日時は不明を明示する', (await backend.usage()).checkedAt === null);

    const bounded = createDevinBackend({ command, dataDir: path.join(root, 'bounded-data'), cancelGraceMs: 100 });
    const signal = new AbortController(), cancelled = [], started = Date.now();
    await bounded.runTurn({ cwd, prompt: '[stubborn]', model: 'swe-2-high', signal, emit: e => cancelled.push(e), onPromptDelivered: () => setTimeout(() => signal.abort(), 50) });
    t.ok('cancel に応じない CLI も期限内に終了する', Date.now() - started < 5000 && cancelled.filter(e => e.type === 'turnResult').length === 1 && cancelled.find(e => e.type === 'turnResult').outcome === 'aborted');

    for (const drift of ['after-mode', 'after-config-mode', 'after-model', 'before-mode', 'after-empty', 'after-duplicate', 'before-recovered', 'after-recovered']) {
      class SetupDrift extends DevinAcp { constructor(options) { super({ ...options, env: { ...options.env, FAKE_DEVIN_SETUP_DRIFT: drift } }); } }
      const dataDir = path.join(root, drift), updates = [];
      const guarded = createDevinBackend({ Acp: SetupDrift, command, dataDir });
      let delivered = false;
      const turn = guarded.runTurn({ cwd, prompt: 'must use ask and SWE-2 High', model: 'swe-2-high', mode: 'ask', emit: event => updates.push(event), onPromptDelivered: () => { delivered = true; } });
      const recovered = drift.endsWith('recovered');
      if (recovered) await turn; else await assert.rejects(turn);
      const nativeDir = path.join(dataDir, 'devin', 'sessions');
      const [file] = (await fs.readdir(nativeDir)).filter(name => name.endsWith('.json'));
      const saved = JSON.parse(await fs.readFile(path.join(nativeDir, file), 'utf8'));
      t.ok(`最終 ACK 前後の同一 batch の最新設定で prompt の送信を判断する（${drift}）`,
        delivered === recovered && updates.find(event => event.type === 'turnResult').outcome === (recovered ? 'ok' : 'error') && saved.messages.filter(message => message.role === 'user').length === (recovered ? 1 : 0));
    }
    for (const kind of ['permission-id-only', 'permission-partial', 'permission-null', 'permission-unknown']) {
      const requests = [], decisions = [];
      class PermissionClient extends DevinAcp {
        constructor(options) {
          super({ ...options, onResponse: response => { options.onResponse(response); if (response.method === 'session/prompt') decisions.push(response.result.permissionResult); } });
        }
      }
      const permissionBackend = createDevinBackend({ Acp: PermissionClient, command, dataDir: path.join(root, kind) });
      await permissionBackend.runTurn({ cwd, prompt: `[${kind}]`, model: 'swe-2-high', emit() {}, askPermission: request => { requests.push(request); return { allow: false }; } });
      assert.deepEqual(decisions, [{ outcome: { outcome: 'selected', optionId: 'reject_once' } }]);
      if (kind === 'permission-unknown') assert.equal(requests.length, 0);
      else {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].toolName, kind === 'permission-partial' ? 'Updated permission' : 'Fixture permission');
        assert.deepEqual(requests[0].input, { command: 'echo fixture' });
      }
      t.ok(`承認要求は既知の詳細を非 null patch と統合し、不明操作は拒否する（${kind}）`, true);
    }

    class BeforePromptLimit extends DevinAcp {
      call(method, ...args) {
        if (method === 'session/new') return Promise.reject(Object.assign(new Error('fixture rate limit'), { acpLimit: { resetsAt: Date.now() + 5000 } }));
        return super.call(method, ...args);
      }
    }
    let deliveredBeforeLimit = false;
    const beforeEvents = [];
    const beforeBackend = createDevinBackend({ Acp: BeforePromptLimit, command, dataDir: path.join(root, 'before-limit') });
    await assert.rejects(beforeBackend.runTurn({ cwd, prompt: 'not delivered', model: 'swe-2-high', emit: e => beforeEvents.push(e), onPromptDelivered: () => { deliveredBeforeLimit = true; } }), e => e.undelivered === true);
    t.ok('送信前の上限は未配送の失敗であり、送信済みや limited に変えない', !deliveredBeforeLimit && beforeEvents.find(e => e.type === 'turnResult')?.outcome === 'error');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
