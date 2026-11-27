// node tests/browser/remote-browser.mjs chromium firefox
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { hostIdFor } from '../../core/remote/noise.mjs';
import { RELAY_PROTOCOL, LOADER_PATH } from '../../web/remote/browser-wire.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createPlusRelayAuthz } from '../lib/plus-relay-authz.mjs';
import { ROOT, startServer, waitForTestHolders } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PW_CORE ?? (process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core' : 'playwright-core'));
const engines = process.argv.slice(2);
if (!engines.length) engines.push('chromium', 'firefox');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'pleiad-browser-remote-'));
const bytes = Buffer.from(Uint8Array.from({ length: 2 * 1024 * 1024 + 7 }, (_, i) => i % 251));
const uid = 'user-1';
const personalTenant = '07e2684e-5f8e-4a90-831a-2f63cc0d9823';
const organizationTenant = '1578ef5a-fc6c-4aee-bc55-c3eeb486f724';
const taskLinks = new Map();
const stops = [];
const send = (res, body, type = 'text/html', headers = {}) =>
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers }).end(body);
const modules = new Map();
let shellOrigin;
const claimsOf = ticket => JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url'));

async function listen(handler, hostname = '127.0.0.1') {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => res.writeHead(500).end());
  });
  server.listen(0, hostname);
  await once(server, 'listening');
  stops.push(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { server, origin: `http://${hostname}:${server.address().port}` };
}

async function asset(req, res) {
  const name = /^\/_pleiad-remote\/([\w-]+\.mjs)$/.exec(req.url)?.[1];
  if (!name) return res.writeHead(404).end();
  const file = name;
  if (!modules.has(file)) modules.set(file, readFile(path.join(ROOT, 'web', 'remote', file)));
  try { send(res, await modules.get(file), 'text/javascript', { 'service-worker-allowed': '/' }); }
  catch { res.writeHead(404).end(); }
}

async function until(fn, label) {
  for (let i = 0; i < 300; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + label);
}

const allHosts = new Map();
const shell = await listen((req, res) => req.url === '/'
  ? send(res, '<!doctype html><title>Browser remote test</title><style>iframe{width:98%;height:45vh}</style>')
  : asset(req, res));
shellOrigin = shell.origin;

try {
  const plusVerifier = () => createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
  let verify;
  const authz = createPlusRelayAuthz({
    verify: token => (verify ??= plusVerifier()).verify(token),
    isBound: async (account, hostId) => plus.state.hosts[hostId]?.uid === account,
    keysUrl: () => plus.ticketKeysUrl,
  });
  // All browser engines share the fixture relay, including the remounts for each workspace.
  const relay = createRelay({ enrollSecret: randomBytes(32).toString('base64url'), trustProxy: false, authz, admitPerMinute: 10 * engines.length,
    logger: process.env.PW_REMOTE_DEBUG ? console.error : () => {} });
  const { port: relayPort } = await relay.listen(0, '127.0.0.1');
  stops.push(() => relay.close());
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:' + relayPort,
    taskLink(path, account, headers, body) {
      const [, , , tenant, requestId, operation] = path.split('/');
      const link = taskLinks.get(requestId);
      if (tenant !== personalTenant || !link || link.hostId !== body.hostId) return { status: 404, body: {} };
      if (operation === 'ticket' && account === uid) return {
        status: 200, body: { agent: 'fake', openRef: link.updates.at(-1)?.openRef ?? null, token: link.token },
      };
      if (operation === 'state' && !account && headers['x-pleiad-task-link-ticket'] === link.token) {
        link.updates.push(body);
        return { status: 200, body: { accepted: true } };
      }
      return { status: 403, body: {} };
    },
  });
  plus.state.accounts[uid] = { uid, email: 'fixture@example.test', status: 'plus',
    plan: { id: 'plus', name: 'Plus' }, limits: { hosts: 4, devicesPerHost: 16 }, sync: { enabled: false } };
  stops.push(() => plus.close());

  // The production browser entry belongs to the shell service. This fixture
  // translates the browser upgrade to the reference relay's existing device route.
  const bridge = new WebSocketServer({ noServer: true, maxPayload: 65_535 });
  stops.push(() => new Promise(resolve => {
    for (const socket of bridge.clients) socket.terminate();
    bridge.close(resolve);
  }));
  shell.server.on('upgrade', (req, socket, head) => {
    const [protocol, ticket, extra] = String(req.headers['sec-websocket-protocol']).split(',').map(value => value.trim());
    let claims;
    try { claims = claimsOf(ticket); } catch {}
    if (req.headers.origin !== shellOrigin || req.url !== '/v1/device' || protocol !== RELAY_PROTOCOL || extra ||
        !allHosts.has(claims?.hostId) || claims.origin !== shellOrigin || claims.deviceKind !== 'browser' ||
        claims.exp <= Date.now() / 1000 || claims.exp - claims.iat !== 60) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/device`, {
      headers: { 'x-pleiad-host': claims.hostId, 'x-pleiad-ticket': ticket },
    });
    const pending = [];
    const buffer = (data, binary) => pending.push([data, binary]);
    upstream.on('message', buffer);
    upstream.on('error', error => { if (process.env.PW_REMOTE_DEBUG) console.error(error.message); socket.destroy(); });
    socket.once('close', () => upstream.terminate());
    req.headers['sec-websocket-protocol'] = RELAY_PROTOCOL;
    upstream.once('open', () => bridge.handleUpgrade(req, socket, head, browser => {
      upstream.off('message', buffer);
      function pipe(from, to) {
        from.on('message', (data, binary) => { if (to.readyState === WebSocket.OPEN) to.send(data, { binary }); });
        from.on('close', (code, reason) => to.close(code === 1006 ? 1011 : code, reason));
        from.on('error', () => to.terminate());
      }
      pipe(browser, upstream);
      pipe(upstream, browser);
      for (const [data, binary] of pending) browser.send(data, { binary });
    }));
  });

  for (const name of ['desk', 'cloud']) {
    const directory = path.join(scratch, name);
    const folder = path.join(directory, 'files');
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, name + '.bin');
    await writeFile(file, bytes);
    const capture = path.join(directory, 'external.log');
    const host = await startServer({ dataDir: path.join(directory, 'data'),
      entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
      env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: capture,
        PLEIAD_REMOTE_BROWSER_ORIGIN: shellOrigin },
    });
    stops.push(() => host.stop());
    const pc = await open(host);
    stops.push(() => pc.ws.terminate());
    await pc.cmd('plusLogin');
    const login = await until(async () => (await readFile(capture, 'utf8').catch(() => '')).trim().split('\n').at(-1), 'sign-in URL');
    assert.ok((await fetch(login)).ok);
    await until(async () => (await pc.cmd('plusStatus')).signedIn, 'host sign-in');
    await pc.cmd('setRemoteSettings', { enabled: true, plusConnect: true, hostName: name });
    const status = await until(async () => {
      const value = await pc.cmd('remoteStatus');
      return value.links.plus.state === 'connected' && value;
    }, 'host relay ' + name);
    const { hostId } = status;
    const hostKey = plus.state.hosts[hostId].publicKey;
    await pc.cmd('authLogin', { backend: 'fake' });
    const { sessionId } = await pc.cmd('newSession', { backend: 'fake', cwd: folder });
    const loader = await listen((req, res) => {
      if (req.url === LOADER_PATH) return send(res, '<!doctype html><p id="status"></p><iframe id="view" style="width:98%;height:90%"></iframe><script type="module" src="/_pleiad-remote/loader.mjs"></script>');
      if (req.url === '/_pleiad-remote/loader.mjs') return send(res,
        `import {startHostLoader} from './browser-loader.mjs'; startHostLoader({shellOrigin:${JSON.stringify(shellOrigin)},view:document.querySelector('#view'),status:document.querySelector('#status')});`, 'text/javascript');
      if (new URL(req.url, 'http://localhost').pathname === '/') return res.writeHead(403).end();
      return asset(req, res);
    }, 'localhost');
    allHosts.set(hostId, { name, pc, sessionId, file, hostId, hostKey, hostOrigin: loader.origin,
      relayUrl: shellOrigin.replace('http:', 'ws:') + '/v1/device' });
  }

  async function ticketRequest(endpoint, body) {
    const result = await fetch(plus.url + '/v1/tickets' + endpoint, {
      method: 'POST', headers: { authorization: 'Bearer ' + plus.issueIdToken(uid), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 200);
    return result.json();
  }

  for (const engine of engines) {
    const browser = await playwright[engine].launch({ executablePath: process.env['PW_' + engine.toUpperCase()] });
    const scenarios = [];
    try {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (process.env.PW_REMOTE_DEBUG) {
        page.on('pageerror', error => console.error(error));
        page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
        page.on('websocket', socket => { socket.on('socketerror', error => console.error(error)); });
        page.on('response', response => { if (response.url().includes('/local-file?')) console.error('File response:', response.status()); });
        page.on('requestfailed', request => { if (request.url().includes('/local-file?')) console.error('File request:', request.failure()); });
      }
      const response403 = [];
      page.on('response', response => { if (response.status() === 403 && response.url().includes('__pleiad_remote=')) response403.push(response.url()); });
      const issued = new Map();
      await page.exposeFunction('challenge', (hostId, publicKey) =>
        ticketRequest('/challenge', { purpose: 'device', publicKey, hostId }));
      await page.exposeFunction('tickets', async (hostId, challengeId, proof, origin, wrongOrigin, tenantId) => {
        assert.equal(origin, shellOrigin);
        const issuedTickets = await ticketRequest('', { challengeId, proof });
        const claims = claimsOf(issuedTickets.admission);
        const history = issued.get(hostId) ?? [];
        issued.set(hostId, [...history, claims]);
        const browserClaims = { deviceKind: 'browser', origin, exp: claims.iat + 60 };
        return {
          relay: plus.signTicket({ ...claimsOf(issuedTickets.relay), ...browserClaims }),
          admission: plus.signTicket({ ...claims, ...browserClaims, tenantId,
            workspaceKind: tenantId === personalTenant ? 'personal' : 'organization',
            origin: wrongOrigin ? 'https://wrong.example.test' : origin }),
        };
      });
      await page.goto(shellOrigin);
      await page.evaluate(async () => {
        const { mountBrowserHost } = await import('/_pleiad-remote/browser-shell.mjs');
        window.events = {};
        window.mounts = {};
        window.mount = (options, wrongOrigin = false) => {
          const id = options.name + (wrongOrigin ? '-wrong' : '');
          const iframe = document.createElement('iframe');
          iframe.id = id;
          document.body.append(iframe);
          const events = window.events[id] = [];
          window.mounts[id] = mountBrowserHost({ ...options, iframe, account: 'fixture',
            onStatus: status => events.push(status),
            getTickets: async ({ hostId, devicePub, origin, prove }) => {
              const challenge = await window.challenge(hostId, devicePub);
              return window.tickets(hostId, challenge.challengeId, await prove(challenge), origin, wrongOrigin, options.tenantId);
            },
          });
        };
        window.unmount = id => {
          window.mounts[id].close();
          delete window.mounts[id];
          document.getElementById(id).remove();
        };
      });
      const mounted = [...allHosts.values()];
      const options = ({ name, hostId, hostKey, hostOrigin, relayUrl }) => ({ name, hostId, hostKey, hostOrigin, relayUrl, tenantId: personalTenant });
      const state = async (name, value, count = 1) => {
        try {
          await page.waitForFunction(({ name, value, count }) =>
            window.events[name]?.filter(item => item.state === value).length >= count, { name, value, count }, { timeout: 20_000 });
        } catch (error) {
          const states = await page.evaluate(name => window.events[name]?.map(({ state, reason }) => ({ state, reason })), name);
          throw new Error(`Expected ${name} to reach ${value}. Received ${JSON.stringify(states)}.`, { cause: error });
        }
      };
      await page.evaluate(value => window.mount(value, true), options(mounted[0]));
      await state('desk-wrong', 'stopped');
      assert.equal(await page.evaluate(() => window.events['desk-wrong'].at(-1).reason), 'account');
      assert.equal((await mounted[0].pc.cmd('remoteStatus')).pairing.requests.length, 0);
      scenarios.push('reject mismatched origin');

      for (const host of mounted) await page.evaluate(value => window.mount(value), options(host));
      const views = [];
      for (const host of mounted) {
        await state(host.name, 'waiting');
        const code = await page.evaluate(name => window.events[name].find(item => item.state === 'waiting').code, host.name);
        const request = await until(async () => (await host.pc.cmd('remoteStatus')).pairing.requests[0], 'PC approval');
        assert.match(code, /^\d{6}$/);
        assert.equal(request.code, code);
        assert.equal(request.platform, 'browser');
        const device = await host.pc.cmd('remotePairingApprove', { id: request.id });
        assert.equal(device.platform, 'browser');
        host.deviceId = device.id;
        await state(host.name, 'ready');
        const frame = page.frameLocator('#' + host.name).frameLocator('#view');
        await frame.locator('html[data-remote-embedded]').waitFor({ timeout: 30_000 });
        assert.equal(await frame.locator('#sidebar').isHidden(), true);
        views.push(frame);
      }
      scenarios.push('PC approval code and embedded screen on two hosts');
      assert.notEqual(issued.get(mounted[0].hostId).at(-1).devicePub, issued.get(mounted[1].hostId).at(-1).devicePub);
      for (let i = 0; i < views.length; i++) {
        const status = await views[i].locator('html').evaluate(async () => {
          const { createHostSocket } = await import('/remote/browser-view.mjs');
          const app = createHostSocket(new URL('/ws', location.href));
          return new Promise((resolve, reject) => {
            let voice;
            app.onmessage = ({ data }) => {
              const message = JSON.parse(data);
              if (message.kind === 'ready') {
                voice = message.voice;
                app.send(new TextEncoder().encode(JSON.stringify({
                  kind: 'command', id: 'preview', command: 'pageOpen', args: { kind: 'html' },
                })));
                return;
              }
              if (message.kind !== 'response' || message.id !== 'preview') return;
              app.close();
              resolve({ voice, preview: message.code, origin: location.origin });
            };
            app.onerror = reject;
          });
        }, undefined, { timeout: 15_000 });
        assert.notEqual(status.voice, 1);
        assert.equal(status.preview, 'BROWSER_PREVIEW_UNAVAILABLE');
        assert.equal(status.origin, mounted[i].hostOrigin);
      }
      scenarios.push('host-scoped keys and virtual WebSocket');

      const [desk, cloud] = mounted;
      const [view, second] = views;
      const requestId = randomUUID();
      const link = { hostId: desk.hostId, token: randomUUID(), updates: [] };
      taskLinks.set(requestId, link);
      const [task, duplicate] = await page.evaluate(requestId => Promise.all([
        window.mounts.desk.taskLink({ action: 'start', requestId }),
        window.mounts.desk.taskLink({ action: 'start', requestId }),
      ]), requestId);
      assert.deepEqual(task, duplicate);
      assert.deepEqual(link.updates, [{ hostId: desk.hostId, openRef: task.sessionId, state: 'not_started', version: 1 }]);
      assert.deepEqual(await page.evaluate(openRef => window.mounts.desk.taskLink({ action: 'open', openRef }), task.sessionId), task);
      assert.deepEqual(await page.evaluate(requestId => window.mounts.desk.taskLink({ action: 'start', requestId }), requestId), task);
      await assert.rejects(page.evaluate(openRef => window.mounts.cloud.taskLink({ action: 'open', openRef }), task.sessionId));
      await desk.pc.runTurn({ sessionId: task.sessionId, prompt: 'echo:private-test' }, { ms: 20_000 });
      await until(() => link.updates.at(-1)?.state === 'completed', 'task link completion');
      assert.equal(link.updates.at(-1).openRef, task.sessionId);
      assert.ok(link.updates.at(-1).version > 1);
      assert.ok(link.updates.every(update => Object.keys(update).sort().join(',') === 'hostId,openRef,state,version'));
      scenarios.push('task link request replay, host authorization and status from the fake backend');
      const oldMarker = await view.locator('html').evaluate(() => location.href);
      const reloaded = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(desk.hostOrigin + '/?'), timeout: 20_000 });
      await view.locator('html').evaluate(() => { setTimeout(() => location.reload(), 0); });
      await reloaded;
      await view.locator('html[data-remote-embedded]').waitFor({ timeout: 30_000 });
      assert.equal(response403.length, 0);
      const unrelated = await context.newPage();
      assert.equal((await unrelated.goto(oldMarker)).status(), 403);
      await unrelated.close();
      scenarios.push('reload and denial in an unbound tab');

      const upload = (frame, sessionId) => frame.locator('html').evaluate(async (_, { sessionId, size }) => {
        const { createHostSocket } = await import('/remote/browser-view.mjs');
        const app = createHostSocket(new URL('/ws', location.href));
        const replies = new Map();
        let id = 0;
        await new Promise((resolve, reject) => {
          app.onerror = reject;
          app.onmessage = ({ data }) => {
            const value = JSON.parse(data);
            if (value.kind === 'ready') resolve();
            if (value.kind === 'response') replies.get(value.id)?.(value);
          };
        });
        async function cmd(command, args) {
          const requestId = String(++id);
          const value = await new Promise(resolve => {
            replies.set(requestId, resolve);
            app.send(JSON.stringify({ kind: 'command', id: requestId, command, args }));
          });
          replies.delete(requestId);
          if (!value.ok) throw new Error(command + ': ' + value.error);
          return value.result;
        }
        const { uploadId, chunkBytes } = await cmd('attachStart', { sessionId, name: 'upload.txt', mime: 'text/plain', size });
        for (let offset = 0; offset < size; offset += chunkBytes) {
          let raw = '';
          for (let i = offset; i < Math.min(offset + chunkBytes, size); i++) raw += String.fromCharCode(i % 251);
          await cmd('attachChunk', { uploadId, offset, data: btoa(raw) });
        }
        const result = await cmd('attachFinish', { uploadId });
        app.close();
        return result.path;
      }, { sessionId, size: bytes.length }, { timeout: 30_000 });
      const attachments = [];
      for (let i = 0; i < views.length; i++) {
        const file = await upload(views[i], mounted[i].sessionId);
        assert.deepEqual(await readFile(file), bytes);
        attachments.push(file);
      }
      scenarios.push('streamed file upload');

      for (let i = 0; i < views.length; i++) {
        await views[i].locator('html').evaluate(async (_, { file, sessionId, name }) => {
          const { fileDownloadUrl } = await import('/file-reference.mjs');
          const link = document.createElement('a');
          link.id = 'fixture-download';
          link.href = fileDownloadUrl(file, sessionId);
          link.download = name + '.bin';
          link.textContent = 'Download';
          document.body.prepend(link);
        }, { file: attachments[i], ...optionsForDownload(mounted[i]) });
        const downloading = page.waitForEvent('download', { timeout: 12_000 });
        const [, download] = await Promise.all([
          views[i].locator('#fixture-download').evaluate(anchor => anchor.click()), downloading,
        ]);
        assert.equal(download.suggestedFilename(), mounted[i].name + '.bin');
        assert.deepEqual(await readFile(await download.path()), bytes);
      }
      scenarios.push('download link on each host');

      await page.evaluate(value => {
        window.unmount('desk');
        window.mount(value);
      }, { ...options(desk), name: 'desk-org', tenantId: organizationTenant });
      await state('desk-org', 'ready');
      await assert.rejects(page.evaluate(openRef => window.mounts['desk-org'].taskLink({ action: 'open', openRef }), task.sessionId));
      const organization = page.frameLocator('#desk-org').frameLocator('#view');
      await organization.locator('html[data-remote-embedded]').waitFor({ timeout: 30_000 }).catch(async error => {
        const loader = page.frameLocator('#desk-org');
        const status = await loader.locator('#status').textContent({ timeout: 2_000 }).catch(() => '');
        const content = await organization.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
        throw new Error(`Organization host view did not load. Loader: ${status}. Frame: ${content.slice(0, 240)}`, { cause: error });
      });
      const execute = (frame, commands) => frame.locator('html').evaluate(async (_, commands) => {
        const { createHostSocket } = await import('/remote/browser-view.mjs');
        const app = createHostSocket(new URL('/ws', location.href));
        const responses = [];
        return new Promise((resolve, reject) => {
          app.onerror = reject;
          const sendNext = () => {
            const next = commands[responses.length];
            if (!next) { app.close(); return resolve(responses); }
            const [command, args] = next;
            app.send(JSON.stringify({ kind: 'command', id: String(responses.length), command, args }));
          };
          app.onmessage = ({ data }) => {
            const frame = JSON.parse(data);
            if (frame.kind === 'ready') return sendNext();
            if (frame.kind === 'response') { responses.push(frame); sendNext(); }
          };
        });
      }, commands, { timeout: 20_000 });
      const [empty, deniedOpen, deniedSend, created] = await execute(organization, [
        ['listSessions', {}], ['loadSession', { sessionId: desk.sessionId }],
        ['sendMessage', { sessionId: desk.sessionId, prompt: 'outside this workspace' }],
        ['newSession', { backend: 'fake', cwd: path.dirname(desk.file) }],
      ]);
      assert.equal(empty.ok, true);
      assert.doesNotMatch(JSON.stringify(empty.result), new RegExp(desk.sessionId));
      assert.equal(deniedOpen.code, 'SESSION_NOT_FOUND');
      assert.equal(deniedSend.code, 'SESSION_NOT_FOUND');
      assert.equal(created.ok, true, JSON.stringify(created));
      const { sessionId: orgSession } = created.result;
      const [orgList, opened, sent] = await execute(organization, [
        ['listSessions', {}], ['loadSession', { sessionId: orgSession }],
        ['sendMessage', { sessionId: orgSession, messageId: 'test-org-message', prompt: 'Inside this workspace' }],
      ]);
      assert.ok(JSON.stringify(orgList.result).includes(orgSession));
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal(sent.ok, true, JSON.stringify(sent));
      await page.evaluate(value => {
        window.unmount('desk-org');
        window.mount(value);
      }, options(desk));
      await state('desk', 'ready');
      await view.locator('html[data-remote-embedded]').waitFor({ timeout: 30_000 });
      const [personalList, personalOpen] = await execute(view, [
        ['listSessions', {}], ['loadSession', { sessionId: orgSession }],
      ]);
      assert.ok(JSON.stringify(personalList.result).includes(desk.sessionId));
      assert.ok(!JSON.stringify(personalList.result).includes(orgSession));
      assert.equal(personalOpen.code, 'SESSION_NOT_FOUND');
      const localList = JSON.stringify(await desk.pc.cmd('listSessions'));
      assert.ok(localList.includes(desk.sessionId) && localList.includes(orgSession));
      scenarios.push('workspace-specific listing, opening, sending, and new conversation creation');

      const claims = issued.get(desk.hostId).at(-1);
      authz.handle.closeTag('k:' + hostIdFor(Buffer.from(claims.devicePub, 'base64url')), 1013, 'try again');
      await state(desk.name, 'ready', 2);
      assert.equal(issued.get(desk.hostId).at(-1).devicePub, claims.devicePub);
      assert.notEqual(issued.get(desk.hostId).at(-1).jti, claims.jti);
      assert.equal((await desk.pc.cmd('remoteStatus')).pairing.requests.length, 0);
      scenarios.push('reconnect with a fresh ticket and the same key');

      const atRevocation = issued.get(desk.hostId).length;
      await desk.pc.cmd('remoteRevoke', { id: desk.deviceId });
      await state(desk.name, 'stopped');
      assert.equal(await page.evaluate(() => window.events.desk.at(-1).reason), 'revoked');
      assert.equal(issued.get(desk.hostId).length, atRevocation);
      assert.equal((await view.locator('html').evaluate(async () => (await fetch('/auth-check')).status)), 502);
      assert.equal((await second.locator('html').evaluate(async () => (await fetch('/auth-check')).status)), 204);
      assert.ok((await desk.pc.cmd('remoteStatus')).revoked.some(device => device.key === claims.devicePub && device.platform === 'browser'));
      await page.evaluate(value => window.mount(value), { ...options(desk), name: 'desk-revoked' });
      await state('desk-revoked', 'stopped');
      assert.equal(await page.evaluate(() => window.events['desk-revoked'].at(-1).reason), 'revoked');
      assert.equal(issued.get(desk.hostId).length, atRevocation + 1);
      assert.equal(issued.get(desk.hostId).at(-1).devicePub, claims.devicePub);
      scenarios.push('revocation cuts one host without affecting the other');
      assert.deepEqual(errors, []);
      console.log(engine + ' ' + browser.version() + ' PASS: ' + scenarios.length + ' scenarios (' + scenarios.join(', ') + ')');
    } finally { await browser.close(); }
  }
} finally {
  for (const stop of stops.reverse()) await stop();
  assert.deepEqual(await waitForTestHolders(), []);
  await rm(scratch, { recursive: true, force: true });
}

function optionsForDownload({ sessionId, name }) { return { sessionId, name }; }
