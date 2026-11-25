// ply_shell: Pleiad がホストでシェルのコマンドを走らせる MCP（ADR 0227 §1）。会話ごとの HTTP の口（core/mcp-bridge.mjs）。
//
// ツール: run（少し待つ。終わらなければ止めずに裏のジョブへ移して戻る）・start（裏で始めてすぐ戻る）・output（ジョブの出力の続き）・stop（ジョブを止める）・list（この会話のジョブ）。
// - run の待ちは既定 RUN_WAIT_MS（timeoutMs で RUN_WAIT_MAX_MS まで）。過ぎたら kind を start に変え（promote）、ジョブ id・今までの出力・「まだ走っている」を返す。
//   以後は start のジョブと同じ（output・stop・裏の一覧・終わりの知らせ）。timeoutMs は「止める上限」ではなく「裏へ移すまでの待ち」
// - 走らせる口は core/host-shell.mjs。シェルが終わったら、パイプを握ったプロセスが残っていても少し待って戻る（leftover）
// - 承認: 読み取りだけのモードでは断る。確認なし（autonomy: never）のモードのほかは、走らせる前に会話へ承認のカードを出す
//   （エージェントのサンドボックスの外になるので、エージェント側の承認とは別に Pleiad が決める。エージェント側では ply_shell を自動で通す）
// - ジョブの出力はメモリだけ（OUTPUT_KEEP。古い方から捨て、どこまで捨てたかを数える）。データ置き場に書かない。
//   保持役に載せたジョブ（ADR 0270 段 2a）は、保持役の子の記録にも残る（サーバーを入れ替えても output・list で読める）
// - 終わったジョブは JOBS_KEPT まで覚える（output で読み直せる）
//
//   createShellBridge({ askPermission, onJobStart, onJobChange, onJobEnd, now?, holder?, listedAfterMs? })
//     askPermission(request)            server の askPermission（{ toolName, input, title, sessionId, signal, kind, canAlways, locale }）
//     onJobStart(sessionId, job)・onJobChange(sessionId, job)・onJobEnd(sessionId, job)  見張り（core/session-commands.mjs）・裏の一覧・終わりの知らせ
//       onJobChange は、裏の一覧に出るかどうか（listed）が変わったとき（待っている run が一覧に出始めた・run が裏へ移った）
//     holder                           保持役の口（core/ply-shell-held.mjs の createPlyShellHolder）。無ければジョブはサーバーの子
//   bridge.open({ origin, locale, token?, owner })  owner() → { sessionId, cwd, mode: { scope, autonomy }, signal, env }
//   bridge.jobs(sessionId)・bridge.job(sessionId, jobId)・bridge.stop(sessionId, jobId)・bridge.stopSession(sessionId)・bridge.stopAll({ keepHeld? })・bridge.cwds()
//   bridge.restore(items)  起動で、保持役に残ったジョブを復元する（core/ply-shell-held.mjs の adoptable）
//   ジョブの見え方: { jobId, kind: 'run' | 'start', listed, command, cwd, shell, startedAt, running, stoppedBy?: 'agent' | 'human' | 'turn' | 'session', endedAt?, exitCode?, … }
//     listed: 裏の一覧に出すか（start のジョブ・裏へ移った run・RUN_LISTED_AFTER_MS を過ぎて待っている run）。人が止められるのは listed のもの
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createMcpBridge } from './mcp-bridge.mjs';
import { runHostShell, hostShell } from './host-shell.mjs';
import { agentT } from './i18n.mjs';

export const SHELL_MCP_PATH = '/mcp/shell';
export const SHELL_SERVER = 'ply_shell';
export const SHELL_TOOL_NAMES = Object.freeze(['run', 'start', 'output', 'stop', 'list']);
/** run が終わるのを待つ時間の既定。過ぎても止めず、裏のジョブ（start と同じ扱い）に移して戻る（ADR 0227 の 2026-11-25 の追記） */
export const RUN_WAIT_MS = 30_000;
/** timeoutMs で伸ばせる待ちの上限。MCP のクライアント（OpenCode など）は 300 秒前後で通信を切るので、それより短くする */
export const RUN_WAIT_MAX_MS = 240_000;
/** 待っている run を、裏の一覧に出し始めるまでの時間（短い run で一覧がちらつかないように。人が止められるのは出てから） */
export const RUN_LISTED_AFTER_MS = 3_000;
/** エージェントの MCP の呼び出しの待ちの上限（承認を待つ時間と run の待ちを足したもの） */
export const CALL_TIMEOUT_MS = 11 * 60_000;
/** ジョブの上限（止め忘れの保険。run から裏に移ったものも含め、これを過ぎたら止める） */
export const JOB_TIMEOUT_MS = 24 * 60 * 60_000;
export const OUTPUT_KEEP = 256 * 1024;
/** 1 回の output・run で返す出力の上限（文字） */
export const OUTPUT_RETURN = 30_000;
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
    { name: 'run', description: d('run'), inputSchema: { type: 'object', properties: { command, cwd, shell, timeoutMs: { type: 'integer', description: d('timeoutArg') } }, required: ['command'], additionalProperties: false } },
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

export function createShellBridge({ askPermission, onJobStart = () => {}, onJobChange = () => {}, onJobEnd = () => {}, now = Date.now, holder = null, withSessionWrite = (_id, fn) => fn(), listedAfterMs = RUN_LISTED_AFTER_MS } = {}) {
  const sessions = new Map();   // sessionId -> Map(jobId -> job)

  const jobsOf = (sessionId) => { if (!sessions.has(sessionId)) sessions.set(sessionId, new Map()); return sessions.get(sessionId); };
  /** 裏の一覧に出すか。start のジョブ（裏へ移った run を含む）と、少し待っている run */
  const isListed = (job) => job.kind === 'start' || job.listed === true;
  const viewOf = (job) => ({ jobId: job.id, kind: job.kind, listed: isListed(job), command: job.command, cwd: job.cwd, shell: job.shell, startedAt: job.startedAt, running: job.endedAt == null,
    ...(job.held ? { held: true } : {}),
    ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}),
    ...(job.endedAt != null ? { endedAt: job.endedAt, exitCode: job.exitCode, ...(job.stopped ? { stopped: true } : {}), ...(job.timedOut ? { timedOut: true } : {}), ...(job.leftover ? { leftover: true } : {}) } : {}),
    outputEnd: job.out.end });
  const trim = (map) => {
    const ended = [...map.values()].filter((j) => j.endedAt != null).sort((a, b) => a.endedAt - b.endedAt);
    while (ended.length > JOBS_KEPT) {
      const job = ended.shift();
      job.held?.finished();
      job.held?.release();
      map.delete(job.id);
    }
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

  /** ジョブを始める。終わったら onJobEnd。job.done は結果の Promise。
   * 保持役があれば保持役の子に載せ（ADR 0270 段 2a）、載せられなければ今の流れ（サーバーの子） */
  function launch(sessionId, plan, { timeoutMs, kind }) {
    const map = jobsOf(sessionId);
    const job = { id: `sh-${crypto.randomUUID().slice(0, 8)}`, kind, stoppedBy: null, sessionId, command: plan.command, cwd: plan.cwd, shell: plan.shell, startedAt: now(),
      endedAt: null, exitCode: null, stopped: false, timedOut: false, leftover: false, out: outputBuffer(), ac: new AbortController(), env: plan.env, held: null };
    map.set(job.id, job);
    onJobStart(sessionId, viewOf(job));
    job.done = (async () => {
      // i18n-ignore: サーバーのログ（console.error）
      const held = holder && !job.ac.signal.aborted ? await holder.start(job, { timeoutMs }).catch(e => { console.error('shell: 保持役に載せられなかった:', e?.message ?? e); return null; }) : null;
      if (held) {
        job.held = held;
        // 保持役に載せる前に裏へ移っていたら、札（jobKind）を置き直す
        if (job.promoted) { try { held.label(job); } catch { /* 札は次の更新で直る */ } }
        return driveHeld(job, held);
      }
      return runHostShell({ command: plan.command, cwd: plan.cwd, timeoutMs, signal: job.ac.signal, env: plan.env,
        onOutput: (_stream, piece) => job.out.push(piece) });
    })().then((r) => {
      Object.assign(job, { endedAt: Number.isFinite(r?.endedAt) ? r.endedAt : now(), exitCode: Number.isInteger(r?.exitCode) ? r.exitCode : null,
        stopped: Boolean(r?.stopped), timedOut: Boolean(r?.timedOut), leftover: Boolean(r?.leftover), startError: r?.startError ?? null });
      if (r?.startError || r?.error) job.out.push(`\n${r.startError ?? r.error}\n`);
      trim(map);
      // 付け直したジョブで、前のサーバーが終わりを処理済み（ack 済み）なら、知らせを出し直さない
      if (!r?.already) onJobEnd(sessionId, viewOf(job), job.out.tail(4000));
      return job;
    });
    return job;
  }

  /** 保持役の子の記録を読む。ack 済みの出力（付け直す前のサーバーが流した分）も、ジョブの outputBuffer に足す（画面へは流さない）。
   * 終わりの行まで処理し終えたら ack して購読をやめる（記録は output・list のために残す。core/ply-shell-held.mjs の finished） */
  function driveHeld(job, held) {
    return held.drive({ signal: job.ac.signal, onOutput: (_stream, text) => { if (text) job.out.push(text); } })
      .finally(() => held.finished());
  }

  /** 待っていた run を、止めずに裏のジョブへ移す。以後は start のジョブと同じ（裏の一覧・終わりの知らせ・output・stop）。
   * 保持役の子は札の jobKind を置き直す（サーバーを入れ替えて復元されたときも start として扱う） */
  function promote(job) {
    job.kind = 'start';
    job.promoted = true;
    if (job.held) { try { job.held.label(job); } catch { /* 札は次の更新で直る。ジョブは止めない */ } }
    onJobChange(job.sessionId, viewOf(job));
  }

  /** moved: run が待ちを過ぎて裏へ移った、その戻り（「まだ走っています」の代わりに、止めていない・どう続けるかを書く） */
  function resultText(job, lng, { from = 0, moved = false } = {}) {
    const read = job.out.read(from);
    const lines = [read.text || agentT(lng, 'shell.noOutput')];
    if (read.skipped) lines.unshift(agentT(lng, 'shell.skipped', { count: read.skipped }));
    if (read.next < job.out.end) lines.push(agentT(lng, 'shell.more', { jobId: job.id, since: read.next }));
    // キーは lint が見つけられるよう、リテラルで書く（三項で選ばない）
    const running = { jobId: job.id, since: read.next, seconds: Math.round((now() - job.startedAt) / 1000) };
    if (job.endedAt == null && moved) lines.push(agentT(lng, 'shell.promoted', running));
    else if (job.endedAt == null) lines.push(agentT(lng, 'shell.stillRunning', running));
    else if (job.timedOut) lines.push(agentT(lng, 'shell.timedOut', { jobId: job.id }));
    else if (job.stopped && job.stoppedBy === 'human') lines.push(agentT(lng, 'shell.stoppedByHuman'));
    else if (job.stopped) lines.push(agentT(lng, 'shell.stopped'));
    else lines.push(agentT(lng, 'shell.exit', { code: job.exitCode ?? '?', seconds: ((job.endedAt - job.startedAt) / 1000).toFixed(1) }));
    if (job.leftover) lines.push(agentT(lng, 'shell.leftover'));
    return lines.join('\n');
  }

  async function call(binding, name, args, { locale, signal }) {
    const owner = await binding.owner();
    const invoke = () => callOwned(owner, name, args, { locale, signal });
    return name === 'run' || name === 'start' ? withSessionWrite(owner.sessionId, invoke) : invoke();
  }

  async function callOwned(owner, name, args, { locale, signal }) {
    const lng = locale;
    const map = jobsOf(owner.sessionId);
    if (name === 'run' || name === 'start') {
      const plan = prepare(owner, args, lng);
      await gate(owner, plan, lng, signal);
      if (name === 'start') {
        const job = launch(owner.sessionId, plan, { timeoutMs: JOB_TIMEOUT_MS, kind: 'start' });
        return agentT(lng, 'shell.started', { jobId: job.id, shell: plan.shell, cwd: plan.cwd });
      }
      // timeoutMs は「止める上限」ではなく「裏のジョブへ移すまでの待ち」。範囲の外は丸める（スキーマでは弾かない。弾くと呼び出しごと失敗する）
      const waitMs = Math.min(RUN_WAIT_MAX_MS, Math.max(1000, Number.isFinite(args.timeoutMs) ? args.timeoutMs : RUN_WAIT_MS));
      const job = launch(owner.sessionId, plan, { timeoutMs: JOB_TIMEOUT_MS, kind: 'run' });
      // 待っているあいだにターンが止まった・呼び出した側が切れたら、走らせたコマンドも止める（エージェントが戻りを受け取れない。裏へ移した後は止めない）
      const abort = () => { job.stoppedBy ??= 'turn'; job.ac.abort(); };
      signal?.addEventListener?.('abort', abort, { once: true });
      owner.signal?.addEventListener?.('abort', abort, { once: true });
      let waitTimer = null, listedTimer = null;
      try {
        // 少し走ったら裏の一覧に出す（人が 1 本だけ止められるように）。短い run ではちらつかせない
        listedTimer = setTimeout(() => { if (job.endedAt == null && job.kind === 'run') { job.listed = true; onJobChange(owner.sessionId, viewOf(job)); } }, listedAfterMs);
        listedTimer.unref?.();
        const outcome = await Promise.race([job.done.then(() => 'done'), new Promise((resolve) => { waitTimer = setTimeout(() => resolve('wait'), waitMs); })]);
        if (outcome === 'wait' && job.endedAt == null) { promote(job); return { text: resultText(job, lng, { moved: true }), isError: false }; }
      } finally {
        clearTimeout(waitTimer); clearTimeout(listedTimer);
        signal?.removeEventListener?.('abort', abort); owner.signal?.removeEventListener?.('abort', abort);
      }
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
      if (job.endedAt == null) { stopJob(job, 'agent'); await job.done; }
      return resultText(job, lng, { from: Math.max(0, job.out.end - 4000) });
    }
    if (name === 'list') return JSON.stringify({ jobs: [...map.values()].map(viewOf) });
    throw new Error(`Unknown tool: ${name}`);
  }

  /** 走っているジョブを止める（同期）。保持役の子は札を置き直してから stop を書く（core/ply-shell-held.mjs の drive が signal で書く） */
  function stopJob(job, stoppedBy) {
    if (job.endedAt != null) return false;
    job.stoppedBy = stoppedBy;
    if (job.held) job.held.label(job);
    job.ac.abort();
    return true;
  }

  /**
   * 起動で、保持役に残ったジョブを復元する（ADR 0270 の規則 ③。core/ply-shell-held.mjs の adoptable）。
   * 走っているジョブは onJobStart で数え直し、終わりを処理していないジョブは onJobEnd を出す。ack 済みの終わりは出し直さない
   */
  function restore(items) {
    let n = 0;
    for (const { card, held } of items) {
      const map = jobsOf(card.sessionId);
      if (map.has(card.jobId)) continue;
      // run の呼び出し（待っていたエージェントの接続）は、サーバーを入れ替えると無くなる。戻り先が無いので、終わりを会話へ知らせる start として扱う
      const job = { id: card.jobId, kind: 'start', stoppedBy: card.stoppedBy ?? null, sessionId: card.sessionId, command: card.command, cwd: card.cwd,
        shell: card.shell, startedAt: card.startedAt, endedAt: null, exitCode: null, stopped: false, timedOut: false, leftover: false,
        out: outputBuffer(), ac: new AbortController(), env: null, held };
      map.set(job.id, job);
      job.done = held.drive({ signal: job.ac.signal, onOutput: (_stream, text) => { if (text) job.out.push(text); } })
        .then((r) => {
          Object.assign(job, { endedAt: Number.isFinite(r?.endedAt) ? r.endedAt : now(), exitCode: Number.isInteger(r?.exitCode) ? r.exitCode : null,
            stopped: Boolean(r?.stopped), timedOut: Boolean(r?.timedOut), leftover: Boolean(r?.leftover), startError: r?.startError ?? null });
          if (r?.startError || r?.error) job.out.push(`\n${r.startError ?? r.error}\n`);
          trim(map);
          if (!r?.already) onJobEnd(card.sessionId, viewOf(job), job.out.tail(4000));
          return job;
        }, error => {
          Object.assign(job, { endedAt: now(), exitCode: null, startError: String(error?.message ?? error) });
          trim(map);
          onJobEnd(card.sessionId, viewOf(job), job.out.tail(4000));
          return job;
        }).finally(() => held.finished());
      if (held.alive) onJobStart(card.sessionId, viewOf(job));
      n++;
    }
    return n;
  }

  const bridge = createMcpBridge({ path: SHELL_MCP_PATH, serverName: SHELL_SERVER, tools: (locale) => shellTools(locale), call });
  const api = {
    ...bridge,
    jobs: (sessionId) => [...(sessions.get(sessionId)?.values() ?? [])].map(viewOf),
    job: (sessionId, jobId) => { const job = sessions.get(sessionId)?.get(jobId); return job ? { ...viewOf(job), output: job.out.tail(OUTPUT_RETURN) } : null; },
    async stop(sessionId, jobId) {
      const job = sessions.get(sessionId)?.get(jobId);
      if (!job || job.endedAt != null) return false;
      stopJob(job, 'human'); await job.done; return true;
    },
    async stopSession(sessionId) {
      const map = sessions.get(sessionId);
      if (!map) return;
      await Promise.all([...map.values()].filter((j) => j.endedAt == null).map((j) => { stopJob(j, 'session'); return j.done; }));
      sessions.delete(sessionId);
    },
    running: (sessionId) => [...(sessions.get(sessionId)?.values() ?? [])].some((j) => j.endedAt == null),
    /** 裏の一覧に出るジョブ（start・裏へ移った run・少し待っている run）が走っている会話 */
    sessionsWithJobs: () => [...sessions.entries()].filter(([, m]) => [...m.values()].some((j) => j.endedAt == null && isListed(j))).map(([id]) => id),
    cwds: () => [...sessions.values()].flatMap((m) => [...m.values()].filter((j) => j.endedAt == null).map((j) => j.cwd)),
    /** 起動で拾う（core/ply-shell-held.mjs の adoptable） */
    restore,
    /** アプリの終了（同期）。保持役の子は札を置き直して stop を書く（次の起動が引き取らない。ADR 0270 決定 4） */
    stopAll() {
      for (const map of sessions.values()) for (const j of map.values()) if (j.endedAt == null) stopJob(j, 'session');
    },
    async closeAll() { await Promise.all([...sessions.keys()].map((id) => api.stopSession(id))); },
  };
  return api;
}
