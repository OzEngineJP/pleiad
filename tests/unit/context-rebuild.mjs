// 記録からの組み立て直しの引き継ぎ（core/context-rebuild.mjs。ADR 0287）。
//   - 組み立て: 人の発言は全文・索引（ファイル・コマンド・URL・委譲の結果・成果物）・直近のやりとり・履歴の写しの場所が入る
//   - 並び: 発言は記録の順、索引は初出の順（重複は 1 つ）
//   - 上限: 発言が多いときは間を一覧に畳む。索引は先頭のいくつか。包み全体にも上限がある
//   - 委譲の完了通知（taskNotices）は人の発言ではなく「委譲の結果」に数える
import crypto from 'node:crypto';
import { buildRebuildPackage, rebuildEnabled, REBUILD_LIMITS } from '../../core/context-rebuild.mjs';

export const name = 'context-rebuild';
export const title = '記録からの組み立て直し: 引き継ぎの組み立て・並び・上限・委譲の結果の見分け';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const user = (text, extra = {}) => ({ role: 'user', text, ...extra });
const assistant = (text, toolCalls = []) => ({ role: 'assistant', text, ...(toolCalls.length ? { toolCalls } : {}) });
const build = (args) => buildRebuildPackage({ ref: '/data/handoff-abc.json', locale: 'ja', ...args });

export default async function (t) {
  t.ok('既定は OFF', rebuildEnabled({}) === false && rebuildEnabled(null) === false);
  t.ok('prefs.contextRebuild が true のときだけ ON', rebuildEnabled({ contextRebuild: true }) === true && rebuildEnabled({ contextRebuild: false }) === false);

  // --- 組み立て: 発言・索引・直近・写しの場所 ---
  const messages = [
    user('最初のお願い https://example.com/spec を見て'),
    assistant('承知しました', [{ name: 'read', input: { file_path: 'D:/dev/app/a.ts' }, result: { text: 'const a = 1;' } }]),
    assistant('', [{ name: 'bash', input: { command: 'npm test' }, result: { text: 'ok' } }]),
    user('ついでに b.ts も直して'),
    assistant('直しました', [{ name: 'edit', input: { file_path: 'D:/dev/app/b.ts' }, result: { text: 'done https://example.com/log' } }]),
    user('ありがとう'),
  ];
  const { context, stats } = build({ messages, presents: [{ name: 'dist/bundle.js' }] });
  t.ok('人の発言が全文・記録の順で入る',
    context.includes('最初のお願い') && context.indexOf('最初のお願い') < context.indexOf('ついでに b.ts も直して')
    && context.indexOf('ついでに b.ts も直して') < context.indexOf('ありがとう'));
  t.ok('写し（handoff-<sha>.json）の場所が入る', context.includes('/data/handoff-abc.json'));
  t.ok('索引にファイル・コマンド・URL・成果物が入る',
    stats.fileCount === 2 && stats.files[0] === 'D:/dev/app/a.ts' && stats.commandCount === 1
    && stats.urls === 2 && stats.presents === 1 && stats.users === 3);
  t.ok('ファイルは初出の順・重複は 1 つ', stats.files[0] === 'D:/dev/app/a.ts' && stats.files[1] === 'D:/dev/app/b.ts');
  t.ok('直近のやりとりは末尾の往復を数える', stats.turns === Math.min(REBUILD_LIMITS.recentTurns, 3));

  // --- 委譲の完了通知は人の発言に数えず「委譲の結果」へ ---
  const notice = '[タスク完了通知]\n件名: 調査\n結果: 完了';
  const withNotice = build({ messages: [user('お願い'), user(notice)], taskNotices: [sha(notice)] });
  t.ok('完了通知は発言に数えない（発言 1 件）', withNotice.stats.users === 1 && withNotice.context.includes('発言（1 件'));
  t.ok('完了通知は委譲の結果として数える', withNotice.stats.reports === 1);

  // --- 上限: 発言が多いときは間を一覧に畳む（先頭と末尾はそのまま）---
  const many = Array.from({ length: REBUILD_LIMITS.userRecent + 30 }, (_, i) => user(`長いお願い ${i} ` + 'x'.repeat(500)));
  const big = build({ messages: many });
  const userPart = big.context.slice(0, big.context.indexOf('## 直近'));
  const lastMiddle = many.length - REBUILD_LIMITS.userRecent - 1;
  t.ok('先頭の発言は全文残る', userPart.includes('長いお願い 0 ' + 'x'.repeat(400)));
  t.ok('間の発言は 1 行の一覧に畳む', userPart.includes(`- 長いお願い ${lastMiddle}`) && !userPart.includes(`長いお願い ${lastMiddle} ` + 'x'.repeat(200)));
  t.ok('末尾の発言は全文残る', userPart.includes(`長いお願い ${many.length - 1} ` + 'x'.repeat(400)));
  t.ok('包み全体の上限を守る', big.context.length <= REBUILD_LIMITS.packageChars);

  // --- 索引の上限: 先頭のいくつかと「ほか N」---
  const manyFiles = Array.from({ length: REBUILD_LIMITS.indexItems + 5 }, (_, i) =>
    assistant('', [{ name: 'read', input: { file_path: `D:/dev/app/f${i}.ts` }, result: { text: 'x' } }]));
  const indexed = build({ messages: [user('全部読んで'), ...manyFiles] });
  t.ok('索引は全部の数を数える', indexed.stats.fileCount === REBUILD_LIMITS.indexItems + 5);
  t.ok('索引の本文は「ほか N」で締める', indexed.context.includes(`ほか 5 件`));

  // --- 空・端の形でも落ちない ---
  const empty = build({ messages: [] });
  t.ok('発言の無い会話でも写しの場所だけは渡る', empty.context.includes('/data/handoff-abc.json') && empty.stats.users === 0);
  const onlyAssistant = build({ messages: [assistant('先に話した')] });
  t.ok('人の発言が無くても直近のやりとりは組めないので発言節は無い', onlyAssistant.stats.turns === 0);
}
