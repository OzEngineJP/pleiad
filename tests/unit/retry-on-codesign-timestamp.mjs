// macOS のビルドの包み（scripts/retry-on-codesign-timestamp.mjs）。偽のコマンドで試し、待ちは注入して実時間では待たない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithTimestampRetry, parseArgs, RETRY_DELAYS_MS, TIMESTAMP_ERROR } from '../../scripts/retry-on-codesign-timestamp.mjs';

export const name = 'retry-on-codesign-timestamp';
export const title = 'ビルドの包みは codesign のタイムスタンプのエラーのときだけ、作りかけを消して間をあけてやり直す';

const STAMP = 'Command failed: codesign ... koffi.node\nThe timestamp service is not available.\n';

// outcomes: 回ごとの { status, matched }。1 回ごとに呼ばれた順と、その前に消した・待ったものを記録する
function harness(outcomes) {
  const events = [];
  let i = 0;
  const options = {
    command: 'fake', args: ['a'], clean: ['dist-desktop'],
    run: async () => { events.push('run'); return outcomes[Math.min(i++, outcomes.length - 1)]; },
    wait: async ms => { events.push(`wait:${ms}`); },
    remove: dir => { events.push(`remove:${dir}`); },
    log: line => { events.push(`log:${line}`); },
  };
  return { options, events };
}

export default async function (t) {
  t.ok('待ちは 120 秒・240 秒（合計 3 回まで）', RETRY_DELAYS_MS.join() === '120000,240000');
  t.ok('当たる文字列は codesign のタイムスタンプのエラー', TIMESTAMP_ERROR.test(STAMP) && !TIMESTAMP_ERROR.test('errSecInternalComponent'));

  { // 成功は 1 回で通る
    const { options, events } = harness([{ status: 0, matched: false }]);
    t.ok('成功は 1 回で通る（待ちも消去も警告も無い）', await runWithTimestampRetry(options) === 0 && events.join() === 'run', events.join());
  }
  { // 1 回目だけタイムスタンプで落ちて 2 回目で通る。やり直しの前に作りかけを消し、警告を出し、120 秒待つ
    const { options, events } = harness([{ status: 1, matched: true }, { status: 0, matched: false }]);
    const code = await runWithTimestampRetry(options);
    t.ok('1 回目だけタイムスタンプで落ちたら、2 回目で通る', code === 0, String(code));
    t.ok('やり直しの前に作りかけを消し、::warning:: を出してから待つ',
      events[0] === 'run' && events[1].startsWith('log:::warning::') && events[2] === 'remove:dist-desktop' && events[3] === 'wait:120000' && events[4] === 'run' && events.length === 5, events.join('|'));
  }
  { // 別のエラーはやり直さずに同じ終了コードで落ちる
    const { options, events } = harness([{ status: 7, matched: false }]);
    const code = await runWithTimestampRetry(options);
    t.ok('別のエラーはやり直さず、同じ終了コードで落ちる', code === 7 && events.join() === 'run', `${code} ${events.join()}`);
  }
  { // 2 回目に別のエラーで落ちたら、そこで止まる
    const { options, events } = harness([{ status: 1, matched: true }, { status: 9, matched: false }]);
    const code = await runWithTimestampRetry(options);
    t.ok('やり直しの途中で別のエラーが出たら、そこで同じ終了コードで落ちる', code === 9 && events.filter(e => e === 'run').length === 2, `${code} ${events.join('|')}`);
  }
  { // 3 回とも落ちたら最後の終了コードで落ちる。待ちは 120・240 秒
    const { options, events } = harness([{ status: 1, matched: true }, { status: 2, matched: true }, { status: 3, matched: true }]);
    const code = await runWithTimestampRetry(options);
    t.ok('3 回とも落ちたら、最後の終了コードで落ちる', code === 3 && events.filter(e => e === 'run').length === 3, `${code}`);
    t.ok('待ちは 120 秒・240 秒で、消去は 2 回、警告は 2 回（最後の失敗の後は待たない・消さない）',
      events.filter(e => e.startsWith('wait:')).join() === 'wait:120000,wait:240000'
      && events.filter(e => e.startsWith('remove:')).length === 2
      && events.filter(e => e.startsWith('log:::warning::')).length === 2, events.join('|'));
  }
  { // 引数
    const parsed = parseArgs(['--clean', 'dist-desktop', '--', 'npm', 'run', 'x', '--', '--mac']);
    t.ok('引数は --clean と、-- の後ろの命令（その中の -- もそのまま）', parsed.clean.join() === 'dist-desktop' && parsed.command === 'npm' && parsed.args.join(' ') === 'run x -- --mac', JSON.stringify(parsed));
    let threw = false; try { parseArgs(['--clean', 'x']); } catch { threw = true; }
    t.ok('命令が無ければ使い方で止まる', threw);
  }
  { // 実際の子プロセス: 出力をそのまま流し、タイムスタンプのエラーだけで 2 回目に通る（待ちは 0）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-retry-'));
    try {
      const marker = path.join(dir, 'marker');
      const stale = path.join(dir, 'out');
      fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'half'), 'x');
      const script = path.join(dir, 'fake.mjs');
      fs.writeFileSync(script, `import fs from 'node:fs';
if (fs.existsSync(${JSON.stringify(marker)})) { process.exit(fs.existsSync(${JSON.stringify(stale)}) ? 5 : 0); }
fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.error('The timestamp service is not available.'); process.exit(1);`);
      const logs = [];
      const code = await runWithTimestampRetry({ command: process.execPath, args: [script], clean: [stale], delaysMs: [0, 0], log: l => logs.push(l) });
      t.ok('本物の子でも、タイムスタンプで落ちた後に作りかけを消してやり直し、通る', code === 0 && logs.length === 1, `${code} ${logs}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
