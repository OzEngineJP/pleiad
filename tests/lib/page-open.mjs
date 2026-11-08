/** Test-only pageOpen provider mirroring core/browser-unify-ws.mjs's contract:
 *  regular pages { kind, path?, suffix, url }, HTML files { kind:'html', path, key, url },
 *  visualizations { kind:'viz', hash, entry, url }. */
export function pageOpenFixture(origin) {
  return async ({ sessionId, kind, path, hash, entry }) => ({
    url: `${origin}/fixture-page?${new URLSearchParams({ sessionId, kind, path:path ?? '', hash:hash ?? '', entry:entry ?? '' })}`,
    kind, path, hash, entry,
    key: kind === 'html' ? 'fixture-key' : undefined,
    suffix: kind === 'dir' ? '/' : '',
    title: path?.split(/[\\/]/).at(-1) ?? '月ごとの売上',
  });
}
