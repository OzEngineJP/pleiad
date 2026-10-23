import { el } from './dom.mjs';

/** Shared terminal surface for tool results and background commands. */
export function terminalView() {
  const box = el('div', 'tc-term');
  box.tabIndex = 0;
  return box;
}

export function updateTerminal(box, { command = '', prompt = '$ ', output = '', running = false, exitCode = null, note = '' } = {}) {
  const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const position = box.scrollTop;
  const cmd = el('span', 'tc-term-command');
  cmd.append(el('span', 'prompt', prompt), String(command));
  box.replaceChildren(cmd);
  if (output) box.append('\n' + String(output));
  if (note) box.append(el('span', 'prompt', '\n' + note));
  if (running) box.append('\n', el('span', 'tc-term-cursor'));
  else if (exitCode != null) box.append(el('span', 'prompt', `\nexit ${exitCode}`));
  if (follow) box.scrollTop = box.scrollHeight;
  else box.scrollTop = position;
  return box;
}
