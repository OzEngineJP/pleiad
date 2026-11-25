// 試験用の偽の git（遅い・止まる git を作る。ADR 0353）。`setGitBin(process.execPath, { args: [このファイル] })` で差し替える。
// 本物の git を呼ばないので、遅い・止まる動きを時間どおりに作れる。リポジトリは要らない（cwd のフォルダーだけあればよい）。
//
// 環境変数（呼び出し側のプロセスで決める。run() は process.env を子へ渡す）:
//   FAKE_GIT_LOG  呼ばれるたびに 1 行（`pid<TAB>名前`）を足すファイル。呼び出しの数え・止まった子の pid を拾うのに使う
//   FAKE_GIT_CTL  動きを決める JSON のファイル（呼ばれるたびに読む。試験の途中で書き換えられる）
//                 { "unborn": true, "rules": { "<名前>": { "delayMs": 400 } | { "hang": true } | { "exit": 1 } } }
// 名前: rev-parse-root（--show-toplevel）・rev-parse-head（HEAD の確認）・rev-parse-index（--git-path）・それ以外はサブコマンドそのまま
//   （status・add・write-tree・commit-tree・update-ref・for-each-ref・diff・…）。決めていないものは何も出さず 0 で終わる（commit-tree・write-tree は hash を出す）。
//   { "out": "…" } は、その名前の標準出力をそのまま出す（for-each-ref に ref の一覧を出させる）。標準入力は読まない。
// hang は、終わらずに生き続ける（本物の kill で落ちる。「kill を無視する git」は呼び出し側が killWith に何もしない関数を渡して作る）。
import fs from 'node:fs';

const argv = process.argv.slice(2);
let at = 0;
while (argv[at] === '-c') at += 2;
const args = argv.slice(at);
const sub = args[0];

let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_CTL, 'utf8')); } catch { /* 決めていない */ }
const name = sub === 'rev-parse'
  ? (args.includes('--show-toplevel') ? 'rev-parse-root' : args.includes('--git-path') ? 'rev-parse-index' : 'rev-parse-head')
  : sub;
if (process.env.FAKE_GIT_LOG) { try { fs.appendFileSync(process.env.FAKE_GIT_LOG, `${process.pid}\t${name}\n`); } catch { /* 数えられなくても動く */ } }

const rule = ctl.rules?.[name] ?? {};
if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
if (rule.hang) { setInterval(() => {}, 1 << 30); await new Promise(() => {}); }
if (rule.exit) process.exit(rule.exit);

const cwd = process.cwd().replaceAll('\\', '/');
const hex = (c) => c.repeat(40);
if (rule.out != null) process.stdout.write(String(rule.out));
else if (name === 'rev-parse-root') process.stdout.write(`${cwd}\n${cwd}/.git\n${cwd}/.git\n`);
else if (name === 'rev-parse-index') process.stdout.write(`${cwd}/.git/index\n`);
else if (name === 'rev-parse-head') { if (ctl.unborn) process.exit(1); process.stdout.write(`${hex('a')}\n`); }
else if (name === 'status') process.stdout.write(`# branch.oid ${ctl.unborn ? '(initial)' : hex('a')}\0# branch.head main\0`);
else if (name === 'write-tree') process.stdout.write(`${hex('b')}\n`);
else if (name === 'commit-tree') process.stdout.write(`${hex('c')}\n`);
