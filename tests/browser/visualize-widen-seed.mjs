// tests/browser/visualize-widen.cjs の種。会話内の可視化（visualize の提示）を 1 件だけ持つ短い会話を fake のデータ置き場に置く。
// 使い方: node tests/browser/visualize-widen-seed.mjs <空のデータ置き場> <作業ディレクトリ>
import fs from "node:fs";
import path from "node:path";

const [dir, cwd] = process.argv.slice(2);
if (!dir || !cwd) throw new Error("usage: node visualize-widen-seed.mjs <data dir> <cwd>");
fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
fs.mkdirSync(path.join(dir, "presents"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const ID = "visualize-widen";
const start = Date.parse("2026-10-20T09:00:00+09:00");
const at = (k) => new Date(start + k * 60_000).toISOString();
const reference = `visualize{"path":"${cwd}/chart.html","title":"chart"}`;
const bars = Array.from({ length: 12 }, (_, i) => `<div style="flex:1;height:${40 + i * 10}px;background:#3c4a9e"></div>`).join("");
const presents = [{
  at: at(1), kind: "visualization", caption: "chart", path: `${cwd}/chart.html`, id: "chart", reference, by: "agent",
  content: `<!doctype html><html><body style="margin:0"><h1 id="title">chart</h1><div style="display:flex;align-items:flex-end;gap:8px;height:180px">${bars}</div></body></html>`,
}];
const messages = [
  { role: "user", text: "図にしてください", uuid: "claude:vw:u0", at: at(0), backend: "claude" },
  { role: "assistant", text: `図にしました。\n${reference}\n下の段落も読めます。`, uuid: "claude:vw:a0", at: at(1), backend: "claude" },
];
const info = { sessionId: ID, title: "Visualize widen", cwd, createdAt: start, lastModified: Date.parse(messages.at(-1).at) };
fs.writeFileSync(path.join(dir, "conversations", `${ID}.json`), JSON.stringify({ messages }));
fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify({
  [ID]: { segments: [{ backend: "claude", nativeId: `n-${ID}` }], info, backend: "fake", nativeId: `n-${ID}`, base: messages.length },
}));
fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
  [ID]: { backend: "fake", title: info.title, cwd, createdAt: info.createdAt, lastModified: info.lastModified },
}));
fs.writeFileSync(path.join(dir, "presents", `${ID}.jsonl`), presents.map((p) => JSON.stringify(p)).join("\n") + "\n");
console.log(`seeded ${ID}: ${messages.length} messages, ${presents.length} presents`);
