// Chrome の確認に Pleiad が答える（ADR 0218）。偽の Chrome と偽の OS の層（allow・enable を持つ）で、接続の状態と、会話のカードの台帳を見る。
//   - Pleiad が押せるときは、ポートが生きていても consent（Pleiad の中の許可）で止まり、Chrome には何も出さない（upgrade 0 回）
//   - 許可（consent・設定の「つなぐ」・確認なしのモードの demand）で upgrade し、出た確認を allowPermission で押す。前に出す（raise）はしない
//   - 押せない・押しても開かない・設定で止めた・OS の層が押せない、のどれでも、今までどおり人が Chrome で押す案内（raise）に戻る
//   - トグルは「オンにしてつなぐ」（enable）のときだけ入れ、その接続の許可も兼ねる。入れられなければ enable-failed（人が入れる案内）
//   - 確認なしのモードの会話は、カードに auto を載せ、demand に consent を渡す。人が手を動かしたら「確認なしのため自動」と書かない
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeHandoffs } from '../../core/chrome/handoff.mjs';
import { unsupportedChromeOs } from '../../core/chrome/os.mjs';

export const name = 'chrome-auto-allow';
export const title = 'Chrome の確認に Pleiad が答える: consent で止める・許可で押す・押せなければ人の案内へ・トグルは押したときだけ・確認なしのモード（偽の Chrome と OS の層。ADR 0218）';

const FEATURES = { dialog: true, raise: true, launch: true, conceal: true, watch: true, bounds: true, allow: true, enable: true };
const until = async (cond, ms = 5000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) throw new Error(`timeout: ${what || cond.toString().slice(0, 80)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

async function rig({ features = FEATURES, auto = true, ...rest } = {}) {
  const chrome = await startFakeChrome({ permission: 'hold' });
  const clock = fakeClock();
  const os = fakeChromeOs({ chrome, features });
  const env = { auto };
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os, clock, autoAllow: async () => env.auto,
    lastUsedProfile: async () => 'Profile 1', ...rest });
  const seen = [];
  conn.onChange(s => seen.push(`${s.state}${s.assist ? `:${s.assist}` : ''}`));
  const stop = async () => { await conn.close(); await chrome.stop(); };
  // 偽の時計で 1 段ずつ進める（確認の窓の探しは 200ms ごと）
  const step = async (n = 1) => { for (let i = 0; i < n; i += 1) await clock.advance(250); };
  return { chrome, clock, os, conn, env, seen, stop, step };
}

export default async function (t) {
  // ===== 1. 押せるとき: consent で止まり、Chrome には何も出さない。許可で upgrade → 押す → つながる =====
  {
    const r = await rig();
    const p = r.conn.demand();
    await until(() => r.conn.state().state === 'consent', 5000, 'consent');
    await r.clock.advance(5000);
    t.ok('ポートが生きていても consent で止まる。upgrade は投げない（Chrome の確認は出ない）', r.conn.state().state === 'consent' && r.chrome.upgrades === 0, JSON.stringify(r.conn.state()));
    t.ok('状態に enable（OS の層がトグルを入れられる）が載る', r.conn.state().enable === true);
    t.ok('consent() は試行があれば true', r.conn.consent() === true);
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    t.ok('許可の後は permission の allowing（「つないでいます」。人に Chrome の確認を探させない）', r.conn.state().state === 'permission' && r.conn.state().assist === 'allowing', JSON.stringify(r.conn.state()));
    await r.step(2);
    const cdp = await p;
    t.ok('出た確認を allowPermission で押して、つながる', r.conn.state().state === 'connected' && typeof cdp.send === 'function' && r.os.calls('allowPermission').length === 1, JSON.stringify(r.os.log.map(e => e.op)));
    t.ok('押すときは確認の窓を前に出さない（raise 0 回）', r.os.calls('raise').length === 0);
    // 確認の窓を見つけた（dialog）変化も便りになるので、同じ表示が続いたものは 1 つに畳んで比べる
    const steps = r.seen.filter((s, i) => s !== r.seen[i - 1]).join(' ');
    t.ok('状態の移り: consent → permission:allowing → connected', steps === 'consent permission:allowing connected', r.seen.join(' '));
    await r.stop();
  }

  // ===== 1b. 読み直しの最中に許可が来ても、upgrade は 1 回（確認は 1 つ） =====
  {
    const { probeLoopbackPort } = await import('../../core/chrome/connection.mjs');
    let slow = false;
    const r = await rig({ probePort: async port => { if (slow) await new Promise(resolve => setTimeout(resolve, 80)); return probeLoopbackPort(port); } });
    const p = r.conn.demand();
    await until(() => r.conn.state().state === 'consent');
    slow = true;
    await r.clock.advance(1000);   // 1 秒ごとの読み直しを始める（ポートの確かめに 80ms かかる）
    r.conn.consent();               // その最中に許可
    await until(() => r.chrome.upgrades >= 1, 5000, 'upgrade');
    await new Promise(resolve => setTimeout(resolve, 300));
    t.ok('読み直しの最中の許可でも、upgrade は 1 回だけ（確認が 2 つ出ない）', r.chrome.upgrades === 1, String(r.chrome.upgrades));
    await r.step(2);
    await p;
    await r.stop();
  }

  // ===== 2. 確認なしのモード（demand の consent）: consent に止まらず、すぐ押す =====
  {
    const r = await rig();
    const p = r.conn.demand({ consent: true });
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    await p;
    t.ok('demand({ consent: true }) は consent を飛ばして押す', r.conn.state().state === 'connected' && !r.seen.includes('consent') && r.os.calls('allowPermission').length === 1, r.seen.join(' '));
    await r.stop();
  }
  {
    // 先に許可の無い会話が consent で待っていても、確認なしのモードの会話が来たら進む
    const r = await rig();
    const a = r.conn.demand();
    await until(() => r.conn.state().state === 'consent');
    const b = r.conn.demand({ consent: true });
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    const [x, y] = await Promise.all([a, b]);
    t.ok('consent で待っている試行に、確認なしのモードの demand が許可を付ける（両方に同じ cdp）', x === y && r.conn.state().state === 'connected');
    await r.stop();
  }

  // ===== 3. 設定の「つなぐ」は許可を兼ねる（consent に止まらない）。consent で待っている試行にも効く =====
  {
    const r = await rig();
    await r.conn.connect();
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    await until(() => r.conn.state().state === 'connected');
    t.ok('設定の「つなぐ」から始めた試行は consent に止まらず押す', !r.seen.includes('consent') && r.os.calls('allowPermission').length === 1, r.seen.join(' '));
    await r.stop();
  }
  {
    const r = await rig();
    const p = r.conn.demand();
    await until(() => r.conn.state().state === 'consent');
    await r.conn.connect();
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    await p;
    t.ok('consent で待っている試行で「つなぐ」を押すと、許可として進む', r.conn.state().state === 'connected');
    await r.stop();
  }

  // ===== 4. 押さないとき: 設定でオフ・OS の層が押せない → 今までどおり（consent に入らず、raise） =====
  {
    const r = await rig({ auto: false });
    const p = r.conn.demand();
    await until(() => r.chrome.pending() === 1, 5000, 'pending');
    await r.step(2);
    t.ok('設定「Chrome の確認に自動で答える」がオフなら consent に入らず、確認を前に出す（raise）だけ', !r.seen.includes('consent') && r.os.calls('raise').length === 1 && r.os.calls('allowPermission').length === 0, r.seen.join(' '));
    r.chrome.approve();
    await p;
    await r.stop();
  }
  {
    const r = await rig({ features: { ...FEATURES, allow: false, enable: false } });
    const p = r.conn.demand();
    await until(() => r.chrome.pending() === 1, 5000, 'pending');
    await r.step(2);
    t.ok('OS の層が押せない（features.allow が無い）なら consent に入らず、raise', !r.seen.includes('consent') && r.os.calls('raise').length === 1 && r.os.calls('allowPermission').length === 0);
    t.ok('トグルを入れられないので enable は false', r.conn.state().enable === false);
    t.ok('enable() は unsupported で断る', (await r.conn.enable()).reason === 'unsupported');
    r.chrome.approve();
    await p;
    await r.stop();
  }

  // ===== 5. 押せなかった・押しても開かなかった → allow-failed、raise（人が Chrome で押す） =====
  {
    const r = await rig();
    r.os.opts.allowFails = true;
    const p = r.conn.demand({ consent: true });
    await until(() => r.chrome.pending() === 1, 5000, 'pending');
    await r.step(2);
    await until(() => r.conn.state().assist === 'allow-failed', 5000, 'allow-failed');
    t.ok('押せなければ allow-failed にして、確認を前に出す（raise）', r.os.calls('raise').length === 1 && r.conn.state().dialog === true, JSON.stringify(r.conn.state()));
    r.chrome.approve();
    await p;
    t.ok('人が Chrome で押せば、そのままつながる', r.conn.state().state === 'connected');
    await r.stop();
  }
  {
    const r = await rig();
    r.os.opts.allowNoOpen = true;
    const p = r.conn.demand({ consent: true });
    await until(() => r.chrome.pending() === 1, 5000, 'pending');
    await r.step(2);
    await until(() => r.os.calls('allowPermission').length === 1);
    t.ok('押した直後はまだ allowing（開くのを待つ）', r.conn.state().assist === 'allowing' && r.os.calls('raise').length === 0);
    await r.clock.advance(5000);
    await until(() => r.conn.state().assist === 'allow-failed', 5000, 'allow-failed');
    t.ok('押しても 5 秒開かなければ allow-failed にして raise（もう押さない）', r.os.calls('raise').length === 1 && r.os.calls('allowPermission').length === 1);
    r.chrome.approve();
    await p;
    await r.stop();
  }

  // ===== 6. トグル: setup で enable → OS の層が入れる → 許可も兼ねて押す =====
  {
    const r = await rig();
    await r.chrome.turnOff();
    const p = r.conn.demand();
    await until(() => r.conn.state().state === 'setup');
    await r.clock.advance(60_000);
    t.ok('setup では、確認なしのモードでもトグルは自動で入れない（enableRemoteDebugging 0 回）', r.os.calls('enableRemoteDebugging').length === 0 && r.conn.state().state === 'setup');
    const result = r.conn.enable();
    const out = await result;
    t.ok('enable() は OS の層の enableRemoteDebugging を、見つけたブラウザーと最後に使ったプロフィールで呼ぶ', out.ok === true && r.os.calls('enableRemoteDebugging').length === 1
      && r.os.calls('enableRemoteDebugging')[0].args.browser === 'fake-browser' && r.os.calls('enableRemoteDebugging')[0].args.profileDir === 'Profile 1', JSON.stringify(r.os.calls('enableRemoteDebugging')));
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    await p;
    t.ok('「オンにしてつなぐ」は許可も兼ねる（consent に止まらず押してつながる）', r.conn.state().state === 'connected' && !r.seen.includes('consent') && r.os.calls('allowPermission').length === 1, r.seen.join(' '));
    t.ok('入れている間は setup:enabling', r.seen.includes('setup:enabling'), r.seen.join(' '));
    await r.stop();
  }
  {
    const r = await rig();
    await r.chrome.turnOff();
    r.os.opts.enableFails = true;
    const p = r.conn.demand(); void p.catch(() => {});
    await until(() => r.conn.state().state === 'setup');
    const out = await r.conn.enable();
    t.ok('入れられなければ setup の enable-failed（人が入れる案内）', out.ok === false && r.conn.state().state === 'setup' && r.conn.state().assist === 'enable-failed', JSON.stringify(r.conn.state()));
    await r.clock.advance(3000);
    t.ok('読み直しの間も enable-failed は残る', r.conn.state().assist === 'enable-failed');
    await r.chrome.turnOn();
    await r.clock.advance(1000);
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    await p;
    t.ok('人が手で入れたら、許可は付いているので押してつながる', r.conn.state().state === 'connected' && r.os.calls('allowPermission').length === 1);
    await r.stop();
  }
  {
    // 設定から（待つ会話が無い）: enable() だけで試行が始まる
    const r = await rig();
    await r.chrome.turnOff();
    const out = await r.conn.enable();
    await until(() => r.chrome.upgrades === 1, 5000, 'upgrade');
    await r.step(2);
    await until(() => r.conn.state().state === 'connected');
    t.ok('待つ会話が無くても enable() で試行を始め、つなぐ', out.ok === true && r.conn.state().state === 'connected');
    await r.stop();
  }

  // ===== 7. 使えない OS: 口は失敗の値を返す =====
  {
    const os = unsupportedChromeOs();
    t.ok('unsupported の層の allowPermission は false、enableRemoteDebugging は unsupported', await os.allowPermission({ id: 'x' }) === false && (await os.enableRemoteDebugging({})).reason === 'unsupported');
    t.ok('unsupported の層の features に allow・enable は false', os.capabilities().features.allow === false && os.capabilities().features.enable === false);
  }

  // ===== 8. 会話のカードの台帳: 確認なしのモードは auto と consent、人が手を動かしたら auto を消す =====
  {
    const cards = [];
    const ask = opts => new Promise(resolve => {
      const card = { opts, updates: [], answer: null };
      const settle = answer => { if (card.answer) return; card.answer = answer; opts.onSettle?.(answer); resolve(answer); };
      cards.push(card);
      opts.onOpen?.({ id: `perm-${cards.length}`, ids: [], update: patch => card.updates.push(patch), settle });
    });
    let status = { state: 'consent', dialog: false, assist: null, enable: true };
    const listeners = new Set();
    const demands = [];
    const conn = {
      state: () => status,
      onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      demand: (args = {}) => new Promise(resolve => { demands.push({ ...args, resolve }); }),
      set(next) { status = { dialog: false, assist: null, enable: true, ...next }; for (const fn of listeners) fn(status); if (status.state === 'connected') for (const d of demands) d.resolve(); },
    };
    const auto = new Set(['yolo']);
    const handoffs = createChromeHandoffs({ askPermission: ask, connection: conn, sessionBusy: () => false, turnLive: () => true, continueTurn: async () => {},
      autoConsent: id => auto.has(id), agentLabel: id => (id === 'yolo' ? 'Codex' : 'Claude'), titleFor: ({ reason, sessionId }) => `${reason}:${sessionId}` });
    handoffs.connect('yolo');
    const card = cards[0];
    t.ok('確認なしのモードの会話: カードに auto・エージェントの名前が載り、demand に consent: true を渡す', card.opts.browserHandoff.auto === true && card.opts.browserHandoff.agent === 'Codex' && demands[0].consent === true, JSON.stringify(card.opts.browserHandoff));
    t.ok('題は titleFor に会話の id を渡して作る（通知の「{エージェント} が…」）', card.opts.title === 'connect:yolo');
    t.ok('カードに状態（consent）・assist・enable が載る', card.opts.browserHandoff.state === 'consent' && card.opts.browserHandoff.enable === true);
    conn.set({ state: 'permission', assist: 'allowing' });
    conn.set({ state: 'connected' });
    await new Promise(resolve => setImmediate(resolve));
    t.ok('人が何もしないでつながったら、決着の response に auto（「確認なしのため自動」）', card.answer?.response?.auto === true, JSON.stringify(card.answer));

    status = { state: 'setup', dialog: false, assist: null, enable: true };
    handoffs.connect('yolo');
    const second = cards[1];
    conn.set({ state: 'setup', assist: 'enabling' });
    conn.set({ state: 'connected' });
    await new Promise(resolve => setImmediate(resolve));
    t.ok('トグルを人が入れた接続は、確認なしのモードでも auto を付けない', second.answer?.allow === true && !second.answer?.response?.auto, JSON.stringify(second.answer));

    status = { state: 'consent', dialog: false, assist: null, enable: true };
    handoffs.connect('normal');
    const third = cards[2];
    t.ok('ほかのモードの会話: auto は false、demand の consent も false', third.opts.browserHandoff.auto === false && demands.at(-1).consent === false && third.opts.browserHandoff.agent === 'Claude');
    handoffs.close();
  }
}
