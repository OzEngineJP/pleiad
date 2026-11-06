import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q={searchTerms}';
const MAX_PREFERENCES_BYTES = 16 * 1024 * 1024;

function expand(template, query) {
  return template.replaceAll('{searchTerms}', encodeURIComponent(query))
    .replaceAll('{google:baseURL}', 'https://www.google.com/')
    .replaceAll('{inputEncoding}', 'UTF-8').replaceAll('{outputEncoding}', 'UTF-8')
    .replace(/\{[^{}]+\?\}/g, '');
}

function validTemplate(template) {
  if (typeof template !== 'string' || template.length > 8192 || !template.includes('{searchTerms}')) return false;
  try {
    const expanded = expand(template, 'pleiad');
    if (/[{}\u0000-\u0020]/.test(expanded)) return false;
    const url = new URL(expanded);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** Read only the default search URL, never account or browsing data. */
export function parseSearchProvider(text) {
  try {
    const value = JSON.parse(text)?.default_search_provider_data;
    const template = value?.template_url_data?.url ?? value?.url;
    return validTemplate(template) ? template : DEFAULT_SEARCH_URL;
  } catch { return DEFAULT_SEARCH_URL; }
}

/** profileDir is the selected profile's directory, not its User Data parent. */
export async function readSearchProvider(profileDir) {
  if (!profileDir) return DEFAULT_SEARCH_URL;
  let handle;
  try {
    handle = await fs.open(path.join(profileDir, 'Preferences'), 'r');
    if ((await handle.stat()).size > MAX_PREFERENCES_BYTES) return DEFAULT_SEARCH_URL;
    const bytes = Buffer.alloc(MAX_PREFERENCES_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_PREFERENCES_BYTES) return DEFAULT_SEARCH_URL;
    return parseSearchProvider(bytes.subarray(0, bytesRead).toString('utf8'));
  } catch { return DEFAULT_SEARCH_URL; }
  finally { await handle?.close().catch(() => {}); }
}

export function searchUrl(query, template = DEFAULT_SEARCH_URL) {
  return expand(validTemplate(template) ? template : DEFAULT_SEARCH_URL, String(query));
}
