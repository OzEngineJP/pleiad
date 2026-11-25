// tests/browser/git-panel-load.cjs の種。git パネルの読み込みの形を、使い捨てのリポジトリと fake の会話で作る。
//   gpl-far … 80 コミットのリポジトリ（最初に読む 50 件を超える）。履歴の先頭ページと「続きを読む」の確認に使う
// 会話の cwd はこのリポジトリ。ほかに worktree を 3 つ作る（作業場所のタブの確認）。
// 「この会話の間」の範囲と会話の始まりの目印（隠し ref の撮影）は ADR 0352 で消したので、種にも作らない。
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

const hashes = [];
for (let i = 0; i < 80; i++) hashes.push(commit(day + i * 20 * 60_000));

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
make("gpl-far", "Far start", day + 10 * 20 * 60_000);
fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify(conversations));
fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(sessions));
console.log(`seeded 1 session in ${repo} (${hashes.length} commits, 3 worktrees)`);
