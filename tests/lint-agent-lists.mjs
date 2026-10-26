#!/usr/bin/env node
/**
 * エージェントの一覧への入れ忘れを見つける lint（Issue #145）
 *
 * 使い方:
 *   node tests/lint-agent-lists.mjs [--json]
 *
 * 検査すること:
 *   1) JS のソースで、`{ ... }` のキーや `[ ... ]`・`[... ]` 内の入れ子の要素として
 *      エージェントの id（core/backends/agents.mjs の記述。試験用の fake は除く）が
 *      2 個以上並んだ「一覧」を拾う。比較（a === 'claude'）や 'claude:model' のような
 *      語の中の id、コメント・文字列の中身は拾わない。
 *   2) 一覧に全エージェントが揃っていれば合格。揃っていなければ ALLOWED で
 *      「この一覧が持つべき組」をエージェントの記述から引く（expect）か、
 *      固定の組（ids）と理由を宣言した一覧だけを許す。宣言の無い部分一覧はエラー。
 *      エージェントを足して落ちたら、一覧へ足すか、一部だけが正しい一覧である理由を ALLOWED に書く。
 *   3) ALLOWED の宣言が余分（当たる一覧が無い・組が合わない）ときもエラー。
 *      許可リストが腐らないようにするため。
 *
 * 分かることの限界（別の検査で補う）:
 *   - 比較・代入の単発の id（`'x' === 'claude'`）は一覧ではないので拾わない。
 *     直書きの件数の抑制は tests/lint-backends.mjs が担う。
 *   - オブジェクトの値・三項演算子の結果の id はキーではないので拾わない。
 *   - `...` の広げは、同じファイルの const と import の先の const まで辿って中身を読む。
 *     関数の戻り値（Object.keys(HOOK_EMULATED) など）は中身が読めないので、
 *     許可リストでは refs に参照の名前を書いて「読めない参照がある」ことを宣言する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, DEFAULT_AGENT_IDS } from '../core/backends/agents.mjs';
import { CAPABILITY_STATES } from '../core/backends/agent-marks.mjs';
import { HOOK_AGENTS, UNIFY_TARGETS } from '../core/hooks-config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['core', 'web', 'desktop', 'bin', 'site'];
const SKIP_DIRS = new Set(['node_modules', 'locales']);
const SKIP_FILE = file => /(^|[/\\])backends[/\\][^/\\]+\.mjs$/.test(file);   // エージェントの記述そのものは正本なので対象外
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
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
      const rel = toks[j]?.k === 'lit' ? toks[j].v : (toks[j + 1]?.k === 'lit' ? toks[j + 1].v : null);
      for (let k = ti + 1; k < j; k++) if (toks[k].k === 'id' && !['import', 'as', 'type'].includes(toks[k].v)) names.push(toks[k].v);
      if (rel) for (const nm of names) imports.set(nm, rel);
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
        const p = path.normalize(path.join(path.dirname(file), target));
        found = resolve(p, name, [...via, key]) ?? { ids: new Set(), missing: new Set([name]) };
      }
    }
    memo.set(key, found);
    return found;
  };
  return resolve;
}

// ---- 正本から引く「持つべき組」 ----
export function expectedSets(root = ROOT) {
  return {
    // Hooks の機構をそのまま持つエージェント（core/hooks-config.mjs の HOOK_AGENTS）
    nativeHooks: new Set(HOOK_AGENTS),
    // Hooks の統合の対象（機構そのまま＋記述の hooksAs で形を写せるもの。core/hooks-config.mjs の UNIFY_TARGETS）
    unifyTargets: new Set(UNIFY_TARGETS),
    // Hooks のイベント名の表を持つエージェント（機構そのまま＋plugin 経由で表が要るもの）
    hookEventOwners: new Set([...HOOK_AGENTS, ...DEFAULT_AGENT_IDS.filter(id => AGENTS[id].hooksVia === 'plugin')]),
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
  { file: 'web/hooks-card.mjs', expect: 'nativeHooks', reason: 'Hooks の機構を持つエージェントの欄（HOOK_AGENTS）' },
  { file: 'web/hooks-card.mjs', expect: 'unifyTargets', reason: 'Hooks の統合の対象の欄（UNIFY_TARGETS）' },
  // 互換エンドポイント（capabilities.compatEndpoints: true のエージェントだけ）
  { file: 'core/compat-endpoints.mjs', expect: 'compatEndpoints', reason: '互換エンドポイントを立てられるエージェント' },
  { file: 'web/compat-endpoints.mjs', expect: 'compatEndpoints', reason: '互換エンドポイントの画面の対象' },
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
  { file: 'core/backend-shape-diagnostics.mjs', ids: ['claude', 'codex', 'antigravity'], reason: '会話ログの形の診断・検証済みの版を持つバックエンド（ログを読む実装があるものだけ）' },
  { file: 'core/ops/mcp.mjs', ids: ['claude', 'codex', 'devin'], reason: 'MCP の操作が扱える形式（core/mcp-config.mjs と同じ 3 形式）' },
  { file: 'site/main.js', ids: ['claude', 'codex'], reason: 'デモの描画のためのチップの表（対応エージェントの名簿ではない）' },
  { file: 'site/tools/build-site.mjs', ids: ['claude', 'antigravity'], reason: 'サイトのロゴの素材名（openai はロゴのファイル名でエージェントの id ではない）' },
  { file: 'site/tools/check-i18n.mjs', ids: ['claude', 'antigravity'], reason: '英語版の {name} 置き換えの素材名（openai はロゴのファイル名でエージェントの id ではない）' },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); continue; }
    if (JS_EXT.has(path.extname(e.name))) out.push(path.join(dir, e.name));
  }
  return out;
}

const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

export function lintRepo({ root = ROOT, allowed = ALLOWED, expected = null } = {}) {
  const files = new Map();
  for (const d of SCAN_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (SKIP_FILE(rel) || rel.startsWith('core/backends/')) continue;
      files.set(rel, scanCollections(fs.readFileSync(f, 'utf8')));
    }
  }
  const resolve = resolver(files);
  const EXP = expected ?? expectedSets(root);
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
      const hit = allowed.findIndex((r, i) => {
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
        message: `${file}:${c.line}${where}: エージェントの一覧に ${lack.join('・')} が無い。一覧へ足すか、一部だけが正しい一覧なら tests/lint-agent-lists.mjs の ALLOWED に理由を書く`,
      });
    }
  }
  allowed.forEach((r, i) => {
    if (!used[i]) problems.push({ rule: 'unused-allow', file: r.file, message: `${r.file}: ALLOWED の宣言（${r.expect ?? r.ids?.join('・')}）に当たる一覧が無い。一覧が消えたか組が変わったので宣言を消すか直す` });
  });
  return { problems, scanned: files.size };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems, scanned } = lintRepo();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ problems, scanned }, null, 2));
  else {
    for (const p of problems) console.error(`✗ ${p.message}`);
    console.error(problems.length ? `\n${problems.length} 件の問題（${scanned} ファイルを走査）` : `OK（${scanned} ファイルを走査）`);
  }
  process.exit(problems.length ? 1 : 0);
}
