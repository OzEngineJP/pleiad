// 前の版（Claude Agent SDK を同梱していた版）から Claude を使っていた人を見分ける（ADR 0206「前から使っていた人」）。
// そういう人は、取得への同意を済ませたものとみなし、案内を出さずに SDK を取る（更新の前後で Claude の会話が途切れないように）。
//
// 根拠にする形跡は、データ置き場に既にあるもので、前の版で Claude を動かした人にしか残らないものを選ぶ。
//   usage         使用量の記録（pleiad.db の usage_records）に、Claude のバックエンドの記録がある（SDK で 1 ターン終えた）
//   conversation  会話の記録（sessions・session_fields）に、Claude の会話があり、まだ送っていない下書き（unsent）ではない
//   account       Claude のアカウントの登録（claude-accounts.json）がある（Claude のバックエンドで使うトークンを登録した）
// Claude の下書きを作っただけ・設定を開いただけ・CLI（claude）を別に使っているだけ、は形跡にしない。
//
// 判断は **一度だけ** して、結果を残す。形跡のうち会話の行とアカウントは、この版でも SDK を取る前に残りうる
// （送信が SDK の無い失敗で戻っても、会話の行は「送った」側に変わる）。毎回見直すと、新しく入れた人が案内を見ずに
// 「前から使っていた人」に変わってしまう。
//   みなす     consent.json に acceptedAt と reason: 'existing-claude-user'（と根拠）を書く。以後は普通の同意と同じ
//   みなさない legacy-check.json に印を書く。以後は見直さない（同意は設定の「取得する」だけ）
//   決められない  DB が読めない・JSON の形式の会話の記録が残っている、など。何も書かず、次に呼ばれたときにもう一度見る
// 呼ぶのは、サーバーの起動（startClaudeSdkMaintenance）・切り替えの前の先取り・会話を始めるとき・状態を出すとき（core/claude-sdk.mjs）。
// 新しく入れた人は、最初の起動で見て「みなさない」を残す（まだ何も使っていないので）。
import fs from 'node:fs';
import path from 'node:path';
import { openRaw, dbPath } from './db.mjs';

export const LEGACY_CHECK_FILE = 'legacy-check.json';
/** consent.json の reason */
export const LEGACY_CONSENT_REASON = 'existing-claude-user';

const hasRow = (db, sql, ...args) => Boolean(db.prepare(sql).get(...args));

/** pleiad.db の形跡。見つかれば 'usage' か 'conversation'、無ければ null。読めなければ投げる */
function databaseEvidence(file) {
  const db = openRaw(file, { readOnly: true });
  try {
    if (hasRow(db, "SELECT 1 FROM usage_records WHERE backend = 'claude' LIMIT 1")) return 'usage';
    if (hasRow(db, `SELECT 1 FROM session_fields f WHERE f.field = 'backend' AND f.value = '"claude"'
      AND NOT EXISTS (SELECT 1 FROM session_fields u WHERE u.session_id = f.session_id AND u.field = 'unsent' AND u.value = 'true') LIMIT 1`)) return 'conversation';
    return null;
  } finally { try { db.close(); } catch { /* 閉じるだけ */ } }
}

/** claude-accounts.json に登録がある（無い・読めない・形が違うは、無いのと同じ） */
function hasAccounts(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-accounts.json'), 'utf8'));
    return Array.isArray(raw?.accounts) && raw.accounts.some((a) => typeof a?.id === 'string' && a.id);
  } catch { return false; }
}

/**
 * dataDir（データ置き場）に、前から Claude を使っていた形跡があるか。
 * { found: true, evidence } か { found: false }（形跡が無いと言い切れる）か { found: null }（決められない）
 */
export function findClaudeUsage(dataDir) {
  const file = dbPath(dataDir);
  if (fs.existsSync(file)) {
    let evidence;
    try { evidence = databaseEvidence(file); } catch { return hasAccounts(dataDir) ? { found: true, evidence: 'account' } : { found: null }; }
    if (evidence) return { found: true, evidence };
    return hasAccounts(dataDir) ? { found: true, evidence: 'account' } : { found: false };
  }
  if (hasAccounts(dataDir)) return { found: true, evidence: 'account' };
  // DB が無いのに、形式 1（JSON）の会話の記録が残っている置き場は、移行の前。ここでは見ない
  return fs.existsSync(path.join(dataDir, 'sessions.json')) ? { found: null } : { found: false };
}

/** 判断を済ませたか（みなさない、の印がある） */
export const legacyChecked = (root) => fs.existsSync(path.join(root, LEGACY_CHECK_FILE));

/**
 * 同意が無いときの判断。みなして同意を書いたら true。みなさない・決められない・書けないは false。
 * writeConsent(reason, evidence) は core/claude-sdk.mjs の同意の書き込み
 */
export function settleLegacyConsent({ dataDir, root, writeConsent }) {
  if (legacyChecked(root)) return false;
  let result;
  try { result = findClaudeUsage(dataDir); } catch { return false; }
  try {
    if (result.found === true) { writeConsent(LEGACY_CONSENT_REASON, result.evidence); return true; }
    if (result.found === false) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, LEGACY_CHECK_FILE), JSON.stringify({ checkedAt: new Date().toISOString(), existingClaudeUser: false }));
    }
  } catch { /* 書けなければ、次に呼ばれたときにもう一度 */ }
  return false;
}
