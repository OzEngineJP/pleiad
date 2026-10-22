// 中継の認可の差し込み（relay/server.mjs、docs/remote.md §5.7）。
// 差し込みがあるときの振る舞いだけを見る。差し込み無しで今のまま動くことは tests/unit/relay.mjs が見る。
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { createRelay, CLOSE } from '../../relay/server.mjs';

export const name = 'relay-authz';
export const title = '中継: 認可の差し込み（host/device の判定・admit・タグ・出来事・RELAY_AUTHZ_MODULE）';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newHostId = () => Array.from(crypto.randomBytes(26), (b) => B32[b & 31]).join('');
function newToken() {
  const raw = crypto.randomBytes(32);
  return { token: raw.toString('base64url'), hash: crypto.createHash('sha256').update(raw).digest('hex') };
}
let ipSeq = 0;
const newIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

async function startRelay(authz, opts = {}) {
  const relay = createRelay({ enrollSecret: SECRET, logger: () => {}, authz, ...opts });
  const { port } = await relay.listen(0, '127.0.0.1');
  return { relay, port };
}

function client(port, path, headers = {}, extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, perMessageDeflate: false, ...extra });
  const msgs = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const m = { data: Buffer.from(data), isBinary };
    const w = waiters.shift();
    if (w) w(m); else msgs.push(m);
  });
  ws.on('error', () => {});
  const closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  const opened = new Promise((res) => {
    ws.once('open', () => res({ open: true }));
    ws.once('unexpected-response', (req, r) => { res({ status: r.statusCode }); r.resume(); req.destroy(); });
    ws.once('error', (e) => res({ error: e.message }));
  });
  const next = (ms = 2000) => msgs.length
    ? Promise.resolve(msgs.shift())
    : new Promise((res, rej) => {
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(done), 1); rej(new Error('届かない')); }, ms);
      const done = (m) => { clearTimeout(t); res(m); };
      waiters.push(done);
    });
  return {
    ws, opened, closed, msgs, next,
    json: async (ms) => JSON.parse((await next(ms)).data.toString('utf8')),
    send: (x, opts) => ws.send(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x), opts),
    closedWithin: (ms = 2000) => Promise.race([closed, sleep(ms).then(() => null)]),
  };
}

const hostHeaders = (hostId, ip, secret = SECRET) => ({ authorization: `Bearer ${secret}`, 'x-pleiad-host': hostId, 'x-forwarded-for': ip });
const noSecretHeaders = (hostId, ip) => ({ 'x-pleiad-host': hostId, 'x-forwarded-for': ip });

/** 制御用の接続を張って sync する。secret を渡さなければ登録用の秘密は付けない。 */
async function host(port, hostId, devices = [], ip = newIp(), secret = null) {
  const headers = { 'x-pleiad-host': hostId, 'x-forwarded-for': ip };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const c = client(port, '/v1/host', headers);
  await c.opened;
  c.send({ type: 'sync', devices });
  await sleep(60);   // sync は別の接続なので、端末より先に中継へ届いたことを待つ
  c.hostId = hostId;
  c.ip = ip;
  return c;
}

function device(port, hostId, deviceId, token, ip = newIp()) {
  return client(port, '/v1/device', { authorization: `Bearer ${token}`, 'x-pleiad-host': hostId, 'x-pleiad-device': deviceId, 'x-forwarded-for': ip });
}

const closeAll = (...cs) => { for (const c of cs) c?.ws.terminate(); };

const freePort = () => new Promise((res, rej) => {
  const s = http.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

export default async function (t) {
  // ── host が通す: 登録用の秘密なしでつながり sync が効く。ctx の中身 ──
  {
    const ctxs = [];
    let attached = 0;
    let handle = null;
    const { relay, port } = await startRelay({
      async host(ctx) { ctxs.push(ctx); return { ok: true, tags: ['example:a', 'example:b'] }; },
      async device(ctx) { ctxs.push(ctx); return { ok: true }; },
      attach(h) { attached++; handle = h; },
    });
    try {
      const hId = newHostId();
      const ip = newIp();
      const tk = newToken();
      const ctl = await host(port, hId, [{ id: 'd', tokenHash: tk.hash }], ip);
      t.ok('差し込みが通せば登録用の秘密なしで /v1/host がつながる', ctl.ws.readyState === WebSocket.OPEN);
      const ctx = ctxs[0];
      t.ok('ctx: route・hostId・ip・deviceId・pairing・enrollOk・凍結された headers',
        ctx.route === '/v1/host' && ctx.hostId === hId && ctx.ip === ip
        && ctx.deviceId === null && ctx.pairing === false && ctx.enrollOk === false
        && Object.isFrozen(ctx.headers) && ctx.headers['x-pleiad-host'] === hId,
        JSON.stringify({ route: ctx?.route, hostId: ctx?.hostId, ip: ctx?.ip }));
      const good = await host(port, newHostId(), [], newIp(), SECRET);
      t.ok('ctx.enrollOk: 正しい秘密で true', ctxs.at(-1).enrollOk === true);
      const wrongSecret = client(port, '/v1/host', hostHeaders(newHostId(), newIp(), 'x'.repeat(40)));
      await wrongSecret.opened;
      await sleep(50);
      t.ok('ctx.enrollOk: 違う秘密で false（通すかは差し込みが決める）', ctxs.at(-1).enrollOk === false);

      const dev = device(port, hId, 'd', tk.token);
      await dev.opened;
      const inc = await ctl.json();
      t.ok('sync が効き、照合の通った端末の incoming が届く', inc.type === 'incoming' && inc.deviceId === 'd' && typeof inc.conn === 'string');
      const dctx = ctxs.at(-1);
      t.ok('device の ctx: route・deviceId・pairing', dctx.route === '/v1/device' && dctx.deviceId === 'd' && dctx.pairing === false);
      t.ok('attach は待ち受けのあと 1 度だけ handle を渡す', attached === 1 && typeof handle?.closeTag === 'function' && typeof handle?.stats === 'function');
      t.ok('handle.stats は今の stats と同じ', handle.stats().hosts === relay.stats().hosts);
      closeAll(ctl, good, wrongSecret, dev);
    } finally {
      await relay.close();
    }
  }

  // ── 断る: 4401 は失敗の回数に数える、ほかは数えない ──
  {
    const { relay, port } = await startRelay(
      { async host() { return { ok: false, code: 4401, reason: 'denied' }; } },
      { failureLimit: 2 },
    );
    try {
      const ip = newIp();
      const c1 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      const cl1 = await c1.closedWithin();
      t.ok('差し込みの断り（4401）で閉じる', cl1?.code === CLOSE.UNAUTHORIZED && cl1?.reason === 'denied', JSON.stringify(cl1));
      const c2 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      await c2.closedWithin();
      const c3 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      t.ok('4401 の断りは失敗の回数に数える（上限で Upgrade せず 429）', (await c3.opened).status === 429);
    } finally {
      await relay.close();
    }
  }
  {
    // count: false の 4401 は数えない。false 以外（省略・0・'false'）は数える
    const verdicts = [
      { ok: false, code: 4401, reason: 'ticket', count: false },
      { ok: false, code: 4401, reason: 'ticket', count: 0 },
    ];
    let next = verdicts[0];
    const { relay, port } = await startRelay({ async host() { return next; } }, { failureLimit: 2 });
    try {
      const ip = newIp();
      let denied = 0;
      for (let i = 0; i < 3; i++) {
        const c = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
        const cl = (await c.opened).open === true ? await c.closedWithin() : null;
        if (cl?.code === CLOSE.UNAUTHORIZED && cl?.reason === 'ticket') denied++;
      }
      t.ok('count: false の 4401 は失敗の回数に数えない（何度でも Upgrade して 4401）', denied === 3 && relay.stats().blocked === 0,
        JSON.stringify({ denied, blocked: relay.stats().blocked }));
      next = verdicts[1];
      const ip2 = newIp();
      await client(port, '/v1/host', noSecretHeaders(newHostId(), ip2)).closedWithin();
      await client(port, '/v1/host', noSecretHeaders(newHostId(), ip2)).closedWithin();
      const c3 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip2));
      t.ok('count が false 以外の 4401 は今までどおり数える', (await c3.opened).status === 429);
      const c4 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      t.ok('数えなかった IP は止まっていない', (await c4.opened).open === true);
      c4.ws.terminate();
    } finally {
      await relay.close();
    }
  }
  {
    const { relay, port } = await startRelay(
      { async host() { return { ok: false, code: 4429, reason: 'busy' }; } },
      { failureLimit: 2 },
    );
    try {
      const ip = newIp();
      let denied = 0;
      for (let i = 0; i < 3; i++) {
        const c = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
        if ((await c.opened).open === true && (await c.closedWithin())?.code === CLOSE.LIMIT) denied++;
      }
      t.ok('4429 の断りは失敗の回数に数えない（何度でも Upgrade して 4429）', denied === 3 && relay.stats().blocked === 0);
    } finally {
      await relay.close();
    }
  }

  // ── 投げる・返らない・形が違う: 1013。失敗の回数に数えない ──
  for (const [kind, hostHook] of [
    ['throw', async () => { throw new Error('boom'); }],
    ['hang', () => new Promise(() => {})],
    ['bad', async () => ({ verdict: 'maybe' })],
  ]) {
    const { relay, port } = await startRelay({ host: hostHook }, { authzTimeoutMs: 120, failureLimit: 2 });
    try {
      const ip = newIp();
      const c1 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      const cl1 = await c1.closedWithin(3000);
      t.ok(`差し込みが ${kind} なら 1013 'try again later'`, cl1?.code === 1013 && cl1?.reason === 'try again later', JSON.stringify(cl1));
      const c2 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      await c2.closedWithin(3000);
      const c3 = client(port, '/v1/host', noSecretHeaders(newHostId(), ip));
      t.ok(`1013 は失敗の回数に数えない（${kind}。3 回目も Upgrade する）`, (await c3.opened).open === true && relay.stats().blocked === 0);
      await c3.closedWithin(3000);
    } finally {
      await relay.close();
    }
  }

  // ── device: 断れば閉じる。通してもトークンの照合は残る ──
  {
    let deviceVerdict = { ok: true };
    const { relay, port } = await startRelay({
      async host() { return { ok: true }; },
      async device() { return deviceVerdict; },
    });
    try {
      const hId = newHostId();
      const tk = newToken();
      const ctl = await host(port, hId, [{ id: 'd', tokenHash: tk.hash }]);
      deviceVerdict = { ok: false, code: 4401, reason: 'no' };
      const d1 = device(port, hId, 'd', tk.token);
      t.ok('device が断れば正しいトークンでも閉じる', (await d1.closedWithin())?.code === CLOSE.UNAUTHORIZED);
      deviceVerdict = { ok: false, code: 4404, reason: 'gone' };
      const d2 = device(port, hId, 'd', tk.token);
      t.ok('device の断りの code 4404 はそのまま返る', (await d2.closedWithin())?.code === CLOSE.NOT_FOUND);
      deviceVerdict = { ok: true };
      const d3 = device(port, hId, 'd', newToken().token);
      const cl3 = await d3.closedWithin();
      t.ok('device が通してもトークンが違えば 4401 \'device token\'', cl3?.code === CLOSE.UNAUTHORIZED && cl3?.reason === 'device token', JSON.stringify(cl3));
      ctl.msgs.length = 0;
      const d4 = device(port, hId, 'd', tk.token);
      await d4.opened;
      const inc = await ctl.json();
      t.ok('device が通しトークンも合えばつながる', inc.type === 'incoming' && inc.deviceId === 'd');
      closeAll(ctl, d4);
    } finally {
      await relay.close();
    }
  }

  // ── admit: deviceId も入場券も無い端末を差し込みが受け入れる ──
  {
    const { relay, port } = await startRelay({
      async host() { return { ok: true, tags: ['example:a'] }; },
      async device(ctx) { return { ok: true, admit: ctx.deviceId == null && !ctx.pairing, tags: ['example:a'] }; },
    });
    try {
      const hId = newHostId();
      const ctl = await host(port, hId, []);
      const anon = client(port, '/v1/device', noSecretHeaders(hId, newIp()));
      await anon.opened;
      const inc = await ctl.json();
      t.ok('admit: deviceId 無しの端末を受け入れ、incoming に admit:true', inc.type === 'incoming' && inc.admit === true && !('deviceId' in inc), JSON.stringify(inc));
      const acc = client(port, `/v1/host/accept?conn=${inc.conn}`, noSecretHeaders(hId, newIp()));
      await acc.opened;
      anon.send(Buffer.from('admit-bytes'));
      t.ok('admit の接続は accept のあとバイト列がそのまま流れる', (await acc.next()).data.toString() === 'admit-bytes');

      const named = client(port, '/v1/device', { 'x-pleiad-host': hId, 'x-pleiad-device': 'ghost', 'x-forwarded-for': newIp() });
      t.ok('admit は deviceId があれば効かない（今のトークンの照合へ）', (await named.closedWithin())?.code === CLOSE.UNAUTHORIZED);
      const pr = client(port, '/v1/device', { 'x-pleiad-host': hId, 'x-pleiad-pairing': crypto.randomBytes(32).toString('base64url'), 'x-forwarded-for': newIp() });
      t.ok('admit は入場券があれば効かない（今の入場券の照合へ）', (await pr.closedWithin())?.code === CLOSE.UNAUTHORIZED);

      // anon を含めて 10 回まで。11 回目は 4429 'admit rate'
      for (let i = 0; i < 9; i++) {
        const d = client(port, '/v1/device', noSecretHeaders(hId, newIp()));
        await d.opened;
        await ctl.json();
      }
      const over = client(port, '/v1/device', noSecretHeaders(hId, newIp()));
      const oc = await over.closedWithin();
      t.ok('admit は 1 ホスト 1 分 10 回まで（11 回目は 4429 \'admit rate\'）', oc?.code === CLOSE.LIMIT && oc?.reason === 'admit rate', JSON.stringify(oc));
      closeAll(ctl, anon, acc);
    } finally {
      await relay.close();
    }
  }

  // ── 判定を待つ間のメッセージ: 溜めて順に届ける・64KB で 4413 ──
  {
    const slowDevice = { async device() { await sleep(150); return { ok: true }; } };
    {
      const { relay, port } = await startRelay({ async host() { return { ok: true }; }, ...slowDevice });
      try {
        const hId = newHostId();
        const tk = newToken();
        const ctl = await host(port, hId, [{ id: 'd', tokenHash: tk.hash }]);
        const dev = device(port, hId, 'd', tk.token);
        await dev.opened;
        const m1 = crypto.randomBytes(1000);
        const m2 = crypto.randomBytes(500);
        dev.send(m1);
        dev.send(m2);
        const inc = await ctl.json();
        const acc = client(port, `/v1/host/accept?conn=${inc.conn}`, noSecretHeaders(hId, newIp()));
        await acc.opened;
        const g1 = await acc.next();
        const g2 = await acc.next();
        t.ok('判定を待つ間に端末が送った分は取りこぼさず、accept の後に順に届く', g1.data.equals(m1) && g2.data.equals(m2));
        closeAll(ctl, dev, acc);
      } finally {
        await relay.close();
      }
    }
    {
      const { relay, port } = await startRelay({ async host() { return { ok: true }; }, ...slowDevice });
      try {
        const hId = newHostId();
        const tk = newToken();
        const ctl = await host(port, hId, [{ id: 'd', tokenHash: tk.hash }]);
        const dev = device(port, hId, 'd', tk.token);
        await dev.opened;
        const chunk = crypto.randomBytes(30 * 1024);
        dev.send(chunk);
        dev.send(chunk);
        dev.send(chunk);   // 判定より先に 64KB を超えて溜める
        const cl = await dev.closedWithin(3000);
        t.ok('判定を待つ間の溜めが 64KB を超えたら 4413 \'buffer\'', cl?.code === CLOSE.OVERFLOW && cl?.reason === 'buffer', JSON.stringify(cl));
        closeAll(ctl);
      } finally {
        await relay.close();
      }
    }
  }

  // ── タグと closeTag・出来事 ──
  {
    const events = [];
    let handle = null;
    const { relay, port } = await startRelay({
      async host(ctx) { return { ok: true, tags: ctx.route === '/v1/host' ? ['example:a'] : ['example:c'] }; },
      async device() { return { ok: true, tags: ['example:a'] }; },
      attach(h) { handle = h; },
      event(e) { events.push(e); if (e.type === 'device-open') throw new Error('boom'); },
    });
    try {
      const hId = newHostId();
      const tk = newToken();
      const tn = newToken();
      const ctl = await host(port, hId, [{ id: 'd', tokenHash: tk.hash }, { id: 'n', tokenHash: tn.hash }]);
      const dev = device(port, hId, 'd', tk.token);
      await dev.opened;
      const inc = await ctl.json();
      const acc = client(port, `/v1/host/accept?conn=${inc.conn}`, noSecretHeaders(hId, newIp()));
      await acc.opened;
      const line = client(port, '/v1/device/notify', { authorization: `Bearer ${tn.token}`, 'x-pleiad-host': hId, 'x-pleiad-device': 'n', 'x-forwarded-for': newIp() });
      await line.opened;
      await sleep(50);
      t.ok('event が投げても中継は止まらない', dev.ws.readyState === WebSocket.OPEN && ctl.ws.readyState === WebSocket.OPEN && line.ws.readyState === WebSocket.OPEN);

      const n = handle.closeTag('example:a', 4401, 'test');
      const closed = await Promise.all([ctl.closedWithin(2000), dev.closedWithin(2000), acc.closedWithin(2000), line.closedWithin(2000)]);
      t.ok('closeTag: 制御・データ・端末・通知の線が全部閉じる', closed.every((r) => r?.code === 4401), JSON.stringify(closed));
      t.ok('closeTag は閉じた数を返す', n === 4, String(n));
      await sleep(50);
      const ho = events.find((e) => e.type === 'host-open');
      const doo = events.find((e) => e.type === 'device-open');
      t.ok('event: host-open と device-open を tags・admit つきで受ける',
        ho?.hostId === hId && JSON.stringify(ho.tags) === '["example:a"]'
        && doo?.deviceId === 'd' && doo?.admit === false && JSON.stringify(doo.tags) === '["example:a"]',
        JSON.stringify(events));
      const dc = events.find((e) => e.type === 'device-close');
      const hc = events.find((e) => e.type === 'host-close');
      t.ok('event: device-close と host-close も届く', dc?.deviceId === 'd' && dc?.admit === false && hc?.hostId === hId);
      let threw = false;
      try { handle.closeTag('example:a', 1234); } catch { threw = true; }
      t.ok('closeTag: 使えない close code は投げる', threw);
    } finally {
      await relay.close();
    }
  }

  // ── RELAY_AUTHZ_MODULE: 起動口が差し込みを読む・読めなければ exit 1 ──
  {
    const serverJs = path.join(ROOT, 'relay', 'server.mjs');
    const fixture = path.join(ROOT, 'tests', 'lib', 'fake-relay-authz.mjs');
    const port = await freePort();
    const child = spawn(process.execPath, [serverJs], {
      env: { ...process.env, RELAY_ENROLL_SECRET: SECRET, RELAY_AUTHZ_MODULE: fixture, PORT: String(port), RELAY_LOG: 'silent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      for (let i = 0; i < 100 && !out.includes('"listening"'); i++) await sleep(50);
      t.ok('RELAY_AUTHZ_MODULE を指して node server.mjs が起動する', out.includes('"listening"'), out);
      const c = client(port, '/v1/host', noSecretHeaders(newHostId(), newIp()));
      t.ok('差し込みが効く（登録用の秘密なしで制御用の接続が通る）', (await c.opened).open === true);
      c.ws.terminate();
    } finally {
      child.kill();
      await new Promise((res) => child.once('exit', res));
    }

    const bad = spawn(process.execPath, [serverJs], {
      env: { ...process.env, RELAY_ENROLL_SECRET: SECRET, RELAY_AUTHZ_MODULE: path.join(ROOT, 'tests', 'lib', 'no-such-module.mjs'), PORT: String(await freePort()), RELAY_LOG: 'silent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    bad.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((res) => bad.once('exit', res));
    t.ok('RELAY_AUTHZ_MODULE が読めなければ理由を出して exit 1', code === 1 && err.length > 0, `code=${code} stderr=${err}`);
  }
}
