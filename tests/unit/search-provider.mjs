import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SEARCH_URL, parseSearchProvider, readSearchProvider, searchUrl } from '../../core/chrome/search-provider.mjs';

export const name = 'search-provider';
export const title = 'Chrome default search provider and fallback';
export default async function(t) {
  const template = 'https://search.example/?q={searchTerms}&ie={inputEncoding}';
  const prefs = JSON.stringify({ default_search_provider_data: { template_url_data: { url: template } } });
  t.ok('profile template', parseSearchProvider(prefs) === template);
  t.ok('query encoded once', searchUrl('日本語 &/#', template) === `https://search.example/?q=${encodeURIComponent('日本語 &/#')}&ie=UTF-8`);
  for (const value of ['{', '{}', JSON.stringify({ default_search_provider_data: { url: 'javascript:{searchTerms}' } }), JSON.stringify({ default_search_provider_data: { url: 'https://u:p@a/?q={searchTerms}' } }), JSON.stringify({ default_search_provider_data: { url: 'https://a/?q={unknown}{searchTerms}' } })]) {
    t.ok('unreadable or unsafe fallback', parseSearchProvider(value) === DEFAULT_SEARCH_URL);
  }
  t.ok('Google placeholders', searchUrl('a b', '{google:baseURL}search?q={searchTerms}&x={google:foo?}') === 'https://www.google.com/search?q=a%20b&x=');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-search-'));
  try {
    t.ok('missing preferences fallback', await readSearchProvider(dir) === DEFAULT_SEARCH_URL);
    await fs.writeFile(path.join(dir, 'Preferences'), prefs);
    t.ok('selected profile preferences', await readSearchProvider(dir) === template);
    await fs.writeFile(path.join(dir, 'Preferences'), 'broken');
    t.ok('broken preferences fallback', await readSearchProvider(dir) === DEFAULT_SEARCH_URL);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
