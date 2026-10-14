// tests/browser/git-panel-load.cjs の種。git パネルの読み込みの 3 つの形を、使い捨てのリポジトリと fake の会話で作る。
//   gpl-near … 会話の始まりが読んだ範囲の中（⚑ が行に付く。札なし）
//   gpl-far  … 会話の始まりが最初に読む 50 件より前（札「読み込んだ範囲より前です［始まりまで読む］」）
//   gpl-lost … 会話の始まりのコミットがどの ref からも辿れない（「見つかりませんでした」）
// どの会話も cwd は同じリポジトリ。ほかに worktree を 3 つ作る（作業場所のタブの確認）。
// 使い方: node tests/browser/git-panel-load-seed.mjs <空のデータ置き場> <リポジトリを作る空のフォルダー>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [dir, repo] = process.argv.slice(2);
if (!dir || !repo) throw new Error("usage: node git-panel-load-seed.mjs <data dir> <repo dir>");
fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
fs.mkdirSync(repo, { recursive: true });

const day = Date.parse("2026-10-13T09:00:00+09:00");
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const sh = (cwd, args, at) => execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "-c", "commit.gpgsign=false", ...args], {
  cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: iso(at ?? day), GIT_COMMITTER_DATE: iso(at ?? day) },
}).trim();

sh(repo, ["init", "-q", "-b", "main"]);
let n = 0;
const subjects = ["Fix the tooltip position", "Add the empty state", "Tidy up the settings page", "Handle a missing file", "Update the dependencies", "Rename the helper", "Speed up the list", "Cover the edge case"];
const commit = (at) => {
  n++;
  fs.writeFileSync(path.join(repo, `f${n % 9}.txt`), `${n}\n`);
  sh(repo, ["add", "-A"], at);
  sh(repo, ["commit", "-q", "-m", `${subjects[n % subjects.length]} (${n})`], at);
  return sh(repo, ["rev-parse", "HEAD"]);
};
// 会話の始まりの目印は「そのときの HEAD」。隠し ref の start の撮影コミットの親になる
const snapshot = (sessionId, parent, at) => {
  const tree = sh(repo, ["rev-parse", `${parent}^{tree}`]);
  const snap = sh(repo, ["commit-tree", tree, "-p", parent, "-m", "pleiad turn snapshot"], at);
  sh(repo, ["update-ref", `refs/pleiad/turn/${sessionId}/1-start`, snap]);
};

const hashes = [];
for (let i = 0; i < 80; i++) hashes.push(commit(day + i * 20 * 60_000));
// 孤立したコミット（どのブランチ・タグからも辿れない）。lost の会話の始まりに使う
const orphanTree = sh(repo, ["rev-parse", "HEAD^{tree}"]);
const orphan = sh(repo, ["commit-tree", orphanTree, "-m", "unreachable"], day);

snapshot("gpl-near", hashes[hashes.length - 4], day + 79 * 20 * 60_000);   // 先頭から 3 つ前（最初の 50 件の中）
snapshot("gpl-far", hashes[9], day + 10 * 20 * 60_000);                  // 先頭から 70 番目（最初の 50 件より前）
snapshot("gpl-lost", orphan, day + 5 * 60_000);

// 作業場所（作業場所のタブ用）。1 つは未コミットの変更つき
for (const [i, name] of ["ui-polish", "perf-spike", "docs-pass"].entries()) {
  const wt = `${repo}-${name}`;
  sh(repo, ["worktree", "add", "-q", "-b", `pleiad/${name}`, wt]);
  fs.writeFileSync(path.join(wt, `${name}.txt`), "x\n");
  sh(wt, ["add", "-A"], day + (90 + i) * 20 * 60_000);
  sh(wt, ["commit", "-q", "-m", `${name}: first pass`], day + (90 + i) * 20 * 60_000);
  if (i === 0) fs.writeFileSync(path.join(wt, "wip.txt"), "wip\n");
}

// fake の会話（保存分）
const conversations = {};
const sessions = {};
const make = (id, title, at) => {
  const messages = [
    { role: "user", text: `${title}を直してください`, uuid: `claude:${id}:u1`, at: iso(at), backend: "claude" },
    { role: "assistant", text: "直しました。", uuid: `claude:${id}:a1`, at: iso(at + 60_000), backend: "claude" },
  ];
  const info = { sessionId: id, title, cwd: repo, createdAt: at, lastModified: at + 60_000 };
  fs.writeFileSync(path.join(dir, "conversations", `${id}.json`), JSON.stringify({ messages }));
  conversations[id] = { segments: [{ backend: "claude", nativeId: `n-${id}` }], info, backend: "fake", nativeId: null, base: messages.length };
  sessions[id] = { backend: "fake", title, cwd: repo, createdAt: at, lastModified: at + 60_000 };
};
make("gpl-near", "Near start", day + 79 * 20 * 60_000);
make("gpl-far", "Far start", day + 10 * 20 * 60_000);
make("gpl-lost", "Lost start", day + 5 * 60_000);
fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify(conversations));
fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(sessions));
console.log(`seeded 3 sessions in ${repo} (${hashes.length} commits, 3 worktrees)`);
