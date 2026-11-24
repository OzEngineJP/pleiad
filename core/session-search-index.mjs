// セッション検索の索引（ADR 0349）。会話の発言を、データ置き場の別ファイル search-index.db に SQLite FTS5 で持つ。
//
// 記録ではなく、会話の履歴から作り直せる写し。開けない・形式番号が違う・引いて壊れていたときは、ファイル（-wal・-shm も）を消して
// 空から作り直す（移行も控えも作らない）。FTS5 は node:sqlite の Node 22.16 以上にある。無いときは投げる（走査へは戻らない）。
//
// 表: conv(id, sig)・msg(id, conv, idx, role, uuid, at, text, tool)・fts（FTS5。content=''・contentless_delete・rowid は msg.id）。
// 語は 2 字ずつ: 字（\p{L}\p{N}\p{M}）の連なりごとに、各字を頭に「その字と次の字」（連なりの最後は 1 字）を空白区切りで入れる。
// 呼ぶ側が畳んだ文字（NFKC・小文字）を渡す。ここは畳まない。引くと候補（本物の一致の上位集合）を返し、確かめは呼ぶ側の照合が行う。
//
// openSearchIndex({ file }) → {
//   sigs                                    … Map<会話 id, sig>（開いたときに読む。write・remove・作り直しで同じ Map を更新する）
//   write(id, sig, msgs, shells)            … 1 会話を 1 つのトランザクションで書く。先頭の同じ発言は残し、最初に違う発言から後ろだけ入れ直す
//   remove(id)
//   candidates(expr) → Map<会話 id, 発言 id[]>
//   messagesOf(conv, ids|null) → 行[]       … 発言（idx 順）。ids が null なら会話の全部
//   outline(id) → { first, count, lastAt }
//   sentRows({ role, first, ids })          … 送信済みの並び（新しい順。first の会話が先）。take を止めればそこまでしか引かない
//   close() }
import fs from 'node:fs';
import path from 'node:path';
import { loadSqlite, transaction } from './db.mjs';
import { assertNotGuarded } from './test-guard.mjs';

export const INDEX_FILE = 'search-index.db';
// PRAGMA user_version に入れる索引の形式番号。表・語の切り方を変えたら上げる（古い索引は消えて作り直される）
export const INDEX_FORMAT = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conv (id TEXT PRIMARY KEY, sig INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS msg (
  id INTEGER PRIMARY KEY,
  conv TEXT NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  uuid TEXT NOT NULL,
  at,
  text TEXT NOT NULL,
  tool TEXT
);
CREATE INDEX IF NOT EXISTS msg_conv ON msg (conv, idx);
CREATE INDEX IF NOT EXISTS msg_sent ON msg (role, at);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(body, tool, content='', contentless_delete=1, tokenize='ascii');
`;

// ------------------------------------------------------------------ 語の切り方（純粋）

const RUN = /[\p{L}\p{N}\p{M}]+/gu;

/** 畳んだ文字を、索引に入れる語（2 字ずつ。空白区切り）にする */
export function bigrams(folded) {
  const out = [];
  for (const [run] of String(folded ?? "").matchAll(RUN)) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) out.push(i + 1 < chars.length ? chars[i] + chars[i + 1] : chars[i]);
  }
  return out.join(" ");
}

/**
 * 語（畳んだ文字）から候補を引く FTS5 の式を作る。字の連なりごとに、1 字は前方一致・2 字以上は 2 字の並びのフレーズにして AND でつなぐ
 * （2 字以上の連なりがあれば 1 字の連なりは使わない。重い前方一致を避けられる）。連なりが無い（記号だけ）語は null（全部の発言が候補）。
 * column は 'body'（本文だけ）か null（ツールの入力も）。
 */
export function termQuery(needle, column = null) {
  const runs = [...new Set(String(needle ?? "").match(RUN) ?? [])].map((run) => Array.from(run));
  if (!runs.length) return null;
  const long = runs.filter((chars) => chars.length > 1);
  return (long.length ? long : runs).map((chars) => {
    const phrase = chars.length === 1 ? `"${chars[0]}"*` : `"${chars.slice(0, -1).map((c, i) => c + chars[i + 1]).join(" ")}"`;
    return column ? `${column} : ${phrase}` : phrase;
  }).join(" AND ");
}

// ------------------------------------------------------------------ 開く・作り直す

const SUFFIXES = ["", "-wal", "-shm"];
const removeFiles = (file) => { for (const suffix of SUFFIXES) fs.rmSync(`${file}${suffix}`, { force: true }); };

/** 壊れているとき（ファイルが壊れた・データベースではない）。引いている途中の SQLITE_CORRUPT・SQLITE_NOTADB */
const isCorrupt = (e) => [11, 26].includes(Number(e?.errcode) & 0xff) || /malformed|not a database|corrupt/i.test(String(e?.message ?? ""));

function init(db, memory) {
  db.exec("PRAGMA busy_timeout = 300");
  if (!memory) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== 0 && version !== INDEX_FORMAT) throw new Error(`search index format ${version}, expected ${INDEX_FORMAT}`);
  transaction(db, () => { db.exec(SCHEMA); db.exec(`PRAGMA user_version = ${INDEX_FORMAT}`); });
}

/** 開く。開けない・形式が違うときは 1 度だけファイルを消して作り直す。FTS5 が無いのは直らないので、消さずに投げる */
function openDb(file) {
  const memory = file === ":memory:";
  if (!memory) assertNotGuarded(path.dirname(file), "open a database in");
  const { DatabaseSync } = loadSqlite();
  for (let attempt = 0; ; attempt++) {
    let db = null;
    try { db = new DatabaseSync(file); init(db, memory); return db; }
    catch (e) {
      try { db?.close(); } catch { /* 閉じられなくてもよい */ }
      if (memory || attempt > 0 || /no such module/i.test(String(e?.message ?? ""))) throw e;
      removeFiles(file);
    }
  }
}

// ------------------------------------------------------------------ 索引

const sameAt = (a, b) => (a ?? null) === (b ?? null);
const sameMsg = (row, m) => row.idx === m.index && row.uuid === m.uuid && row.role === m.role && sameAt(row.at, m.at) && row.text === m.text && (row.tool ?? "") === (m.tool ?? "");
/** SQLite に入れられる形にする（時刻は文字か数。ほかは文字にし、有限でない数は無いことにする） */
const atOf = (at) => (typeof at === "string" ? at : typeof at === "number" && Number.isFinite(at) ? at : at == null ? null : String(at));

export function openSearchIndex({ file = ":memory:" } = {}) {
  let db = openDb(file);
  let statements = new Map();
  const sigs = new Map();

  const stmt = (sql) => { let s = statements.get(sql); if (!s) statements.set(sql, s = db.prepare(sql)); return s; };
  const loadSigs = () => { sigs.clear(); for (const r of stmt("SELECT id, sig FROM conv").iterate()) sigs.set(r.id, r.sig); };
  loadSigs();

  /** 引いて壊れていたら、ファイルを消して空から作り直す（sigs は同じ Map を空にする。呼ぶ側は「まだ入っていない」として読み直す） */
  function guard(fn) {
    try { return fn(); }
    catch (e) {
      if (isCorrupt(e) && file !== ":memory:") {
        try { db.close(); } catch { /* 閉じられなくてもよい */ }
        statements = new Map();
        removeFiles(file);
        db = openDb(file);
        sigs.clear();
      }
      throw e;
    }
  }

  const insertMsg = (conv, role, idx, uuid, at, text, tool, body, toolBody) => {
    const { lastInsertRowid } = stmt("INSERT INTO msg (conv, idx, role, uuid, at, text, tool) VALUES (?, ?, ?, ?, ?, ?, ?)").run(conv, idx, role, uuid, atOf(at), text, tool || null);
    if (role !== "shell") stmt("INSERT INTO fts (rowid, body, tool) VALUES (?, ?, ?)").run(lastInsertRowid, body, toolBody);
  };

  return {
    sigs,

    /** msgs は extractMessages の結果、shells は extractShellCommands の結果。1 会話 = 1 トランザクション */
    write(id, sig, msgs, shells) {
      guard(() => {
        const stored = stmt("SELECT id, idx, uuid, role, at, text, tool FROM msg WHERE conv = ? AND role <> 'shell' ORDER BY idx").all(id);
        let keep = 0;
        while (keep < stored.length && keep < msgs.length && sameMsg(stored[keep], msgs[keep])) keep++;
        transaction(db, () => {
          if (keep < stored.length) {
            const from = stored[keep].idx;
            stmt("DELETE FROM fts WHERE rowid IN (SELECT id FROM msg WHERE conv = ? AND role <> 'shell' AND idx >= ?)").run(id, from);
            stmt("DELETE FROM msg WHERE conv = ? AND role <> 'shell' AND idx >= ?").run(id, from);
          }
          for (let i = keep; i < msgs.length; i++) {
            const m = msgs[i];
            insertMsg(id, m.role, m.index, m.uuid, m.at, m.text, m.tool, bigrams(m.folded), bigrams(m.toolFolded));
          }
          stmt("DELETE FROM msg WHERE conv = ? AND role = 'shell'").run(id);
          shells.forEach((s, i) => insertMsg(id, "shell", i, s.uuid, s.at, s.text, null, "", ""));
          stmt("INSERT INTO conv (id, sig) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET sig = excluded.sig").run(id, sig);
        });
        sigs.set(id, sig);
      });
    },

    remove(id) {
      guard(() => {
        transaction(db, () => {
          stmt("DELETE FROM fts WHERE rowid IN (SELECT id FROM msg WHERE conv = ? AND role <> 'shell')").run(id);
          stmt("DELETE FROM msg WHERE conv = ?").run(id);
          stmt("DELETE FROM conv WHERE id = ?").run(id);
        });
        sigs.delete(id);
      });
    },

    /** FTS5 の式に当たる発言を、会話ごとにまとめる（候補。本物の一致の上位集合） */
    candidates(expr) {
      return guard(() => {
        const out = new Map();
        for (const r of stmt("SELECT m.conv AS conv, m.id AS id FROM fts JOIN msg m ON m.id = fts.rowid WHERE fts MATCH ?").iterate(expr)) {
          const list = out.get(r.conv);
          if (list) list.push(r.id); else out.set(r.conv, [r.id]);
        }
        return out;
      });
    },

    /** 1 会話の発言（`!` のコマンドを除く。idx 順）。ids を渡せばその発言だけ（候補を引いた後に会話が書き直されても、別の会話の発言は返さない） */
    messagesOf(conv, ids = null) {
      return guard(() => (ids
        ? stmt("SELECT idx, role, uuid, at, text, tool FROM msg WHERE conv = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY idx").all(conv, JSON.stringify(ids))
        : stmt("SELECT idx, role, uuid, at, text, tool FROM msg WHERE conv = ? AND role <> 'shell' ORDER BY idx").all(conv)));
    },

    /** 会話の頭: 最初の人の発言・発言の数・最後の発言の時刻 */
    outline(id) {
      return guard(() => {
        const first = stmt("SELECT uuid, at, text FROM msg WHERE conv = ? AND role = 'user' AND text <> '' ORDER BY idx LIMIT 1").get(id) ?? null;
        const { n, lastAt } = stmt("SELECT count(*) AS n, max(at) AS lastAt FROM msg WHERE conv = ? AND role <> 'shell'").get(id);
        return { first: first ? { uuid: first.uuid, at: first.at ?? null, text: first.text } : null, count: n, lastAt: lastAt || null };
      });
    },

    /** 送信済みの並び。first の会話の分を先に、ほかを後に、それぞれ新しい順。止めたいところで break する */
    *sentRows({ role, first = null, ids }) {
      if (first) yield* guard(() => stmt("SELECT conv, uuid, at, text FROM msg WHERE conv = ? AND role = ? AND text <> '' ORDER BY at DESC, id DESC").all(first, role));
      const rest = JSON.stringify(ids.filter((id) => id !== first));
      yield* guard(() => stmt("SELECT conv, uuid, at, text FROM msg INDEXED BY msg_sent WHERE role = ? AND text <> '' AND conv IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id DESC").iterate(role, rest));
    },

    close() { try { db.close(); } catch { /* 閉じられなくてもよい */ } },
  };
}
