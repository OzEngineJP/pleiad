// 設定 › リモートと常駐（docs/remote.md §6.1・§6.3、issue #13 の画面側）。
//   - 画面の小さな部品（web/remote.mjs・web/remote-hosts.mjs・web/remote-parts.mjs）: 確認コードの区切り・残り時間・QR の点・
//     つながらないときの一行・端末とホストの行・端末の絵・中継の見せ方
//   - 常駐の設定（core/remote/resident.mjs）: 既定・丸め・保存・main へ送る状態
//   - main の常駐（desktop/resident.cjs）: トレイの出し入れ・スリープの抑止・窓を閉じたときの扱い（Electron は差し替える）
//   - サーバー: RemoteStatus.resident と setRemoteResident（fake のサーバーを別プロセスで立てる）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCode, remaining, qrPath, connectionFailed, deviceRow, platformName } from '../../web/remote.mjs';
import { hostLine, agentLine, setupRemoteHosts } from '../../web/remote-hosts.mjs';
import { N } from '../lib/dom-stub.mjs';
import { deviceIcon, relayHost } from '../../web/remote-parts.mjs';
import { normalizeResident, residentSignal, enabledRoutineCount, createResidentPrefs, DEFAULT_RESIDENT, SLEEP_MODES } from '../../core/remote/resident.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { createResident, sleepWanted, keepRunning } = require('../../desktop/resident.cjs');

export const name = 'remote-settings';
export const title = '設定 › リモートの部品と、ホストとしての常駐（トレイ・スリープ）';

/** Electron の Tray / Menu / powerSaveBlocker と窓の身代わり */
function fakes() {
  const log = [];
  let next = 0;
  const started = new Set();
  class Tray {
    constructor(icon) { this.icon = icon; this.handlers = {}; log.push('tray'); Tray.live = this; }
    on(name, fn) { this.handlers[name] = fn; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { log.push('tray-destroy'); if (Tray.live === this) Tray.live = null; }
  }
  const Menu = { buildFromTemplate: items => ({ items }) };
  const powerSaveBlocker = {
    start(type) { const id = ++next; started.add(id); log.push(`block:${type}`); return id; },
    stop(id) { started.delete(id); log.push('unblock'); },
    isStarted: id => started.has(id),
  };
  const window = { visible: true, minimized: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; }, show() { this.visible = true; log.push('show'); }, focus() {}, hide() { this.visible = false; } };
  return { Tray, Menu, powerSaveBlocker, window, log, started };
}

export default async function (t) {
  // ---- 画面の部品
  t.ok('確認コードは 3 桁ずつ', formatCode('482193') === '482 193' && formatCode('12') === '12' && formatCode(null) === '');
  const now = Date.parse('2026-09-23T10:00:00Z');
  t.ok('残り時間は m:ss、過ぎたら 0:00', remaining('2026-09-23T10:04:32Z', now) === '4:32' && remaining('2026-09-23T09:59:00Z', now) === '0:00' && remaining('bad', now) === '0:00');
  const payload = 'pleiad://pair?v=1&r=https%3A%2F%2Frelay.example.com&h=abcdefghijklmnopqrstuvwxyz&k=' + 'A'.repeat(43) + '&s=' + 'B'.repeat(43) + '&n=desktop-home';
  const qr = qrPath(payload);
  // 余白 4 マスの内側の左上に位置合わせの模様（7×7 の外周）がある
  const cells = new Set([...qr.d.matchAll(/M(\d+) (\d+)/g)].map(m => `${m[1]},${m[2]}`));
  const finder = [0, 1, 2, 3, 4, 5, 6].every(i => cells.has(`${4 + i},4`) && cells.has(`4,${4 + i}`) && cells.has(`${4 + i},10`) && cells.has(`10,${4 + i}`));
  t.ok('QR は余白込みの正方形で、左上に位置合わせの模様がある', qr.size >= 29 + 8 && (qr.size - 8 - 17) % 4 === 0 && finder && !cells.has('5,5'), String(qr.size));
  t.ok('長い文字列ほど大きい型になる', qrPath('x').size < qr.size);
  const on = { enabled: true, configured: true, connection: { state: 'connected' } };
  t.ok('「サーバーへの接続に失敗しました」は、許可がオンで設定もあるのに中継につながらないときだけ',
    connectionFailed({ ...on, connection: { state: 'error' } }) && connectionFailed({ ...on, connection: { state: 'retrying' } })
    && !connectionFailed(on) && !connectionFailed({ ...on, connection: { state: 'connecting' } })
    && !connectionFailed({ ...on, enabled: false, connection: { state: 'error' } })
    && !connectionFailed({ ...on, configured: false, connection: { state: 'error' } }) && !connectionFailed(null));
  t.ok('端末の種類は名前にし、知らない値はそのまま', platformName('android') === 'Android' && platformName('ios') === 'iPhone' && platformName('toaster') === 'toaster');
  t.ok('端末の行の「オフライン」は、中継につながっているのに端末がつながっていないときだけ',
    deviceRow({ name: 'Pixel', platform: 'android', connected: false }, on).offline === true
    && deviceRow({ name: 'Pixel', platform: 'android', connected: true }, on).offline === false
    && deviceRow({ name: 'Pixel', connected: false }, { ...on, connection: { state: 'error' } }).offline === false
    && deviceRow({ name: 'Pixel', connected: false }, { ...on, enabled: false }).offline === false);
  t.ok('名前の無い端末は「名前のない端末」の扱い', deviceRow({ name: '', platform: 'ios' }, on).name !== '' && deviceRow({ name: 'iPhone 15' }, on).name === 'iPhone 15');
  t.ok('端末の絵: スマホ・タブレット（名前で見分ける）・PC',
    deviceIcon({ platform: 'android', name: 'Pixel 9' }) === 'phone' && deviceIcon({ platform: 'ios', name: 'iPad Air' }) === 'tablet'
    && deviceIcon({ platform: 'android', name: 'Galaxy Tab S9' }) === 'tablet' && deviceIcon({ platform: 'desktop', name: 'ThinkPad' }) === 'monitor'
    && deviceIcon({ platform: 'desktop', name: 'MacBook Air' }) === 'laptop' && deviceIcon() === 'monitor');
  t.ok('中継はホスト名だけ見せ、読めない値はそのまま',
    relayHost('https://relay.example.com/x?y=1') === 'relay.example.com' && relayHost('relay.local') === 'relay.local' && relayHost(null) === '');
  t.ok('ホストの行: つながらないときだけ「オフライン」、取り消されたら開けない',
    hostLine({ hostId: 'h1', name: 'desk', state: 'offline' }).sub === 'オフライン' && hostLine({ hostId: 'h1', name: 'desk', state: 'host-offline' }).sub === 'オフライン'
    && hostLine({ hostId: 'h1', name: 'desk', state: 'connected' }).sub === '' && hostLine({ hostId: 'h1', name: 'desk', state: 'closed' }).canOpen
    && (h => h.revoked && !h.canOpen && h.sub === '取り消されました')(hostLine({ hostId: 'h1', name: 'desk', state: 'revoked' }))
    && hostLine({ hostId: 'h1' }).name === 'h1');
  t.ok('AI から任せる: オフなら何も出さず、ホストが古ければ更新を促す',
    agentLine({ agentState: 'ready', agentAllowed: true }) === '' && agentLine({ agentState: 'offline', agentAllowed: false }) === ''
    && agentLine({ agentState: 'ready', agentAllowed: false, name: 'desk' }) === 'desk の Pleiad を更新すると使えます'
    && agentLine({ agentState: 'unsupported', name: 'desk' }) === 'desk の Pleiad を更新すると使えます');

  // ---- 「ほかの PC へ」の Pleiad Plus の行（web/remote-hosts.mjs の setupRemoteHosts）
  {
    const savedWindow = globalThis.window, savedCreate = document.createElement, savedBody = document.body;
    const clicked = [];
    globalThis.window = { plyDesktop: { hosts: {
      onChange: () => {}, onCode: () => {},
      init: async () => ({ ok: true, hosts: [], encrypted: true, plus: { status: 'free', available: true, urls: { account: 'https://account.example.com/account' }, hosts: [] } }),
      list: async () => ({ ok: true, hosts: [] }),
    } } };
    document.body = new N('body');   // createWizard は setup の時点で dialog を body に足す
    try {
      const hostsPanel = setupRemoteHosts({ onChange: () => {}, cmd: async () => {}, page: () => {} });
      await hostsPanel.refresh();
      const walk = ns => { for (const n of ns ?? []) { if (n?.dataset?.fk === 'plus-upgrade') return n; const hit = walk(n?.children); if (hit) return hit; } return null; };
      const upgrade = walk(hostsPanel.build());
      t.ok('Pleiad Plus が無料なら「Pleiad Plus にする」の行がある', Boolean(upgrade));
      // 開き先の末端（新しいタブの a.click）だけを拾う
      const anchor = { href: '', target: '', rel: '', click() { clicked.push(this.href); }, remove() {} };
      document.createElement = () => anchor;
      upgrade.onclick();
      t.ok('urls.account がパスを持っても /account/plus ではなくオリジンの /plus を開く', clicked.at(-1) === 'https://account.example.com/plus', String(clicked.at(-1)));
    } finally {
      globalThis.window = savedWindow;
      document.createElement = savedCreate;
      document.body = savedBody;
    }
  }

  // ---- 常駐の設定
  t.ok('既定は「窓を閉じても続ける」「作業中だけ防ぐ」', DEFAULT_RESIDENT.keepRunning === true && DEFAULT_RESIDENT.sleep === 'working');
  t.ok('知らない値は既定に丸める', JSON.stringify(normalizeResident({ keepRunning: 'yes', sleep: 'never' })) === JSON.stringify(DEFAULT_RESIDENT)
    && normalizeResident({ keepRunning: false, sleep: 'off' }).sleep === 'off');
  t.ok('スリープの規則は「作業中だけ防ぐ」「防がない」の 2 つ', SLEEP_MODES.join() === 'working,off');
  t.ok('廃止した「リモートが有効な間は防ぐ」（always）は「作業中だけ防ぐ」に読み替える',
    JSON.stringify(normalizeResident({ keepRunning: false, sleep: 'always' })) === JSON.stringify({ keepRunning: false, sleep: 'working' }));
  const status = { enabled: true, connection: { state: 'connected' }, devices: [{ connected: true }, { connected: true }, { connected: false }] };
  const idle = residentSignal({ status, prefs: DEFAULT_RESIDENT, work: { turns: [], permissions: [], count: 0 }, locale: 'ja' });
  t.ok('main へ送る状態: リモート・接続中の端末・中継の状態', idle.remote && idle.devices === 2 && idle.relay === 'connected' && !idle.working && idle.locale === 'ja', JSON.stringify(idle));
  const waiting = residentSignal({ status, prefs: DEFAULT_RESIDENT, work: { turns: [], permissions: [{ relay: false }, { relay: true }], count: 1 } });
  t.ok('承認待ちがあれば作業中（中継の複製は数えない）', waiting.working && waiting.waiting === 1 && waiting.running === 0);
  t.ok('ターンが走っていれば作業中', residentSignal({ status, prefs: DEFAULT_RESIDENT, work: { turns: [{}], permissions: [], count: 1 } }).working);

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-resident-')));
  try {
    const prefs = createResidentPrefs({ dataDir: scratch });
    await prefs.loaded;
    t.ok('ファイルが無ければ既定', prefs.get().keepRunning === true && prefs.get().sleep === 'working');
    await prefs.set({ sleep: 'off' });
    await prefs.set({ keepRunning: false });
    const again = createResidentPrefs({ dataDir: scratch });
    await again.loaded;
    t.ok('保存して読み直せる（続けて変えても両方残る）', again.get().keepRunning === false && again.get().sleep === 'off', JSON.stringify(again.get()));
    let threw = false;
    try { prefs.set({ sleep: 'sometimes' }); } catch { threw = true; }
    t.ok('知らないスリープの規則は受け付けない', threw);
    let retired = false;
    try { prefs.set({ sleep: 'always' }); } catch { retired = true; }
    t.ok('廃止した always は新しく保存できない', retired);

    // 前の版が保存した always を読み込むと working に移し、ファイルも書き直す
    await fs.writeFile(prefs.file, JSON.stringify({ keepRunning: false, sleep: 'always' }));
    const migrated = createResidentPrefs({ dataDir: scratch });
    await migrated.loaded;
    const rewritten = JSON.parse(await fs.readFile(prefs.file, 'utf8'));
    t.ok('保存されていた always は working に移り、ほかの値はそのまま', migrated.get().sleep === 'working' && migrated.get().keepRunning === false, JSON.stringify(migrated.get()));
    t.ok('移した値で resident.json を書き直す', rewritten.sleep === 'working' && rewritten.keepRunning === false, JSON.stringify(rewritten));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }

  // ---- ルーティンの件数。bots-host の公開された口だけを使う
  const host = rows => ({ opsDeps: () => ({ routines: { list: async () => rows } }) });
  t.ok('ルーティンの口が無い・未実装なら 0 件', await enabledRoutineCount() === 0
    && await enabledRoutineCount({}) === 0 && await enabledRoutineCount({ opsDeps: () => ({}) }) === 0
    && await enabledRoutineCount({ opsDeps: () => ({ routines: {} }) }) === 0);
  t.ok('有効なものだけ数え、一時停止中は数えない', await enabledRoutineCount(host([
    { paused: false }, { paused: true }, { paused: false },
  ])) === 2 && await enabledRoutineCount(host([{ paused: true }])) === 0 && await enabledRoutineCount(host([])) === 0);
  t.ok('ルーティンの読み込み失敗は常駐の更新を止めない', await enabledRoutineCount({ opsDeps: () => ({
    routines: { list: async () => { throw new Error('unavailable'); } },
  }) }) === 0);
  t.ok('常駐の状態には有効件数だけ載せる', residentSignal({ routines: 2 }).routines === 2
    && residentSignal({}).routines === 0 && residentSignal({ routines: -1 }).routines === 0);

  // ---- main の常駐
  const matrix = [['working', false, false], ['working', true, true], ['off', true, false], ['off', false, false]];
  t.ok('スリープ: 作業中だけ / 防がない', matrix.every(([sleep, working, want]) => sleepWanted({ remote: true, sleep, working }) === want)
    && !sleepWanted({ remote: false, sleep: 'working', working: true }));
  t.ok('ルーティンが無ければ、リモートが有効で設定がオンのときだけ続ける', keepRunning({ remote: true, keepRunning: true }) && !keepRunning({ remote: false, keepRunning: true }) && !keepRunning({ remote: true, keepRunning: false }));

  const f = fakes();
  let quits = 0;
  const r = createResident({ Tray: f.Tray, Menu: f.Menu, powerSaveBlocker: f.powerSaveBlocker, icon: 'icon.png', getWindow: () => f.window, quit: () => { quits++; }, platform: 'win32' });
  r.update({ remote: false, keepRunning: true, sleep: 'working', working: false, running: 0, devices: 0, relay: 'disabled', locale: 'ja' });
  t.ok('リモートが無効ならトレイも抑止も無く、窓を閉じれば今までどおり終わる', !r.hasTray && !r.blocking && !r.keepOnClose());
  r.update({ remote: true, keepRunning: true, sleep: 'working', working: false, running: 0, devices: 1, relay: 'connected', locale: 'ja' });
  t.ok('リモートを有効にするとトレイに残り、窓を閉じても続ける', r.hasTray && r.keepOnClose() && !r.blocking);
  const items = f.Tray.live.menu.items;
  t.ok('トレイのメニュー: 状態・開く・終了', items[0].label === '中継 つながっている · 接続中の端末 1 · 実行中 0' && items[0].enabled === false
    && items[2].label === 'Pleiad を開く' && items[3].label === '終了', items.map(i => i.label).join(' / '));
  r.update({ remote: true, keepRunning: true, sleep: 'working', working: true, running: 1, devices: 1, relay: 'connected', locale: 'en' });
  t.ok('作業中はスリープを防ぐ（prevent-app-suspension）', r.blocking && f.log.includes('block:prevent-app-suspension'));
  t.ok('トレイの文言は言語に従う', f.Tray.live.menu.items[0].label === 'Relay connected · Devices online 1 · Running 1', f.Tray.live.menu.items[0].label);
  r.update({ remote: true, keepRunning: true, sleep: 'working', working: false, running: 0, devices: 1, relay: 'connected', locale: 'en' });
  t.ok('作業が終われば抑止をやめる', !r.blocking && f.started.size === 0);
  f.window.hide();
  f.Tray.live.handlers.click();
  t.ok('トレイを押すと窓を出す', f.window.visible);
  f.window.hide();
  f.Tray.live.menu.items[3].click();
  t.ok('「終了」は窓を出してから main の確認付きの終了へ', quits === 1 && f.window.visible);
  f.window.hide();
  r.update({ remote: false, keepRunning: true, sleep: 'working', working: true, running: 0, devices: 0, relay: 'disabled', locale: 'en' });
  t.ok('リモートを無効にするとトレイを消し、隠れていた窓を出し直す', !r.hasTray && f.window.visible && !r.blocking);
  r.update({ remote: true, keepRunning: false, sleep: 'working', working: true, running: 1, devices: 0, relay: 'connected', locale: 'en' });
  t.ok('続ける設定がオフでも作業中の抑止は効く', !r.hasTray && !r.keepOnClose() && r.blocking);
  r.update({ remote: false, routines: 2, keepRunning: false, sleep: 'working', working: false, locale: 'ja' });
  t.ok('リモートと常駐設定がオフでも、有効なルーティンがあればトレイに残る', r.hasTray && r.keepOnClose() && !r.blocking);
  t.ok('ルーティンのために残ることをメニューとツールチップへ 1 行添える',
    f.Tray.live.menu.items[1].label === 'ルーティン 2 件のために常駐しています'
    && f.Tray.live.menu.items[1].enabled === false && f.Tray.live.tooltip.includes('ルーティン 2 件のために常駐しています'));
  f.window.hide();
  r.update({ remote: true, routines: 1, keepRunning: true, sleep: 'working', working: false, locale: 'en' });
  t.ok('リモートとルーティンが両方有効なら同じトレイを使い、英語の説明に更新する',
    r.hasTray && !f.window.visible && f.Tray.live.menu.items[1].label === 'Staying in the tray for enabled routines: 1');
  f.Tray.live.menu.items.find(item => item.label === 'Quit').click();
  t.ok('ルーティンの常駐中も「終了」は確認付きの終了へ進む', quits === 2 && f.window.visible);
  f.window.hide();
  r.update({ remote: true, routines: 0, keepRunning: true, sleep: 'working', working: false, locale: 'en' });
  t.ok('最後のルーティンを無効にしてもリモートの常駐があれば窓は隠れたまま',
    r.hasTray && r.keepOnClose() && !f.window.visible && f.Tray.live.menu.items.length === 4);
  r.update({ remote: false, routines: 1, keepRunning: false, sleep: 'working', working: true, locale: 'ja' });
  t.ok('リモートを無効にしてもルーティンがあれば残る。スリープ抑止の条件は変えない',
    r.hasTray && r.keepOnClose() && !f.window.visible && !r.blocking);
  r.update({ remote: false, routines: 0, keepRunning: false, sleep: 'working', working: false, locale: 'ja' });
  t.ok('最後の常駐理由が無くなればトレイを消し、隠れていた窓を出す', !r.hasTray && !r.keepOnClose() && f.window.visible);
  r.update({ remote: false, routines: 1, keepRunning: false, sleep: 'off', working: true, locale: 'ja' });
  r.dispose();
  t.ok('ルーティンの常駐も終了時にトレイを片付ける', !r.hasTray);
  t.ok('終了時に抑止を解く', !r.blocking && f.started.size === 0);

  const dicts = Object.fromEntries(await Promise.all(['ja', 'en'].map(async l => [l, JSON.parse(await fs.readFile(new URL(`../../web/locales/${l}/desktop.json`, import.meta.url), 'utf8'))])));
  t.ok('トレイの中継の状態はすべての状態に訳がある', ['disabled', 'connecting', 'connected', 'retrying', 'error'].every(s => dicts.ja.resident.relay[s] && dicts.en.resident.relay[s]));

  // ---- サーバー
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-settings-')));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    const s0 = await c.cmd('remoteStatus');
    t.ok('RemoteStatus に常駐の設定が載る（npm start のホストでは使わない）', s0.resident?.available === false && s0.resident.keepRunning === true && s0.resident.sleep === 'working', JSON.stringify(s0.resident));
    const from = c.mark();
    const s1 = await c.cmd('setRemoteResident', { sleep: 'off', keepRunning: false });
    t.ok('setRemoteResident で変えられ、状態を丸ごと返す', s1.resident.sleep === 'off' && s1.resident.keepRunning === false && s1.connection?.state === 'disabled');
    const ev = await c.waitFor(e => e.type === 'remoteStatus' && e.status.resident?.sleep === 'off', { from, ms: 5000 }).catch(() => null);
    t.ok('変えるとほかの画面にも remoteStatus が届く', Boolean(ev));
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'resident.json'), 'utf8'));
    t.ok('設定は <data>/remote/resident.json に残る', saved.sleep === 'off' && saved.keepRunning === false);
    const bad = await c.cmd('setRemoteResident', { sleep: 'sometimes' }).then(() => null, e => e);
    t.ok('知らない規則は断る', Boolean(bad));
    t.ok('常駐の設定を変えても中継の設定は触らない', (await c.cmd('remoteStatus')).enabled === false);
  } finally {
    c.close?.();
    await server.stop?.();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
