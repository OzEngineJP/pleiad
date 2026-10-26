import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSqlite } from '../db.mjs';

export function devinSessionsDb(dataDir = os.homedir(), env = process.env) {
  const dir = String(env?.DEVIN_SESSIONS_DIR ?? '').trim();
  if (dir) {
    const direct = path.join(dir, 'sessions.db');
    if (fs.existsSync(direct)) return direct;
    return path.join(dir, 'cli', 'sessions.db');
  }
  return path.join(dataDir, 'devin', 'sessions', 'cli', 'sessions.db');
}

function openDb(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const { DatabaseSync } = loadSqlite();
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function parseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeInput(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = parseJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return raw.trim() ? { command: raw } : {};
  }
  return {};
}

export function listDevinSubagents({ dataDir, sessionId, dbFile, env } = {}) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return [];
  const db = openDb(dbFile || devinSessionsDb(dataDir, env));
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT agent_id FROM subagent_heads WHERE session_id = ? ORDER BY updated_at DESC, rowid DESC')
      .all(sid);
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const id = String(row?.agent_id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

function walkChain(db, sessionId, headNodeId) {
  const stmt = db.prepare(
    'SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? AND node_id = ?',
  );
  const nodes = [];
  const visited = new Set();
  let cur = String(headNodeId ?? '').trim();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const row = stmt.get(sessionId, cur);
    if (!row) break;
    nodes.push(row);
    cur = String(row.parent_node_id ?? '').trim();
  }
  nodes.reverse();
  return nodes;
}

export function getDevinSubagentMessages({ dataDir, sessionId, agentId, limit, dbFile, env } = {}) {
  const sid = String(sessionId ?? '').trim();
  const aid = String(agentId ?? '').trim();
  if (!sid || !aid) return [];
  const db = openDb(dbFile || devinSessionsDb(dataDir, env));
  if (!db) return [];
  try {
    const head = db
      .prepare('SELECT chain_node_id FROM subagent_heads WHERE session_id = ? AND agent_id = ?')
      .get(sid, aid);
    if (!head?.chain_node_id) return [];
    const nodes = walkChain(db, sid, head.chain_node_id);

    const toolOutputs = new Map();
    for (const node of nodes) {
      const msg = parseJson(node.chat_message);
      if (msg?.role === 'tool' && msg.tool_call_id) {
        toolOutputs.set(String(msg.tool_call_id), String(msg.content ?? ''));
      }
    }

    const out = [];
    for (const node of nodes) {
      const msg = parseJson(node.chat_message);
      if (!msg || typeof msg !== 'object') continue;
      const nodeId = String(node.node_id ?? '');
      if (msg.role === 'user') {
        const text = String(msg.content ?? '');
        if (!text.trim()) continue;
        out.push({
          uuid: `${sid}:${aid}:user:${nodeId}`,
          role: 'user',
          text,
        });
      } else if (msg.role === 'assistant') {
        const text = String(msg.content ?? '');
        const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const toolCalls = [];
        for (const tc of rawCalls) {
          const id = String(tc?.id ?? '').trim();
          if (!id) continue;
          const fnName = String(tc?.function?.name ?? 'tool');
          const input = normalizeInput(tc?.function?.arguments);
          const result = toolOutputs.get(id) ?? null;
          toolCalls.push({
            id,
            name: fnName,
            input,
            result,
          });
        }
        if (!text.trim() && toolCalls.length === 0) continue;
        out.push({
          uuid: `${sid}:${aid}:assistant:${nodeId}`,
          role: 'assistant',
          text,
          ...(toolCalls.length ? { toolCalls } : {}),
        });
      }
    }
    return Number.isInteger(limit) && limit > 0 ? out.slice(-limit) : out;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

export function getDevinSubagentOrigin({ dataDir, sessionId, agentId, dbFile, env } = {}) {
  const sid = String(sessionId ?? '').trim();
  const aid = String(agentId ?? '').trim();
  if (!sid || !aid) return null;
  const db = openDb(dbFile || devinSessionsDb(dataDir, env));
  if (!db) return null;
  try {
    let nodes = [];
    try {
      const sess = db.prepare('SELECT main_chain_id FROM sessions WHERE id = ?').get(sid);
      if (sess?.main_chain_id != null) nodes = walkChain(db, sid, sess.main_chain_id);
    } catch {}
    if (!nodes.length) nodes = db
      .prepare('SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sid);
    for (const node of nodes) {
      const msg = parseJson(node.chat_message);
      if (msg?.role === 'tool' && msg.tool_call_id) {
        const content = String(msg.content ?? '');
        if (content.includes(`agent_id=${aid}`) || content.includes(aid)) {
          return String(msg.tool_call_id);
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}
