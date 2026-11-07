import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectFile, previewFailure } from './file-preview.mjs';

const blocked = code => ({ kind: 'blocked', code });
const network = value => /^[\\/]{2}/.test(value);

/**
 * Resolve explicit path notation before considering URLs or search (ADR 0294 §2).
 * Bare words remain search terms: ./ or .\ makes a relative
 * path unambiguous without sending a failed path lookup to a search provider.
 * This is lexical classification only; use resolveAddressInput before opening.
 */
export function classifyAddressInput(input, { cwd, home = os.homedir(), platform = process.platform } = {}) {
  if (typeof input !== 'string' || !input.trim()) return blocked('empty-input');
  let value = input.trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) return blocked('invalid-input');
  const win = platform === 'win32', paths = win ? path.win32 : path.posix;
  const fileUrl = /^file:/i.test(value);
  if (fileUrl) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return blocked('network-path');
      // Decode on the host whose path syntax is being classified, including tests.
      value = fileURLToPath(url, { windows: win });
    } catch { return blocked('invalid-path'); }
  }
  if (network(value)) return blocked('network-path');
  const drive = /^[a-z]:/i.test(value);
  const explicit = fileUrl || drive || /^[\\/]/.test(value) || /^~[\\/]/.test(value) || /^\.{1,2}(?:[\\/]|$)/.test(value);
  if (explicit) {
    if ((win && value.startsWith('/')) || (!win && (drive || value.includes('\\')))) return blocked('different-host');
    if (drive && !/^[a-z]:[\\/]/i.test(value)) return blocked('invalid-path');
    if (win && /^\\(?!\\)/.test(value)) return blocked('invalid-path');
    if (/^~[\\/]/.test(value)) {
      if (!home || !paths.isAbsolute(home) || network(home)) return blocked('invalid-path');
      value = paths.join(home, value.slice(2));
    }
    if (!paths.isAbsolute(value) && (!cwd || !paths.isAbsolute(cwd) || network(cwd))) return blocked('cwd-unknown');
    return { kind: 'path', path: paths.resolve(cwd || paths.parse(value).root, value) };
  }
  if (value.includes('\\')) return blocked('invalid-path');
  let candidate = value;
  // Hostnames, IP addresses and localhost with a port are URLs. A slash in an
  // otherwise bare phrase does not silently turn it into a relative file path.
  if (!/\s/.test(value) && /^(?:localhost(?::\d+)?|\[[0-9a-f:]+\](?::\d+)?|[^/:]+\.[^/:]+(?::\d+)?)(?:[/?#]|$)/i.test(value)) candidate = `http${/^localhost(?::|[/?#]|$)|^127\.|^\[::1\]/i.test(value) ? '' : 's'}://${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.href === 'about:blank') return { kind: 'url', url: url.href };
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return blocked('invalid-url');
      return { kind: 'url', url: url.href };
    } catch { return blocked('invalid-url'); }
  }
  // Ambiguous slash notation is rejected rather than sent to search.
  if (/[\\/]/.test(value)) return blocked('invalid-path');
  return { kind: 'search', query: value };
}

/** Apply the same realpath, data directory, upload and review policy as previews. */
export async function resolveAddressInput(input, { access, ...options } = {}) {
  const result = classifyAddressInput(input, options);
  if (result.kind !== 'path') return result;
  if (!access?.dataDir) return blocked('access-unavailable');
  try {
    const { file, stat } = await inspectFile(result.path, access);
    return { kind: 'path', path: file, page: stat.isDirectory() ? 'dir' : 'file' };
  } catch (error) { return blocked(previewFailure(error).code); }
}
