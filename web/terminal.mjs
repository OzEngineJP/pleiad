import { el } from './dom.mjs';

/** Shared terminal surface for tool results and background commands. */
export function terminalView() {
  const box = el('div', 'tc-term');
  box.tabIndex = 0;
  return box;
}

let terminalBatch = 0;
const terminalUpdates = new Map();
const positionOf = box => ({ follow: box.scrollHeight - box.scrollTop - box.clientHeight < 30, position: box.scrollTop });

/** Restore terminal contents without a layout read between every tool result. */
export function batchTerminalUpdates(fn) {
  terminalBatch++;
  try { return fn(); }
  finally {
    if (!--terminalBatch) {
      const updates = [...terminalUpdates].map(([box, options]) => ({ box, options, ...positionOf(box) }));
      terminalUpdates.clear();
      for (const { box, options } of updates) paintTerminal(box, options);
      const positions = updates.map(({ box, follow, position }) => [box, follow ? box.scrollHeight : position]);
      for (const [box, position] of positions) box.scrollTop = position;
    }
  }
}

export function updateTerminal(box, options = {}) {
  if (terminalBatch) { terminalUpdates.set(box, options); return box; }
  const { follow, position } = positionOf(box);
  paintTerminal(box, options);
  box.scrollTop = follow ? box.scrollHeight : position;
  return box;
}

function paintTerminal(box, { command = '', prompt = '$ ', output = '', running = false, exitCode = null, note = '' } = {}) {
  const cmd = el('span', 'tc-term-command');
  cmd.append(el('span', 'prompt', prompt), String(command));
  box.replaceChildren(cmd);
  if (output) box.append('\n' + String(output));
  if (note) box.append(el('span', 'prompt', '\n' + note));
  if (running) box.append('\n', el('span', 'tc-term-cursor'));
  else if (exitCode != null) box.append(el('span', 'prompt', `\nexit ${exitCode}`));
}
