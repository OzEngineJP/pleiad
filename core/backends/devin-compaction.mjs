// Devin CLI の圧縮の区切りを、会話の DB（DEVIN_SESSIONS_DIR/cli/sessions.db の message_nodes）から読む。
// 圧縮が適用されると、生きている鎖（sessions.main_chain_id から辿れる列）に、継続用の system ノードが入る:
//   「You are continuing work from a previous conversation thread. … <summary>…</summary>」
//   （metadata の summarized_from は要約が覆った最後のノード）
// あとから送ったリクエストの鎖にも同じ文が写るが、複製は metadata.extensions['compact/prior_node_ids'] が
// 元のノードを指すので、元のノードだけを数える。要約を作る側の小さな鎖（"You are a Summarizer" 系）は
// system でも summarized_from を持たないので当たらない。
import fs from 'node:fs';
import path from 'node:path';
import { loadSqlite } from '../db.mjs';

export const devinSessionsDb = (dataDir) => path.join(dataDir, 'devin', 'sessions', 'cli', 'sessions.db');
const CONTINUATION = 'continuing work from a previous conversation';
const PRIOR_IDS = 'compact/prior_node_ids';
const MAX_CHAIN = 200_000;

const parseJson = (raw) => { try { const v = JSON.parse(raw ?? 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const contentOf = (msg) => {
  const c = msg?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '';
};
// ACP の再生が発言にする行（mapper の row と同じ並べ方）: user→user、assistant・tool→assistant、system は出ない
const visibleRole = (role) => (role === 'user' ? 'user' : (role === 'assistant' || role === 'tool') ? 'assistant' : null);

/** 「Full conversation history saved at …\nSummary:\n<summary>…</summary>」形の文字列から要約の本文だけを取る */
export function extractDevinSummary(text) {
  if (typeof text !== 'string') return null;
  const m = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * _cognition.ai/compaction 通知（ext_notification）→ 区切りの出来事。
 * 実測: { status: 'started' | 'completed' | 'failed', sessionId, summary? }（CLI 3000.11.92）。
 * 知らない status には null を返す。
 */
export function devinCompactionFromNotification(params) {
  const status = String(params?.status ?? '');
  if (!['started', 'completed', 'failed'].includes(status)) return null;
  return {
    status,
    ...(typeof params?.summary === 'string' ? { summary: extractDevinSummary(params.summary) ?? params.summary } : {}),
    ...(params?.error || params?.reason || params?.message ? { reason: String(params.error ?? params.reason ?? params.message) } : {}),
  };
}

/**
 * 会話の圧縮の区切りを DB から読む（getCompactions の中身）。
 * 区切りの形は core/compaction-history.mjs の native 行: { id, nativeId, phase:'complete', trigger:'auto', at, summary?,
 *   beforeMessageId?, afterMessageId? }。手動・自動の見分けはノードに無いので auto に倒す
 *   （Pleiad が起こした手動圧縮は保存済みの区切りと時刻で突き合わされ、そちらの trigger が残る）。
 * 位置（before/afterMessageId）は、区切りが今の main chain に残っているときだけ、mapper と同じ行の並べ方で作る。
 * DB が無い・読めない・会話が無いときは []。
 */
export function devinCompactionsFromDb({ dataDir, sessionId, dbFile = devinSessionsDb(dataDir), open = file => new (loadSqlite().DatabaseSync)(file, { readOnly: true }) } = {}) {
  if (!fs.existsSync(dbFile)) return [];
  let db = null;
  try {
    db = open(dbFile);
    // 継続ノードの候補を SQL 側で絞る。区切りの無い会話は、履歴の全行を読んで JSON.parse せずにここで終わる
    // （compact() の実効の確認は最大 120 秒、1 秒ごとにこれを呼ぶ）。
    // LIKE は文字の大小を区別せず鍵でない場所の同じ文字列にも当たるので広めに取り、正確な条件は JS で確かめる
    const candidates = new Map();
    for (const row of db.prepare('select node_id, parent_node_id, chat_message, metadata, created_at from message_nodes where session_id = ? and metadata like ? and chat_message like ? order by node_id')
        .all(sessionId, '%summarized_from%', `%${CONTINUATION}%`)) {
      candidates.set(row.node_id, { pid: row.parent_node_id, msg: parseJson(row.chat_message), meta: parseJson(row.metadata), at: Number(row.created_at) });
    }
    if (!candidates.size) return [];
    // 区切りの位置（直前・直後の発言の uuid）を作るための鎖は、軽い列だけ読む。
    // 行の role は本文（JSON）から SQL の JSON 関数で取り、全文は parse しない（継続ノードだけ parse 済み）
    const nodes = new Map();
    for (const row of db.prepare("select node_id, parent_node_id, case when json_valid(chat_message) then json_extract(chat_message, '$.role') end as role from message_nodes where session_id = ?").all(sessionId)) {
      nodes.set(row.node_id, { pid: row.parent_node_id, role: typeof row.role === 'string' ? row.role : null });
    }
    const head = db.prepare('select main_chain_id from sessions where id = ?').get(sessionId)?.main_chain_id;
    return compactionEntries(nodes, head, sessionId, candidates);
  } catch { return []; }
  finally { try { db?.close(); } catch {} }
}

function compactionEntries(nodes, head, sessionId, candidates) {
  const chain = [];
  for (let n = head, guard = 0; n != null && nodes.has(n) && guard++ < MAX_CHAIN; n = nodes.get(n).pid) chain.push(n);
  chain.reverse();
  const onMain = new Map(chain.map((n, i) => [n, i]));

  // 継続ノード → 区切り。複製（prior_node_ids 付き）は元のノードへ寄せる
  const byOrigin = new Map();
  for (const [nid, node] of candidates) {
    const content = contentOf(node.msg);
    if (node.msg?.role !== 'system' || node.meta?.summarized_from == null || !content.includes(CONTINUATION) || !content.includes('<summary>')) continue;
    const priors = node.meta.extensions?.[PRIOR_IDS];
    const origin = Array.isArray(priors) && priors.length ? priors[0] : nid;
    const copy = Array.isArray(priors) && priors.length;
    const existing = byOrigin.get(origin);
    if (!existing || (existing.copy && !copy)) byOrigin.set(origin, { nid, node, copy });
  }

  const entries = [];
  for (const { nid, node } of byOrigin.values()) {
    const entry = { id: `native:node-${nid}`, nativeId: `node-${nid}`, phase: 'complete', trigger: 'auto', at: Number.isFinite(node.at) ? node.at * 1000 : 0 };
    const summary = extractDevinSummary(contentOf(node.msg));
    if (summary) entry.summary = summary;
    if (onMain.has(nid)) {
      // mapper の発言と同じ並べ方で、直前・直後の行の位置の uuid を作る（devin-normalize.mjs の positional uuid）
      let idx = -1, lastRole = null, i = 0;
      for (; i < onMain.get(nid); i++) {
        const role = visibleRole(nodes.get(chain[i]).role);
        if (role && role !== lastRole) { idx++; lastRole = role; }
      }
      if (lastRole) entry.afterMessageId = `${sessionId}:${lastRole}:${idx}`;
      for (; i < chain.length; i++) {
        const role = visibleRole(nodes.get(chain[i]).role);
        if (!role) continue;
        entry.beforeMessageId = `${sessionId}:${role}:${role === lastRole ? idx : idx + 1}`;
        break;
      }
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.at - b.at);
  return entries;
}
