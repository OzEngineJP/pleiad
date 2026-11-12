// tests/browser/browser-files-load.cjs の補助（ADR 0320）。run-code の中では fs が使えないので、
// 「ファイルを書き換える」操作だけを、種のリポジトリの直下に限った小さな HTTP の口で受ける（127.0.0.1 のみ）。
// 使い方: node tests/browser/browser-files-load-writer.mjs <シードしたリポジトリ> [port=7457]
//   POST /write?name=<ファイル名（直下の 1 つだけ）>  本文がそのまま新しい中身になる
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [repo, port = "7457"] = process.argv.slice(2);
if (!repo) throw new Error("usage: node browser-files-load-writer.mjs <repo dir> [port]");
const root = path.resolve(repo);
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const name = url.searchParams.get("name") ?? "";
  if (req.method !== "POST" || url.pathname !== "/write" || !/^[\w.-]+$/.test(name)) { res.writeHead(400).end(); return; }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    fs.writeFileSync(path.join(root, name), Buffer.concat(chunks));
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("ok");
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`writer on 127.0.0.1:${port} for ${root}`));
