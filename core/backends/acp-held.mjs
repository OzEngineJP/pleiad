// ACP（JSON-RPC の stdio）の CLI を保持役（core/holder/）の子に載せる（ADR 0270 段 2b）。
// Devin・Grok は 1 ターン 1 プロセスで、stdin に 1 行 1 JSON を書き、stdout の 1 行 1 JSON を読む。保持役の子にすれば、
// サーバーが入れ替わっても CLI は走り続け、新しいサーバーが同じ子の記録を印から読み直して続きを受ける（devin.mjs・grok.mjs の adoptTurn）。
//   載せるか（heldAcpPlan）: 切り替え（AGENT_HOST_DEVIN_HOLDER・AGENT_HOST_GROK_HOLDER。既定は実行場所の置き場 AGENT_HOST_RUNTIME_ROOT があるとき on）・
//     shell 無しで起こせる実行ファイル（.cmd は中のスクリプトに解く）・保持役につなげる。どれかが外れたら今の流れ（サーバーが CLI を直に起こす）
//   policy 'jsonrpc': 保持役は、子が出した答えていない依頼（session/request_permission など）を控え、付け直した親へ渡し直す。
//     再生（印から ack まで）の依頼は履歴なので出し直さない（答え済みは控えに無い）。控えに残っているものだけを、渡し直しの 1 回で聞き直す
//   印（turn）は、session/prompt を書く直前に打つ（再生はここから）。札（label）はサーバーのターンの札（core/turn-card.mjs）で、
//     サーバーの touchCard が control.holder.label で置き直す
//   ターンが終わったら札と印を外してから子を止める（endTurn → close）
// 寿命（lifetime）: 'turn'（既定。Devin・Grok）は 1 ターン 1 プロセス。'conversation'（agy の ACP）は会話のあいだ子が生き、ターンの間は idle で次のターンを待つ。
//   会話寿命の endTurn は札と印を外すだけで子を止めない（idle の間は札を置かない。遅れて届いた置き直しで idle の子を付け直す対象に戻さない）。
//   印は markTurn でターンごとに打ち直す。アプリの終了は exitFrames（end・kill）を client.sendBatch で 1 回に送る。
//   札と印の欠けた idle の子は、次のサーバーの起動で sweepIdleAcp が止める（止めるタイマーを持つ人が居なくなったため）
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { bootEnv } from '../boot-env.mjs';
import { directCommand } from '../cli-installation.mjs';
import { holderLink } from '../holder/link.mjs';
import { KEEP_MS } from '../process.mjs';
import { ADOPT_TURN_MARK, holderSource } from '../adopt.mjs';

/** 保持役の子の id の頭。ほかのバックエンドの子（agy・Codex・Claude）と見分ける */
export const ACP_CHILD_PREFIX = 'acp-';

/**
 * 保持役に載せる切り替え（AGENT_HOST_DEVIN_HOLDER・AGENT_HOST_GROK_HOLDER）。`on` は載せる・`off` は載せない（今の流れ）。
 * **無ければ、実行場所の置き場（AGENT_HOST_RUNTIME_ROOT。パッケージ版の main が渡す）があるときだけ載せる**。
 * 置き場の無い起動（`npm start`・テスト）は何も変わらない。起動用の変数（core/boot-env.mjs）
 */
export function acpHeldEnabled(envName, env = process.env, boot = bootEnv) {
  const value = String(boot(envName) ?? env[envName] ?? '').trim().toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  return Boolean(boot('AGENT_HOST_RUNTIME_ROOT') ?? env.AGENT_HOST_RUNTIME_ROOT);
}

/**
 * このターンの ACP の CLI を保持役に載せるか。載せるなら { client }（保持役への共有の口）、載せないなら null。
 * 保持役を起こせない（抜け道の無い Job など）ときは載せない
 */
export async function heldAcpPlan({ dataDir, argv, envName, log = console.error } = {}) {
  if (!acpHeldEnabled(envName)) return null;
  const root = bootEnv('AGENT_HOST_RUNTIME_ROOT');
  if (!dataDir || !root || !argv?.length || !directCommand(argv)) return null;
  try {
    return { client: await holderLink({ dataDir, root, key: bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '' }) };
  } catch (error) {
    // i18n-ignore: サーバーのログ（log は console.error）
    log('  保持役につなげないので、ACP の CLI を今の形で起こす:', String(error?.code ?? error?.message ?? error));
    return null;
  }
}

/**
 * 保持役の子を ACP の CLI の ChildProcess に見せる口。DevinAcp・GrokAcp の held に渡す。
 *   createHeldAcp({ client })   このサーバーが起こす子（start で spawn する）
 *   createHeldAcp({ source })   付け直す子（source は core/adopt.mjs の holderSource）
 * lifetime: 'turn'（既定）か 'conversation'（上の「寿命」）。childPrefix: 保持役の子の id の頭（保持役は Claude・Codex・fake の子とも共有するので、自分の子だけを見分ける）
 * start は proc を返すだけ（読みは begin で始める。付け直しは、再生の前に写し（mapper）を組み立てるため）。
 * open は attach の答え（pendingRequests。付け直す子だけ）を返す
 */
export function createHeldAcp({ client = null, source = null, lifetime = 'turn', childPrefix = ACP_CHILD_PREFIX } = {}) {
  if (lifetime !== 'turn' && lifetime !== 'conversation') throw new Error(`acp: unknown held lifetime (${String(lifetime)})`);
  const conversation = lifetime === 'conversation';
  let id = source?.id ?? null;
  const adopting = Boolean(source);
  let exited = null, closing = false;
  let idle = false;   // 会話寿命だけ: ターンの間（endTurn の後、次の markTurn まで）。札は置かない
  let proc = null, onLine = () => {}, onStderr = () => {}, started = false;

  const writeLine = data => { if (!exited) source.write(String(data)); };

  async function pump() {
    let info = { code: null, signal: null };
    try {
      if (adopting) {
        const mark = source.state.marks?.[ADOPT_TURN_MARK];
        if (!Number.isInteger(mark)) throw new Error('acp: the record has no turn mark');
        const acked = Math.max(mark - 1, source.state.acked ?? 0);
        // 印から ack までは再生（画面へは出さず、状態だけ作る）。続きは普通に流して行ごとに ack する
        if (acked >= mark) for (const [, line] of await source.replay(mark, acked)) await onLine(line, { replay: true });
        for await (const item of source.attach(acked + 1)) {
          if (item.exit) { info = item.exit; break; }
          // 控えの渡し直し（答えていない依頼）。履歴の再生で出したものと同じ id でも、聞き直すのは 1 回だけ（DevinAcp の asked）
          if (item.redelivered) { await onLine(item.line, { replay: true, redelivered: true }); continue; }
          await onLine(item.line, null);
          source.ack(item.seq);
        }
      } else {
        for await (const item of source.attach(1)) {
          if (item.exit) { info = item.exit; break; }
          await onLine(item.line, null);
          source.ack(item.seq);
        }
      }
    } catch (error) {
      console.error('  保持役の ACP の読みが切れた:', String(error?.message ?? error));
      info = { code: null, signal: null, lost: true };
    }
    exited = info;
    proc.exitCode = info.code ?? null;
    proc.signalCode = info.signal ?? null;
    // 終わった子の記録を捨てる（保持役の側の控え）。つながりが切れて終わりが分からないときは触れない
    if (!info.lost) { try { source.release(); } catch { /* つながりが切れた */ } }
    source.dispose();
    // ChildProcess と同じ順（close → exit）
    setImmediate(() => {
      proc.emit('close', proc.exitCode, proc.signalCode, { lost: Boolean(info.lost) });
      proc.emit('exit', proc.exitCode, proc.signalCode, { lost: Boolean(info.lost) });
    });
  }

  const held = {
    get id() { return id; },
    get source() { return source; },
    get client() { return source?.client ?? client; },
    get adopting() { return adopting; },
    get exited() { return exited; },
    get pid() { return source?.state?.pid ?? null; },

    /** ACP のクラスが呼ぶ。保持役に子を起こし（付け直しは起こさない）、proc（ChildProcess の最小の写し）を返す */
    start({ argv, cwd, env }) {
      proc = new EventEmitter();
      if (!source) {
        const target = directCommand(argv);
        if (!target) throw new Error('acp: the CLI cannot be started by the holder');
        id = `${childPrefix}${crypto.randomUUID().slice(0, 8)}`;
        // 出来事の購読は spawn より前（holderSource が先に購読を始める）
        source = holderSource(client, { id, acked: 0, seq: 0, marks: {} }, { spawned: true });
        client.spawn({ id, command: target.command, args: target.args, cwd: cwd || undefined, env, policy: 'jsonrpc', keepMs: KEEP_MS });
      }
      const onErr = frame => { if (frame.id === id && !exited) onStderr(String(frame.chunk ?? '')); };
      source.client.on('err', onErr);
      const stdin = new EventEmitter();
      Object.defineProperties(stdin, {
        writable: { get: () => !closing && !exited },
        write: { value: data => { writeLine(data); return true; } },
        end: { value: () => source.client.end(id) },
        destroy: { value: () => { /* 保持役の子の stdin は親が切っても閉じない */ } },
      });
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), pid: held.pid, killed: false, exitCode: null, signalCode: null });
      proc.kill = () => {
        proc.killed = true;
        if (!exited) source.client.kill(id, { tree: true });
        return true;
      };
      proc.once('exit', () => source.client.off('err', onErr));
      return proc;
    },

    /** 読みを始める（付け直しは、写しを組み立てた後で呼ぶ）。onLine は ACP のクラスの行の処理 */
    begin({ onLine: line, onStderr: err } = {}) {
      if (line) onLine = line;
      if (err) onStderr = err;
      if (started) return;
      started = true;
      void pump();
    },

    /** 付け直す子の attach の答え（pendingRequests など）。起こした子は null */
    async open(from = 1) {
      if (!adopting) return null;
      return source.open(from);
    },

    /** ターンの最初の行（session/prompt）を書く直前に打つ。印は次の行（保持役が子の出力の通番で数える）。再生はここから */
    markTurn() { if (source && !exited) { idle = false; source.client.mark(id, ADOPT_TURN_MARK); } },
    /** 札を子に置く（server の touchCard が、札の中身が変わるたびに呼ぶ）。会話寿命は idle の間は置かない */
    label(card) { if (source && !exited && !idle) source.client.label(id, card); },

    /** ターンが終わった（会話寿命は子が idle で次のターンを待つ。ターン寿命は続けて close で止める）。付け直す対象から外す: 札と印を 1 回の書き込みで外す。終わった子には触れない */
    endTurn() {
      if (!source || exited) return;
      if (conversation) idle = true;
      source.client.sendBatch([{ t: 'label', id, label: null }, { t: 'unmark', id, name: ADOPT_TURN_MARK }]);
    },

    /** アプリの終了で子を止める依頼（stdin を閉じ、木ごと止める）。続けて write せず、client.sendBatch で 1 回にまとめて送る。終わった子は空 */
    exitFrames() {
      if (!source || exited) return [];
      return [{ t: 'end', id }, { t: 'kill', id, tree: true }];
    },

    /** 子を止める（stdin を閉じ、木ごと止める）。終わるのを待つ（上限つき） */
    async close({ waitMs = 10_000 } = {}) {
      if (!source) return;
      closing = true;
      if (!exited) {
        // Windows の taskkill /T は、親が先に stdin 終了で落ちると子孫を
        // たどれないことがある。Windows では end を送らず、保持役の kill で木ごと止める。
        if (process.platform !== 'win32') {
          try { source.client.end(id); } catch { /* つながりが切れた */ }
        }
        try { source.client.kill(id, { tree: true }); } catch { /* つながりが切れた */ }
      }
      const waitForStop = async ms => {
        const end = Date.now() + ms;
        while (!exited && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      };
      await waitForStop(waitMs);
      if (!exited) {
        // The holder's Windows tree kill is asynchronous. Retry once if the
        // first request did not produce an exit before dropping this source.
        try { source.client.kill(id, { tree: true }); } catch { /* disconnected */ }
        await waitForStop(waitMs);
      }
      // それでも終わらなければ、購読元は残す（終わりの知らせを受け取れるように）。close は会話の片付けから
      // 呼ばれるので投げない（投げると終わったターンが失敗になる）
      if (!exited) return;
      source.dispose();
    },

    /** 子を止める（待たない。落ちたときの保険） */
    kill() { if (source && !exited) source.client.kill(id, { tree: true }); },
  };
  return held;
}

/**
 * 付け直せる子か（札と印の両方がある。server の restoreAdoptedTurns と同じ条件）。どちらかが欠けたものは、止める人が居ない idle の子
 */
const adoptable = child => Boolean(child.label) && Number.isInteger(child.marks?.[ADOPT_TURN_MARK]);

/**
 * 前のサーバーが保持役に残した idle の子を止める: prefix の子のうち、**札か印の欠けた**ものを止める（旧サーバーの停止・更新・落ちで、止めるタイマーを持つ人が居なくなった）。
 * 札と印を持つ子は付け直し（server の restoreAdoptedTurns）が読むので触れない。ids は、この呼び出しの前に保持役へつないでいた自分の子（止めない）。
 * onHomes(kept) は止めた後に（子が居なくても）1 回呼ぶ。kept は、付け直せる生きた子（札と印を持つもの）。agent の置き場（agy の held-*）を、生きている子が指していないものだけ消すために使う。
 * 「プロセスで 1 回だけ」の制御は呼ぶ側が持つ（antigravity-held.mjs の sweepIdle）。戻り値は止めた子の id
 */
export async function sweepIdleAcp(client, { prefix = ACP_CHILD_PREFIX, ids = new Set(), onHomes = null } = {}) {
  const children = (client.welcome?.children ?? []).filter(child => String(child.id).startsWith(prefix) && !ids.has(child.id));
  const stopped = [];
  for (const child of children) {
    if (adoptable(child)) continue;
    try {
      await client.attach(child.id, { from: (child.seq ?? 0) + 1 });
      if (child.alive) client.kill(child.id, { tree: true }); else client.release(child.id);
      await client.detach(child.id);
      stopped.push(child.id);
    } catch { /* つながりが切れた・子が消えた */ }
  }
  if (onHomes) onHomes(children.filter(child => child.alive && adoptable(child)));
  return stopped;
}
