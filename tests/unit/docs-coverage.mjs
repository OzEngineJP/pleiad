// 公開リファレンス（site/docs）: 利用者に見える機能と、載せるページの対応表（site/docs/docs-coverage.json）の検査。
//   機能の一覧はコードから作る（site/tools/docs-features.mjs。agents・操作の名前空間・設定・能力の印）。
//   - 機能にページ（cover）も除外の理由（except）も無い → 落とす
//   - 対応表に載るがコードに無いキー（消した・変えた機能の残り）→ 落とす
//   - cover のページ: 手書きなら ja・en の両方のファイルが要る。generated に書いたものは generate.mjs が組む約束として数える
//   - agent:<id> は、生成されるエージェントのページに差し込む手書きの断片
//     agents/<id>/_connect.md（日本語）と en/agents/<id>/_connect.md（英語）が要る
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, featureKeys, sourceFiles, loadAgentsFromPath, loadMarks } from '../../site/tools/docs-features.mjs';
import os from 'node:os';

export const name = 'docs-coverage';
export const title = '公開文書: 利用者に見える機能とページの対応表';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(ROOT, 'site', 'docs');
const CONTENT = path.join(DOCS, 'src', 'content', 'docs');
const MANIFEST = path.join(DOCS, 'docs-coverage.json');

/** slug に対応する手書きのページのファイル（<slug>.md(x) か <slug>/index.md(x)）。無ければ null */
const pageFile = (dir, slug) => {
  for (const rel of [`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`]) {
    const p = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return null;
};

/** generated の宣言（'agents/<id>' のような型）に slug が合うか */
const generatedMatch = (generated, slug) => Object.keys(generated).some((pattern) => {
  if (pattern === slug) return true;
  // <id>・<name> などの型は 1 区分の任意の字に合う
  const re = new RegExp('^' + pattern.split('/').map((part) => (part.startsWith('<') && part.endsWith('>') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');
  return re.test(slug);
});

export default async function (t) {
  // ---- 機能一覧（コードから） ----
  const agents = await loadAgentsFromPath(path.join(ROOT, 'core', 'backends', 'agents.mjs'));
  t.ok('エージェントの一覧が agents.mjs から取れる', Object.keys(agents).length > 0, Object.keys(agents).join(', '));

  const files = {};
  const missing = [];
  for (const rel of sourceFiles(agents)) {
    const p = path.join(ROOT, ...rel.split('/'));
    if (fs.existsSync(p)) files[rel] = fs.readFileSync(p, 'utf8');
    else missing.push(rel);
  }
  t.ok('機能一覧の元のファイルがそろっている', missing.length === 0, missing.join(', '));

  const readNow = (rel) => { const p = path.join(ROOT, ...rel.split('/')); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
  const marks = await loadMarks(readNow, fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-')));
  t.ok('能力の印の状態が core/backends/agent-marks.mjs から取れる', marks && Object.keys(marks).length > 0);
  const inv = inventory(files, agents, marks);
  const keys = featureKeys(inv);
  t.ok('機能の一覧が取れる（エージェント・操作・設定・能力の印）', keys.length > 0, `${keys.length} 件`);

  // ---- 対応表 ----
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {
    t.ok('対応表 site/docs/docs-coverage.json が JSON として読める', false, String(e?.message ?? e));
    return;
  }
  const generated = manifest.generated ?? {};
  const cover = manifest.cover ?? {};
  const except = manifest.except ?? {};

  // 機能 → ページか除外の理由
  const uncovered = keys.filter((k) => !(k in cover) && !(k in except));
  t.ok('利用者に見える機能は全部、ページか除外の理由が付いている', uncovered.length === 0, uncovered.join(', '));

  // 対応表にだけ残る古いキー
  const keySet = new Set(keys);
  const stale = [...Object.keys(cover), ...Object.keys(except)].filter((k) => !keySet.has(k));
  t.ok('対応表にコードに無い機能が残っていない', stale.length === 0, stale.join(', '));

  // 除外の理由は書く
  const noReason = Object.entries(except).filter(([, reason]) => typeof reason !== 'string' || !reason.trim()).map(([k]) => k);
  t.ok('除外した機能には理由が書いてある', noReason.length === 0, noReason.join(', '));

  // cover のページ: 手書きは ja・en の両方、生成は generated に宣言が要る
  const badPages = [];
  for (const [key, slug] of Object.entries(cover)) {
    if (generatedMatch(generated, slug)) continue;
    const ja = pageFile(CONTENT, slug);
    const en = pageFile(path.join(CONTENT, 'en'), slug);
    if (!ja || !en) badPages.push(`${key} → ${slug}（${!ja ? 'ja ' : ''}${!en ? 'en ' : ''}無し）`);
  }
  t.ok('cover のページは手書き（ja・en）か生成の宣言済み', badPages.length === 0, badPages.join(', '));

  // 生成されるエージェントのページに差し込む手書きの断片（ja・en の両方）
  const noFragment = Object.entries(cover)
    .filter(([key]) => key.startsWith('agent:') && generatedMatch(generated, cover[key]))
    .map(([key]) => key.slice('agent:'.length))
    .filter((id) => !fs.existsSync(path.join(CONTENT, 'agents', id, '_connect.md')) || !fs.existsSync(path.join(CONTENT, 'en', 'agents', id, '_connect.md')))
    .map((id) => `agents/${id}/_connect.md, en/agents/${id}/_connect.md`);
  t.ok('載せるエージェントには手書きの断片（agents/<id>/_connect.md・en/agents/<id>/_connect.md）がある', noFragment.length === 0, noFragment.join(', '));

  // 対応表の同じ機能が cover と except の両方に無い
  const both = Object.keys(cover).filter((k) => k in except);
  t.ok('同じ機能が cover と except の両方に無い', both.length === 0, both.join(', '));

  // generated の宣言は空でない slug
  const badGenerated = Object.entries(generated).filter(([slug, note]) => !slug || typeof note !== 'string' || !note.trim()).map(([slug]) => slug || '(空)');
  t.ok('generated の宣言は slug と一言を持つ', badGenerated.length === 0, badGenerated.join(', '));
}
