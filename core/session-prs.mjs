// 会話が作った PR の覚え書き（git パネルの頭に出す PR の元。docs/git-panel-pr.md、ADR 0206）。
// 純関数だけ。会話ごとに { number, url, at } の列を session の prs に残し（上限 PRS_KEEP）、親の会話は
// 委譲した子孫の会話の列を読んで自分の分と 1 つの一覧にする。履歴から拾い直すのは自分の会話の分だけ（子の昔の PR は戻さない）。

export const PRS_KEEP = 30;

const PR_PATH = /^\/(?<repo>[^/]+\/[^/]+)\/pull\/(?<number>\d+)(?:[/?#].*)?$/;

/** PR の URL から { host, repo: 'owner/name', number } を取り出す（GitHub の形でなければ null） */
export function parsePrUrl(url) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = PR_PATH.exec(u.pathname);
  return m ? { host: u.host, repo: m.groups.repo, number: Number(m.groups.number) } : null;
}

/** 同じ PR か（URL の host・repo・番号が同じ。末尾の /files などは無視） */
export const prKey = (url) => { const p = parsePrUrl(url); return p ? `${p.host.toLowerCase()}/${p.repo.toLowerCase()}#${p.number}` : String(url ?? ''); };

/**
 * 会話の覚え書きに、拾った PR（{ number, url }）を足す。同じ PR は 1 件のまま（at は初めて見た時刻）。
 * 変わらなければ null（書かない）。上限を超えたら古いものから捨てる。
 */
export function mergePrs(list, found, at = new Date().toISOString()) {
  const kept = Array.isArray(list) ? list.filter((p) => p && typeof p.url === 'string') : [];
  const seen = new Set(kept.map((p) => prKey(p.url)));
  const added = [];
  for (const e of Array.isArray(found) ? found : []) {
    if (!e || typeof e.url !== 'string' || !Number.isInteger(e.number)) continue;
    const key = prKey(e.url);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ number: e.number, url: e.url, at });
  }
  return added.length ? [...kept, ...added].slice(-PRS_KEEP) : null;
}

/**
 * 親の会話が出す PR の一覧。own: この会話の分（覚え書き＋履歴から拾った分。{ number, url, at? }）、
 * children: 子孫の会話の覚え書き（[{ prs }]）。同じ PR は 1 件にし、子でも作られた PR は child: true。
 * 新しい順（at が無いものは最後）。
 */
export function unionPrs(own, children) {
  const out = new Map();
  const add = (p, child) => {
    if (!p || typeof p.url !== 'string' || !Number.isInteger(p.number)) return;
    const key = prKey(p.url);
    const old = out.get(key);
    if (old) { old.child = old.child && child; if (!old.at && p.at) old.at = p.at; return; }
    out.set(key, { number: p.number, url: p.url, at: p.at ?? null, child });
  };
  for (const p of own ?? []) add(p, false);
  for (const c of children ?? []) for (const p of c?.prs ?? []) add(p, true);
  return [...out.values()].sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
}
