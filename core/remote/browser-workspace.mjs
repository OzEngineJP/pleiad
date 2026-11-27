import { randomUUID } from 'node:crypto';

export const BROWSER_SCOPE_HEADER = 'x-pleiad-browser-scope';
const pending = new Map();

// The forwarder and the host HTTP server run in the same process. Pass a
// single-use handle over loopback, never a workspace supplied by the client.
export function forwardBrowserScope(scope) {
  const handle = randomUUID();
  pending.set(handle, scope);
  return { handle, release: () => pending.delete(handle) };
}

export function takeBrowserScope(handle) {
  const scope = pending.get(handle);
  pending.delete(handle);
  return scope;
}

export function browserWorkspaceKey(scope) {
  return scope.workspaceKind === 'personal' ? null : scope.tenantId;
}

export function browserPartition(scope) {
  return scope ? JSON.stringify([scope.uid, scope.tenantId]) : null;
}

const WORKSPACE_COMMANDS = new Set(['listSessions', 'newSession', 'backends', 'modes', 'models', 'efforts']);
const CONVERSATION_COMMANDS = new Set([
  'loadSession', 'watchSession', 'presence', 'sendMessage', 'listMessages', 'saveDraft',
  'setTurnSettings', 'applyTurnSettingsNow', 'abort', 'resume', 'messageAction', 'attachFile', 'attachStart',
]);

// Browser connections have no generic operation or host-management surface.
export function browserCommandTarget(command, args) {
  if (WORKSPACE_COMMANDS.has(command)) return args?.sourceSessionId ?? args?.sessionId ?? null;
  if (!CONVERSATION_COMMANDS.has(command)) return undefined;
  if (command === 'watchSession' && ![undefined, 'main', 'modal'].includes(args?.slot)) return undefined;
  if (['watchSession', 'loadSession', 'presence'].includes(command) && !args?.sessionId) return null;
  return typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : undefined;
}

export function browserHttpResource(pathname) {
  if (['/present-body', '/tool-input', '/local-file'].includes(pathname)) return 'conversation';
  if (pathname === '/' || pathname === '/index.html' || pathname === '/auth-check' ||
      pathname === '/static-bundle' || /^\/bulk\/[a-f0-9]{32}$/.test(pathname)) return 'application';
  if (/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:m?js|css|json|svg|png|webp|ico|woff2?|bcmap|wasm|ttf|otf)$/.test(pathname)) {
    return 'application';
  }
  return null;
}
