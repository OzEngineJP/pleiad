import '../tests/lib/test-env.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, ROOT } from '../tests/lib/server.mjs';
import { open } from '../tests/lib/ws-client.mjs';

export async function packagedRoots(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === (process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`) && process.platform === 'win32') result.push(path.join(directory, entry.name, 'resources/app'));
    if (process.platform === 'darwin' && entry.name === (process.arch === 'x64' ? 'mac' : `mac-${process.arch}`)) {
      for (const bundle of await fs.readdir(path.join(directory, entry.name))) if (bundle.endsWith('.app')) result.push(path.join(directory, entry.name, bundle, 'Contents/Resources/app'));
    }
  }
  if (!result.length) throw new Error(`No packaged application for ${process.platform}/${process.arch} in ${directory}`);
  return result;
}

async function checkWindow(host, sessionId, scratch, label) {
  const executable = createRequire(import.meta.url)('electron');
  const env = { ...process.env, PLEIAD_SMOKE_URL: `http://127.0.0.1:${host.port}/?token=${host.token}`, PLEIAD_SMOKE_PROFILE: path.join(scratch, label), PLEIAD_SMOKE_SESSION: sessionId || '', PLEIAD_SMOKE_SHOT: path.join(scratch, `${label}.png`) };
  delete env.ELECTRON_RUN_AS_NODE;
  await fs.mkdir(env.PLEIAD_SMOKE_PROFILE, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(ROOT, 'tests/desktop/ui-startup-smoke.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-16000); });
    const timer = setTimeout(() => { child.kill(); }, 60000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || !output.includes('"ok":true')) reject(new Error(`${label}: ${output.replaceAll(host.token, '[redacted]')}`));
      else { console.log(`${label}: UI startup passed`); resolve(); }
    });
  });
}

export async function smoke(root) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ui-smoke-'));
  let host, client, passed = false;
  try {
    const options = { lazy: true, entry: path.join(root, 'core/server.mjs'), dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', AGENT_HOST_CHROME_USER_DATA: path.join(scratch, 'no-chrome') } };
    host = await startServer(options);
    await host.ready();
    await checkWindow(host, '', scratch, 'fresh');
    client = await open(host);
    const { sessionId } = await client.cmd('newSession', { backend: 'fake', cwd: scratch });
    await client.cmd('setTitle', { sessionId, title: 'Release startup fixture' });
    client.close(); client = null;
    await host.stop(); host = null;
    host = await startServer(options);
    await host.ready();
    await checkWindow(host, sessionId, scratch, 'existing');
    passed = true;
  } finally {
    client?.close();
    await host?.stop();
    if (passed) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else console.error(`Smoke diagnostics retained in ${scratch}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory = 'dist-desktop'] = process.argv.slice(2);
  const roots = directory === '--source' ? [ROOT] : await packagedRoots(path.resolve(directory));
  for (const root of roots) await smoke(root);
}
