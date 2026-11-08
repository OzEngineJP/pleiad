// 記憶の自動整理の入切・世代・停止の回帰:
//   - 既定は OFF。明示の「今すぐ」も OFF をすり抜けない（runNow・learnNow とも skipped: 'off'）
//   - AI の応答を待っている間の OFF（・短時間の OFF→ON＝世代の入れ替わり）では、その世代の結果を書かない
//   - 分類不能な失敗は 1 回で halted（認証エラーなど、元の理由を askBackend が失う失敗を繰り返さない）。
//     許可リストの一時エラー（learner turn: limited など）だけ有限再試行。halted は明示の「もう一度」（learnNow）
//     か再有効化（memoryLearnFrom が halt より新しい）でだけ解除され、無関係の成功では消えない（ラッチ）
//   - エピソード（静かなスレッドの要約）は learner と同じ halted を共有し、OFF/halted では AI を呼ばず書き込まない。
//     commit が世代違いで中止（null）なら古い要約も保存しない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { backend as fake } from '../../core/backends/fake.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createMemoryService } from '../../core/memory/service.mjs';
import { createMemoryLearner, episodeSummaryAllowedAt } from '../../core/memory/learn.mjs';
import { createEpisodes } from '../../core/memory/episodes.mjs';
import { DB_FILE } from '../../core/db.mjs';

// 書き込み失敗の注入用（データ置き場のロック・接続の共有を回らない、別の素の接続）
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const name = 'memory-learn-gate';
export const title = '自動整理: 既定 OFF・世代で古い結果を書かない・halted のラッチ・許可リスト再試行・エピソード共有停止';

const DAY = 86_400_000;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-learn-gate-'));
  const keepAlive = setInterval(() => {}, 1000);
  const cleanup = [];
  try {
    let at = new Date(2026, 9, 4, 3, 0).getTime();   // 現地時刻 03:00（その日の 02:00 を過ぎている）
    const clock = { now: () => at, setTimer: () => 0, clearTimer: () => {} };
    const channels = createChannelService({ dir: path.join(dir, 'channels') });
    cleanup.push(() => channels.close());
    await channels.start();
    const memory = createMemoryService({ dataDir: dir, channels });
    cleanup.push(() => memory.stop());
    await memory.start();
    const side = new Map();
    const chat = async (text) => {
      const id = `fake-${crypto.randomUUID()}`;
      await fake.runTurn({ sessionId: id, prompt: text, cwd: dir, mode: 'default', model: '',
        emit: () => {}, onPromptDelivered: () => {}, askPermission: async () => ({ allow: true }) });
      side.set(id, { backend: 'fake', lastModified: at });
      return id;
    };
    const host = {
      runtime: { turns: new Map() }, sessionBusy: () => false,
      store: { getAll: async () => Object.fromEntries(side), get: async (id) => side.get(id) ?? {} },
      getBackend: (id) => (id === 'fake' ? fake : null), listBackends: () => [fake],
    };
    let prefs = {};   // 既定: 全部 OFF
    let failWith = null;
    let episodeFail = null;   // エピソードの呼び出しだけに当てる失敗（並行注入用）
    let episodeGate = null, episodeRelease = null;   // エピソードの ask を途中で止めるゲート（並行注入用）
    let holdGate = null;      // learner の ask を途中で止めるゲート（並行注入用）
    let asks = 0;
    const ask = async (prompt) => {
      asks++;
      if (prompt.includes('<pleiad-memory-episode>')) {
        if (episodeFail === 'hold') { episodeFail = null; await episodeGate; }
        if (episodeFail === 'bad-json') { episodeFail = null; return 'not json at all'; }
        if (episodeFail) { const e = episodeFail; episodeFail = null; throw e; }
        return JSON.stringify({ summary: '要約です', memories: [] });
      }
      if (failWith === 'flip-off') { prefs = {}; }
      if (failWith === 'flip-gen') { prefs = { ...prefs, memoryLearnFrom: Date.now() + 1 }; }
      if (failWith === 'hold') { failWith = null; await holdGate; }
      if (failWith instanceof Error) { const e = failWith; failWith = null; throw e; }
      if (failWith === 'bad-json') { failWith = null; return 'not json at all'; }
      if (failWith) { failWith = null; }
      const line = prompt.split('\n').find((part) => part.startsWith('Human statements: '));
      const statements = JSON.parse(line.slice('Human statements: '.length));
      return JSON.stringify({ memories: statements.flatMap((item) => {
        const m = /^覚えて[:：]\s*(.{8,300})/u.exec(item.text.trim());
        return m ? [{ action: 'add', layer: 'user', text: m[1], kind: 'pref', weight: 2, sourceIndexes: [item.index] }] : [];
      }) });
    };
    const learner = createMemoryLearner({ dataDir: dir, channels, bots: { get: async () => null }, memory, host, clock, now: () => at,
      readPrefs: async () => prefs, readMessages: async (id) => fake.getMessages(id), ask,
      listSessions: async () => [...side].map(([id, meta]) => ({ id, ...meta })) });
    cleanup.push(() => learner.close());

    // ---- 既定 OFF: 予定の回・今すぐ・もう一度も動かない
    await chat('覚えて: OFF のままでは絶対に書き込まれない発言');
    assert.equal((await learner.runIfDue()).skipped, 'off', '既定 OFF では予定の回も走らない');
    assert.equal((await learner.status()).skip.reason, 'off');
    assert.equal((await learner.runNow()).skipped, 'off', '明示の「今すぐ」も OFF をすり抜けない');
    assert.equal((await learner.learnNow()).skipped, 'off', '「もう一度」も OFF をすり抜けない');
    assert.equal(asks, 0, 'OFF では AI を呼ばない');
    const off = await learner.status();
    assert.ok(off.enabled === false && off.summaryEnabled === false && off.nextAt === null, '様子は OFF を出す');
    t.ok('既定 OFF では予定・今すぐ・もう一度のどれも AI を呼ばず走らない', true);

    // ---- ON にすると走る。AI を待っている間の OFF は書き込みに進まない
    prefs = { memoryAutoLearn: true };
    failWith = 'flip-off';   // ask を待っている間に OFF になる
    const flipped = await learner.runNow();
    assert.equal(flipped.changed, 0, 'AI の応答を待っている間に OFF になったら書き込まない');
    assert.equal((await memory.list({ layer: 'user' })).length, 0);
    t.ok('待機中の OFF で実行中の結果を書き込まない', true);

    // ---- 短時間の OFF→ON（世代の入れ替わり）でも、OFF 前の世代の結果を書かない
    prefs = { memoryAutoLearn: true };
    at += 60_000;
    await chat('覚えて: 世代が替わる前の発言です');
    failWith = 'flip-gen';   // ask を待っている間に ON にし直される（memoryLearnFrom が進む＝世代違い）
    const stale = await learner.runNow();
    assert.equal(stale.changed, 0, 'OFF→ON で世代が替わったら、OFF 前の応答を書かない');
    assert.equal((await memory.list({ layer: 'user' })).length, 0);
    t.ok('短時間の OFF→ON でも OFF 前の世代の結果を書かない', true);

    // ---- 普通に ON なら書く（カーソルは先行の実行が読み終えているので、新しい発言を足す）
    prefs = { memoryAutoLearn: true };
    at += 60_000;   // 先行の実行の lastRunAt より新しい発言
    await chat('覚えて: ON ではこの発言を記憶に書きます');
    const learned = await learner.runNow();
    assert.ok(learned.changed >= 1 && (await memory.list({ layer: 'user' })).some((e) => e.text.includes('記憶に書きます')),
      `learned=${JSON.stringify(learned)} memories=${JSON.stringify(await memory.list({ layer: 'user' }))}`);
    t.ok('ON では記憶に書く', true);

    // ---- 分類不能な失敗は 1 回で halted。scoped の実行も止まる（解除は learnNow・再有効化だけ）
    at += DAY;
    await chat('覚えて: halted の間に新しい発言が来ても自動では走らない');
    failWith = new Error('totally unknown failure');
    await assert.rejects(learner.runIfDue(), /totally unknown/);
    let status = await learner.status();
    assert.ok(status.halted?.message === 'totally unknown failure' && status.failure === null, '分類不能な失敗は halted へ');
    assert.ok(learner.isHalted());
    assert.equal((await learner.runIfDue()).skipped, 'halted', 'halted 中は間隔を待たずに試さない');
    const before = asks;
    const scoped = await learner.runNow({ scope: { sessionIds: [...side.keys()].at(-1) } });
    assert.equal(scoped.skipped, 'halted', 'scoped・エピソードの自動経路も halted で止まる');
    assert.equal(asks, before, 'halted 中は scoped 実行も AI を呼ばない');
    assert.equal((await learner.runIfDue()).skipped, 'halted', '自動の回も止まったまま');
    t.ok('分類不能な失敗は 1 回で halted。scoped 実行も止まり、解除は明示操作だけ', true);

    // ---- 「もう一度」は halted を解除して 1 回走る（止まっていた間の発言を読む）
    const retried = await learner.learnNow();
    assert.ok(retried.changed >= 1 && !learner.isHalted() && (await learner.status()).halted === null, 'learnNow が halted を解除して走る');
    assert.ok(asks > before, '解除の後は AI を呼ぶ');
    t.ok('明示の「もう一度」で halted を解除して走る', true);

    // ---- 実行中に別経路（エピソード）が記録した一時エラーは、その実行の成功で消さない（回数・再試行の予定が残る）
    prefs = { memoryAutoLearn: true, memoryEpisodeSummary: true };
    at += DAY;
    await chat('覚えて: 実行の途中でエピソードが失敗しても、その回数と再試行の予定を消さない');
    let release;
    holdGate = new Promise((r) => { release = r; });
    failWith = 'hold';
    const inFlight = learner.runNow();
    episodeFail = new Error('learner turn: limited');
    await assert.rejects(learner.summarizeEpisode({ botId: 'b_x', channelId: 'c', threadId: 'th',
      posts: [{ id: 'p-par', author: { kind: 'human' }, text: '話します', at }], previous: '' }), /learner turn: limited/);
    release();
    const done = await inFlight;
    assert.ok(done.changed >= 1, '実行自体は成功する');
    status = await learner.status();
    assert.equal(status.failure?.message, 'learner turn: limited', '実行中に別経路が記録した失敗は成功で消さない');
    assert.equal(status.failure.count, 1, '失敗の回数も残る');
    assert.ok(status.failure.retryAt > at, '再試行の予定も残る');
    t.ok('実行中に別経路が記録した一時エラーは成功で消さない', true);

    // ---- 実行の途中に別経路（エピソード）が分類不能な失敗で停止を記録したら、それ以降の書き込みはしない
    //      （mayWrite は停止も見る。learner の ask が応答を待っている間に停止が掛かる形）
    prefs = { memoryAutoLearn: true, memoryEpisodeSummary: true };
    await learner.learnNow();   // 前区間の一時エラーを明示操作で消す
    at += DAY;
    await chat('覚えて: 停止の途中で書き込みへ進まない発言');
    holdGate = new Promise((r) => { release = r; });
    failWith = 'hold';
    const asksBeforeRun = asks;
    const haltedRun = learner.runNow();   // learner の ask がゲートで止まる
    while (asks === asksBeforeRun) await new Promise((r) => setTimeout(r, 0));   // ask の中まで進んだことを確かめる
    episodeFail = new Error('Failed to load credentials JSON');   // 別経路が停止を記録する
    await assert.rejects(learner.summarizeEpisode({ botId: 'b_x', channelId: 'c', threadId: 'th',
      posts: [{ id: 'p-halt', author: { kind: 'human' }, text: '話します', at }], previous: '' }), /credentials JSON/);
    assert.ok(learner.isHalted(), '別経路の分類不能な失敗で停止');
    release();
    const haltedRes = await haltedRun;
    assert.equal(haltedRes.changed, 0, '実行の途中で止まったら書き込まない');
    assert.ok(!(await memory.list({ layer: 'user' })).some((e) => e.text.includes('進まない発言')), '停止後の候補は書かれない');
    status = await learner.status();
    assert.equal(status.lastResult?.stopped, 'halted', '停止で打ち切った印が残る');
    t.ok('実行の途中に別経路が停止を記録したら書き込みを打ち切る', true);

    // ---- 停止中に届いた遅い一時エラーは、既に掛かっている停止ラッチを消さない
    //      （エピソードの要約が停止の前に始まっていて、遅れて一時エラーで返ってきた形）
    await learner.learnNow();   // 直前の停止を明示解除
    at += DAY;
    await chat('覚えて: 遅い一時失敗の前に止まった発言');
    episodeGate = new Promise((r) => { episodeRelease = r; });
    episodeFail = 'hold';
    const asksBeforeEp = asks;
    const slowEpisode = learner.summarizeEpisode({ botId: 'b_x', channelId: 'c', threadId: 'th',
      posts: [{ id: 'p-slow', author: { kind: 'human' }, text: '話します', at }], previous: '' });   // 停止の前に始めておく
    while (asks === asksBeforeEp) await new Promise((r) => setTimeout(r, 0));   // エピソードが ask の中まで進むのを待つ
    failWith = new Error('Failed to load credentials JSON');
    await assert.rejects(learner.runNow(), /credentials JSON/);   // learner 側が停止する
    assert.ok(learner.isHalted());
    episodeFail = 'bad-json';   // 遅れて届くのは一時エラー（自分の返答の形の失敗）
    episodeRelease();
    await assert.rejects(slowEpisode, /malformed JSON/);
    status = await learner.status();
    assert.equal(status.halted?.message, 'Failed to load credentials JSON', '遅い一時エラーで停止ラッチを消さない');
    assert.equal(status.failure?.message, 'learner returned malformed JSON', '一時失敗の記録自体は残る');
    assert.equal((await learner.runIfDue()).skipped, 'halted', 'ラッチは外れない');
    t.ok('停止中に届いた遅い一時エラーは停止ラッチを消さない', true);

    // ---- memory.list などの準備の途中で OFF になっても、ask の直前に確かめ直して AI を呼ばない
    await learner.learnNow();   // 直前の停止を明示解除（前区間の未処理の発言も片づく）
    at += DAY;
    await chat('覚えて: 準備中に OFF になった発言');
    const realList = memory.list.bind(memory);
    let flipInList = true;
    memory.list = async (...a) => { const r = await realList(...a); if (flipInList) { flipInList = false; prefs = {}; } return r; };
    try {
      const asksBefore = asks;
      const skippedMid = await learner.runNow();
      assert.equal(asks, asksBefore, '準備中の OFF は ask の直前で止める（AI を呼ばない）');
      assert.equal(skippedMid.changed, 0);
    } finally { memory.list = realList; }
    t.ok('準備の途中の OFF を ask の直前に拾う', true);

    // ---- 実経路（askBackend）でも、新しい AI 呼び出し（runTurn）の直前に確かめる。
    //      会話を作ってから AI を呼ぶ間（resolveModel 等の await）に OFF になっても、runTurn へ進まない。中止はエラー・停止にしない
    prefs = { memoryAutoLearn: true };
    at += DAY;
    await chat('覚えて: resolveModel の途中で OFF になる発言');
    let reachedResolve, releaseModel, turnCalls = 0;
    const reached = new Promise((r) => { reachedResolve = r; });
    const modelGate = new Promise((r) => { releaseModel = r; });
    const stubBackend = { id: 'stub',
      modes: () => ({ readonly: { scope: 'readonly', autonomy: 'never' } }),
      getMessages: async () => [{ role: 'assistant', text: '{"memories":[]}' }] };
    const learnerStub = createMemoryLearner({ dataDir: path.join(dir, 'stub-learner'), channels, bots: { get: async () => null }, memory,
      host: { runtime: { turns: new Map() },
        listBackends: () => [stubBackend], getBackend: () => stubBackend,
        resolveModel: async () => { reachedResolve(); await modelGate; return 'stub-model'; },
        resolveEffort: async () => null,
        createConversation: async () => 'stub-session',
        store: { getAll: async () => Object.fromEntries(side), get: async (id) => side.get(id) ?? {},
          setMeta: async () => {}, setMode: async () => {}, setModel: async () => {}, setSessionData: async () => {} },
        runTurn: async () => { turnCalls++; return 'ok'; }, deleteHidden: async () => {} },
      clock, now: () => at, readPrefs: async () => prefs,
      readMessages: async (id) => fake.getMessages(id), listSessions: async () => [...side].map(([id, meta]) => ({ id, ...meta })) });
    cleanup.push(() => learnerStub.close());
    const stubRun = learnerStub.runNow();
    await reached;   // resolveModel の中まで進んだことを確かめる
    prefs = {};   // その途中で OFF
    releaseModel();
    const stubRes = await stubRun;
    assert.equal(turnCalls, 0, 'OFF のあとは新しい AI 呼び出し（runTurn）へ進まない');
    assert.ok(stubRes.changed === 0 && !(await learnerStub.status()).halted, '中止は失敗・停止にしない');
    t.ok('実経路（resolveModel の途中）の OFF は runTurn の直前で止める', true);

    // ---- 旧世代の AI 呼び出し中に OFF→ON され、旧世代の応答が遅れて失敗しても、新しい世代を止めない
    prefs = { memoryAutoLearn: true };
    at += DAY;
    await chat('覚えて: 旧世代の遅い失敗で新しい世代を止めない発言');
    holdGate = new Promise((r) => { release = r; });
    failWith = 'hold';
    const asksBeforeStale = asks;
    const staleRun = learner.runNow();
    while (asks === asksBeforeStale) await new Promise((r) => setTimeout(r, 0));   // ask の中まで進むのを待つ
    prefs = { memoryAutoLearn: true, memoryLearnFrom: at + 1 };   // OFF→ON で世代が替わる
    failWith = new Error('Failed to load credentials JSON');      // 旧世代の応答が遅れて失敗する
    release();
    await assert.rejects(staleRun, /credentials JSON/);
    status = await learner.status();
    assert.ok(!status.halted && !learner.isHalted(), '旧世代の遅い失敗は新しい世代を止めない');
    assert.equal(status.failure, null, '失敗も記録しない');
    t.ok('旧世代の遅い失敗は結果も失敗も無効（新世代を止めない）', true);

    // ---- 許可リストの一時エラー（learner turn: limited）は有限再試行。上限を越えると halted
    await learner.learnNow();   // 直前の一時エラーを明示操作で消す（次の区間は失敗を重ねる）
    at += DAY;
    await chat('覚えて: 一時エラーの発言です');
    failWith = new Error('learner turn: limited');
    await assert.rejects(learner.runIfDue(), /limited/);
    status = await learner.status();
    assert.ok(status.failure?.count === 1 && status.failure.retryAt > at && status.halted === null, '一時エラーは再試行の予定を残す');
    for (let n = 2; n <= 5; n++) {
      at += DAY;
      failWith = new Error('learner turn: limited');
      await assert.rejects(learner.runIfDue(), /limited/);
    }
    status = await learner.status();
    assert.ok(status.halted?.message === 'learner turn: limited' && status.failure === null, '一時エラーも上限（5 回）で halted');
    assert.ok(learner.isHalted());
    t.ok('許可リストの一時エラーは有限再試行、上限で halted', true);

    // ---- halted はエピソードにも効く（要約は AI を呼ばず書き込まない）
    const episode = await learner.summarizeEpisode({ botId: 'b_x', channelId: 'c', threadId: 'th',
      posts: [{ id: 'p1', author: { kind: 'human' }, text: '話します', at }], previous: '' });
    assert.equal(episode, null, 'halted 中はエピソードの要約を始めない');
    t.ok('エピソードは halted を共有する', true);

    // ---- 再有効化（今の世代が止まった実行の世代と違う）で halted を解除する
    prefs = { memoryAutoLearn: true, memoryLearnFrom: at + 1 };
    await learner.runIfDue();   // floor（from）がその日の予定より新しいので notDue でも解除だけは進む
    assert.ok(!learner.isHalted(), '再有効化（別の世代）で halted を解除する');
    t.ok('再有効化で halted を解除する', true);

    // ---- 停止は時刻でなく世代で持つ。同じ瞬間の ON→即失敗（memoryLearnFrom > halted.at）を
    //      「再有効化」と誤認して勝手に解除しない（時計の後戻りにも強い）
    prefs = { memoryAutoLearn: true, memoryLearnFrom: at + 1 };   // settings.set が書く形（世代は「今」+1）
    await chat('覚えて: 同じ瞬間に止まった発言');
    failWith = new Error('backend is down');
    await assert.rejects(learner.learnNow(), /backend is down/);   // halted.at === at（from = at+1 より古い時刻でも世代は同じ）
    assert.ok(learner.isHalted());
    await learner.runIfDue();   // 自動経路（解除判定はここ）を通しても…
    assert.ok(learner.isHalted(), '同じ瞬間の停止を再有効化と誤認しない（ラッチは外れない）');
    assert.equal((await learner.runNow()).skipped, 'halted', '同じ世代のままなら実行も止まる');
    prefs = { memoryAutoLearn: true, memoryLearnFrom: at + 2 };   // 本当の再有効化＝別の世代
    const unlatched = await learner.runIfDue();
    assert.notEqual(unlatched.skipped, 'halted', '別の世代（新しい ON）でだけ解除');
    assert.ok(!learner.isHalted());
    t.ok('停止は世代で持ち、同じ瞬間の ON→失敗を再有効化と誤認しない', true);

    // ---- 一時エラーは自分の既知の失敗だけ。自分の返答の JSON 解析失敗は再試行するが、
    //      backend などが投げる『…JSON』を含む失敗は分類不能＝即 halted（例: Failed to load credentials JSON）
    await learner.learnNow();   // 残っている未処理の発言を片づける（明示操作の実行）
    at += DAY;
    await chat('覚えて: JSON の分類の発言です');
    failWith = 'bad-json';   // 返答そのものが JSON でない（自分の parseAnswer が投げる失敗）
    await assert.rejects(learner.runIfDue(), /malformed JSON/);
    status = await learner.status();
    assert.ok(status.failure?.count === 1 && status.failure.message === 'learner returned malformed JSON' && status.halted === null,
      '自分の返答の JSON 解析失敗は一時エラー');
    at += DAY;
    failWith = new Error('Failed to load credentials JSON');   // backend 側が投げる失敗（たまたま JSON を含む）
    await assert.rejects(learner.runIfDue(), /credentials JSON/);
    status = await learner.status();
    assert.equal(status.halted?.message, 'Failed to load credentials JSON', '他者の JSON を含む失敗は即 halted');
    assert.equal(status.failure, null, '分類不能な失敗は再試行の予定を立てない');
    const asksAtHalt = asks;
    assert.equal((await learner.runIfDue()).skipped, 'halted');
    assert.equal(asks, asksAtHalt, 'halted は繰り返さない');
    await learner.learnNow();   // 後続の区間のため解除して未処理を片づける
    t.ok('一時エラーは自分の既知の失敗だけ（JSON を含む他者の失敗は即停止）', true);

    // ---- エピソードの世代: 要約を作っている間に世代が替わったら commit は null（古い要約を保存しない）
    prefs = { memoryAutoLearn: true, memoryEpisodeSummary: true };
    const learner2 = createMemoryLearner({ dataDir: path.join(dir, 'episodes-learner'), channels, bots: { get: async () => null }, memory, host, clock, now: () => at,
      readPrefs: async () => prefs, readMessages: async (id) => fake.getMessages(id),
      ask: async () => JSON.stringify({ summary: '要約です', memories: [] }),
      listSessions: async () => [] });
    cleanup.push(() => learner2.close());
    const ep2 = await learner2.summarizeEpisode({ botId: 'b_x', channelId: 'c', threadId: 'th',
      posts: [{ id: 'p1', author: { kind: 'human' }, text: '話します', at }], previous: '' });
    assert.ok(ep2 && typeof ep2.text === 'string', 'ON では要約を作る');
    prefs = { ...prefs, memoryLearnFrom: Date.now() + 1 };   // OFF→ON があった＝世代の入れ替わり
    const wrote = await ep2.commit();
    assert.equal(wrote, null, '世代が替わった commit は中止（null）');
    // OFF にしても同じく中止
    prefs = { memoryAutoLearn: true, memoryEpisodeSummary: true, memoryLearnFrom: at };   // ON に戻して次の要約を作れるように
    const ep3 = await learner2.summarizeEpisode({ botId: 'b_x', channelId: 'c', threadId: 'th',
      posts: [{ id: 'p1', author: { kind: 'human' }, text: '話します', at }], previous: '' });
    prefs = {};
    assert.equal(await ep3.commit(), null, 'OFF にされた commit も中止（null）');
    t.ok('要約の commit は世代違い・OFF で null（呼び出し側は古い要約を保存しない）', true);

    // ---- episodes 側: enabled() が落ちたら digest を保存しない（digestThread の再確認）
    const botId = 'b_owl12345';
    const thread = { sessions: { [botId]: 's' }, state: 'idle', digest: {}, updatedAt: at };
    const posts = [{ id: 'p1', threadId: 'th', author: { kind: 'human' }, text: '依頼です', at }];
    let allow = true;
    const timers = [];
    const episodes = createEpisodes({ now: () => at,
      channels: {
        threads: { list: async () => [], get: async () => thread, update: async (_c, _t, patch) => { Object.assign(thread, typeof patch === 'function' ? patch(thread) : patch); } },
        get: async () => ({ id: 'c' }), read: async () => ({ posts }),
      },
      bots: { get: async () => ({ id: botId }) },
      enabled: async () => allow,
      summarize: async () => ({ text: '要約', commit: async () => (allow ? 0 : null) }),
      setTimer: (fn) => { timers.push({ fn, live: true }); return timers.at(-1); },
      clearTimer: (timer) => { timer.live = false; } });
    await episodes.start();
    episodes.onTurnEnd('c', 'th');
    const timer = timers.at(-1);
    timer.live = false; timer.fn();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.equal(thread.digest[botId]?.text, '要約', 'ON では要約を保存する');
    // OFF にしてもう一度: commit が null なら古い要約を保存しない
    thread.digest = {};
    allow = false;
    episodes.onTurnEnd('c', 'th');
    const timer2 = timers.filter((x) => x.live).at(-1);
    timer2.live = false; timer2.fn();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.equal(thread.digest[botId], undefined, 'OFF（enabled false）では digestThread が要約も記憶も書かない');
    episodes.stop();

    // ---- OFF→ON より前の静かなスレッドは自動要約しない（起動時の再予約・残ったタイマーの発火で古いスレッドを走らせない。
    //       enabled(latestAt) は bots-host と同じ episodeSummaryAllowedAt を通す）
    const ch = await channels.create({ name: 'gate-ep' }, { kind: 'human' });
    const oldPost = await channels.post({ channelId: ch.id, text: 'OFF の間に静かになった話です' }, { kind: 'human' });
    await channels.threads.update(ch.id, oldPost.id, { sessions: { b_x: 's_old' } });
    await new Promise((r) => setTimeout(r, 10));
    const newPost = await channels.post({ channelId: ch.id, text: 'ON にしてから来た話です' }, { kind: 'human' });
    await channels.threads.update(ch.id, newPost.id, { sessions: { b_x: 's_new' } });
    prefs = { memoryAutoLearn: true, memoryEpisodeSummary: true, memoryLearnFrom: newPost.at - 1 };   // ON は oldPost のあと・newPost の前
    const called = [];
    const timers2 = [];
    const epGate = createEpisodes({ channels, bots: { get: async () => ({ id: 'b_x' }), acquire: () => {} },
      summarize: async ({ threadId }) => { called.push(threadId); return { text: '要約です', commit: async () => 0 }; },
      enabled: async (latestAt = null) => !learner.isHalted() && episodeSummaryAllowedAt(prefs, latestAt),
      now: Date.now,
      setTimer: (fn) => { const timer = { fn, live: true }; timers2.push(timer); return timer; },
      clearTimer: (timer) => { timer.live = false; } });
    cleanup.push(() => epGate.stop());
    await epGate.start();
    for (const timer of timers2) if (timer.live) { timer.live = false; timer.fn(); }
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.deepEqual(called, [newPost.id], 'memoryLearnFrom より前のスレッドは要約しない。ON の後の投稿だけ走る');
    assert.ok(!(await channels.threads.get(ch.id, oldPost.id))?.digest?.b_x, '古いスレッドに要約を保存しない');
    assert.equal((await channels.threads.get(ch.id, newPost.id))?.digest?.b_x?.text, '要約です', '新しいスレッドは要約を残す');
    t.ok('再有効化より前の静かなスレッドは自動要約しない', true);

    // ---- 再起動: 停止は memory_state に残り、新しい learner でも同じ世代なら停止を引き継ぐ
    await learner.learnNow();   // いったん明示解除して残りを片づける
    at += DAY;
    prefs = { memoryAutoLearn: true, memoryLearnFrom: at + 1 };
    await chat('覚えて: 再起動をまたぐ停止の発言');
    failWith = new Error('backend is down');
    await assert.rejects(learner.learnNow(), /backend is down/);   // 世代 at+1 の実行で止まる（halted.gen = at+1）
    assert.ok(learner.isHalted());
    learner.close();   // 再起動を真似る（DB の接続を離す）

    const asksRe = asks;
    const learnerRe = createMemoryLearner({ dataDir: dir, channels, bots: { get: async () => null }, memory, host, clock, now: () => at,
      readPrefs: async () => prefs, readMessages: async (id) => fake.getMessages(id), ask,
      listSessions: async () => [...side].map(([id, meta]) => ({ id, ...meta })) });
    cleanup.push(() => learnerRe.close());
    await learnerRe.start();   // 起動時の確かめ（load + runIfDue + arm）
    assert.ok(learnerRe.isHalted(), '停止は再起動をまたぐ（同じ世代のまま）');
    assert.equal(asks, asksRe, '再起動の確かめでは AI を呼ばない');
    assert.equal((await learnerRe.runNow()).skipped, 'halted', '再起動後も同じ世代の停止は実行を止める');
    t.ok('再起動で停止を復元し、起動の確かめは AI を呼ばない', true);

    // ---- 停止解除の保存に失敗したら、実行には進まずメモリ上の停止も戻す
    //      （データ置き場を別の素の接続で掴み、learner の save を SQLITE_BUSY で落とす）
    prefs = { memoryAutoLearn: true, memoryLearnFrom: at + 2 };   // 別の世代＝再有効化の条件を満たす
    const holder = new DatabaseSync(path.join(dir, DB_FILE));
    holder.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(learnerRe.runIfDue(), /busy|locked/i);
      assert.ok(learnerRe.isHalted(), '解除の保存に失敗したらメモリ上の停止も戻す');
      assert.equal(asks, asksRe, '解除できないので AI も呼ばない');
    } finally { try { holder.exec('ROLLBACK'); } catch {} try { holder.close(); } catch {} }
    t.ok('停止解除の保存に失敗したら実行せず、メモリ上の停止も戻す', true);

    // ---- 明示の解除は再起動しても残る（halted・failure を消した保存が次の learner に効く）
    await learnerRe.learnNow();   // 明示解除 → 残っていた発言を読んで走る
    assert.ok(!learnerRe.isHalted());
    learnerRe.close();
    const learnerRe2 = createMemoryLearner({ dataDir: dir, channels, bots: { get: async () => null }, memory, host, clock, now: () => at,
      readPrefs: async () => prefs, readMessages: async (id) => fake.getMessages(id), ask,
      listSessions: async () => [...side].map(([id, meta]) => ({ id, ...meta })) });
    cleanup.push(() => learnerRe2.close());
    await learnerRe2.start();
    assert.ok(!learnerRe2.isHalted(), '明示の解除は再起動しても残る');
    learnerRe2.close();
    t.ok('明示の解除は再起動しても残る', true);

    // ---- OFF・prefs 不在でも再起動では AI を呼ばない。保存した記憶は残る
    prefs = {};
    const learnerOff = createMemoryLearner({ dataDir: dir, channels, bots: { get: async () => null }, memory, host, clock, now: () => at,
      readPrefs: async () => prefs, readMessages: async (id) => fake.getMessages(id), ask,
      listSessions: async () => [...side].map(([id, meta]) => ({ id, ...meta })) });
    cleanup.push(() => learnerOff.close());
    const asksOff = asks;
    await learnerOff.start();
    assert.equal(asks, asksOff, 'OFF・prefs 不在の再起動でも AI を呼ばない');
    assert.ok((await memory.list({ layer: 'user' })).some((e) => e.text.includes('再起動をまたぐ')), '保存した記憶は残る');
    learnerOff.close();
    t.ok('OFF・prefs 不在の再起動でも AI を呼ばず、保存した記憶は残る', true);
  } finally {
    clearInterval(keepAlive);
    for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
