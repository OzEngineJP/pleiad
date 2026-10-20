// 設定を書いている間の選択（web/client.mjs の reserveSettings・pendingChoice・settleNext・composerSelection・syncTopbar・runRefresh）。
// エージェントを選んだ直後（setTurnSettings の応答待ち）に別の会話の変更などで一覧の取り直しが走っても、入力欄が前のエージェントへ戻らない。
//   - 最後に選んだ意図を、書く前の一覧の写しや保存の応答より優先して見せる（モデル・エフォート・承認モード・接続先・アカウントは新しいエージェントの既定）
//   - 書けた後に届く、書く前に始まった取り直しの写しは、書けた値で載せ直す。書けた後に始まった取り直しは正本として任せる
//   - 書けなかったら保存できた値（前のエージェント）へ戻る。続けた選択・取り消しは畳んで見せる。別の会話の保存は今の会話の表示を動かさない
// client.mjs の該当の関数をそのまま vm で走らせる（on.backend の 1 行も client.mjs から取る）。
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { composerAccount } from '../../web/agent-accounts.mjs';

export const name = 'composer-pending-choice';
export const title = '設定を書いている間の選択: エージェントを選んだ直後の取り直しで前のエージェントへ戻らない・書けた後の古い写しは載せ直す・失敗は保存できた値へ戻る';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
function gate() {
  const g = {};
  g.promise = new Promise((resolve, reject) => { g.resolve = resolve; g.reject = reject; });
  return g;
}

export default async function (t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const take = (name) => {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`client.mjs に ${name} が無い`);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  const FUNCTIONS = ['reserveSettings', 'chooseSettings', 'justCreated', 'noteDraftChange', 'draftView', 'pendingChoice', 'settleNext', 'composerSelection',
    'endpointOf', 'selectedMode', 'syncTopbar', 'runRefresh', 'activeBackendId', 'capsOf'];
  const onBackend = /^\s+backend: (\(v\) => \{.*\}),$/m.exec(source);
  if (!onBackend) throw new Error('client.mjs の on.backend が見つからない');
  const code = `let settingsWrite = Promise.resolve(), settingsFailure = null, failedSettingsPatch = null, failedSettingsError = '';
let topbarVersion = 0, refreshVersion = 0, refreshSnapshotReady = false;
const inflightNext = new Map(), settledNext = new Map(), stagedNext = new Map();
${FUNCTIONS.map(take).join('\n')}
const onBackend = ${onBackend[1]};`;

  const noop = () => {};
  const painted = [];   // controls.paint のたびの、見せているエージェントとモデル
  const vocabAsked = [];
  const writes = [];    // setTurnSettings（手で終わらせる）
  const listings = [];  // listSessions（手で終わらせる）
  const state = {
    current: 'A', sessions: [], backends: [{ id: 'claude', capabilities: { accounts: 'token' } }, { id: 'codex', capabilities: { accounts: 'agent' } }],
    backendId: 'claude', prefs: {}, draft: {}, shownBackend: null, modes: {}, models: {}, model: '', effort: '', mode: 'default', endpoint: '', account: '', cwd: '', homeDir: '/home',
  };
  const row = (id, extra = {}) => ({ id, backend: 'claude', model: 'opus', effort: 'high', mode: 'plan', cwd: '/w', compatEndpoint: 'ep1', claudeAccount: 'acc1', ...extra });
  const reset = () => {
    state.current = 'A'; state.shownBackend = null; state.draft = {};
    state.sessions = [row('A'), row('B')];
    painted.length = 0; vocabAsked.length = 0; writes.length = 0; listings.length = 0;
  };
  const elements = new Map();
  const context = vm.createContext({
    state, composerAccount, homeDest: { bot: null, paint: noop }, bootHold: null, unsentHere: () => false,
    $: (id) => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '' }); return elements.get(id); },
    syncParentEntry: noop, rememberTitle: noop, syncTitleControls: noop, syncSettingsHold: noop, refreshGit: async () => {}, refreshWorktree: async () => {},
    headerUsage: { show: noop }, controls: { paint: () => painted.push({ shown: state.shownBackend, model: state.model }) },
    vocabKey: ({ backend, account, endpoint }) => `${backend}|${account}|${endpoint}`,
    loadVocab: async (bid) => { vocabAsked.push(bid); return { modes: { default: {}, plan: {} }, models: { '': {}, [`${bid}-m`]: {}, opus: {} } }; },
    syncEndpoint: async () => {}, syncAccount: async () => {}, defaultModelOf: () => '', adoptEfforts: async () => true, paintSettingsNotice: noop, renderSessions: noop,
    warmAgentChoices: noop,
    cmd: (command, args) => {
      if (command !== 'setTurnSettings') return Promise.resolve({});
      const g = gate();
      writes.push({ args, ...g });
      return g.promise;
    },
    listSessions: () => { const g = gate(); listings.push(g); return g.promise; },
    moveLanes: { confirm: noop }, serverMoveFields: new Map(), applyPendingPatches: (rows) => rows, readCompletions: { fromSessions: noop },
    applyPendingStatuses: (rows) => rows, paintAutoCompactionSettings: noop, browserSettings: { paint: noop }, computerSettings: { paint: noop },
    refreshPreviewConfirmation: noop, filePreview: { prefsChanged: noop }, loadBackends: async () => {}, applyRunning: noop, listLoaded: { sessions: true, threads: true },
    REFRESH_REPLY_TIMEOUT_MS: 1000,
    setTimeout, clearTimeout,
  });
  vm.runInContext(code, context);
  const sel = () => vm.runInContext('composerSelection()', context);
  const refresh = () => vm.runInContext('runRefresh(() => {})', context);
  const landed = async (g, rows) => { g.resolve(rows); await settle(); };
  const staleListing = () => [row('A'), row('B', { title: 'changed elsewhere' })];   // 書く前の A（予約なし）と、別の会話の変更
  const hasRow = (id) => state.sessions.find((s) => s.id === id);

  // ---------------------------------------------------------------- 保存の応答待ちの間に、別の会話の変更で取り直しが走る
  reset();
  await vm.runInContext('syncTopbar()', context);
  t.ok('前提: 選ぶ前は Claude のまま', state.shownBackend === 'claude' && sel().backend === 'claude');
  painted.length = 0; vocabAsked.length = 0;
  vm.runInContext("onBackend('codex')", context);
  t.ok('選んだ直後に、見せるエージェントは新しい方になる', state.shownBackend === 'codex');
  t.ok('書いている間は選択を重ねて見せる（新しいエージェントの既定へ戻る前提で reset）', sel().backend === 'codex' && sel().draft?.reset === true && sel().account === '' && sel().endpoint === '');
  const refreshing = refresh();
  await settle();
  await landed(listings[0], staleListing());
  await refreshing;
  t.ok('書く前の写しの取り直しが syncTopbar まで終わっても、見せるエージェントは戻らない', state.shownBackend === 'codex', state.shownBackend);
  t.ok('入力欄の選択も新しいエージェントのまま（モデル・エフォート・承認モードは前のエージェントのを読まない）',
    sel().backend === 'codex' && state.model === '' && state.effort === '' && state.mode === 'default' && state.endpoint === '' && state.account === '',
    JSON.stringify({ model: state.model, effort: state.effort, mode: state.mode, endpoint: state.endpoint, account: state.account }));
  t.ok('語彙は新しいエージェントの分を取った（前のエージェントの一覧に戻さない）', vocabAsked.at(-1) === 'codex' && 'codex-m' in state.models && !('claude-m' in state.models), JSON.stringify(vocabAsked));
  t.ok('選んでから取り直しが終わるまでに描いた表示に、前のエージェントは出ていない', painted.length > 0 && painted.every((p) => p.shown === 'codex'), JSON.stringify(painted));
  t.ok('別の会話の変更は一覧に載っている', hasRow('B').title === 'changed elsewhere');

  // 書き終わる。書く前に始まった取り直しの写しが後から届いても、書けた値を載せ直す
  const second = refresh();
  await settle();
  writes[0].resolve({ backend: 'codex', model: '', effort: '' });   // サーバーの応答は effort を必ず持つ（reserveTurnSettings）
  await settle();
  t.ok('書けた予約は行へ載り、見せるエージェントは新しいまま', hasRow('A').nextSettings?.backend === 'codex' && state.shownBackend === 'codex');
  await landed(listings[1], staleListing());   // 書く前に始まった取り直し（後から届く）
  await second;
  t.ok('書けた後に届いた、書く前に始まった取り直しの写しでも、予約は書けた値のまま', hasRow('A').nextSettings?.backend === 'codex' && sel().backend === 'codex' && state.shownBackend === 'codex',
    JSON.stringify(hasRow('A').nextSettings));
  t.ok('書けた後も、モデル・エフォート・承認モードは新しいエージェントの既定', state.model === '' && state.effort === '' && state.mode === 'default');

  // 書けた後に始まった取り直しは、サーバーの一覧を正本にする（古い控えで上書きしない）
  const third = refresh();
  await settle();
  await landed(listings[2], [row('A', { nextSettings: { backend: 'codex', model: 'codex-m' } }), row('B')]);
  await third;
  t.ok('書けた後に始まった取り直しは、サーバーの予約を正本にする', hasRow('A').nextSettings?.model === 'codex-m' && state.model === 'codex-m', JSON.stringify(hasRow('A').nextSettings));
  const fourth = refresh();
  await settle();
  await landed(listings[3], [row('A', { nextSettings: { backend: 'codex', model: 'codex-m' } }), row('B')]);
  await fourth;
  t.ok('控えは残らない（正本の後に古い値を載せ直さない）', vm.runInContext('settledNext.size', context) === 0);

  // ---------------------------------------------------------------- 書けなかった
  reset();
  await vm.runInContext('syncTopbar()', context);
  painted.length = 0;
  vm.runInContext("onBackend('codex')", context);
  const failing = vm.runInContext("settingsWrite", context);
  await settle();
  const failedWrite = writes[0];
  const stale = refresh();
  await settle();
  failedWrite.reject(new Error('disk'));
  await settle();
  await landed(listings[0], staleListing());
  await stale;
  t.ok('書けなかったら、保存できた値（前のエージェント）へ戻る', state.shownBackend === 'claude' && sel().backend === 'claude' && sel().draft === null, `${state.shownBackend}`);
  t.ok('書けなかった予約は控えに残らない', vm.runInContext('inflightNext.size', context) === 0 && vm.runInContext('settledNext.size', context) === 0);
  t.ok('失敗は入力欄の上の通知へ渡る（失敗した予約と理由）', vm.runInContext('settingsFailure', context) === 'A' && vm.runInContext('failedSettingsError', context) === 'disk');
  await failing.catch(() => {});

  // ---------------------------------------------------------------- 続けた選択・取り消し・ほかの会話
  reset();
  await vm.runInContext('syncTopbar()', context);
  vm.runInContext("onBackend('codex')", context);
  vm.runInContext("chooseSettings({ model: 'codex-m', rememberModel: true })", context);
  t.ok('エージェントの後に選んだモデルは、そのエージェントの選択として重なる', sel().backend === 'codex' && sel().draft.model === 'codex-m' && sel().draft.reset === true);
  vm.runInContext("chooseSettings({ backend: 'claude', model: '' })", context);
  t.ok('保存できている値と同じエージェントへ選び直したら、書く前の予約を読む（既定へ戻る扱いにしない）', sel().backend === 'claude' && !sel().draft.reset);
  vm.runInContext("chooseSettings({ cancel: true })", context);
  t.ok('取り消しが混ざるときは重ねず、保存できた値を見せる', sel().draft === null && sel().backend === 'claude');
  // 別の会話へ移っても、書いている会話の選択は混ざらない
  state.current = 'B';
  t.ok('別の会話の表示には、書いている会話の選択を混ぜない', sel().draft === null && sel().backend === 'claude');
  state.current = 'A';
  for (const w of writes) w.resolve({ backend: 'claude' });
  await settle();
}
