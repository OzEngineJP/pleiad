// tests/browser/browser-files-load.cjs の種（ADR 0320）。右の欄のファイルの読み直しと待っている間の見せ方を確かめるための、
// 使い捨てのリポジトリと fake の会話を 1 つ作る。リポジトリには文書・コード・表・HTML と、未追跡の 300 ファイル（変更の件数が重くなる量）を置く。
// 使い方: node tests/browser/browser-files-load-seed.mjs <空のデータ置き場> <リポジトリを作る空のフォルダー>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [dir, repo] = process.argv.slice(2);
if (!dir || !repo) throw new Error("usage: node browser-files-load-seed.mjs <data dir> <repo dir>");
fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "gen"), { recursive: true });

const sh = (args) => execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const w = (file, text) => fs.writeFileSync(path.join(repo, file), text);
sh(["init", "-q", "-b", "main"]);
w("docs/plan.md", ["# 計画書", "", ...Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}。ファイルを開き直したら読み直す。待っている間は骨組みを出す。`)].join("\n\n"));
w("docs/notes.md", "# メモ\n\n- 一つ目\n- 二つ目\n");
w("src/app.js", Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
w("data.csv", `a,b,c\n${Array.from({ length: 30 }, (_, i) => `${i},${i * 2},${i * 3}`).join("\n")}\n`);
w("page.html", '<!doctype html><meta charset="utf-8"><title>p</title><h1>HTML ページ</h1><div style="height:1600px">長い</div>');
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);
for (let i = 0; i < 300; i++) w(`gen/f${i}.txt`, `file ${i}\n`);

const at = Date.parse("2026-11-12T09:00:00+09:00");
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const id = "bf-1";
const messages = [
  { role: "user", text: "計画を開いてください", uuid: `claude:${id}:u1`, at: iso(at), backend: "claude" },
  { role: "assistant", text: "開きました。", uuid: `claude:${id}:a1`, at: iso(at + 60_000), backend: "claude" },
];
fs.writeFileSync(path.join(dir, "conversations", `${id}.json`), JSON.stringify({ messages }));
fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify({ [id]: { segments: [{ backend: "claude", nativeId: `n-${id}` }],
  info: { sessionId: id, title: "ファイルの読み直し", cwd: repo, createdAt: at, lastModified: at + 60_000 }, backend: "fake", nativeId: null, base: messages.length } }));
fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ [id]: { backend: "fake", title: "ファイルの読み直し", cwd: repo, createdAt: at, lastModified: at + 60_000 } }));
console.log(`seeded session ${id} in ${repo} (3 committed files + 300 untracked)`);
