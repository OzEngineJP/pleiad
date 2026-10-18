// ply_shell: Pleiad がホストでシェルのコマンドを走らせる MCP（ADR 0225 §1）。会話ごとの HTTP の口（core/mcp-bridge.mjs）。
//
// ツール: run（終わるまで待つ）・start（裏で始めてすぐ戻る）・output（ジョブの出力の続き）・stop（ジョブを止める）・list（この会話のジョブ）。
// - 走らせる口は core/host-shell.mjs。シェルが終わったら、パイプを握ったプロセスが残っていても少し待って戻る（leftover）
// - 承認: 読み取りだけのモードでは断る。確認なし（autonomy: never）のモードのほかは、走らせる前に会話へ承認のカードを出す
//   （エージェントのサンドボックスの外になるので、エージェント側の承認とは別に Pleiad が決める。エージェント側では ply_shell を自動で通す）
// - ジョブの出力はメモリだけ（OUTPUT_KEEP。古い方から捨て、どこまで捨てたかを数える）。データ置き場に書かない
// - 会話ごとの同時のジョブは JOBS_PER_SESSION まで。終わったジョブは JOBS_KEPT まで覚える（output で読み直せる）
//
//   createShellBridge({ askPermission, onJobStart, onJobEnd, now? })
//     askPermission(request)            server の askPermission（{ toolName, input, title, sessionId, signal, kind, canAlways, locale }）
//     onJobStart(sessionId, job)・onJobEnd(sessionId, job)  見張り（core/session-commands.mjs）・裏の一覧・終わりの知らせ
//   bridge.open({ origin, locale, token?, owner })  owner() → { sessionId, cwd, mode: { scope, autonomy }, signal, env }
//   bridge.jobs(sessionId)・bridge.job(sessionId, jobId)・bridge.stop(sessionId, jobId)・bridge.stopSession(sessionId)・bridge.stopAll()・bridge.cwds()
//   ジョブの見え方: { jobId, kind: 'run' | 'start', command, cwd, shell, startedAt, running, stoppedBy?: 'agent' | 'human' | 'turn' | 'session', endedAt?, exitCode?, … }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createMcpBridge } from './mcp-bridge.mjs';
import { runHostShell, hostShell } from './host-shell.mjs';
import { agentT } from './i18n.mjs';

export const SHELL_MCP_PATH = '/mcp/shell';
export const SHELL_SERVER = 'ply_shell';
export const SHELL_TOOL_NAMES = Object.freeze(['run', 'start', 'output', 'stop', 'list']);
export const RUN_TIMEOUT_MS = 2 * 60_000;
export const RUN_TIMEOUT_MAX_MS = 10 * 60_000;
/** start のジョブの上限（止め忘れの保険。これを過ぎたら止める） */
export const JOB_TIMEOUT_MS = 24 * 60 * 60_000;
export const OUTPUT_KEEP = 256 * 1024;
/** 1 回の output・run で返す出力の上限（文字） */
export const OUTPUT_RETURN = 30_000;
export const JOBS_PER_SESSION = 8;
const JOBS_KEPT = 20;
const SHELLS = ['default', 'bash', 'powershell', 'cmd'];

/** ツールの定義（会話の言語で）。agentT で説明を引く */
// i18n-dynamic: agent:shell.tools.
export function shellTools(locale) {
  const d = (key) => agentT(locale, `shell.tools.${key}`);
  const shell = { type: 'string', enum: SHELLS, description: d('shellArg') };
  const cwd = { type: 'string', description: d('cwdArg') };
  const command = { type: 'string', description: d('commandArg') };
  const jobId = { type: 'string', description: d('jobIdArg') };
  return [
    { name: 'run', description: d('run'), inputSchema: { type: 'object', properties: { command, cwd, shell, timeoutMs: { type: 'integer', minimum: 1000, maximum: RUN_TIMEOUT_MAX_MS, description: d('timeoutArg') } }, required: ['command'], additionalProperties: false } },
    { name: 'start', description: d('start'), inputSchema: { type: 'object', properties: { command, cwd, shell }, required: ['command'], additionalProperties: false } },
    { name: 'output', description: d('output'), inputSchema: { type: 'object', properties: { jobId, since: { type: 'integer', minimum: 0, description: d('sinceArg') } }, required: ['jobId'], additionalProperties: false } },
    { name: 'stop', description: d('stop'), inputSchema: { type: 'object', properties: { jobId }, required: ['jobId'], additionalProperties: false } },
    { name: 'list', description: d('list'), inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ];
}

/** 使うシェルの実行ファイル。見つからなければ null */
export function resolveShell(choice = 'default', env = process.env) {
  const win = process.platform === 'win32';
  const root = env.SystemRoot || 'C:/Windows';
  if (choice === 'powershell') {
    if (win) return path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    return ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'].find((p) => fs.existsSync(p)) ?? null;
  }
  if (choice === 'cmd') return win ? path.join(root, 'System32/cmd.exe') : null;
  if (choice === 'bash') {
    const found = hostShell({ ...env, AGENT_HOST_SHELL: '' });
    if (found && /bash/i.test(found.name)) return found.file;
    return fs.existsSync('/bin/bash') ? '/bin/bash' : null;
  }
  return hostShell(env)?.file ?? null;
}

/** 出力を古い方から捨てて持つ入れ物。offset は捨てた分も含めた通しの位置（文字） */
function outputBuffer() {
  let text = '', dropped = 0;
  return {
    push(piece) { text += piece; if (text.length > OUTPUT_KEEP) { const cut = text.length - OUTPUT_KEEP; text = text.slice(cut); dropped += cut; } },
    get end() { return dropped + text.length; },
    /** since から（捨てた位置より前なら、残っている頭から）。{ text, from, next, skipped } */
    read(since = 0, max = OUTPUT_RETURN) {
      const from = Math.max(since, dropped);
      const slice = text.slice(from - dropped, from - dropped + max);
      return { text: slice, from, next: from + slice.length, skipped: from > since ? from - since : 0 };
    },
    tail(max) { return text.slice(-max); },
  };
}

export function createShellBridge({ askPermission, onJobStart = () => {}, onJobEnd = () => {}, now = Date.now } = {}) {
  const sessions = new Map();   // sessionId -> Map(jobId -> job)

  const jobsOf = (sessionId) => { if (!sessions.has(sessionId)) sessions.set(sessionId, new Map()); return sessions.get(sessionId); };
  const viewOf = (job) => ({ jobId: job.id, kind: job.kind, command: job.command, cwd: job.cwd, shell: job.shell, startedAt: job.startedAt, running: job.endedAt == null,
    ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}),
    ...(job.endedAt != null ? { endedAt: job.endedAt, exitCode: job.exitCode, ...(job.stopped ? { stopped: true } : {}), ...(job.timedOut ? { timedOut: true } : {}), ...(job.leftover ? { leftover: true } : {}) } : {}),
    outputEnd: job.out.end });
  const trim = (map) => {
    const ended = [...map.values()].filter((j) => j.endedAt != null).sort((a, b) => a.endedAt - b.endedAt);
    while (ended.length > JOBS_KEPT) map.delete(ended.shift().id);
  };

  async function gate(owner, args, lng, signal) {
    const scope = owner.mode?.scope;
    if (scope === 'none' || scope === 'readonly') throw new Error(agentT(lng, 'shell.readOnly'));
    if (owner.mode?.autonomy === 'never') return;
    const answer = await askPermission({ toolName: 'ply_shell', input: { command: args.command, cwd: args.cwd },
      title: agentT(lng, 'shell.approvalTitle', { command: String(args.command).slice(0, 300) }), sessionId: owner.sessionId, signal, kind: 'tool', canAlways: false, locale: lng });
    if (!answer?.allow) throw new Error(answer?.message ? agentT(lng, 'shell.deniedWith', { message: answer.message }) : agentT(lng, 'shell.denied'));
  }

  function prepare(owner, args, lng) {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) throw new Error(agentT(lng, 'shell.commandRequired'));
    const base = owner.cwd || process.cwd();
    const cwd = path.resolve(base, typeof args.cwd === 'string' && args.cwd ? args.cwd : '.');
    if (!fs.existsSync(cwd)) throw new Error(agentT(lng, 'shell.cwdMissing', { cwd }));
    const choice = SHELLS.includes(args.shell) ? args.shell : 'default';
    const env = { ...process.env, ...(owner.env ?? {}) };
    const file = resolveShell(choice, env);
    if (!file) throw new Error(agentT(lng, 'shell.shellMissing', { shell: choice }));
    return { command, cwd, shell: choice, env: { ...env, AGENT_HOST_SHELL: file } };
  }

  /** ジョブを始める。終わったら onJobEnd。job.done は結果の Promise */
  function launch(sessionId, plan, { timeoutMs, kind }) {
    const map = jobsOf(sessionId);
    const job = { id: `sh-${crypto.randomUUID().slice(0, 8)}`, kind, stoppedBy: null, sessionId, command: plan.command, cwd: plan.cwd, shell: plan.shell, startedAt: now(),
      endedAt: null, exitCode: null, stopped: false, timedOut: false, leftover: false, out: outputBuffer(), ac: new AbortController() };
    map.set(job.id, job);
    onJobStart(sessionId, viewOf(job));
    job.done = runHostShell({ command: plan.command, cwd: plan.cwd, timeoutMs, signal: job.ac.signal, env: plan.env,
      onOutput: (_stream, piece) => job.out.push(piece) })
      .then((r) => {
        Object.assign(job, { endedAt: now(), exitCode: r.exitCode ?? null, stopped: Boolean(r.stopped), timedOut: Boolean(r.timedOut), leftover: Boolean(r.leftover),
          startError: r.startError ?? null });
        if (r.startError) job.out.push(`\n${r.startError}\n`);
        trim(map);
        onJobEnd(sessionId, viewOf(job), job.out.tail(4000));
        return job;
      });
    return job;
  }

  function resultText(job, lng, { from = 0 } = {}) {
    const read = job.out.read(from);
    const lines = [read.text || agentT(lng, 'shell.noOutput')];
    if (read.skipped) lines.unshift(agentT(lng, 'shell.skipped', { count: read.skipped }));
    if (read.next < job.out.end) lines.push(agentT(lng, 'shell.more', { jobId: job.id, since: read.next }));
    if (job.endedAt == null) lines.push(agentT(lng, 'shell.stillRunning', { jobId: job.id, since: read.next }));
    else if (job.timedOut) lines.push(agentT(lng, 'shell.timedOut', { jobId: job.id }));
    else if (job.stopped) lines.push(agentT(lng, 'shell.stopped'));
    else lines.push(agentT(lng, 'shell.exit', { code: job.exitCode ?? '?', seconds: ((job.endedAt - job.startedAt) / 1000).toFixed(1) }));
    if (job.leftover) lines.push(agentT(lng, 'shell.leftover'));
    return lines.join('\n');
  }

  async function call(binding, name, args, { locale, signal }) {
    const owner = await binding.owner();
    const lng = locale;
    const map = jobsOf(owner.sessionId);
    if (name === 'run' || name === 'start') {
      const running = [...map.values()].filter((j) => j.endedAt == null).length;
      if (name === 'start' && running >= JOBS_PER_SESSION) throw new Error(agentT(lng, 'shell.tooMany', { max: JOBS_PER_SESSION }));
      const plan = prepare(owner, args, lng);
      await gate(owner, plan, lng, signal);
      if (name === 'start') {
        const job = launch(owner.sessionId, plan, { timeoutMs: JOB_TIMEOUT_MS, kind: 'start' });
        return agentT(lng, 'shell.started', { jobId: job.id, shell: plan.shell, cwd: plan.cwd });
      }
      const timeoutMs = Math.min(RUN_TIMEOUT_MAX_MS, Math.max(1000, Number.isFinite(args.timeoutMs) ? args.timeoutMs : RUN_TIMEOUT_MS));
      const job = launch(owner.sessionId, plan, { timeoutMs, kind: 'run' });
      // ターンが止まった・呼び出した側が切れたら、走らせたコマンドも止める（run は待つ前提。裏に残すなら start）
      const abort = () => { job.stoppedBy ??= 'turn'; job.ac.abort(); };
      signal?.addEventListener?.('abort', abort, { once: true });
      owner.signal?.addEventListener?.('abort', abort, { once: true });
      try { await job.done; } finally { signal?.removeEventListener?.('abort', abort); owner.signal?.removeEventListener?.('abort', abort); }
      return { text: resultText(job, lng), isError: job.exitCode !== 0 };
    }
    if (name === 'output') {
      const job = map.get(String(args.jobId ?? ''));
      if (!job) throw new Error(agentT(lng, 'shell.noJob', { jobId: String(args.jobId ?? '') }));
      return resultText(job, lng, { from: Number.isInteger(args.since) && args.since >= 0 ? args.since : 0 });
    }
    if (name === 'stop') {
      const job = map.get(String(args.jobId ?? ''));
      if (!job) throw new Error(agentT(lng, 'shell.noJob', { jobId: String(args.jobId ?? '') }));
      if (job.endedAt == null) { job.stoppedBy = 'agent'; job.ac.abort(); await job.done; }
      return resultText(job, lng, { from: Math.max(0, job.out.end - 4000) });
    }
    if (name === 'list') return JSON.stringify({ jobs: [...map.values()].map(viewOf) });
    throw new Error(`Unknown tool: ${name}`);
  }

  const bridge = createMcpBridge({ path: SHELL_MCP_PATH, serverName: SHELL_SERVER, tools: (locale) => shellTools(locale), call });
  const api = {
    ...bridge,
    jobs: (sessionId) => [...(sessions.get(sessionId)?.values() ?? [])].map(viewOf),
    job: (sessionId, jobId) => { const job = sessions.get(sessionId)?.get(jobId); return job ? { ...viewOf(job), output: job.out.tail(OUTPUT_RETURN) } : null; },
    async stop(sessionId, jobId) {
      const job = sessions.get(sessionId)?.get(jobId);
      if (!job || job.endedAt != null) return false;
      job.stoppedBy = 'human'; job.ac.abort(); await job.done; return true;
    },
    async stopSession(sessionId) {
      const map = sessions.get(sessionId);
      if (!map) return;
      await Promise.all([...map.values()].filter((j) => j.endedAt == null).map((j) => { j.stoppedBy = 'session'; j.ac.abort(); return j.done; }));
      sessions.delete(sessionId);
    },
    running: (sessionId) => [...(sessions.get(sessionId)?.values() ?? [])].some((j) => j.endedAt == null),
    /** start のジョブが走っている会話 */
    sessionsWithJobs: () => [...sessions.entries()].filter(([, m]) => [...m.values()].some((j) => j.endedAt == null && j.kind === 'start')).map(([id]) => id),
    cwds: () => [...sessions.values()].flatMap((m) => [...m.values()].filter((j) => j.endedAt == null).map((j) => j.cwd)),
    /** サーバーの終わり（同期。子のプロセスごと止める） */
    stopAll() { for (const map of sessions.values()) for (const j of map.values()) if (j.endedAt == null) { j.stoppedBy = 'session'; j.ac.abort(); } },
    async closeAll() { await Promise.all([...sessions.keys()].map((id) => api.stopSession(id))); },
  };
  return api;
}
