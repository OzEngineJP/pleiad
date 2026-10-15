// Antigravity の会話の、次の発言の候補を作る 1 回（core/prompt-suggestions.mjs、ADR 0211）。
//
// agy には予測の口も fork も無いので、指示と要約を `agy --print` に 1 回渡して作る。
// **`agy --print` は 1 回ごとに会話を履歴に残す**（~/.gemini/antigravity-cli/ の conversations・brain・要約の DB に 1 件ずつ増える。
// 失敗で終わった回も残る。agy 1.3.5 で確認。2026-10-15）。残ると利用者の /resume の一覧に候補づくりの会話が並び、
// `agy --continue` が最新の会話として拾う。消す口は対話の画面にしか無い。
// そこで agy の状態の置き場（ホーム）だけを使い捨ての場所へ向けて起こす（USERPROFILE と HOME）。ログインは Windows の資格情報
// （gemini:antigravity）にあり、ホームを替えてもそのまま通る。利用者の置き場は変わらない（同じ実機で前後を比べた）。
// 使い捨ての場所は一時フォルダーの下に 1 つ（agy の補助の実行ファイルで 15 MB ほど。データ置き場には置かない。試験は AGENT_HOST_AGY_SUGGEST_HOME で
// 自分の一時の置き場へ向ける）。回ごとにその回の会話の置き場を消し、Pleiad の終了と重なって消せなかった分は、次に起こす前に 10 分より古いものを消す。
// 要約の DB は回ごとに 1 行ずつ増えるので、2 MB を超えたら消す。同時に 2 本は起こさない（同じ置き場の DB を取り合わない）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliCommand, spawnCli } from "../cli-installation.mjs";

const NL = String.fromCharCode(10);
/** 1 回の上限。agy の --print-timeout にも渡す */
export const AGY_SUGGEST_TIMEOUT_MS = 60_000;

/** 使い捨てのホーム（一時フォルダーの下の pleiad-agy-suggest）。dir を渡せばその下（単体の試験）、AGENT_HOST_AGY_SUGGEST_HOME があればそこ（サーバーの試験） */
export const suggestHome = (dir) => (dir ? path.join(dir, 'pleiad-agy-suggest')
  : process.env.AGENT_HOST_AGY_SUGGEST_HOME || path.join(os.tmpdir(), 'pleiad-agy-suggest'));

/** 消せずに残った会話の置き場を消す（前の回が Pleiad の終了と重なったとき）。古さは更新の時刻で見る */
export const STALE_MS = 10 * 60_000;
export function sweepStale(home, { now = Date.now(), maxAge = STALE_MS } = {}) {
  const base = path.join(home, '.gemini', 'antigravity-cli');
  let removed = 0;
  for (const sub of ['conversations', 'brain', 'annotations']) {
    let names = [];
    try { names = fs.readdirSync(path.join(base, sub)); } catch { continue; }
    for (const name of names) {
      const p = path.join(base, sub, name);
      try {
        if (now - fs.statSync(p).mtimeMs <= maxAge) continue;
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
        removed++;
      } catch {}
    }
  }
  return removed;
}

/** 候補に使うモデル。一覧にある軽い Flash の low を選ぶ。無ければ agy の既定（--model を渡さない） */
export function suggestModel(models) {
  const ids = Object.keys(models ?? {}).filter(Boolean);
  return ids.find((id) => /flash/i.test(id) && /-low$/i.test(id)) ?? ids.find((id) => /flash/i.test(id)) ?? null;
}

/** agy に渡す引数（本体の会話と同じ stream-json の形。antigravity-cli.mjs の args） */
export function suggestArgs(model) {
  return ["--print=", "--input-format", "stream-json", "--output-format", "stream-json",
    "--print-timeout", `${Math.round(AGY_SUGGEST_TIMEOUT_MS / 1000)}s`, ...(model ? ["--model", model] : [])];
}

/** その回の会話の置き場を消す（会話の DB・brain・注釈）。要約の DB の 1 行は残る（形が公開されていないので書かない） */
export function forgetConversation(home, conversationId) {
  if (!/^[A-Za-z0-9-]+$/.test(String(conversationId ?? ''))) return;
  const base = path.join(home, '.gemini', 'antigravity-cli');
  for (const p of [path.join(base, 'conversations', `${conversationId}.db`), path.join(base, 'conversations', `${conversationId}.db-wal`),
    path.join(base, 'conversations', `${conversationId}.db-shm`), path.join(base, 'brain', conversationId), path.join(base, 'annotations', `${conversationId}.pbtxt`)]) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}

/** 要約の DB（回ごとに 1 行ずつ残る）の上限。超えたら起こす前に消す（agy は無ければ作り直す。消すのはこの使い捨ての場所の分だけ） */
export const SUMMARIES_MAX_BYTES = 2 * 1024 * 1024;
export function trimSummaries(home, max = SUMMARIES_MAX_BYTES) {
  const base = path.join(home, '.gemini', 'antigravity-cli');
  let size = 0;
  try { size = fs.statSync(path.join(base, 'conversation_summaries.db')).size; } catch { return false; }
  if (size <= max) return false;
  for (const name of ['conversation_summaries.db', 'conversation_summaries.db-wal', 'conversation_summaries.db-shm']) {
    try { fs.rmSync(path.join(base, name), { force: true }); } catch {}
  }
  return true;
}

let chain = Promise.resolve();

/**
 * 1 回起こして、返答の本文（生のまま。読むのは parseSuggestion）を返す。止められたら null。
 * @param {{ prompt: string, model?: string|null, signal?: AbortSignal, dir?: string, command?: string[] }} o
 */
export function runAgySuggestion(o) {
  const run = chain.then(() => once(o), () => once(o));
  chain = run.catch(() => {});
  return run;
}

async function once({ prompt, model = null, signal, dir, command = cliCommand('antigravity') }) {
  if (signal?.aborted) return null;
  const home = suggestHome(dir);
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  sweepStale(home);
  trimSummaries(home);
  const child = spawnCli(command, suggestArgs(model), {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  let conversationId = null;
  let text = '';
  let failed = null;
  const stop = () => { try { child.kill(); } catch {} };
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, AGY_SUGGEST_TIMEOUT_MS + 5_000);
  try {
    const finished = new Promise((resolve) => {
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf(NL)) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          conversationId ??= m?.conversation_id ?? m?.result?.conversation_id ?? m?.step_update?.conversation_id ?? null;
          if (m?.event === 'step_update' && m.step_update?.step_type === 'agent_response' && typeof m.step_update.text_delta === 'string') text += m.step_update.text_delta;
          if (m?.event === 'result') {
            if (m.result?.status !== 'SUCCESS') failed = String(m.result?.error ?? m.result?.status ?? 'failed');
            else if (typeof m.result?.response === 'string' && m.result.response) text = m.result.response;
            // 返り（result）を受けたら入力を閉じて終わらせる（stdin が閉じると agy は落ちる）
            child.stdin.end();
          }
        }
      });
      child.stderr.resume();
      child.on('error', (error) => { failed = String(error?.message ?? error); resolve(); });
      child.on('close', () => resolve());
    });
    child.stdin.write(JSON.stringify({ event: 'user', message: { content: String(prompt ?? '') } }) + NL);
    await finished;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (conversationId) forgetConversation(home, conversationId);
  }
  if (signal?.aborted) return null;
  if (failed) throw new Error(failed);
  return text;
}
