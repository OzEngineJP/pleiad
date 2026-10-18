function insertByTime(entries, entry) {
  const before = entries.findIndex(other => (Number(other.at) || 0) > (Number(entry.at) || 0));
  entries.splice(before < 0 ? entries.length : before, 0, entry);
}

// Native boundaries are the history source. Sidecar records add details and cover missing boundaries.
export function mergeCompactionHistory(nativeEntries = [], savedEntries = []) {
  const unused = new Set(savedEntries);
  const near = (a, b) => Number.isFinite(a.at) && Number.isFinite(b.at)
    && Math.abs(a.at - b.at) <= 2 * 60_000;
  const score = (native, saved) => {
    if (saved.phase !== 'complete') return -1;
    if (native.nativeId && saved.nativeId && native.nativeId !== saved.nativeId) return -1;
    if (native.nativeId && saved.nativeId === native.nativeId) return 3;
    if (native.turnId && saved.turnId) return native.turnId === saved.turnId ? 2 : -1;
    return near(native, saved) ? 1 : -1;
  };
  const merged = nativeEntries.map(native => {
    let match = null, best = -1, distance = Infinity;
    for (const saved of unused) {
      const candidate = score(native, saved);
      const candidateDistance = native.atEstimated && candidate === 2
        ? Number(saved.at) || 0 : Math.abs(Number(native.at) - Number(saved.at)) || 0;
      if (candidate > best || (candidate === best && candidate >= 0 && candidateDistance < distance)) {
        best = candidate; distance = candidateDistance; match = saved;
      }
    }
    if (!match || best < 0) return native;
    unused.delete(match);
    // An observed event time is more precise than a boundary dated from its enclosing turn.
    const completeTurn = best !== 2 || nativeEntries.filter(x => x.turnId === native.turnId).length
      === savedEntries.filter(x => x.turnId === native.turnId && x.phase === 'complete').length;
    const observed = native.atEstimated && Number.isFinite(match.at) && completeTurn;
    return { ...native, ...match, id: native.id, nativeId: native.nativeId,
      at: observed ? match.at : native.at, phase: native.phase, ...(native.atEstimated ? { atEstimated: !observed } : {}) };
  });
  // Keep native item order when only some boundaries have an observed time.
  for (const saved of [...unused].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))) {
    insertByTime(merged, saved);
  }
  return merged;
}

/**
 * 圧縮の要約の発言（core/system-messages.mjs の kind: 'compactSummary'）を区切りに入れる（ADR 0053）。
 * 区切りの uuid が分かれば（transcript の印）それに、分からなければ区切りの直後（前後 2 分）の要約とみなす。
 * 合う区切りが無い（CLI の自動圧縮を保存分で読んだなど）ときは、要約から自動の区切りを作る。
 * 区切りが既に要約を持っていれば（Pleiad の PostCompact で受け取った分）、そちらを残す。
 */
export function attachCompactSummaries(summaries = [], compactions = []) {
  const list = compactions.map(entry => ({ ...entry }));
  const claimed = new Set();
  for (const m of summaries) {
    if (m?.kind !== 'compactSummary' || !m.summary) continue;
    const at = Date.parse(m.at ?? '');
    let target = m.boundary ? list.find(entry => entry.nativeId === m.boundary) : null;
    if (!target && Number.isFinite(at)) {
      target = list.filter(entry => entry.phase === 'complete' && !claimed.has(entry) && Number.isFinite(entry.at)
        && Math.abs(at - entry.at) <= 2 * 60_000)
        .sort((a, b) => Math.abs(at - a.at) - Math.abs(at - b.at))[0] ?? null;
    }
    if (target) { claimed.add(target); target.summary ??= m.summary; continue; }
    const entry = { id: `summary:${m.uuid ?? at}`, phase: 'complete', trigger: 'auto', at: Number.isFinite(at) ? at : 0, summary: m.summary };
    claimed.add(entry);
    insertByTime(list, entry);
  }
  return list;
}
