// Hidden Chromium window: execute the actual packaged client, not a DOM mock.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
if (!app) throw new Error('Unset ELECTRON_RUN_AS_NODE');
app.setPath('userData', path.join(process.env.PLEIAD_SMOKE_PROFILE, 'chromium'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const errors = [];
let win;
let finished = false;
let stage = 'Electron ready';
const timer = setTimeout(() => finish(1, 'UI startup timed out'), 45000);
function finish(code, detail) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log(JSON.stringify({ ok: code === 0, detail, stage, errors }));
  if (code && win && process.env.PLEIAD_SMOKE_SHOT) {
    win.capturePage().then(image => fs.writeFileSync(process.env.PLEIAD_SMOKE_SHOT, image.toPNG())).catch(() => {}).finally(() => app.exit(code));
  } else app.exit(code);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const wc = win.webContents;
  await win.loadURL('about:blank');
  wc.on('did-fail-load', (_event, code, description) => errors.push(`Load failed ${code}: ${description}`));
  wc.on('render-process-gone', (_event, details) => finish(1, `Renderer exited: ${details.reason}`));
  stage = 'Attach debugger';
  wc.debugger.attach('1.3');
  wc.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
  });
  stage = 'Enable runtime';
  await wc.debugger.sendCommand('Runtime.enable');
  stage = 'Load packaged UI';
  await win.loadURL(process.env.PLEIAD_SMOKE_URL);
  stage = 'Wait for session list and composer';
  const fixture = process.env.PLEIAD_SMOKE_SESSION || '';
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (errors.length) throw new Error('Unhandled JavaScript exception');
    const ready = await wc.executeJavaScript(`(() => {
      const visible = e => Boolean(e && e.getBoundingClientRect().width && e.getBoundingClientRect().height);
      const p = document.querySelector('#prompt'), box = document.querySelector('#cbox');
      const rows = [...document.querySelectorAll('.row[data-session]')];
      return visible(p) && !p.disabled && !p.readOnly && !box?.hasAttribute('aria-busy') && rows.length > 0
        && (!${JSON.stringify(fixture)} || rows.some(r => r.dataset.session === ${JSON.stringify(fixture)}));
    })()`);
    if (ready) {
      // Let deferred startup work and rejected promises run before accepting.
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (errors.length) throw new Error('Unhandled JavaScript exception');
      return finish(0, fixture ? 'Persisted session and composer rendered' : 'Fresh session list and composer rendered');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Session list or usable composer did not render');
}).catch(error => finish(1, error.message));
