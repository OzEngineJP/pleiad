#!/usr/bin/env node
/* ==================== エージェントの種類の漏れの lint（直書きと一覧の入れ忘れ） ====================
   エージェントごとの知識は core/backends/（バックエンドと、エージェントの記述 agents.mjs）に置き、ほかの場所は能力の印
   （core/backends/capability-marks.mjs。エージェントごとの状態は agent-marks.mjs）とエージェントの記述から引く
   （docs/multi-backend.md「エージェントを足す」・ADR 0361）。その外に id を書くと、エージェントを足したときに黙って足りなくなる。

     node tests/lint-agents.mjs [--update-baseline] [--json]

   規則 1 id-literal（直書きの数。基準は tests/backends-baseline.json。下がる一方の基準＝ラチェット）:
     - core/（core/backends/ を除く）・web/・desktop/・bin/・scripts/・site/ の JS で、エージェントの id（エージェントの記述の id。
       fake を除く）とちょうど同じ文字列リテラル（'claude'・"codex"・`antigravity`）を、ファイルごとに数える。コメントは数えない。
       オブジェクトの裸のキー（{ claude: … }）は拾わない（字句解析が文字列しか返さない。一覧は規則 2 が見る）。
     - 数えないのは、`backend-allow: 理由` の印がある行（行末か、直前の行にコメントだけで）。理由の無い印は失敗（mark）。
       印を付けてよいのは、そのエージェントだけの事情で、能力の印にする意味が無いもの（Claude の transcript の救済など）。
     - ファイルごとの件数が増えた・基準に無いファイルに出た → 失敗（increased）。減った → 「基準を下げてください」で失敗（decreased）。
     - 印の総数 allowMarks も同じラチェット（増えた → allow-marks、減った → decreased）。印で逃がすのを増やさない。
     - 当たる直書きの無い印（その行にも次の行にも数える直書きが無い）は失敗（dead-mark）。
     --update-baseline で基準を下げる（上げる更新は拒む）。

   規則 2 agent-list（一覧の入れ忘れ。Issue #145）:
     - `{ ... }` のキーや `[ ... ]` の要素としてエージェントの id が 2 個以上並んだ「一覧」を拾う。全エージェントが揃っていれば合格。
       揃っていなければ ALLOWED で「この一覧が持つべき組」をエージェントの記述から引く（expect）か、固定の組（ids）と理由を宣言した
       一覧だけを許す（partial-list）。当たる一覧の無い宣言も失敗（unused-allow）。
     - `...` の広げは、同じファイルの const と import の先の const まで辿る。読めない参照は ALLOWED の refs に名前を書く。
     - 比較・代入の単発の id、オブジェクトの値・三項演算子の結果の id は一覧ではないので拾わない（規則 1 が数える）。
     - README の名簿と AGENTS.md の実行ファイルの環境変数（cli.binEnv）の表は tests/unit/agents-lint.mjs が照らす。

   npm test からは tests/unit/agents-lint.mjs が lintIds()・lintLists()・selftest() を直接呼ぶ。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanJs } from './lint-i18n.mjs';
import { AGENTS, DEFAULT_AGENT_IDS } from '../core/backends/agents.mjs';
import { CAPABILITY_STATES } from '../core/backends/agent-marks.mjs';
import { HOOK_AGENTS, UNIFY_TARGETS } from '../core/hooks-config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = path.join(ROOT, 'tests', 'backends-baseline.json');
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/* ==================== 規則 1 id-literal ==================== */
const ID_SCAN_DIRS = ['core', 'web', 'desktop', 'bin', 'scripts', 'site'];
/* エージェントの知識を置いてよい場所・作られたもの・外の CLI の写し（数えない） */
const ID_EXCLUDE = [
  /^core\/backends\//, /^web\/locales\//, /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)\.astro\//,
  /^site\/docs\/src\//,
  /^scripts\/zero-downtime\/(agy|claude|codex)\//,
];
/** 数えるエージェントの id。試験用の fake は、試験の分岐（computerDriver.kind === 'fake' など）と区別できないので数えない */
export const AGENT_IDS = Object.freeze(Object.keys(AGENTS).filter((id) => id !== 'fake'));
const ALLOW_MARK = /backend-allow\b(?:\s*:\s*(.*?))?\s*(?:\*\/|-->)?\s*$/;

function walk(dir, out = [], skip = () => false) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skip(e.name)) walk(full, out, skip); continue; }
    if (JS_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

export function listFiles(root = ROOT) {
  return ID_SCAN_DIRS.filter((d) => fs.existsSync(path.join(root, d)))
    .flatMap((d) => walk(path.join(root, d), [], (name) => name === 'node_modules'))
    .map((f) => rel(root, f)).filter((f) => !ID_EXCLUDE.some((re) => re.test(f))).sort();
}

/**
 * 1 つのファイルの id の直書き。
 * { hits: [{ line, id }], allowed: [{ line, id, reason }], badMarks: [line], marks: [line], deadMarks: [line] }
 * ids は数える id（既定は AGENT_IDS）
 */
export function scanText(text, ids = AGENT_IDS) {
  const wanted = new Set(ids);
  const { literals, comments } = scanJs(text);
  const lines = text.split(/\r?\n/);
  const commentOnly = new Set(comments.filter((c) => /^(\/\/|\/\*|\*)/.test(lines[c.line - 1]?.trim() ?? '')).map((c) => c.line));
  const markComments = comments.filter((c) => ALLOW_MARK.test(c.text));
  const markOn = (line) => markComments.find((c) => c.line === line)
    ?? markComments.find((c) => c.line === line - 1 && commentOnly.has(line - 1)) ?? null;
  const hits = [], allowed = [], badMarks = new Set(), used = new Set();
  for (const lit of literals) {
    if (!wanted.has(lit.text)) continue;
    const mark = markOn(lit.line);
    if (!mark) { hits.push({ line: lit.line, id: lit.text }); continue; }
    used.add(mark.line);
    const reason = ALLOW_MARK.exec(mark.text)?.[1]?.trim();
    if (!reason) badMarks.add(mark.line);
    allowed.push({ line: lit.line, id: lit.text, reason: reason ?? '' });
  }
  const marks = [...new Set(markComments.map((c) => c.line))];
  return { hits, allowed, badMarks: [...badMarks], marks, deadMarks: marks.filter((l) => !used.has(l)) };
}

export function scanRepo(root = ROOT, ids = AGENT_IDS) {
  const files = {};
  for (const file of listFiles(root)) {
    const result = scanText(fs.readFileSync(path.join(root, file), 'utf8'), ids);
    if (result.hits.length || result.allowed.length || result.marks.length) files[file] = result;
  }
  return files;
}

export function readBaseline(file = BASELINE_FILE) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { _comment: '', allowMarks: 0, files: {} };
}

const countMarks = (scanned) => Object.values(scanned).reduce((n, r) => n + r.marks.length, 0);

/** 基準との比べ。問題の配列 { rule, file, message } */
export function checkBaseline(scanned, baseline) {
  const problems = [];
  const counts = Object.fromEntries(Object.entries(scanned).map(([f, r]) => [f, r.hits.length]).filter(([, n]) => n > 0));
  const base = baseline.files ?? {};
  for (const [file, n] of Object.entries(counts)) {
    const was = base[file] ?? 0;
    if (n > was) {
      const lines = scanned[file].hits.map((h) => `${h.line}:${h.id}`).join(' ');
      problems.push({ rule: 'increased', file, message: `${file}: エージェントの id の直書きが ${was} → ${n} に増えた（${lines}）。能力の印（core/backends/capability-marks.mjs）かエージェントの記述（core/backends/agents.mjs）から引く。どうしても要るなら \`backend-allow: 理由\` の印` });
    }
  }
  for (const [file, was] of Object.entries(base)) {
    const n = counts[file] ?? 0;
    if (n < was) problems.push({ rule: 'decreased', file, message: `${file}: ${was} → ${n} に減った。基準を下げてください（node tests/lint-agents.mjs --update-baseline）` });
  }
  for (const [file, r] of Object.entries(scanned)) {
    for (const line of r.badMarks) problems.push({ rule: 'mark', file, message: `${file}:${line}: backend-allow の印に理由が無い` });
    for (const line of r.deadMarks) problems.push({ rule: 'dead-mark', file, message: `${file}:${line}: backend-allow の印に当たる直書きが無い（その行にも次の行にも数える id が無い）。印を消す` });
  }
  const marks = countMarks(scanned), wasMarks = baseline.allowMarks ?? 0;
  if (marks > wasMarks) problems.push({ rule: 'allow-marks', file: '', message: `backend-allow の印が ${wasMarks} → ${marks} に増えた。印で逃がさず、能力の印かエージェントの記述から引く` });
  else if (marks < wasMarks) problems.push({ rule: 'decreased', file: '', message: `backend-allow の印が ${wasMarks} → ${marks} に減った。基準を下げてください（node tests/lint-agents.mjs --update-baseline）` });
  return problems;
}

const BASELINE_COMMENT = 'エージェントの id の直書きの件数（tests/lint-agents.mjs の規則 1 id-literal）と backend-allow の印の総数（allowMarks）。増やせない。減らしたら node tests/lint-agents.mjs --update-baseline で下げる。Hooks・MCP・指示ファイルの形式名（claude・codex を形式の名として使うもの）の分は #91 で SOURCES 定数へ寄せて減らす（Ph1 では減らさない）';

export function formatBaseline(files, allowMarks) {
  const sorted = Object.fromEntries(Object.entries(files).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ _comment: BASELINE_COMMENT, allowMarks, files: sorted }, null, 2) + '\n';
}

export function lintIds({ root = ROOT, baselineFile = BASELINE_FILE } = {}) {
  const scanned = scanRepo(root);
  const baseline = readBaseline(baselineFile);
  return {
    scanned, problems: checkBaseline(scanned, baseline),
    total: Object.values(scanned).reduce((n, r) => n + r.hits.length, 0), allowMarks: countMarks(scanned),
  };
}

/** 基準を下げる（上がるファイル・印の数があれば拒む） */
export function updateBaseline({ root = ROOT, baselineFile = BASELINE_FILE } = {}) {
  const scanned = scanRepo(root);
  const baseline = readBaseline(baselineFile);
  const base = baseline.files ?? {};
  const next = Object.fromEntries(Object.entries(scanned).map(([f, r]) => [f, r.hits.length]));
  const raised = Object.entries(next).filter(([f, n]) => n > (base[f] ?? 0));
  const marks = countMarks(scanned);
  if (marks > (baseline.allowMarks ?? 0)) raised.push(['allowMarks', marks]);
  if (raised.length && Object.keys(base).length) return { ok: false, raised };
  fs.writeFileSync(baselineFile, formatBaseline(next, marks));
  return { ok: true, raised: [] };
}

/* ==================== 規則 2 agent-list ==================== */
const LIST_SCAN_DIRS = ['core', 'web', 'desktop', 'bin', 'site'];
const LIST_SKIP_DIRS = new Set(['node_modules', 'locales']);
const LIST_SKIP_FILE = (file) => /(^|[/\\])backends[/\\][^/\\]+\.mjs$/.test(file);   // エージェントの記述そのものは正本なので対象外
const IDS = new Set(DEFAULT_AGENT_IDS);
const KW_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'instanceof', 'yield', 'await']);

// ---- 字句 ----
function* lex(src) {
  let i = 0, line = 1, prev = null;
  const n = src.length;
  const isId = c => c !== undefined && /[$\w]/.test(c);
  const isPunct = c => c !== undefined && !/[$\w\s'"`/]/.test(c);
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c, start = i++; let expr = false;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          expr = true; let d = 1; i += 2;
          while (i < n && d) { if (src[i] === '{') d++; else if (src[i] === '}') d--; if (src[i] === '\n') line++; i++; }
          continue;
        }
        if (src[i] === '\n') line++;
        i++;
      }
      i++;
      prev = { k: 'lit', v: expr ? undefined : src.slice(start + 1, i - 1), line };
      yield prev; continue;
    }
    if (/[0-9]/.test(c)) { while (i < n && /[\w.]/.test(src[i])) i++; prev = { k: 'num', line }; yield prev; continue; }
    if (isId(c)) {
      const s = i; while (i < n && isId(src[i])) i++;
      prev = { k: 'id', v: src.slice(s, i), line }; yield prev; continue;
    }
    if (c === '/' && (prev === null || prev.k === 'p' || (prev.k === 'id' && KW_REGEX.has(prev.v)))) {
      i++; let cls = false;
      while (i < n && (cls || src[i] !== '/')) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
        if (src[i] === '\n') line++;
        i++;
      }
      i++; while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = { k: 'lit', v: undefined, line }; yield prev; continue;
    }
    if (isPunct(c)) {
      // 括弧や ':' は閉じ・キーの目印なので 1 文字ずつ出す（'];' のような連結にしない）。'=>''&&' 等の 2 文字だけ束ねる
      const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
      const v = three === '...' ? three : ['=>', '&&', '||', '??'].includes(two) ? two : c;
      i += v.length;
      prev = { k: 'p', v, line }; yield prev; continue;
    }
    i++;
  }
}

// ---- 一覧の抽出 ----
/**
 * `{`/`[`/`(` の枠を追い、枠ごとに {own（直のキー・要素の id）, all（own＋入れ子の枠の全部）, refs（... の参照名）, name, line} を返す。
 * `{` の値の位置にある入れ子の一覧はキーではないので `{` の own に混ぜない。
 * 名前は `const X = <一覧>` の X か `key: <一覧>` の key。
 */
// `{` がオブジェクトの始まりになる直前の記号・語（関数・if・class などの本文の `{` はブロックなので一覧に数えない）
const OBJECT_AFTER_PUNCT = new Set(['=', '(', '[', ',', ':', '?', '=>', '&&', '||', '??', '!', '~', '+', '-', '*', '/', '%', '<', '>', '&', '|', '^']);
const OBJECT_AFTER_KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
function isObjectBrace(toks, i) {
  const p = toks[i - 1];
  if (!p) return false;
  if (p.k === 'p') {
    if (p.v === '>' && toks[i - 2]?.v === '=') return false;   // `=> {` は矢印関数の本文
    return OBJECT_AFTER_PUNCT.has(p.v);
  }
  return p.k === 'id' && OBJECT_AFTER_KW.has(p.v);
}

export function scanCollections(src) {
  const toks = [...lex(src)];
  const out = [], stack = [], decls = new Map(), imports = new Map();
  let pendingDecl = null;
  const top = () => stack[stack.length - 1];
  for (let ti = 0; ti < toks.length; ti++) {
    const tk = toks[ti];
    if (tk.k === 'id' && tk.v === 'import') {
      // `import { a, b } from 'rel'` と `import * as ns from 'rel'` の名前を記録（参照の解決用）
      let j = ti + 1; const names = [];
      while (toks[j] && toks[j].v !== 'from' && !(toks[j].k === 'lit')) j++;
      const from = toks[j]?.k === 'lit' ? toks[j].v : (toks[j + 1]?.k === 'lit' ? toks[j + 1].v : null);
      for (let k = ti + 1; k < j; k++) if (toks[k].k === 'id' && !['import', 'as', 'type'].includes(toks[k].v)) names.push(toks[k].v);
      if (from) for (const nm of names) imports.set(nm, from);
      continue;
    }
    if (tk.k === 'id' && (tk.v === 'const' || tk.v === 'let' || tk.v === 'var')) {
      const a = toks[ti + 1], b = toks[ti + 2];
      if (a?.k === 'id' && b?.v === '=') pendingDecl = a.v;
      continue;
    }
    if (tk.k === 'p') {
      if (tk.v === '{' || tk.v === '[' || tk.v === '(') {
        let name = pendingDecl;
        if (!name && toks[ti - 1]?.v === ':' && (toks[ti - 2]?.k === 'id' || toks[ti - 2]?.k === 'lit')) name = toks[ti - 2].v;
        stack.push({ kind: tk.v, block: tk.v === '{' && !isObjectBrace(toks, ti), own: new Set(), all: new Set(), refs: new Set(), name, line: tk.line, expecting: true });
        pendingDecl = null;
        continue;
      }
      if (tk.v === '}' || tk.v === ']' || tk.v === ')') {
        const f = stack.pop();
        if (!f) continue;
        const reportable = f.kind === '[' || (f.kind === '{' && !f.block);
        const p = top();
        if (p) {
          p.expecting = false;
          // `[`・`(`・ブロックの `{` は中身を透過的に親へ渡す。オブジェクトの `{` は値の位置の一覧をキーに混ぜない
          if (p.kind !== '{' || p.block) {
            for (const x of f.all) p.all.add(x);
            for (const r of f.refs) p.refs.add(r);
          }
        } else if (f.name && reportable) {
          decls.set(f.name, { all: f.all, refs: f.refs });
        }
        if (reportable && (f.all.size >= 1 || f.refs.size >= 1)) {
          const set = f.kind === '{' ? new Set(f.own) : new Set(f.all);
          out.push({ kind: f.kind, set, refs: f.refs, name: f.name, line: f.line });
        }
        continue;
      }
      const f = top();
      if (f) {
        if (tk.v === ',') f.expecting = true;
        else if (tk.v === '...') {
          const nx = toks[ti + 1];
          if (nx && (nx.k === 'id' || (nx.k === 'lit' && nx.v !== undefined))) f.refs.add(nx.v);
        }
      }
      continue;
    }
    // 名前・文字列・数。`(`・ブロックの `{` の中は要素・キーの位置ではないので数えない
    const f = top();
    if (f && f.kind !== '(' && !f.block) {
      if (f.expecting && tk.v !== undefined && IDS.has(tk.v)) { f.own.add(tk.v); f.all.add(tk.v); }
      f.expecting = false;
    } else if (f) f.expecting = false;
  }
  return { collections: out, decls, imports };
}

// ---- 参照の解決 ----
function resolver(files) {
  const seen = new Set();
  const memo = new Map();
  const resolve = (file, name, via = []) => {
    const key = `${file}#${name}`;
    if (memo.has(key)) return memo.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    const f = files.get(file);
    let found = null;
    if (f?.decls.has(name)) {
      const d = f.decls.get(name);
      found = { ids: new Set(d.all), missing: new Set() };
      for (const r of d.refs) {
        const sub = resolve(file, r, [...via, key]);
        if (sub) {
          for (const x of sub.ids) found.ids.add(x);
          for (const m of sub.missing) found.missing.add(m);
        } else found.missing.add(r);
      }
    } else if (f?.imports.has(name)) {
      const target = f.imports.get(name);
      if (target.startsWith('.')) {
        // 一覧の鍵は `/` 区切りの相対パス。Windows でも同じ鍵で引く（`\` のままだと import 先を引けず、広げた一覧を見逃す）
        const p = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
        found = resolve(p, name, [...via, key]) ?? { ids: new Set(), missing: new Set([name]) };
      }
    }
    memo.set(key, found);
    return found;
  };
  return resolve;
}

// ---- 正本から引く「持つべき組」 ----
export function expectedSets() {
  return {
    // Hooks の機構をそのまま持つエージェント（core/hooks-config.mjs の HOOK_AGENTS）
    nativeHooks: new Set(HOOK_AGENTS),
    // Hooks の統合の対象（機構そのまま＋記述の hooksAs で形を写せるもの。core/hooks-config.mjs の UNIFY_TARGETS）
    unifyTargets: new Set(UNIFY_TARGETS),
    // Hooks のイベント名の表を持つエージェント（機構そのまま＋plugin 経由で表が要るもの）
    hookEventOwners: new Set([...HOOK_AGENTS, ...DEFAULT_AGENT_IDS.filter(id => ['plugin', 'config'].includes(AGENTS[id].hooksVia))]),
    // 互換エンドポイントを立てられるエージェント（core/backends/agent-marks.mjs の CAPABILITY_STATES.<id>.compatEndpoints が true）
    compatEndpoints: new Set(DEFAULT_AGENT_IDS.filter(id => CAPABILITY_STATES[id]?.compatEndpoints === true)),
  };
}

/**
 * 部分一覧を許す宣言。file はリポジトリからの相対パス。
 * expect: expectedSets() のキー（エージェントの記述から引く。記述が変われば組も変わる）
 * ids:    固定の組（形式の名・実行ファイルの名・後方互換の固定の並びなど、記述から引けないもの）
 * refs:   一覧の中に `...` で広げられた、中身の読めない参照の名前（読めないまま通さないための宣言）
 * reason: なぜ全エージェントの一覧ではないのか（必須）
 */
export const ALLOWED = [
  // Hooks の機構を持つのは claude・codex・antigravity（機構の無いエージェントは hooksAs で形を写す。core/hooks-config.mjs）
  { file: 'core/hooks-config.mjs', expect: 'nativeHooks', reason: 'Hooks の機構をそのまま持つエージェント（HOOK_AGENTS）' },
  { file: 'core/hooks-config.mjs', expect: 'hookEventOwners', reason: 'Hooks のイベント名の表を持つエージェント（HOOK_EVENTS。機構＋plugin 経由）' },
  { file: 'core/hooks-config.mjs', expect: 'nativeHooks', refs: ['HOOK_AGENTS', 'Object'], reason: 'UNIFY_TARGETS の [...HOOK_AGENTS] 側。HOOK_EMULATED は記述から引くので中身が読めない' },
  { file: 'core/hooks-copy.mjs', expect: 'nativeHooks', reason: 'Hooks の設定を別エージェントの形に写すときの対象（native だけ）' },
  { file: 'core/hook-adapter.mjs', expect: 'nativeHooks', reason: 'Hooks の機構を持つエージェントだけを扱う単独ファイル（import しない）' },
  { file: 'core/hooks-unify.mjs', expect: 'nativeHooks', reason: 'Hooks の統合で native 側の鍵を扱う一覧' },
  { file: 'core/hooks-agents.mjs', expect: 'nativeHooks', reason: '旧「Pleiad がそろえる」から移すとき、作業場所の Hooks の行で止める相手（作業場所の定義を自分で持つエージェント = HOOK_AGENTS。ADR 0338）' },
  { file: 'web/hooks-card.mjs', expect: 'nativeHooks', reason: 'Hooks の機構を持つエージェントの欄（HOOK_AGENTS）' },
  // 互換エンドポイント（capabilities.compatEndpoints: true のエージェントだけ）
  { file: 'web/compat-presets.mjs', expect: 'compatEndpoints', reason: '互換エンドポイントの preset の対象' },
  { file: 'web/api-keys-settings.mjs', expect: 'compatEndpoints', reason: 'API キーの設定カードでエージェント名を出す対象（互換エンドポイントの利用者）' },
  // 固定の組（記述から引けないもの。引けるなら expect にする）
  { file: 'core/context-settings.mjs', ids: ['claude', 'codex'], reason: 'DEFAULT_SOURCES: 既定で探す探索元。新しいエージェントを既定で足すかは別の判断' },
  { file: 'core/context-scan.mjs', ids: ['claude', 'codex'], reason: 'ユーザーの全体の指示ファイルの別名（gemini は形式名でエージェントの id ではない）' },
  { file: 'core/plus/sync/targets.mjs', ids: ['claude', 'codex'], reason: 'Plus の同期で扱う形式の名（gemini は形式名でエージェントの id ではない）' },
  { file: 'core/mcp-config.mjs', ids: ['claude', 'codex', 'devin'], reason: '外部 MCP の設定ファイルとして読める形式（この 3 形式だけ読み方を持つ）' },
  { file: 'web/mcp-config.mjs', ids: ['claude', 'codex', 'devin'], reason: 'MCP の設定カードが扱える形式（core/mcp-config.mjs と同じ 3 形式）' },
  { file: 'core/ply-instructions.mjs', ids: ['claude', 'codex'], reason: 'LEGACY_AGENTS: 前の版の選択肢（固定の組。今の選択肢は DEFAULT_AGENT_IDS から引く）' },
  { file: 'core/computer-use/apps.mjs', ids: ['claude', 'codex'], reason: 'computer-use が起動したと見なす CLI の実行ファイル名（プロセス名との照合）' },
  { file: 'core/ops/mcp.mjs', ids: ['claude', 'codex', 'devin'], reason: 'MCP の操作が扱える形式（core/mcp-config.mjs と同じ 3 形式）' },
  { file: 'core/hooks-agents.mjs', ids: ['grok', 'devin'], reason: 'compat: Claude の設定の Hooks を自分で取り込むエージェントの取り込みの止め方（Grok の互換・Devin の取り込み。ADR 0338）' },
  { file: 'site/main.js', ids: ['claude', 'codex'], reason: 'デモの描画のためのチップの表（対応エージェントの名簿ではない）' },
  { file: 'site/tools/build-site.mjs', ids: ['claude', 'antigravity'], reason: 'サイトのロゴの素材名（openai はロゴのファイル名でエージェントの id ではない）' },
  { file: 'site/tools/check-i18n.mjs', ids: ['claude', 'antigravity'], reason: '英語版の {name} 置き換えの素材名（openai はロゴのファイル名でエージェントの id ではない）' },
];

const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

export function lintLists({ root = ROOT, allowed = ALLOWED, expected = null } = {}) {
  const files = new Map();
  for (const d of LIST_SCAN_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [], (name) => LIST_SKIP_DIRS.has(name))) {
      const file = rel(root, f);
      if (LIST_SKIP_FILE(file) || file.startsWith('core/backends/')) continue;
      files.set(file, scanCollections(fs.readFileSync(f, 'utf8')));
    }
  }
  const resolve = resolver(files);
  const EXP = expected ?? expectedSets();
  const problems = [];
  const used = new Array(allowed.length).fill(0);
  for (const [file, { collections }] of files) {
    for (const c of collections) {
      const ids = new Set(c.set);
      const missing = new Set();
      for (const r of c.refs) {
        const sub = resolve(file, r);
        if (sub) {
          for (const x of sub.ids) ids.add(x);
          for (const m of sub.missing) missing.add(m);
        } else missing.add(r);
      }
      if (ids.size < 2) continue;   // id が 1 つしか無いものは「一覧」と見なさない
      if ([...IDS].every(x => ids.has(x))) continue;   // 全エージェントを持つ一覧は合格
      const hit = allowed.findIndex((r) => {
        if (r.file !== file) return false;
        if (r.refs) { if (![...missing].every(m => r.refs.includes(m))) return false; }
        else if (missing.size) return false;
        const want = r.expect ? EXP[r.expect] : new Set(r.ids ?? []);
        return same(ids, want);
      });
      if (hit >= 0) { used[hit]++; continue; }
      const lack = [...IDS].filter(x => !ids.has(x));
      const where = c.name ? `（${c.name}）` : '';
      problems.push({
        rule: 'partial-list', file, line: c.line,
        message: `${file}:${c.line}${where}: エージェントの一覧に ${lack.join('・')} が無い。一覧へ足すか、一部だけが正しい一覧なら tests/lint-agents.mjs の ALLOWED に理由を書く`,
      });
    }
  }
  allowed.forEach((r, i) => {
    if (!used[i]) problems.push({ rule: 'unused-allow', file: r.file, message: `${r.file}: ALLOWED の宣言（${r.expect ?? r.ids?.join('・')}）に当たる一覧が無い。一覧が消えたか組が変わったので宣言を消すか直す` });
  });
  return { problems, scanned: files.size };
}

/* ==================== 自己診断 ==================== */
/** 失敗の文の配列（空なら通過）。規則 1 は架空の id、規則 2 は今のエージェントの記述で確かめる */
export function selftest() {
  const fails = [];
  const ok = (label, cond) => { if (!cond) fails.push(label); };
  // 規則 1
  const ids = ['alpha', 'beta'];
  const s1 = scanText(`if (x === 'alpha') y(); // 'beta'\nconst z = ["beta"];`, ids);
  ok('id-literal: 比較と配列の id を数え、コメントは数えない', s1.hits.length === 2 && s1.hits[0].line === 1 && s1.hits[1].line === 2);
  const s2 = scanText(`const a = 'alpha'; // backend-allow: 理由\n// backend-allow: 次の行の理由\nconst b = 'beta';\nconst c = 'beta'; // backend-allow`, ids);
  ok('id-literal: 理由付きの印は数えない（行末・直前の行）', s2.hits.length === 0 && s2.allowed.length === 3);
  ok('id-literal: 理由の無い印は失敗', s2.badMarks.length === 1 && s2.badMarks[0] === 4);
  ok('id-literal: 当たる印は死んでいない', s2.marks.length === 3 && s2.deadMarks.length === 0);
  const s3 = scanText(`t('alpha.errors.x'); const k = 'alphabet';`, ids);
  ok('id-literal: id を含むだけの文字列は数えない', s3.hits.length === 0);
  const s4 = scanText(`// backend-allow: 次の行に id が無い\nconst x = 'gamma';\nconst y = 1; // backend-allow: 行末だが id が無い\n// backend-allow: 2 行先には効かない\n\nconst z = 'alpha';`, ids);
  ok('dead-mark: 当たる直書きの無い印を拾う', JSON.stringify(s4.deadMarks) === '[1,3,4]' && s4.hits.length === 1);
  const scanned = { 'a.mjs': { hits: [{ line: 1, id: 'alpha' }, { line: 2, id: 'beta' }], allowed: [], badMarks: [], marks: [], deadMarks: [] } };
  ok('id-literal: 増えたら失敗', checkBaseline(scanned, { files: { 'a.mjs': 1 } }).some((p) => p.rule === 'increased'));
  ok('id-literal: 基準に無いファイルに出たら失敗', checkBaseline(scanned, { files: {} }).some((p) => p.rule === 'increased'));
  ok('id-literal: 減ったら下げさせる', checkBaseline({}, { files: { 'a.mjs': 1 } }).some((p) => p.rule === 'decreased'));
  ok('id-literal: 同じなら通る', checkBaseline(scanned, { files: { 'a.mjs': 2 } }).length === 0);
  const marked = { 'b.mjs': { hits: [], allowed: [{ line: 1 }], badMarks: [], marks: [1], deadMarks: [] } };
  ok('allow-marks: 印が増えたら失敗', checkBaseline(marked, { allowMarks: 0, files: {} }).some((p) => p.rule === 'allow-marks'));
  ok('allow-marks: 印が減ったら下げさせる', checkBaseline({}, { allowMarks: 1, files: {} }).some((p) => p.rule === 'decreased'));
  ok('dead-mark: 死んだ印は失敗', checkBaseline({ 'c.mjs': { ...marked['b.mjs'], deadMarks: [1] } }, { allowMarks: 1, files: {} }).some((p) => p.rule === 'dead-mark'));
  ok('id-literal: 走査から外す場所（作られたもの・外の CLI の写し）', ['site/docs/src/a.mjs', 'site/dist/a.js', 'site/.astro/a.mjs', 'scripts/zero-downtime/codex/a.mjs', 'core/backends/a.mjs']
    .every((f) => ID_EXCLUDE.some((re) => re.test(f))) && !ID_EXCLUDE.some((re) => re.test('scripts/zero-downtime/stage1-7/a.mjs')));
  // 規則 2: 拾える形・許可・見逃し
  const all = DEFAULT_AGENT_IDS;
  const src = [
    `import { HOOK_AGENTS } from '../core/hooks-config.mjs';`,
    `const A = ['${all[0]}', '${all[1]}'];`,                               // 部分一覧 → 拾う
    `const B = [${all.map((id, i) => `['${id}', ${i}]`).join(', ')}];`,    // 全部 → 通る
    `const C = { ${all[0]}: 1, ${all[1]}: 2 };`,                           // キーの一覧 → 拾う
    `function f() { const ${all[0]} = 1; const out = []; }`,               // ブロック・1 個だけ → 拾わない
    `const D = [...HOOK_AGENTS, ['${all.at(-2)}', 'x'], ['${all.at(-1)}', 'y']];`,   // 参照の解決 → 拾う（HOOK_AGENTS は import 先）
    `const E = x === '${all[0]}' && y === '${all[1]}';`,                   // 比較 → 拾わない
  ].join('\n');
  const { collections, decls, imports } = scanCollections(src);
  const got = collections.filter((c) => c.set.size >= 2).map((c) => [...c.set].sort().join(',')).sort();
  const pair = [all[0], all[1]].sort().join(',');
  const want = [pair, pair, [...all].sort().join(','), [all.at(-2), all.at(-1)].sort().join(',')].sort();
  ok(`agent-list: 拾った一覧が違う: ${JSON.stringify(got)}`, JSON.stringify(got) === JSON.stringify(want));
  ok('agent-list: const の一覧を記録する', decls.has('A') && [...decls.get('A').all].includes(all[0]));
  ok('agent-list: import の記録', imports.has('HOOK_AGENTS'));
  return fails;
}

/* ==================== まとめ ==================== */
export function lintRepo(opts = {}) {
  const ids = lintIds(opts);
  const lists = lintLists({ root: opts.root });
  return { ids, lists, problems: [...ids.problems, ...lists.problems] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.includes('--update-baseline')) {
    const r = updateBaseline();
    if (!r.ok) { console.error('基準を上げる更新は拒む:', r.raised.map(([f, n]) => `${f}=${n}`).join(' ')); process.exit(1); }
    console.log('基準を更新した:', path.relative(ROOT, BASELINE_FILE));
    process.exit(0);
  }
  const result = lintRepo();
  const fails = selftest();
  if (args.includes('--json')) console.log(JSON.stringify({ total: result.ids.total, allowMarks: result.ids.allowMarks, problems: result.problems, selftest: fails }, null, 2));
  else {
    for (const p of result.problems) console.error(`✗ [${p.rule}] ${p.message}`);
    for (const f of fails) console.error('✗ 自己診断:', f);
    console.log(`id-literal: 直書き ${result.ids.total} 件（${Object.keys(result.ids.scanned).length} ファイル）・backend-allow の印 ${result.ids.allowMarks} 件`);
    console.log(`agent-list: ${result.lists.scanned} ファイルを走査`);
    console.log(result.problems.length || fails.length ? `${result.problems.length + fails.length} 件の問題` : 'OK');
  }
  process.exit(result.problems.length || fails.length ? 1 : 0);
}
