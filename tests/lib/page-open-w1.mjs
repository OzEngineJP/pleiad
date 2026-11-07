/** Test-only pageOpen provider. Replace this injection with W2's command handler. */
export function pageOpenFixture(origin) {
  return async ({ sessionId, kind, path, vizHash, entry }) => ({
    url: `${origin}/fixture-page?${new URLSearchParams({ sessionId, kind, path:path ?? '', vizHash:vizHash ?? '', entry:entry ?? '' })}`,
    title: path?.split(/[\\/]/).at(-1) ?? '月ごとの売上', path, kind, origin,
  });
}
