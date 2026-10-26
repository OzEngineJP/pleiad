#!/usr/bin/env node
/* ==================== エージェントの id の直書きの lint ====================
   エージェントごとの知識は core/backends/（バックエンドと、エージェントの記述 agents.mjs）に置き、ほかの場所は能力の印
   （core/backends/capability-marks.mjs。エージェントごとの状態は agent-marks.mjs）とエージェントの記述から引く（docs/multi-backend.md「エージェントを足す」）。
   その外に id を直に書くと、エージェントを足したときに黙って足りなくなる（一覧に無い・分岐に当たらない）ので、数えて増やさない。

     node tests/lint-backends.mjs [--update-baseline] [--json]

   検査すること（基準は tests/backends-baseline.json。i18n の lint・操作の一覧の lint と同じ「下がる一方の基準（ラチェット）」）:
   1. core/（core/backends/ を除く）・web/・desktop/・bin/ の JS で、エージェントの id（エージェントの記述の id。fake を除く）と
      ちょうど同じ文字列リテラル（'claude'・"codex"・`antigravity`）を、ファイルごとに数える。コメントは数えない。
      比べる・並べる・getBackend('codex') のように引く書き方を拾う。オブジェクトの裸のキー（{ claude: … }）は拾わない（字句解析が文字列しか返さない）。
   2. 数えないのは、`backend-allow: 理由` の印がある行（行末か、直前の行にコメントだけで）。理由の無い印は失敗。
      印を付けてよいのは、そのエージェントだけの事情で、能力の印にする意味が無いもの（Claude の transcript の救済など）。
   3. ファイルごとの件数を基準と比べ、増えた・基準に無いファイルに出た → 失敗。減った → 「基準を下げてください」で失敗
      （--update-baseline で下げる。上げる更新は拒む）。
   4. 自己診断（selftest。npm test でも回す）。

   npm test からは tests/unit/backends-lint.mjs が lintRepo() と selftest() を直接呼ぶ。 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanJs } from './lint-i18n.mjs';
import { AGENTS } from '../core/backends/agents.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = path.join(ROOT, 'tests', 'backends-baseline.json');

const SCAN_DIRS = ['core', 'web', 'desktop', 'bin'];
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);
/* エージェントの知識を置いてよい場所（数えない） */
const EXCLUDE = [/^core\/backends\//, /^web\/locales\//, /node_modules\//];
/** 数えるエージェントの id。試験用の fake は、試験の分岐（computerDriver.kind === 'fake' など）と区別できないので数えない */
export const AGENT_IDS = Object.freeze(Object.keys(AGENTS).filter((id) => id !== 'fake'));
const ALLOW_MARK = /backend-allow\b(?:\s*:\s*(.*?))?\s*(?:\*\/|-->)?\s*$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (JS_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

export function listFiles(root = ROOT) {
  return SCAN_DIRS.filter((d) => existsSync(path.join(root, d))).flatMap((d) => walk(path.join(root, d)))
    .map((f) => path.relative(root, f).replace(/\\/g, '/')).filter((f) => !EXCLUDE.some((re) => re.test(f))).sort();
}

/**
 * 1 つのファイルの id の直書き。{ hits: [{ line, id }], allowed: [{ line, id, reason }], badMarks: [line] }
 * ids は数える id（既定は AGENT_IDS）
 */
export function scanText(text, ids = AGENT_IDS) {
  const wanted = new Set(ids);
  const { literals, comments } = scanJs(text);
  const lines = text.split(/\r?\n/);
  const commentOnly = new Set(comments.filter((c) => lines[c.line - 1]?.trim().startsWith('//') || lines[c.line - 1]?.trim().startsWith('/*') || lines[c.line - 1]?.trim().startsWith('*')).map((c) => c.line));
  const markOn = (line) => {
    const own = comments.find((c) => c.line === line && ALLOW_MARK.test(c.text));
    if (own) return own;
    const prev = comments.find((c) => c.line === line - 1 && commentOnly.has(line - 1) && ALLOW_MARK.test(c.text));
    return prev ?? null;
  };
  const hits = [], allowed = [], badMarks = new Set();
  for (const lit of literals) {
    if (!wanted.has(lit.text)) continue;
    const mark = markOn(lit.line);
    if (!mark) { hits.push({ line: lit.line, id: lit.text }); continue; }
    const reason = ALLOW_MARK.exec(mark.text)?.[1]?.trim();
    if (!reason) badMarks.add(mark.line);
    allowed.push({ line: lit.line, id: lit.text, reason: reason ?? '' });
  }
  return { hits, allowed, badMarks: [...badMarks] };
}

export function scanRepo(root = ROOT, ids = AGENT_IDS) {
  const files = {};
  for (const file of listFiles(root)) {
    const result = scanText(readFileSync(path.join(root, file), 'utf8'), ids);
    if (result.hits.length || result.allowed.length || result.badMarks.length) files[file] = result;
  }
  return files;
}

export function readBaseline(file = BASELINE_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { _comment: '', files: {} };
}

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
    if (n < was) problems.push({ rule: 'decreased', file, message: `${file}: ${was} → ${n} に減った。基準を下げてください（node tests/lint-backends.mjs --update-baseline）` });
  }
  for (const [file, r] of Object.entries(scanned)) {
    for (const line of r.badMarks) problems.push({ rule: 'mark', file, message: `${file}:${line}: backend-allow の印に理由が無い` });
  }
  return problems;
}

export function formatBaseline(files) {
  const sorted = Object.fromEntries(Object.entries(files).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    _comment: 'エージェントの id の直書きの件数（tests/lint-backends.mjs）。増やせない。減らしたら node tests/lint-backends.mjs --update-baseline で下げる',
    files: sorted,
  }, null, 2) + '\n';
}

export function lintRepo({ root = ROOT, baselineFile = BASELINE_FILE } = {}) {
  const scanned = scanRepo(root);
  const baseline = readBaseline(baselineFile);
  return { scanned, problems: checkBaseline(scanned, baseline), total: Object.values(scanned).reduce((n, r) => n + r.hits.length, 0) };
}

/** 基準を下げる（上がるファイルがあれば拒む） */
export function updateBaseline({ root = ROOT, baselineFile = BASELINE_FILE } = {}) {
  const scanned = scanRepo(root);
  const base = readBaseline(baselineFile).files ?? {};
  const next = Object.fromEntries(Object.entries(scanned).map(([f, r]) => [f, r.hits.length]));
  const raised = Object.entries(next).filter(([f, n]) => n > (base[f] ?? 0));
  if (raised.length && Object.keys(base).length) return { ok: false, raised };
  writeFileSync(baselineFile, formatBaseline(next));
  return { ok: true, raised: [] };
}

/** 自己診断。失敗の文の配列（空なら通過） */
export function selftest() {
  const fails = [];
  const ok = (label, cond) => { if (!cond) fails.push(label); };
  const ids = ['alpha', 'beta'];
  const s1 = scanText(`if (x === 'alpha') y(); // 'beta'\nconst z = ["beta"];`, ids);
  ok('比較と配列の id を数え、コメントは数えない', s1.hits.length === 2 && s1.hits[0].line === 1 && s1.hits[1].line === 2);
  const s2 = scanText(`const a = 'alpha'; // backend-allow: 理由\n// backend-allow: 次の行の理由\nconst b = 'beta';\nconst c = 'beta'; // backend-allow`, ids);
  ok('理由付きの印は数えない（行末・直前の行）', s2.hits.length === 0 && s2.allowed.length === 3);
  ok('理由の無い印は失敗', s2.badMarks.length === 1 && s2.badMarks[0] === 4);
  const s3 = scanText(`t('alpha.errors.x'); const k = 'alphabet';`, ids);
  ok('id を含むだけの文字列は数えない', s3.hits.length === 0);
  const scanned = { 'a.mjs': { hits: [{ line: 1, id: 'alpha' }, { line: 2, id: 'beta' }], allowed: [], badMarks: [] } };
  ok('増えたら失敗', checkBaseline(scanned, { files: { 'a.mjs': 1 } }).some((p) => p.rule === 'increased'));
  ok('基準に無いファイルに出たら失敗', checkBaseline(scanned, { files: {} }).some((p) => p.rule === 'increased'));
  ok('減ったら下げさせる', checkBaseline({}, { files: { 'a.mjs': 1 } }).some((p) => p.rule === 'decreased'));
  ok('同じなら通る', checkBaseline(scanned, { files: { 'a.mjs': 2 } }).length === 0);
  return fails;
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
  if (args.includes('--json')) console.log(JSON.stringify({ total: result.total, problems: result.problems, selftest: fails }, null, 2));
  else {
    for (const p of result.problems) console.error(p.message);
    for (const f of fails) console.error('自己診断:', f);
    console.log(`エージェントの id の直書き: ${result.total} 件（${Object.keys(result.scanned).length} ファイル）`);
  }
  process.exit(result.problems.length || fails.length ? 1 : 0);
}
