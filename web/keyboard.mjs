// IME owns navigation and confirmation keys during composition.
// Some browsers report the final composition key only as keyCode 229.
export const isComposingKey = event => event.isComposing || event.keyCode === 229;

// Node (tests) is never treated as macOS: Node on macOS reports navigator.platform as MacIntel.
export const isMac = () => !globalThis.process?.versions?.node && /Mac/.test(globalThis.navigator?.platform ?? '');

// Ctrl/⌘ shortcuts are handled as ⌘ on macOS, so show them that way (same form as ⌘⇧B / ⌘⇧F; Enter is written ↩).
// The key handlers themselves are unchanged; this only builds the text shown in titles and placeholders.
export const shortcutLabel = (key, { shift = false } = {}, mac = isMac()) =>
  mac ? `⌘${shift ? '⇧' : ''}${key === 'Enter' ? '↩' : key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
/** Value for aria-keyshortcuts */
export const shortcutAria = (key, { shift = false } = {}, mac = isMac()) =>
  `${mac ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`;
/** Reads a data-shortcut value ("Enter", "shift+Enter", "B") */
export function parseShortcut(spec) {
  const parts = String(spec).split('+');
  return { key: parts.at(-1), shift: parts.slice(0, -1).includes('shift') };
}
