// 公開文書の生成に使う core/ のファイルの一覧（DOCS_SOURCE_FILES）と、その閉包を確かめる道具。
//
// site/tools/build-site.mjs は、最新の安定版のタグから raw.githubusercontent.com でこの一覧のファイルを取り、
// site/docs/scripts/generate.mjs に渡す（ADR 0271・0274）。Cloudflare の clone は浅くタグを持たないので、
// git show ではなく Releases API のタグを使う。
//
// 一覧は「エージェントのページの生成に読むファイル」とその相対 import の閉包。ファイルを足したら一覧にも足す。
// 漏れは tests/unit/docs-source.mjs が、依存を辿った閉包と一覧を突き合わせて落とす。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** エージェントごとのページの生成に使うファイル（リポジトリの根からの相対。取る順でもある） */
export const DOCS_SOURCE_FILES = Object.freeze([
  "core/backends/agents.mjs",
  "core/backends/capability-marks.mjs",
  "core/backends/agent-marks.mjs",
  "core/backends/computer-timing.mjs",
]);

/** 古いタグ（新しいモジュールが無い）で、一覧だけを作るときに使うファイル */
export const DOCS_INDEX_FILE = "core/backends/agents.mjs";

/** 相対 import の指定を集める（静的な import・export from・動的な import()） */
export function importSpecifiers(source) {
  const specs = new Set();
  for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.add(m[1]);
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.add(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

/**
 * entries（リポジトリの根からの相対）から相対 import を辿った閉包。
 * files はリポジトリの根からの / 区切りの相対（entries を含む、重複なし）。problems は外部の import と読めないファイル。
 */
export function closureOf(entries, root = REPO_ROOT) {
  const files = new Set();
  const problems = [];
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    files.add(rel);
    const file = path.join(root, rel);
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (err) {
      problems.push(`${rel}: 読めない（${err.code ?? err.message}）`);
      continue;
    }
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        problems.push(`${rel}: 相対でない import（${spec}）。公開文書の生成に使うファイルは、相対 import と node: の組み込みだけで閉じる`);
        continue;
      }
      const target = path.relative(root, path.resolve(path.dirname(file), spec)).split(path.sep).join("/");
      if (target.startsWith("..")) {
        problems.push(`${rel}: リポジトリの外を指す import（${spec}）`);
        continue;
      }
      queue.push(target);
    }
  }
  return { files: [...files].sort(), problems };
}
