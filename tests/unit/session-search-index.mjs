// セッション検索の索引（core/session-search-index.mjs・ADR 0349）。2 字ずつの語・候補の引き方・書き方（先頭を残す更新）・
// ファイルの持ち越しと作り直し（壊れた・形式が違う）・createSessionSearch から使ったときの結果と更新を確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bigrams, termQuery, openSearchIndex, INDEX_FILE, INDEX_FORMAT } from '../../core/session-search-index.mjs';
import { createSessionSearch, extractMessages, extractShellCommands, fold, normalizeInput, matchSession, findRanges, makeExcerpt } from '../../core/session-search.mjs';
import { loadSqlite } from '../../core/db.mjs';

export const name = 'session-search-index';
export const title = 'セッション検索の索引: 2 字ずつの語・候補・先頭を残す更新・持ち越しと作り直し・結果が走査と同じ';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const msg = (role, text, extra = {}) => ({ role, text, uuid: `${role}-${text.slice(0, 4)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date(NOW).toISOString(), ...extra });
const row = (id, extra = {}) => ({ id, title: id, status: null, cwd: "D:\\dev\\app", backend: "claude", lastModified: NOW - 86_400_000, delegation: null, ...extra });
const ids = (r) => r.sessions.map((s) => s.sessionId).sort();
/** 索引に書く形（extractMessages・extractShellCommands の結果）にして書く */
const put = (index, id, sig, raw) => index.write(id, sig, extractMessages(raw), extractShellCommands(raw));
const convs = (index, expr) => [...index.candidates(expr).keys()].sort().join();

export default async function (t) {
  // ------------------------------------------------------------ 語の切り方・引き方（純粋）
  t.ok("2 字ずつ: 連なりごとに各字と次の字・最後は 1 字・記号と空白は区切り", bigrams("ab cd-e") === "ab b cd d e" && bigrams("翻訳") === "翻訳 訳" && bigrams("") === "" && bigrams("!!") === "", bigrams("ab cd-e"));
  t.ok("引き方: 1 字は前方一致・2 字以上は 2 字の並びのフレーズ", termQuery("猫") === '"猫"*' && termQuery("翻訳") === '"翻訳"' && termQuery("abc") === '"ab bc"');
  t.ok("引き方: 連なりごとに AND・2 字以上があれば 1 字の連なりは使わない・同じ連なりは 1 つ", termQuery("ci 設定") === '"ci" AND "設定"' && termQuery("c++") === '"c"*' && termQuery("a-bc") === '"bc"' && termQuery("ab ab") === '"ab"');
  t.ok("引き方: 列を指す・字の無い語（記号だけ）は null", termQuery("ab", "body") === 'body : "ab"' && termQuery("---") === null && termQuery("") === null);

  // ------------------------------------------------------------ 書く・引く・更新（メモリ）
  {
    const index = openSearchIndex();
    put(index, "a", 100, [msg("user", "翻訳の ci を直したい", { uuid: "u1" }), msg("assistant", "了解", { uuid: "u2" }), { role: "user", kind: "shell", uuid: "s1", at: "2026-11-24T00:00:00Z", text: "! ls", command: "ls" }]);
    put(index, "b", 100, [msg("user", "別の話 cat", { uuid: "u3" })]);
    t.ok("sigs に会話ごとの sig が入る", index.sigs.get("a") === 100 && index.sigs.get("b") === 100 && index.sigs.size === 2);
    t.ok("2 字の語・1 字の語・日本語で候補を引く", convs(index, termQuery("翻訳")) === "a" && convs(index, termQuery("ci")) === "a" && convs(index, termQuery("猫")) === "" && convs(index, termQuery("c")) === "a,b");
    t.ok("`!` のコマンドは語に入らない", convs(index, termQuery("ls")) === "");
    t.ok("messagesOf は idx 順で、`!` のコマンドを含まない", index.messagesOf("a").map((r) => r.uuid).join() === "u1,u2");
    const first = index.candidates(termQuery("翻訳")).get("a").map((r) => r.id);
    t.ok("候補は本文を持たず、idx・role・at を持つ", (() => { const [r] = index.candidates(termQuery("翻訳")).get("a"); return r.id === first[0] && r.idx === 0 && r.role === "user" && r.at === index.messagesOf("a")[0].at && !("text" in r); })());
    t.ok("messagesOf に ids を渡すとその発言だけ", index.messagesOf("a", first).length === 1 && index.messagesOf("a", first)[0].uuid === "u1");

    // 先頭の同じ発言は残し、違う所から後ろだけ入れ直す
    put(index, "a", 200, [msg("user", "翻訳の ci を直したい", { uuid: "u1", at: index.messagesOf("a")[0].at }), msg("assistant", "了解", { uuid: "u2", at: index.messagesOf("a")[1].at }), msg("user", "足した発言 worktree", { uuid: "u4" })]);
    t.ok("足した発言だけ書く（先頭の発言の行は同じ）", JSON.stringify(index.candidates(termQuery("翻訳")).get("a").map((r) => r.id)) === JSON.stringify(first) && convs(index, termQuery("worktree")) === "a" && index.sigs.get("a") === 200);
    put(index, "a", 300, [msg("user", "翻訳の ci を直したい", { uuid: "u1", at: index.messagesOf("a")[0].at }), msg("assistant", "書き換えた cat", { uuid: "u2" })]);
    t.ok("途中から違うときは、そこから後ろを入れ直す（消えた発言には当たらず、新しい発言には当たる）",
      convs(index, termQuery("worktree")) === "" && convs(index, termQuery("cat")) === "a,b" && index.messagesOf("a").length === 2 && index.messagesOf("a")[1].text === "書き換えた cat");
    t.ok("`!` のコマンドは書き直しても重ならない", index.sentRows({ role: "shell", ids: ["a"] }).next().done === true);

    const outline = index.outline("a");
    t.ok("outline: 最初の人の発言・数・最後の時刻", outline.first?.uuid === "u1" && outline.count === 2 && typeof outline.lastAt === "string", JSON.stringify(outline));
    t.ok("outline: 無い会話は first なし・数 0", JSON.stringify(index.outline("zzz")) === JSON.stringify({ first: null, count: 0, lastAt: null }));

    index.remove("a");
    t.ok("remove: 発言も語も sig も消える", !index.sigs.has("a") && convs(index, termQuery("翻訳")) === "" && index.messagesOf("a").length === 0);
    index.close();
  }

  // ------------------------------------------------------------ ファイル: 持ち越し・壊れた・形式が違う
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ply-search-index-"));
  try {
    const file = path.join(dir, INDEX_FILE);
    let index = openSearchIndex({ file });
    put(index, "a", 100, [msg("user", "ファイルに残る本文")]);
    index.close();
    index = openSearchIndex({ file });
    t.ok("閉じて開き直しても、sig と本文が残る", index.sigs.get("a") === 100 && convs(index, termQuery("本文")) === "a");
    index.close();

    await fs.writeFile(file, "これはデータベースではない ".repeat(400));
    index = openSearchIndex({ file });
    t.ok("壊れたファイルは消して空から作り直す", index.sigs.size === 0 && convs(index, termQuery("本文")) === "");
    put(index, "b", 5, [msg("user", "作り直した後の本文")]);
    index.close();
    index = openSearchIndex({ file });
    t.ok("作り直したファイルは次も開ける", index.sigs.get("b") === 5);
    index.close();

    const { DatabaseSync } = loadSqlite();
    const other = new DatabaseSync(file);
    other.exec(`PRAGMA user_version = ${INDEX_FORMAT + 1}`);
    other.close();
    index = openSearchIndex({ file });
    t.ok("形式番号が違うファイルは消して作り直す", index.sigs.size === 0);
    index.close();
    const check = new DatabaseSync(file);
    t.ok("作り直したファイルは今の形式番号", check.prepare("PRAGMA user_version").get().user_version === INDEX_FORMAT);
    check.close();

    // ---------------------------------------------------------- createSessionSearch から使う
    const sessions = [
      row("a", { title: "請求書", messages: [msg("user", "ＣＩ の設定を見直したい"), msg("assistant", "c++ のビルドを直しました"), msg("user", "猫の写真")] }),
      row("b", { title: "その他", messages: [msg("user", "別の話"), msg("assistant", "Hello World を出力する")] }),
      row("c", { title: "ci", messages: [] }),
    ];
    const bodies = new Map(sessions.map((s) => [s.id, s.messages]));
    const listed = sessions.map(({ messages, ...r }) => r);
    const calls = { stored: [], full: [] };
    const make = (extra = {}) => createSessionSearch({
      listSessions: async () => listed.map((r) => ({ ...r })),
      readStored: async (id) => { calls.stored.push(id); return bodies.get(id) ?? null; },
      readFull: async (id) => { calls.full.push(id); return bodies.get(id) ?? []; },
      file, now: () => NOW, ...extra,
    });
    for (const suffix of ["", "-wal", "-shm"]) await fs.rm(`${file}${suffix}`, { force: true });
    let search = make();
    await search.search({ query: "" }); await search.idle();
    const q = async (query, filters) => ids(await search.search({ query, ...(filters ? { filters } : {}) }));
    t.ok("1 字の語（前方一致）・2 字の語・全角", (await q("猫")).join() === "a" && (await q("ci")).join() === "a,c" && (await q("ＣＩ")).join() === "a,c");
    t.ok("記号を含む語は本文で確かめる（c++ は c を含む発言の中から）", (await q("c++")).join() === "a" && (await q("++")).join() === "a" && (await q("c+++")).join() === "");
    t.ok("字の無い語（記号だけ）は全部の発言を確かめる", (await q("!!!")).join() === "" && (await q("+")).join() === "a");
    t.ok("\"…\" の語は畳まない", (await q('"Hello World"')).join() === "b" && (await q('"hello world"')).join() === "");
    t.ok("字の連なりを挟んだ語は部分一致（連なりの途中・離れた 2 字は当たらない）", (await q("設定を")).join() === "a" && (await q("定見")).join() === "");
    t.ok("題・状態・場所と本文で語が分かれても AND で当たる", (await q("請求書 猫")).join() === "a" && (await q("請求書 Hello")).join() === "");
    search.stop(); await search.idle();
    const readsBefore = calls.stored.length + calls.full.length;

    // 開き直しても読み直さない・索引より新しい会話だけ読み直す
    search = make();
    await search.start();
    t.ok("開き直した直後から、索引にある会話は全部入っている", search.status().indexed === 3 && search.status().pending === 0, JSON.stringify(search.status()));
    t.ok("開き直しても読み込みをやり直さない・partial ではない", calls.stored.length + calls.full.length === readsBefore && (await search.search({ query: "猫" })).partial === false);
    listed[1].lastModified = NOW + 10_000_000;
    bodies.set("b", [msg("user", "別の話"), msg("assistant", "Hello World を出力する"), msg("user", "新しく足した発言")]);
    search.stop(); await search.idle();
    search = make({ now: () => NOW + 20_000_000 });
    await search.start(); await search.idle();
    t.ok("索引より新しい会話は、開き直した後に裏で読み直して足す", calls.full.includes("b") && (await q("足した発言")).join() === "b", JSON.stringify(calls));
    search.stop(); await search.idle();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ 結果が走査と同じ（総当たりの照合と比べる）
  {
    const words = ["翻訳", "ci", "猫", "設定", "worktree", "ゲートウェイ", "c++", "Hello", "world", "ｇａｔｅｗａｙ", "の", "している"];
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const pick = () => words[Math.floor(rnd() * words.length)];
    const sessions = Array.from({ length: 30 }, (_, i) => row(`s${i}`, {
      title: rnd() < 0.2 ? pick() : `会話${i}`, lastModified: NOW - i * 3_600_000,
      messages: Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, k) => msg(rnd() < 0.5 ? "user" : "assistant", `${pick()} ${pick()}${rnd() < 0.3 ? " " + pick() : ""} ${k}`)),
    }));
    const bodies = new Map(sessions.map((s) => [s.id, s.messages]));
    const listed = sessions.map(({ messages, ...r }) => r);
    const search = createSessionSearch({ listSessions: async () => listed, readStored: async (id) => bodies.get(id), readFull: async (id) => bodies.get(id), now: () => NOW });
    await search.search({ query: "" }); await search.idle();
    // 総当たり: 全部の語（空白で分けた）が題か本文のどこかに（畳んだ部分一致で）当たる会話
    const naive = (query) => {
      const need = query.split(/\s+/).filter(Boolean).map(fold);
      return sessions.filter((s) => need.every((w) => fold(s.title).includes(w) || fold("D:\\dev\\app".split("\\").pop()).includes(w) || s.messages.some((m) => fold(m.text).includes(w)))).map((s) => s.id).sort();
    };
    let same = 0, differ = [];
    const queries = [...words.map((w) => w), "翻訳 ci", "猫 の", "c++ hello", "している の", "gateway", "ゲー", "ト", "ｗｏｒｌｄ 設定"];
    for (const query of queries) {
      const got = ids(await search.search({ query, limit: 200 }));
      const want = naive(query);
      if (JSON.stringify(got) === JSON.stringify(want)) same++; else differ.push(`${query}: ${got.length} vs ${want.length}`);
    }
    t.ok(`索引で引いた結果が、総当たりの照合と全部の語で同じ（${queries.length} 語）`, differ.length === 0, differ.join(" / "));
    search.stop(); await search.idle();
  }

  // ------------------------------------------------------------ 字の連なりだけの語は、索引の候補をそのまま一致にする（本文を読んで確かめたときと件数・順位・抜粋まで同じ）
  {
    const texts = ["ＣＩ が落ちた。ci の設定", "Éclair と éclair", "𠮷野家の𠮷", "ﾊﾟｰﾄ ﾊﾟｰﾄﾅｰ とパート", "ǅ ǆ ǈ", "same-word_other.word", "ΑΣ ΑΣΒ", "…あ…あ", "c++ と c# と C", "の の の", "Ｈｅｌｌｏ ｗｏｒｌｄ Hello", "…", "ゲートウェイ gateway"];
    let seed = 11;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const sessions = Array.from({ length: 24 }, (_, i) => row(`t${i}`, {
      title: rnd() < 0.2 ? texts[Math.floor(rnd() * texts.length)] : `会話${i}`, lastModified: NOW - i * 3_600_000,
      messages: Array.from({ length: 1 + Math.floor(rnd() * 7) }, (_, k) => msg(rnd() < 0.5 ? "user" : "assistant", `${texts[Math.floor(rnd() * texts.length)]} ${texts[Math.floor(rnd() * texts.length)]} ${k}`, { at: new Date(NOW - (i * 10 + k) * 60_000).toISOString() })),
    }));
    const bodies = new Map(sessions.map((s) => [s.id, s.messages]));
    const listed = sessions.map(({ messages, ...r }) => r);
    const search = createSessionSearch({ listSessions: async () => listed, readStored: async (id) => bodies.get(id), readFull: async (id) => bodies.get(id), now: () => NOW });
    await search.search({ query: "" }); await search.idle();
    const byId = (a, b) => (a.id < b.id ? -1 : 1);
    // 基準: 全部の発言の本文を読んで確かめる（matchSession を、本文を持つ発言に当てる）
    const want = (query, speaker, hits) => {
      const q = normalizeInput({ query, hitsPerSession: hits, filters: { speaker } });
      return sessions.flatMap((s) => {
        const m = matchSession(s, extractMessages(s.messages), q.terms, { speaker, toolInputs: false, hits });
        if (!m) return [];
        const hitsOf = m.top.map(({ msg: x }) => { const { excerpt, ranges } = makeExcerpt(x.text, findRanges(x.text, x.folded, q.terms)); return { uuid: x.uuid, index: x.index, role: x.role, at: x.at ?? "", excerpt, ranges }; });
        return [{ id: s.id, hitCount: m.hitCount, matched: m.matched, hits: hitsOf }];
      }).sort(byId);
    };
    const queries = ["ci", "ＣＩ", "ｅ́", "éclair", "𠮷", "𠮷野", "パート", "ぱ", "word", "other", "ας", "ασ", "あ", "の", "は", "c", "ｗｏｒｌｄ hello", "ci の", "gateway ゲート", "…", "c++", "same-word", "同じ語 ci"];
    const differ = [];
    for (const query of queries) for (const speaker of ["any", "user", "assistant"]) {
      const got = (await search.search({ query, limit: 200, hitsPerSession: 3, filters: { speaker } })).sessions
        .map((s) => ({ id: s.sessionId, hitCount: s.hitCount, matched: s.matched, hits: s.hits })).sort(byId);
      const expected = want(query, speaker, 3);
      if (JSON.stringify(got) !== JSON.stringify(expected)) differ.push(`${query}/${speaker}: ${got.length} vs ${expected.length}`);
    }
    t.ok(`字の連なりだけの語は、本文を読んで確かめた結果と同じ（件数・一致の場所・上位の発言・抜粋。${queries.length} 語 × 話者 3）`, differ.length === 0, differ.join(" / "));
    const hit = (await search.search({ query: "ci", limit: 1 })).sessions[0]?.hits[0];
    t.ok("表に出す発言には本文の抜粋が付く", typeof hit?.excerpt === "string" && hit.excerpt.length > 0 && hit.ranges.length > 0, JSON.stringify(hit));
    search.stop(); await search.idle();
  }
}
