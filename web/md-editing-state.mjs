// Versioned, optional composer state. Markdown remains the transport format.
// A boundary is a serialization separator, never an editable or hidden DOM row.
const KINDS = new Set(['p', 'h', 'ul', 'ol', 'quote', 'cont', 'code', 'att']);
const boundary = /^(?:[ \t]*>[ \t]?)*[ \t]*$/;
// Consume only container syntax, never ordinary text. A code row owns only its
// outer containers; fence characters and language names remain visible content.
function validMarker(kind, marker) {
  if (kind === 'p' || kind === 'att') return marker === '';
  let rest = marker, last = null;
  while (rest) {
    const spaces = /^[ \t]+/.exec(rest);
    if (spaces) { rest = rest.slice(spaces[0].length); if (!rest) return kind === 'code' || kind === 'cont'; }
    const token = /^(>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/.exec(rest);
    if (!token) break;
    last = token[0] === '>' ? 'quote' : /^\d/.test(token[0]) ? 'ol' : 'ul';
    rest = rest.slice(token[0].length);
    // Padding after a marker is owned by that marker, not a continuation.
    rest = rest.replace(last === 'quote' ? /^[ \t]/ : /^[ \t]+/, '');
  }
  if (kind === 'h') return /^#{1,6}[ \t]+$/.test(rest);
  if (rest) return false;
  if (kind === 'code') return true;
  return kind === last;
}

export function textHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Reject stale, partial, oversized or malformed sidecars; never repair their text. */
export function normalizeEditingState(text, state) {
  if (typeof text !== 'string' || text.length > 2_000_000 || !state || state.v !== 1 || state.length !== text.length || state.hash !== textHash(text)
    || !Array.isArray(state.rows) || !state.rows.length || state.rows.length > text.length + 1) return null;
  const rows = [];
  let at = 0;
  for (const row of state.rows) {
    if (!row || !Number.isInteger(row.at) || !KINDS.has(row.kind) || typeof row.marker !== 'string') return null;
    const before = row.before;
    if (before !== undefined) {
      if (!rows.length || typeof before !== 'string' || !boundary.test(before) || before.length > text.length || text.slice(at, at + before.length + 1) !== before + '\n') return null;
      at += before.length + 1;
    }
    if (row.at !== at || at > text.length) return null;
    const end = text.indexOf('\n', at), raw = text.slice(at, end < 0 ? text.length : end);
    if (!raw.startsWith(row.marker) || !validMarker(row.kind, row.marker)) return null;
    rows.push({ at, kind: row.kind, marker: row.marker, ...(before !== undefined ? { before } : {}) });
    at = (end < 0 ? text.length : end) + 1;
  }
  if (at !== text.length + 1) return null;
  return { v: 1, length: text.length, hash: state.hash, rows };
}

export function editingState(text, rows) {
  return normalizeEditingState(text, { v: 1, length: text.length, hash: textHash(text), rows });
}
