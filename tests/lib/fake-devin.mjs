import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv[0] === 'version') { console.log('devin fake 1.0.0'); process.exit(0); }
if (argv[0] === 'models' && argv[1] === 'list') { console.log(JSON.stringify([{ id: 'fake-devin-model', name: 'Fake Devin Model' }])); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') { console.log(JSON.stringify({ authenticated: true, user: 'fixture' })); process.exit(0); }
if (argv[0] !== 'acp') { console.error('unsupported fake command'); process.exit(2); }

const stateDir = process.env.FAKE_DEVIN_STATE_DIR || '';
if (stateDir) fs.mkdirSync(stateDir, { recursive: true });
const sessionsPath = stateDir ? path.join(stateDir, 'sessions.json') : '';
let sessions = new Map();
try { sessions = new Map(JSON.parse(fs.readFileSync(sessionsPath, 'utf8')).map((s) => [s.sessionId, s])); } catch {}
let seq = sessions.size;
let serverId = 0;
const pending = new Map();
const write = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const persist = () => { if (sessionsPath) fs.writeFileSync(sessionsPath, JSON.stringify([...sessions.values()], null, 2)); };
const notify = (method, params) => write({ method, params });
const ask = (method, params) => new Promise((resolve, reject) => {
  const id = `fake-${++serverId}`;
  pending.set(id, { resolve, reject });
  write({ id, method, params });
});
const textOf = (prompt) => (prompt ?? []).map((p) => p.text ?? '').join('');
const message = (role, text) => ({ role, content: [{ type: 'text', text }] });

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (Object.hasOwn(req, 'method')) {
    if (!Object.hasOwn(req, 'id')) return;
    try {
      let result;
      switch (req.method) {
        case 'initialize': result = { protocolVersion: 1, agentInfo: { name: 'fake-devin', version: '1.0.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } } }; break;
        case 'session/new': {
          const sessionId = `devin-fixture-${++seq}`;
          const session = { sessionId, cwd: req.params?.cwd ?? process.cwd(), title: null, messages: [] };
          sessions.set(sessionId, session); persist(); result = { sessionId }; break;
        }
        case 'session/load': {
          const session = sessions.get(req.params?.sessionId);
          if (!session) throw Object.assign(new Error('Unknown session'), { code: -32004 });
          result = { sessionId: session.sessionId }; break;
        }
        case 'session/list': result = { sessions: [...sessions.values()].map(({ sessionId, cwd, title }) => ({ sessionId, cwd, title })) }; break;
        case 'session/set_config_option': result = { configOptions: [{ id: req.params?.configId ?? 'model', value: req.params?.value ?? 'fake-devin-model' }] }; break;
        case 'session/cancel': result = {}; break;
        case 'session/prompt': {
          const session = sessions.get(req.params?.sessionId);
          if (!session) throw Object.assign(new Error('Unknown session'), { code: -32004 });
          const prompt = req.params?.prompt ?? [];
          const text = textOf(prompt);
          session.messages.push(message('user', text));
          persist();
          if (text.includes('[kill]')) { process.exit(17); return; }
          if (text.includes('[slow]')) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DEVIN_SLOW_MS || 5000)));
          let permissionResult = null;
          if (text.includes('[permission]')) {
            try { permissionResult = await ask('session/request_permission', { sessionId: session.sessionId, toolCall: { toolCallId: 'fake-permission', title: 'Fixture permission', kind: 'execute' }, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] }); }
            catch (error) { permissionResult = { denied: true, message: error.message }; }
          }
          const reply = `fixture: ${text}`;
          if (text.includes('[frame-malformed]')) { process.stdout.write('{not-json}\n'); return; }
          if (text.includes('[multi-utf8]')) {
            const frame = `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '日本語🙂' } } } })}\n`;
            const bytes = Buffer.from(frame); const split = bytes.indexOf(Buffer.from('🙂')) + 2;
            process.stdout.write(bytes.subarray(0, split)); await new Promise((resolve) => setTimeout(resolve, 5)); process.stdout.write(bytes.subarray(split));
          }
          const delta = (value) => notify('session/update', { sessionId: session.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } });
          delta(reply.slice(0, Math.ceil(reply.length / 2))); delta(reply.slice(Math.ceil(reply.length / 2)));
          session.messages.push(message('assistant', reply)); persist();
          result = { permissionResult }; break;
        }
        default: throw Object.assign(new Error(`Unsupported method: ${req.method}`), { code: -32601 });
      }
      write({ id: req.id, result });
    } catch (error) { write({ id: req.id, error: { code: error.code ?? -32000, message: error.message } }); }
    return;
  }
  const waiter = pending.get(req.id);
  if (waiter) { pending.delete(req.id); if (req.error) waiter.reject(Object.assign(new Error(req.error.message), req.error)); else waiter.resolve(req.result); }
});
