// ply_shell（ADR 0227）のジョブを、保持役（core/holder/）の子に載せる（ADR 0270 段 2a。規則 ①・③）。
// サーバーを入れ替えてもジョブは止まらず、新しいサーバーが起動で保持役の子の一覧から拾う（手放す/引き取るの対は書かない）。
//   子: core/shell-held-child.mjs（`!` の行と同じ包み。runHostShell で走らせ、stdout・stderr・終わりを 1 行 1 JSON の記録にする）。policy は 'none'
//   印: 'ply_shell' を通番 1 に置く（記録を捨てさせない。出力は runHostShell の上限で stdout・stderr それぞれ 256 KB まで）
//   札: { kind: 'ply_shell', v: 1, sessionId, jobId, jobKind, command, cwd, shell, startedAt, stoppedBy? }。起こすときに置き、止めるときに stoppedBy を置き直す
//   ack: 画面へ流し終えた出力の行（ジョブの outputBuffer に足した位置）。付け直したサーバーは、印から ack までを出力の組み立てだけに使い、その先を足す。
//       終わりの行（done）は、ack 済みなら前のサーバーが終わりを処理している（onJobEnd を呼び直さない）。ack より後なら、このサーバーが終わりを処理する
//   記録は、終わった後も output・list で読めるように残す（release は JOBS_KEPT から溢れたとき。core/shell-bridge.mjs）
// 載せるかの切り替え: AGENT_HOST_PLY_SHELL_HOLDER。既定は載せる（置き場は core/process.mjs が決める）。`off` で今の流れ（サーバーの子）
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootEnv } from './boot-env.mjs';
import { holderLink } from './holder/link.mjs';
import { holderSource } from './adopt.mjs';
import { start as startProcess, holderRootFor } from './process.mjs';

const CHILD = fileURLToPath(new URL('./shell-held-child.mjs', import.meta.url));
export const PLY_SHELL_MARK = 'ply_shell';
export const PLY_SHELL_CARD_KIND = 'ply_shell';
export const PLY_SHELL_CARD_VERSION = 1;
/** 札の上限（保持役の label の上限 256 KB より十分小さく。越える行は保持役に載せない） */
const CARD_MAX_BYTES = 64 * 1024;

const lineOf = value => `${JSON.stringify(value)}\n`;
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/** 保持役に載せる切り替え。既定は載せる（置き場は core/process.mjs が決める）。AGENT_HOST_PLY_SHELL_HOLDER=off で載せない（戻し道） */
export const plyShellHolderEnabled = (env = process.env) => String(bootEnv('AGENT_HOST_PLY_SHELL_HOLDER') ?? env.AGENT_HOST_PLY_SHELL_HOLDER ?? '').trim().toLowerCase() !== 'off';

/** 走っているジョブの札 */
export const plyShellCard = job => ({ kind: PLY_SHELL_CARD_KIND, v: PLY_SHELL_CARD_VERSION, sessionId: job.sessionId, jobId: job.id, jobKind: job.kind,
  command: job.command, cwd: job.cwd, shell: job.shell, startedAt: job.startedAt, ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}) });

/** 札からジョブの形を戻す。形が合わなければ null */
export function readPlyShellCard(card) {
  if (card?.kind !== PLY_SHELL_CARD_KIND || card.v !== PLY_SHELL_CARD_VERSION) return null;
  const { sessionId, jobId, jobKind, command, startedAt } = card;
  if (![sessionId, jobId, command].every(value => typeof value === 'string' && value)) return null;
  if (jobKind !== 'run' && jobKind !== 'start') return null;
  if (!Number.isFinite(startedAt)) return null;
  return { sessionId, jobId, jobKind, command, cwd: typeof card.cwd === 'string' ? card.cwd : null, shell: typeof card.shell === 'string' ? card.shell : null,
    startedAt, ...(typeof card.stoppedBy === 'string' ? { stoppedBy: card.stoppedBy } : {}) };
}

/**
 * 保持役の子 1 つ分（source は core/adopt.mjs の holderSource）。shell-bridge が使う:
 *   drive({ onOutput(stream, text, replay), signal }) … 印から記録を読み、終わりの結果を返す（{ already: true, ...result }・runHostShell と同じ形）
 *     replay は ack 済みの出力（ジョブの outputBuffer に足すだけで、画面へ流し直さない）。signal の中断で子へ stop を書く
 *   finished()  … 終わりを処理し終えた（出力の行を ack し、購読をやめる。記録は output・list のために残す）
 *   release()   … 記録を捨てる（JOBS_KEPT から溢れたとき）
 *   label(job)  … 札を置き直す（止めた理由）
 */
function heldJob(source) {
  let state = 'driving';            // driving -> finishing -> done
  let doneSeq = null, lastSeq = 0;
  const client = source.client;
  const write = value => source.write(lineOf(value));
  return {
    id: source.id,
    get alive() { return source.state.alive !== false; },
    async drive({ onOutput, signal }) {
      const acked = source.state.acked ?? 0;
      const from = source.state.marks?.[PLY_SHELL_MARK] ?? 1;
      let result = null;
      const onAbort = () => write({ t: 'stop' });
      if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
      // 保持役が断った spawn（id の重なり・札の大きさ）は exit が来ないので、ここで終わりにする
      let fault;
      const faulted = new Promise(resolve => { fault = frame => { if (frame?.id === source.id) resolve({ exit: { code: null, signal: null, error: `holder: ${frame.op} ${frame.reason}` } }); }; });
      client.on('fault', fault);
      const items = source.attach(from)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const item = await Promise.race([items.next().then(next => (next.done ? { exit: null } : next.value)), faulted]);
          if (item.exit !== undefined) {
            state = 'finishing';
            if (doneSeq !== null && doneSeq <= acked) return { already: true, ...result };
            if (result) return result;
            return { exitCode: null, error: item.exit?.error ? String(item.exit.error) : `the shell wrapper exited without a result (code ${item.exit?.code ?? 'none'})` };
          }
          lastSeq = item.seq;
          const m = parse(item.line);
          if (m?.t === 'o' || m?.t === 'e') {
            onOutput(m.t === 'e' ? 'stderr' : 'stdout', String(m.x ?? ''), item.seq <= acked);
            if (item.seq > acked) source.ack(item.seq);
          } else if (m?.t === 'done') {
            const { t: _t, ...rest } = m;
            result = rest;
            doneSeq = item.seq;
          }
        }
      } catch (error) {
        state = 'finishing';
        return { exitCode: null, error: String(error?.message ?? error) };
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
        client.off('fault', fault);
      }
    },
    finished() {
      if (state === 'done') return;
      state = 'done';
      if (lastSeq) source.ack(lastSeq);
      source.dispose();
    },
    release() {
      source.release();
      source.dispose();
    },
    label: job => client.label(source.id, plyShellCard(job)),
  };
}

/**
 * サーバーの口。shell-bridge の holder に渡す:
 *   start(job, { timeoutMs }) … 保持役に子を起こし、heldJob を返す。載せないとき（切り替えが off・つなげない・札が大きすぎる）は null（今の流れ）
 *   adoptable()               … 起動で拾うジョブ（[{ card, held }]）。居る保持役にだけつなぐ
 */
export function createPlyShellHolder({ dataDir, root = bootEnv('AGENT_HOST_RUNTIME_ROOT'), key = bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '', appVersion = '',
  enabled = plyShellHolderEnabled, log = console.error } = {}) {
  return {
    async start(job, { timeoutMs }) {
      if (!enabled() || !dataDir) return null;
      const card = plyShellCard(job);
      if (Buffer.byteLength(JSON.stringify(card), 'utf8') > CARD_MAX_BYTES) return null;
      const id = `ply-${job.id}-${crypto.randomBytes(3).toString('hex')}`;
      let started;
      try {
        started = await startProcess({
          dataDir, root, key, appVersion,
          id, command: process.execPath, args: [CHILD], cwd: job.cwd || undefined,
          // job.env は秘密情報と変数（ADR 0217。shell-bridge の prepare）。札（label）には載せない
          env: { ...process.env, ...(job.env ?? {}) }, policy: 'none', label: card, marks: { [PLY_SHELL_MARK]: 1 }, log,
        });
      } catch (error) {
        // i18n-ignore: サーバーのログ（log は console.error）
        log('  保持役につなげないので、ply_shell のジョブを今の形で走らせる:', String(error?.code ?? error?.message ?? error));
        return null;
      }
      if (!started) return null;
      started.source.write(lineOf({ t: 'run', command: job.command, cwd: job.cwd, timeoutMs }));
      return heldJob(started.source);
    },
    async adoptable() {
      if (!enabled() || !dataDir) return [];
      const holderRoot = holderRootFor({ dataDir, root });
      if (!holderRoot) return [];
      let client;
      try { client = await holderLink({ dataDir, root: holderRoot, appVersion, launch: false }); }
      catch (error) { if (error?.code === 'HOLDER_NONE') return []; throw error; }
      return (client.welcome?.children ?? [])
        .filter(child => readPlyShellCard(child.label) && Number.isInteger(child.marks?.[PLY_SHELL_MARK]))
        .map(child => ({ card: readPlyShellCard(child.label), held: heldJob(holderSource(client, child)) }));
    },
  };
}
