// 遅い命令・イベントループ・送信待ちの診断記録（core/slow-log.mjs・web/slow-client.mjs）:
//   - しきい値の環境変数読み込み・サニタイズ（本文・タイトル・パス・設定値・生エラー文言を落とす）
//   - slow-commands.log への追記・自己除外（invoke:app.reportSlow）・上限超過時の新しい半分への切り詰め
//   - monitorEventLoopDelay によるイベントループ遅延の記録
//   - slowClient の client-pending / client-rtt / offline バッファと再送・submit-wait / submit-switched
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlowLog, readSlowThresholds, sanitizeSlowEntry } from '../../core/slow-log.mjs';
import { createSlowClient } from '../../web/slow-client.mjs';

export const name = 'slow-log';
export const title = '遅い命令・イベントループ・送信待ちの診断記録（サニタイズ・ログ切り詰め・オフラインバッファ）';

export default async function (t) {
  // 1. 環境変数からのしきい値読み込みとサニタイズ
  const th = readSlowThresholds({
    AGENT_HOST_SLOW_CLIENT_MS: '150',
    AGENT_HOST_SLOW_SERVER_MS: '80',
    AGENT_HOST_SLOW_LOOP_MS: '40',
    AGENT_HOST_SLOW_LOOP_WINDOW_MS: '5', // min=10 未満は既定値 (1000) へフォールバック
    AGENT_HOST_SLOW_SUBMIT_MS: '120',
  });
  const thValidWin = readSlowThresholds({ AGENT_HOST_SLOW_LOOP_WINDOW_MS: '250' });
  t.ok('環境変数からしきい値を読める', th.clientMs === 150 && th.serverMs === 80 && th.loopMs === 40 && th.loopWindowMs === 1000 && th.submitMs === 120 && thValidWin.loopWindowMs === 250, JSON.stringify({ th, thValidWin }));

  const dirty = sanitizeSlowEntry({
    kind: 'submit-wait',
    source: 'client',
    command: 'submit',
    ms: 2345.6,
    sessionId: 'ses-abc_123',
    outcome: 'sent',
    prompt: 'SECRET MESSAGE BODY',
    title: 'Secret Conversation Title',
    path: 'C:\\secret\\file.txt',
    settings: { model: 'claude' },
    error: 'should never appear',
    errorCode: 'ETIMEDOUT',
    wait: {
      phase: 'settings',
      settingsMs: 1800,
      modeMs: 500,
      hadSettingsWrite: true,
      prompt: 'leak inside wait',
      title: 'leak',
    },
  });
  const dirtyText = JSON.stringify(dirty);
  t.ok('サニタイズで本文・タイトル・パス・設定値・生エラーを落とす',
    dirty && !dirtyText.includes('SECRET') && !dirtyText.includes('Secret') && !dirtyText.includes('secret')
    && !dirtyText.includes('leak') && !dirtyText.includes('should never appear')
    && dirty.ms === 2346 && dirty.sessionId === 'ses-abc_123' && dirty.wait?.settingsMs === 1800 && dirty.wait?.hadSettingsWrite === true,
    dirtyText);

  const smuggled = sanitizeSlowEntry({
    kind: 'client-rtt',
    command: 'C:/Users/alice/prompt text',
    sessionId: 'bad id with spaces',
    errorCode: 'err msg/with path',
    ms: 3000,
  });
  t.ok('トークン形式を外れた command / sessionId / errorCode（空白やパス区切りを含むもの）は落とす',
    smuggled && smuggled.command === undefined && smuggled.sessionId === undefined && smuggled.errorCode === undefined,
    JSON.stringify(smuggled));

  // 2. ファイル追記・自己記録除外・サイズ切り詰め・イベントループ遅延
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-slow-log-'));
  try {
    const logger = createSlowLog({
      dataDir: tmpDir,
      thresholds: { clientMs: 50, serverMs: 50, loopMs: 30, loopWindowMs: 40, submitMs: 50 },
      maxBytes: 1024,
    });
    logger.recordServerCommand({ command: 'sendMessage', ms: 20, sessionId: 'ses-1' }); // しきい値未満
    logger.recordServerCommand({ command: 'invoke:app.reportSlow', ms: 5000, sessionId: 'ses-1' }); // 自己除外
    logger.recordServerCommand({ command: 'sendMessage', ms: 120, sessionId: 'ses-1', outcome: 'ok', inFlight: 2 });
    await logger.flush();

    const firstLines = fs.readFileSync(logger.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    t.ok('しきい値未満と invoke:app.reportSlow は書かず、しきい値超えの命令だけ書く',
      firstLines.length === 1 && firstLines[0].kind === 'server-cmd' && firstLines[0].command === 'sendMessage' && firstLines[0].inFlight === 2,
      JSON.stringify(firstLines));

    // 上限超過で新しい半分に詰める
    const batch = [];
    for (let i = 0; i < 30; i += 1) {
      batch.push({ kind: 'client-rtt', command: 'setSettings', sessionId: `s-${i}`, ms: 100 + i, outcome: 'ok' });
    }
    logger.recordClientBatch(batch);
    await logger.flush();
    const trimmedRaw = fs.readFileSync(logger.logPath, 'utf8');
    const trimmedLines = trimmedRaw.trim().split('\n').map((l) => JSON.parse(l));
    t.ok('上限超過時は新しい側を残して上限以下に保つ（途中切れの行も残さない）',
      Buffer.byteLength(trimmedRaw, 'utf8') <= 1024 && trimmedLines.at(-1)?.sessionId === 's-29' && trimmedLines.length < 31,
      JSON.stringify({ bytes: Buffer.byteLength(trimmedRaw, 'utf8'), count: trimmedLines.length, last: trimmedLines.at(-1) }));

    // イベントループ遅延の記録
    let inflightMock = 3;
    logger.startLoopMonitor({ getInFlight: () => inflightMock });
    const deadline = Date.now() + 80;
    while (Date.now() < deadline) { /* block event loop >= 30ms */ }
    await new Promise((r) => setTimeout(r, 90));
    await logger.close();
    const afterLoop = fs.readFileSync(logger.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    t.ok('イベントループの遅れが loopMs を超えたら event-loop 行を残す',
      afterLoop.some((e) => e.kind === 'event-loop' && e.ms >= 30 && typeof e.p99Ms === 'number'),
      JSON.stringify(afterLoop.slice(-5)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  // 3. web/slow-client.mjs: pending/rtt・自己記録除外・切断中保持・再接続フラッシュ・失敗無視
  {
    let connected = true;
    let fakeNow = 1000;
    let nextTimerId = 1;
    const activeTimers = new Map();
    const sentBatches = [];
    let failSend = false;

    const slowClient = createSlowClient({
      thresholds: { clientMs: 200, submitMs: 200 },
      now: () => fakeNow,
      monoNow: () => fakeNow,
      setTimer: (fn, ms) => { const id = nextTimerId++; activeTimers.set(id, { fn, ms }); return id; },
      clearTimer: (id) => { activeTimers.delete(id); },
      isConnected: () => connected,
      sendBatch: async (entries) => {
        if (failSend) throw new Error('boom');
        sentBatches.push(entries);
      },
    });

    // 速い命令は記録しない
    let resolveFast;
    slowClient.track('setStatus', { sessionId: 's-fast' }, new Promise((r) => { resolveFast = r; }));
    fakeNow += 50;
    resolveFast('ok');
    await Promise.resolve();
    await slowClient.flush();
    t.ok('しきい値未満の命令は送らない', sentBatches.length === 0);

    // 自己記録は追跡しない
    slowClient.track('invoke', { op: 'app.reportSlow' }, new Promise(() => {}));
    t.ok('app.reportSlow 自体はタイマーを作らない', activeTimers.size === 0);

    // しきい値超えの命令は client-pending → client-rtt を記録
    let rejectSlow;
    slowClient.track('sendMessage', { sessionId: 's-slow' }, new Promise((_r, j) => { rejectSlow = j; }));
    fakeNow += 250;
    for (const { fn } of [...activeTimers.values()]) fn();
    const err = new Error('sensitive text should not leak');
    err.code = 'BACKEND_BUSY';
    fakeNow += 100;
    rejectSlow(err);
    await new Promise((r) => setTimeout(r, 10));
    const flat = sentBatches.flat();
    t.ok('しきい値超えで client-pending と client-rtt（errorCode のみ）を送る',
      flat.length === 2
      && flat[0].kind === 'client-pending' && flat[0].command === 'sendMessage' && flat[0].ms === 250
      && flat[1].kind === 'client-rtt' && flat[1].outcome === 'error' && flat[1].errorCode === 'BACKEND_BUSY'
      && !JSON.stringify(flat).includes('sensitive text'),
      JSON.stringify(flat));

    // 切断中は溜め、再接続の flush で送る。通常の失敗は黙って捨てる
    sentBatches.length = 0;
    connected = false;
    slowClient.recordSubmitWait({ sessionId: 's-off', ms: 3000, outcome: 'sent', wait: { phase: 'send', sendMs: 3000 } });
    slowClient.recordSubmitSwitched({ sessionId: 's-sw', ms: 90, wait: { phase: 'settings', switched: true } });
    await slowClient.flush();
    t.ok('切断中は送らずバッファに保持する', sentBatches.length === 0 && slowClient.queueSize === 2);

    connected = true;
    await slowClient.flush();
    const reconnected = sentBatches.flat();
    t.ok('再接続後の flush でまとめて送る（submit-wait / submit-switched）',
      reconnected.length === 2 && reconnected[0].kind === 'submit-wait' && reconnected[1].kind === 'submit-switched' && slowClient.queueSize === 0,
      JSON.stringify(reconnected));

    // 記録送信の失敗は投げず画面を止めない
    failSend = true;
    slowClient.recordSubmitSwitched({ sessionId: 's-drop', ms: 10, wait: { phase: 'mode', switched: true } });
    await slowClient.flush();
    t.ok('記録送信が接続中に失敗しても例外を投げず溜め続けない', slowClient.queueSize === 0);
  }
}
