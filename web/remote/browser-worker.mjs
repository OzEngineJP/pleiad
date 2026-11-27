import { Handshake, prologueFor } from './noise.mjs';
import { Channel } from './channel.mjs';
import { browserIdentity, confirmationCode, ticketProof } from './browser-identity.mjs';
import { RELAY_PROTOCOL, b64url, encode, decode } from './browser-wire.mjs';

const MAX_ACTIVE = 24;
const MAX_QUEUED = 512;
const report = (state, fields) => postMessage({ type: 'status', state, ...fields });
const json = value => encode.encode(JSON.stringify(value));

// One port per stream. A reader returns credit as it consumes data.
function serve(channel, { data, port }, finished) {
  let stream;
  let index = 0;
  const releases = new Map();
  const send = (type, fields) => port.postMessage({ type, ...fields });
  const finish = (type, fields) => {
    send(type, fields);
    finished();
    if (!releases.size) port.close();
  };
  const chunk = (bytes, release, text = false) => {
    releases.set(++index, release);
    send('data', { index, data: text ? decode.decode(bytes) : Uint8Array.from(bytes) });
  };
  try {
    if (data.type === 'http') {
      stream = channel.openHttp(data.head);
      stream.on('response', head => send('response', { head }));
      stream.on('data', chunk);
      stream.on('end', () => finish('end'));
      stream.end().catch(() => {});
    } else {
      stream = channel.openWs(data.head);
      stream.on('accept', () => send('open'));
      stream.on('reject', status => finish('close', { code: 1006, reason: 'HTTP ' + status }));
      stream.on('message', (bytes, text, release) => chunk(bytes, release, text));
      stream.on('close', (code, reason) => finish('close', { code, reason }));
    }
    stream.on('reset', code => {
      releases.clear();
      finish('reset', { code });
    });
    port.onmessage = ({ data: message }) => {
      if (message.type === 'credit') {
        releases.get(message.index)?.();
        releases.delete(message.index);
        if (!releases.size && (stream.remoteDone || stream.destroyed)) port.close();
      } else if (message.type === 'cancel') {
        for (const release of releases.values()) release();
        stream.reset();
        port.close();
      } else if (data.type === 'ws' && message.type === 'send') {
        stream.send(message.data).catch(() => stream.reset());
      } else if (data.type === 'ws' && message.type === 'close') {
        stream.close(message.code, message.reason).catch(() => stream.reset());
      }
    };
  } catch {
    stream?.reset();
    finish('reset', { reason: 'could not open stream' });
  }
}

function attempt(url, tickets, options, device, interactive, onReady) {
  return new Promise(resolve => {
    const socket = new WebSocket(url, [RELAY_PROTOCOL, tickets.relay]);
    socket.binaryType = 'arraybuffer';
    const handshake = new Handshake({
      initiator: true, staticKey: device, remoteStatic: device.remoteStatic,
      prologue: prologueFor(options.hostId),
    });
    let channel, transport, terminal;
    let received = Promise.resolve(), sending = Promise.resolve(), queuedBytes = 0;
    let deadline;
    const timeout = ms => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.close(), ms);
    };
    timeout(20_000);
    socket.onclose = event => {
      clearTimeout(deadline);
      void received.finally(() => {
        const reason = event.code === 4401 && ({
          revoked: 'revoked', account: 'account', host: 'host', 'update required': 'update_required',
        })[event.reason];
        resolve(terminal ?? (reason || null));
        channel?.close();
      });
    };
    socket.onopen = async () => {
      try {
        if (socket.protocol !== RELAY_PROTOCOL) return socket.close();
        socket.send(await handshake.writeMessage(json({
          name: options.name, platform: 'browser', plus: { ticket: tickets.admission, origin: self.location.origin },
        })));
      } catch { socket.close(); }
    };
    socket.onmessage = ({ data }) => {
      received = received.then(async () => {
        if (channel) return channel.receive(await transport.decrypt(data));
        if (socket.readyState !== WebSocket.OPEN && !transport) return;
        if (!transport) {
          await handshake.readMessage(data);
          transport = await handshake.split();
          socket.send(await transport.encrypt(json({ type: interactive ? 'pair' : 'admit' })));
          return;
        }
        const message = JSON.parse(decode.decode(await transport.decrypt(data)));
        if (message.type === 'waiting') {
          timeout(310_000);
          report('waiting', { code: await confirmationCode(transport.handshakeHash) });
          return;
        }
        if (message.type !== 'approved') {
          terminal = message.type === 'denied' ? message.reason : 'expired';
          return socket.close();
        }
        channel = new Channel({
          role: 'device',
          send(frame) {
            queuedBytes += frame.length;
            sending = sending.then(async () => {
              if (socket.readyState === WebSocket.OPEN) socket.send(await transport.encrypt(frame));
            }).catch(() => socket.close()).finally(() => { queuedBytes -= frame.length; });
          },
          bufferedAmount: () => socket.bufferedAmount + queuedBytes,
          hello: { shell: 'browser' },
        });
        timeout(20_000);
        channel.once('hello', () => {
          clearTimeout(deadline);
          onReady(channel, { deviceId: message.deviceId, hostName: message.hostName });
        });
        channel.once('goaway', ({ code }) => {
          if (code === 'revoked') terminal = 'revoked';
        });
        channel.once('close', () => socket.close());
        channel.start();
      }).catch(() => socket.close());
    };
  });
}

self.onmessage = async ({ data: options }) => {
  self.onmessage = null;
  const replies = new Map();
  let nextId = 0;
  let device;
  const waiting = new Map();
  let active = 0, channel, stopped;
  const reject = (port, reason) => { port.postMessage({ type: 'reset', reason }); port.close(); };
  const pump = () => {
    while (channel && !channel.closed && active < MAX_ACTIVE && waiting.size) {
      const [port, data] = waiting.entries().next().value;
      waiting.delete(port);
      active++;
      let done = false;
      serve(channel, { port, data }, () => {
        if (done) return;
        done = true;
        active--;
        queueMicrotask(pump);
      });
    }
  };
  const onRequest = ({ data, ports: [port] }) => {
    if (!port) return;
    if (!channel || channel.closed) return reject(port, stopped ?? 'host disconnected');
    if (!['ws', 'http'].includes(data?.type) || waiting.size >= MAX_QUEUED) return reject(port, 'request unavailable');
    waiting.set(port, data);
    port.onmessage = ({ data: message }) => {
      if (message.type === 'cancel') { waiting.delete(port); port.close(); }
    };
    pump();
  };
  self.onmessage = async ({ data, ports: [bus] }) => {
    if (data.type === 'bind' && bus) {
      bus.onmessage = onRequest;
      return;
    }
    const reply = replies.get(data.id);
    if (!reply) return;
    if (data.type === 'proof') {
      try {
        const proof = await ticketProof({ ...data.challenge, privateKey: device.privateKey, hostId: options.hostId });
        postMessage({ type: 'proof', id: data.id, proofId: data.proofId, proof });
      } catch { postMessage({ type: 'proof', id: data.id, proofId: data.proofId, error: true }); }
    } else if (data.type === 'tickets') {
      replies.delete(data.id);
      reply(data.tickets);
    }
  };

  try { device = await browserIdentity(options); }
  catch (error) { stopped = error.message; return report('stopped', { reason: stopped }); }
  let interactive = options.interactive !== false;
  let delay = 500;
  while (true) {
    report('connecting');
    const id = ++nextId;
    const tickets = await new Promise(resolve => {
      replies.set(id, resolve);
      postMessage({ type: 'tickets', id, devicePub: b64url(device.publicKey) });
    });
    try {
      if (tickets?.error) {
        if (!tickets.retry) stopped = tickets.error;
      } else if (tickets?.relay && tickets?.admission) {
        stopped = await attempt(options.relayUrl, tickets, options, device, interactive, (ready, info) => {
          channel = ready;
          interactive = false;
          delay = 500;
          report('ready', info);
        });
      } else stopped = 'tickets unavailable';
    } catch { stopped = 'invalid relay configuration'; }
    channel = null;
    for (const port of waiting.keys()) reject(port, 'host disconnected');
    waiting.clear();
    if (stopped && !['unavailable', 'rate'].includes(stopped)) return report('stopped', { reason: stopped });
    stopped = null;
    report('disconnected');
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 15_000);
  }
};
