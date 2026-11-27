export const RELAY_PROTOCOL = 'pleiad-browser-v1';
export const LOADER_PATH = '/_pleiad-remote/loader';
export const TAB_PARAM = '__pleiad_remote';
export const encode = new TextEncoder();
export const decode = new TextDecoder();
export const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const unbase64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

export function exactOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new TypeError('expected an exact secure origin');
  }
  return value;
}
