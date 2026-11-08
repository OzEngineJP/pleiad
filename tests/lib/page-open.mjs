/** Test-only pageOpen provider mirroring core/browser-unify-ws.mjs's contract:
 *  regular pages { kind, path?, suffix, url }, HTML files { kind:'html', path, key, url },
 *  visualizations { kind:'viz', hash, entry, url }. */
export function pageOpenFixture(origin) {
  return async ({ sessionId, kind, path, hash, entry, tab }) => {
    const owner = `screen:${sessionId}/page:${tab ?? ''}`;
    const params = new URLSearchParams({ sessionId, kind, path:path ?? '', hash:hash ?? '', entry:entry ?? '', watchOwner:owner });
    const url = kind === 'file' && path?.endsWith('/actual.md')
      ? `${origin}/_pleiad/s/${encodeURIComponent(sessionId)}/file?${new URLSearchParams({ path, watchOwner:owner })}`
      : `${origin}/fixture-page?${params}`;
    return {
      url,
      kind, path, hash, entry,
      key: kind === 'html' ? 'fixture-key' : undefined,
      suffix: kind === 'dir' ? '/' : '',
      title: path?.split(/[\\/]/).at(-1) ?? '月ごとの売上',
    };
  };
}
