// 版番号の比較と、ノートの範囲の切り出し。画面（web/updates.mjs）と配布の道具（scripts/release-info.mjs）が同じものを使う
// semver の順。文字列の比較だと 0.1.0-beta.74 が 0.1.0 より新しくなるので、先行版は同じ番号の正式な版より前に置く
export function compareVersions(a, b) {
  const [coreA, preA] = a.split('-'), [coreB, preB] = b.split('-');
  const core = coreA.localeCompare(coreB, undefined, { numeric: true });
  if (core || preA === preB) return core;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA.localeCompare(preB, undefined, { numeric: true });
}
/** from < 版 ≤ to の版だけを、新しい順で返す（from が無ければ上限だけ。to が無ければ下限だけ） */
export function versionsBetween(releases, from, to) {
  return releases.filter(r => (!from || compareVersions(r.version, from) > 0) && (!to || compareVersions(r.version, to) <= 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}
