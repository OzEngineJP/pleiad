// 会話の PR の覚え書き（core/session-prs.mjs）と、PR の状態を gh で読む口（core/git-prs.mjs）。
// gh は本物を呼ばない: 読み手へは run を差し替え、既定の呼び出し（runGh）は AGENT_HOST_GH の偽の gh（.mjs）で確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergePrs, unionPrs, parsePrUrl, prKey, PRS_KEEP } from '../../core/session-prs.mjs';
import { checksOf, normalizeView, reasonOf, runGh, createPrReader, PR_TTL_MS } from '../../core/git-prs.mjs';

export const name = 'git-prs';
export const title = 'PR の覚え書きと状態の読み取り: 重複・上限・子の合流・状態/チェックの正規化・gh が無い/未ログイン・60 秒の覚え';

const U = (n, repo = 'example/pleiad') => `https://github.com/${repo}/pull/${n}`;
const view = (o) => JSON.stringify({ title: 'fix: a', state: 'OPEN', isDraft: false, statusCheckRollup: [], ...o });

export default async function (t) {
  // ---- URL
  t.ok('parsePrUrl: host・repo・番号（末尾の /files は無視）', (() => {
    const p = parsePrUrl(`${U(412)}/files`);
    return p?.host === 'github.com' && p.repo === 'example/pleiad' && p.number === 412;
  })());
  t.ok('parsePrUrl: GitHub の形でなければ null', parsePrUrl('https://example.com/a') === null && parsePrUrl('ftp://github.com/a/b/pull/1') === null && parsePrUrl('') === null && parsePrUrl(null) === null);
  t.ok('prKey: 大文字小文字と末尾の違いは同じ PR', prKey(U(5)) === prKey(`${U(5)}/files`) && prKey('https://GitHub.com/Example/Pleiad/pull/5') === prKey(U(5)));

  // ---- 覚え書き
  t.ok('mergePrs: 足す・at は初めて見た時刻', (() => {
    const a = mergePrs(null, [{ number: 1, url: U(1) }], '2026-10-14T00:00:00Z');
    const b = mergePrs(a, [{ number: 1, url: U(1) }, { number: 2, url: U(2) }], '2026-10-14T01:00:00Z');
    return a.length === 1 && b.length === 2 && b[0].at === '2026-10-14T00:00:00Z' && b[1].at === '2026-10-14T01:00:00Z';
  })());
  t.ok('mergePrs: 変わらなければ null（書かない）', mergePrs([{ number: 1, url: U(1), at: 'x' }], [{ number: 1, url: U(1) }]) === null && mergePrs([], []) === null && mergePrs(null, undefined) === null);
  t.ok('mergePrs: 壊れた入力は捨てる', mergePrs([null, { url: 3 }], [null, { number: 'x', url: U(1) }, { number: 1 }]) === null);
  t.ok(`mergePrs: 上限 ${PRS_KEEP} を超えたら古いものから捨てる`, (() => {
    let list = null;
    for (let i = 1; i <= PRS_KEEP + 5; i++) list = mergePrs(list, [{ number: i, url: U(i) }], `2026-10-14T00:${String(i % 60).padStart(2, '0')}:00Z`);
    return list.length === PRS_KEEP && list[0].number === 6 && list.at(-1).number === PRS_KEEP + 5;
  })());

  // ---- 子との合流
  t.ok('unionPrs: 新しい順・子は child: true', (() => {
    const out = unionPrs(
      [{ number: 1, url: U(1), at: '2026-10-14T01:00:00Z' }],
      [{ prs: [{ number: 2, url: U(2), at: '2026-10-14T03:00:00Z' }] }, { prs: [{ number: 3, url: U(3), at: '2026-10-14T02:00:00Z' }] }]);
    return out.map((p) => p.number).join() === '2,3,1' && out.map((p) => Boolean(p.child)).join() === 'true,true,false';
  })());
  t.ok('unionPrs: 親でも子でも出てきた PR は 1 件で child ではない', (() => {
    const out = unionPrs([{ number: 1, url: U(1), at: '2026-10-14T01:00:00Z' }], [{ prs: [{ number: 1, url: U(1), at: '2026-10-14T02:00:00Z' }] }]);
    return out.length === 1 && out[0].child === false;
  })());
  t.ok('unionPrs: 子しか持たない PR は at が無くても落ちず最後に並ぶ', (() => {
    const out = unionPrs([{ number: 1, url: U(1) }], [{ prs: [{ number: 2, url: U(2), at: '2026-10-14T00:00:00Z' }] }, null, {}]);
    return out.map((p) => p.number).join() === '2,1';
  })());
  t.ok('unionPrs: 空', unionPrs(null, null).length === 0);

  // ---- 状態の正規化
  t.ok('normalizeView: open / draft / merged / closed', normalizeView(view({})).state === 'open'
    && normalizeView(view({ isDraft: true })).state === 'draft'
    && normalizeView(view({ state: 'MERGED' })).state === 'merged'
    && normalizeView(view({ state: 'CLOSED', isDraft: true })).state === 'closed');
  t.ok('normalizeView: 題は 1 行にして取る', normalizeView(view({ title: ' a\n  b ' })).title === 'a b');
  t.ok('normalizeView: 読めない・知らない状態は null', normalizeView('{') === null && normalizeView('null') === null && normalizeView(view({ state: 'X' })) === null);
  t.ok('checksOf: チェックが無ければ null', checksOf([]) === null && checksOf(undefined) === null);
  t.ok('checksOf: 全部成功 → pass（SKIPPED・NEUTRAL も失敗ではない）', checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'NEUTRAL' }]) === 'pass');
  t.ok('checksOf: 1 つでも失敗 → fail（実行中が混ざっても fail）', checksOf([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS', conclusion: '' }]) === 'fail' && checksOf([{ state: 'ERROR' }]) === 'fail');
  t.ok('checksOf: 実行中・待ち → pending', checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]) === 'pending' && checksOf([{ state: 'PENDING' }]) === 'pending' && checksOf([{ status: 'QUEUED' }]) === 'pending');
  t.ok('reasonOf: ENOENT → no-gh、未ログインの文面 → no-auth、それ以外 → null',
    reasonOf({ code: 'ENOENT' }) === 'no-gh'
    && reasonOf({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) === 'no-auth'
    && reasonOf({ stderr: 'HTTP 401: Bad credentials' }) === 'no-auth'
    && reasonOf({ stderr: 'GraphQL: Could not resolve to a PullRequest' }) === null && reasonOf(null) === null);

  // ---- 読み手（run を差し替える）
  const calls = [];
  let clock = 1_000_000;
  const fake = (answers) => async (args) => {
    calls.push(args);
    const a = answers[args[2]];
    if (a instanceof Error) throw a;
    return a;
  };
  const list = [{ number: 3, url: U(3), child: true }, { number: 2, url: U(2) }, { number: 1, url: U(1) }];
  const reader = createPrReader({
    run: fake({ [U(3)]: view({ title: 'child work', isDraft: true }), [U(2)]: view({ state: 'MERGED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }), [U(1)]: new Error('GraphQL: Could not resolve to a PullRequest') }),
    now: () => clock,
  });
  const got = await reader.read(list);
  t.ok('read: 状態・題・チェックを足し、番号・URL・repo・child はそのまま', got.prs.length === 3
    && got.prs[0].number === 3 && got.prs[0].state === 'draft' && got.prs[0].title === 'child work' && got.prs[0].child === true && got.prs[0].repo === 'example/pleiad' && !('checks' in got.prs[0])
    && got.prs[1].state === 'merged' && got.prs[1].checks === 'pass' && !('child' in got.prs[1]), JSON.stringify(got));
  t.ok('read: 1 件だけ読めなくても、その PR は番号と URL だけで、理由は返さない（gh の不備ではない）', got.prs[2].number === 1 && !('state' in got.prs[2]) && got.reason === null);
  t.ok('read: gh には pr view <URL> --json を読み取りだけで呼ぶ', calls.length === 3 && calls.every((a) => a[0] === 'pr' && a[1] === 'view' && a[3] === '--json' && /state/.test(a[4])), JSON.stringify(calls[0]));
  await reader.read(list);
  t.ok(`read: ${PR_TTL_MS / 1000} 秒の間は覚えていて、gh を呼び直さない（失敗も覚える）`, calls.length === 3);
  clock += PR_TTL_MS - 1;
  await reader.read(list);
  t.ok('read: 期限の手前までは覚えている', calls.length === 3);
  clock += 2;
  await reader.read(list);
  t.ok('read: 期限を過ぎたら読み直す', calls.length === 6);
  reader.clear();
  await reader.read(list);
  t.ok('clear: 覚えを捨てる', calls.length === 9);
  t.ok('read: 空の一覧は gh を呼ばない', (await createPrReader({ run: async () => { throw new Error('呼ぶな'); } }).read([])).prs.length === 0);

  const noGh = await createPrReader({ run: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } }).read(list);
  t.ok('gh が無い: 番号・URL・repo だけ返し、reason は no-gh', noGh.reason === 'no-gh' && noGh.prs.length === 3 && noGh.prs.every((p) => !p.state && p.repo === 'example/pleiad'), JSON.stringify(noGh));
  const noAuth = await createPrReader({ run: async () => { throw Object.assign(new Error('exit 4'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }); } }).read(list);
  t.ok('ログインしていない: reason は no-auth', noAuth.reason === 'no-auth' && noAuth.prs.every((p) => !p.state));
  const notGithub = await createPrReader({ run: async () => view({}) }).read([{ number: 7, url: 'https://git.example.com/team/app/-/merge_requests/7' }]);
  t.ok('GitHub の形でない URL でも落ちず、repo は null', notGithub.prs[0].repo === null && notGithub.prs[0].number === 7);
  const partial = await createPrReader({ run: async (a) => { if (a[2] === U(1)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return view({}); } }).read(list);
  t.ok('一部だけ取れたら reason は返さない', partial.reason === null && partial.prs.filter((p) => p.state).length === 2);

  // ---- 既定の呼び出し（AGENT_HOST_GH の偽の gh）
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-prs-')));
  try {
    const script = path.join(scratch, 'fake-gh.mjs');
    await fs.writeFile(script, [
      "const mode = process.env.FAKE_GH_MODE || 'ok';",
      "if (mode === 'noauth') { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4); }",
      "if (process.argv[2] !== 'pr' || process.argv[3] !== 'view') { process.stderr.write('unexpected'); process.exit(1); }",
      "process.stdout.write(JSON.stringify({ title: 'from fake gh', state: 'OPEN', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], url: process.argv[4] }));",
    ].join('\n'));
    const env = { ...process.env, AGENT_HOST_GH: script };
    const out = await runGh(['pr', 'view', U(9), '--json', 'title'], { env });
    t.ok('runGh: AGENT_HOST_GH の .mjs をこの node で動かす', normalizeView(out)?.title === 'from fake gh' && normalizeView(out).checks === 'fail', out);
    const bad = await runGh(['pr', 'view', U(9)], { env: { ...env, FAKE_GH_MODE: 'noauth' } }).catch((e) => e);
    t.ok('runGh: 失敗は stderr 付きで投げ、未ログインと読める', reasonOf(bad) === 'no-auth' && /gh auth login/.test(bad.stderr));
    const missing = await runGh(['pr', 'view', U(9)], { env: { ...process.env, AGENT_HOST_GH: path.join(scratch, 'no-such-gh.exe') } }).catch((e) => e);
    t.ok('runGh: 実行ファイルが無ければ ENOENT → no-gh', reasonOf(missing) === 'no-gh');
    const viaReader = await createPrReader({ run: (a) => runGh(a, { env }) }).read([{ number: 9, url: U(9) }]);
    t.ok('読み手と偽の gh をつなぐ', viaReader.prs[0].state === 'open' && viaReader.prs[0].checks === 'fail' && viaReader.reason === null, JSON.stringify(viaReader));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
