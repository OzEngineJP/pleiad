// ホストに任せたタスクの詳細が、経過を読めないとき（オフライン・読み出しの失敗）も手元の委譲と同じ筋（readonlyThread）で出ること（実ブラウザー）。
// 依頼は「依頼」の吹き出し（Markdown）で、オフラインの走っているタスクは末尾に衛星の活動の行、終わったタスクの結果は
// ホストの便りで写した分を 1 つの AI の発言として出す。古い形（依頼と結果の 2 つの箱・生の文字）へ戻らない確かめ
// （docs/remote.md §4.5「オフライン」「古いホスト」、docs/design-system.md「ホストに任せた作業の詳細」）。
// 本物の中継をこのプロセスで、ホストと端末のローカルのサーバー（どちらも fake バックエンド）を別プロセスで立てる。
// 端末のサーバーは main の身代わり（tests/lib/remote-agent-parent-port.mjs）を付けて起こす。LLM も外部のネットワークも使わない。
// 実行: node tests/browser/host-task-offline.mjs（HOST_TASK_SHOTS で撮影先を変えられる）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.HOST_TASK_SHOTS || path.join(process.cwd(), 'temporary', 'screenshots', 'host-task-offline');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-host-task-offline-'));
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`); await sleep(100); }
};

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const SECRET = crypto.randomBytes(32).toString('base64url');
const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
const relayAddr = await relay.listen(0, '127.0.0.1');
const hostDir = path.join(SCRATCH, 'host');
const termDir = path.join(SCRATCH, 'term');
const devDir = path.join(SCRATCH, 'device');
let host = null, term = null, ch = null, ct = null, browser = null;

try {
  // ---- ホストを有効にして、端末（デスクトップ版の資格）をペアリングする
  host = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: hostDir, timeoutMs: 30_000 });
  ch = await open({ port: host.port, token: host.token });
  const hostCmd = (command, args = {}) => within(ch.cmd(command, args), 15_000, `ホストの ${command}`);
  await hostCmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayAddr.port}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
  await ch.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from: 0, ms: 10_000 });
  const offer = await hostCmd('remotePairingStart');
  const dev = createRemoteDevice({ dir: devDir, app: 'test', name: 'laptop-test', platform: 'desktop' });
  const fromPair = ch.mark();
  const paired = dev.pair(offer.payload, { onCode: () => {} });
  const req = await ch.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from: fromPair, ms: 10_000 });
  await hostCmd('remotePairingApprove', { id: req.request.id });
  const rec = await within(paired, 20_000, 'ペアリング');
  await dev.closeAll();
  const hostId = rec.hostId;

  // ---- 端末のローカルのサーバーを main の身代わり付きで起こす
  term = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', FAKE_REMOTE_DEVICE_DIR: devDir }, dataDir: termDir, entry: path.join(ROOT, 'tests', 'lib', 'remote-agent-parent-port.mjs'), timeoutMs: 60_000 });
  ct = await open({ port: term.port, token: term.token });
  const termCmd = (command, args = {}) => within(ct.cmd(command, args), 15_000, `端末の ${command}`);
  const tRows = () => termCmd('agentTasks');
  await until(async () => (await termCmd('running')).remoteHosts?.[hostId]?.online === true, 30_000, 'ホストの線が ready');

  // ---- ply_delegate で 2 つ任せる: 走り続ける依頼（Markdown 入り）と、すぐ終わる依頼（結果が Markdown）
  // 完了通知で始まった依頼元のターンが走っている間は、同じ会話に次のターンを始められない（切り替え中）。空くまで待ってやり直す
  const delegate = async (sessionId, args) => {
    for (let i = 0; ; i++) {
      try {
        const from = ct.mark();
        const r = await ct.runTurn({ ...(sessionId ? { sessionId } : { backend: 'fake', cwd: ROOT }), prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: args }) }, { ms: 60_000 });
        if (!r.events.some(e => e.type === 'tool.result')) {
          await ct.waitFor(e => e.type === 'tool.result', { from, ms: 30_000 });
          return ct.turnResult(from, { sessionId: r.sessionId });
        }
        return r;
      }
      catch (e) {
        if (i < 40 && /切り替え中/.test(e.message)) { await sleep(250); continue; }
        e.message = `ply_delegate ${JSON.stringify(args).slice(0, 80)}: ${e.message}`;
        throw e;
      }
    }
  };
  const toolJson = r => { const e = r.events.findLast(x => x.type === 'tool.result'); return JSON.parse(e?.text ?? '{}'); };
  const first = await delegate(null, { host: 'desk-test', kind: 'mechanical', backend: 'fake', title: 'オフラインの作業', task: 'slow\n\n## 進捗メモ\n\n- **一項目** の箇条書き' });
  const sid = first.sessionId;
  const liveId = toolJson(first).taskId;
  check(/^ply-task-/.test(liveId ?? ''), '走り続ける依頼をホストへ任せた', toolJson(first));
  await until(async () => (await tRows()).find(r => r.taskId === liveId && r.status === 'running'), 20_000, '走り続ける依頼が実行中');
  const done = await delegate(sid, { host: 'desk-test', kind: 'mechanical', backend: 'fake', title: 'レポート作り', task: 'echo:## 完了レポート\n\n- **終了** の確認' });
  const doneId = toolJson(done).taskId;
  await until(async () => (await tRows()).find(r => r.taskId === doneId && r.status === 'completed' && r.result), 30_000, '終わる依頼の結果が写る');

  // ---- ホストをオフラインにする（許可を切ると中継から離れる）。まだ詳細を一度も開いていない
  await hostCmd('setRemoteSettings', { enabled: false });
  await until(async () => (await termCmd('running')).remoteHosts?.[hostId]?.online === false, 20_000, 'ホストがオフライン');

  // ---- 実ブラウザーで依頼元の会話を開き、作業の詳細を見る
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'ja-JP' });
  await ctx.addInitScript(sid => { try { localStorage.setItem('agent-host-current', sid); } catch {} }, sid);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${term.port}/?token=${term.token}`, { waitUntil: 'load' });
  await page.locator('#onboardingDialog').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.locator('#workEntryButton').waitFor({ timeout: 20_000 });
  await page.locator('#workEntryButton').click();
  await page.waitForSelector('#workDialog[open] .bg-row');
  const shot = async name => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const detail = sel => page.locator(`#workBody ${sel}`);
  const rowOf = title => page.locator('#workDialog .bg-row', { hasText: title });
  const detailSummary = () => page.evaluate(() => [...document.querySelectorAll('#workBody .m')].map(m => `${m.className}:${(m.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}`));

  // ---- 走っている・まだ一度も読めていない詳細: 依頼の吹き出し + 衛星の活動の行
  await rowOf('オフラインの作業').click();
  await page.waitForSelector('#workBody .thread');
  await shot('host-task-offline-live');
  await page.waitForSelector('#workBody .thread .m.activity', { timeout: 10_000 });
  check(await detail('.rt-request').count() === 0, 'オフライン: 「依頼と結果」の箱は出ない', await detailSummary());
  const liveReq = detail('.m.user').first();
  check(await liveReq.count() === 1 && (await liveReq.locator('.who').innerText()).includes('依頼'), 'オフライン: 依頼は「依頼」の吹き出し', await detailSummary());
  check((await liveReq.locator('.body.md-user h2').innerText()) === '進捗メモ' && (await liveReq.locator('.body.md-user strong').innerText()) === '一項目',
    'オフライン: 依頼は Markdown で描かれる', await liveReq.locator('.body').innerText());
  const act = detail('.m.activity').first();
  check((await act.locator('.txt').innerText()) === 'ホストがオフライン' && (await act.locator('.el').innerText()).includes('つながり直すと追いつきます'),
    'オフライン: 末尾は「ホストがオフライン」の活動の行', await act.innerText());
  check(await detail('.m.activity .run.sat').count() === 1, 'オフライン: 活動の行の印は衛星（弧ではない）');
  check(await detail('.m.sys').count() === 0, 'オフライン: 余計な注記は出ない', await detailSummary());

  // ---- 終わった・まだ一度も読めていない詳細: 依頼の吹き出し + 結果の発言（Markdown）
  await rowOf('レポート作り').click();
  await page.waitForSelector('#workBody .thread .m.ai, #workBody .thread .rt-request', { timeout: 15_000 });
  await shot('host-task-offline-done');
  await page.waitForSelector('#workBody .thread .m.ai .body h2', { timeout: 10_000 });
  check(await detail('.rt-request').count() === 0, '終了・オフライン: 「依頼と結果」の箱は出ない', await detailSummary());
  check((await detail('.m.user .who').first().innerText()).includes('依頼'), '終了・オフライン: 依頼は「依頼」の吹き出し', await detailSummary());
  const ai = detail('.m.ai').first();
  check((await ai.locator('.body h2').innerText()) === '完了レポート' && (await ai.locator('.body strong').innerText()) === '終了',
    '終了・オフライン: 結果は 1 つの AI の発言（Markdown）', await ai.innerText());
  check(await detail('.m.activity').count() === 0, '終了・オフライン: 終わったタスクに活動の行は出ない', await detailSummary());
  check(await detail('.m.sys').count() === 0, '終了・オフライン: 余計な注記は出ない', await detailSummary());

  // ---- ホストを端末から消すと、読み出しは失敗（NOT_FOUND）する: 同じ筋 + 「読めなかった」の 1 行
  fs.writeFileSync(path.join(devDir, 'hosts.json'), JSON.stringify({ version: 1, hosts: [] }));
  await until(async () => !(await termCmd('running')).remoteHosts?.[hostId], 20_000, '端末からホストを消す');
  // 走っている行は読み直しが効くので、もう一度開くと失敗の筋になる
  await rowOf('オフラインの作業').click();
  await page.waitForSelector('#workBody .thread .m.sys, #workBody .thread .rt-request', { timeout: 15_000 });
  await shot('host-task-failed');
  await page.waitForSelector('#workBody .thread .m.sys', { timeout: 10_000 });
  const sys = detail('.m.sys').first();
  check((await sys.innerText()).includes('読めなかった') && (await sys.innerText()).includes('ホストにこのタスクが見つかりません'),
    '失敗: 同じ筋に「読めなかった」の 1 行（ホストの英語やコードは出さない）', await detailSummary());
  // ホストを消すと、動いていた写しは「追えなくなりました」と理由つきで終わる（item.error の 1 行が出る）
  check(await detail('.rt-request').count() === 0 && (await detail('.m.user .who').first().innerText()).includes('依頼'),
    '失敗: 依頼の吹き出しは同じ部品のまま', await detailSummary());
} finally {
  await browser?.close().catch(() => {});
  ct?.close();
  ch?.close();
  if (term) await term.stop().catch(() => {});
  if (host) await host.stop().catch(() => {});
  await relay.close().catch(() => {});
}
console.log(`ok ${results.length}\n${results.map(r => `- ${r}`).join('\n')}`);
