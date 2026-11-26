// bot が実際にどこで動くか（web/work-place.mjs の workPlace）。core（pickCwd）と web（チャンネルの設定の「各 bot の動く場所」・スレッドの返信先の推定）が
// 同じ判定を使うことを確かめる: パスの比較（Windows の形・UNC・末尾の区切り・`..`・前方一致の別の名前）・各理由・
// core の pickCwd / unrestrictedMode / defaultMode との一致（実際のバックエンドのモード表で）。LLM も本物の CLI も呼ばない。
import os from 'node:os';
import { insideFolder, workPlace, modeEntryFor, unrestrictedEntry } from '../../web/work-place.mjs';
import { foldersUnlimited } from '../../web/channels/bot-model.mjs';
import { createWorkPlaces, whereRows } from '../../web/channels/work-places.mjs';
import { pickCwd, unrestrictedMode, defaultMode } from '../../core/bots/sessions.mjs';
import { backend as claude } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';

export const name = 'work-place';
export const title = '作業場所の判定: 中か外かのパス比較・各理由・core の pickCwd と同じ答え・モードの既定の選び方が core と同じ';

const HOME = os.homedir();

export default async function (t) {
  // --- パスの中か外か ---
  t.ok('同じフォルダー・その下は中', insideFolder('/work/a', '/work/a') && insideFolder('/work/a', '/work/a/sub/deep'));
  t.ok('前方一致の別の名前（/work/ab）は中ではない', !insideFolder('/work/a', '/work/ab') && !insideFolder('/work/a', '/work/a-old/x'));
  t.ok('親は中ではない', !insideFolder('/work/a/sub', '/work/a') && !insideFolder('/work/a', '/'));
  t.ok('末尾の区切り・重なった区切り・`.` を吸収する', insideFolder('/work/a/', '/work/a') && insideFolder('/work/a', '/work//a/./b/') && insideFolder('/work/a', '/work/a/'));
  t.ok('`..` は 1 つ戻る（外へ出る `..` は中ではない）', insideFolder('/work/a', '/work/a/b/../c') && !insideFolder('/work/a', '/work/a/../b') && !insideFolder('/work/a', '/work/a/../../x'));
  t.ok('根（/）はすべての絶対パスの親', insideFolder('/', '/anything/here') && insideFolder('/', '/'));
  t.ok('空・未指定は中ではない', !insideFolder('', '/work/a') && !insideFolder('/work/a', '') && !insideFolder(null, undefined));
  t.ok('POSIX は大文字小文字を区別する', !insideFolder('/Work/A', '/work/a'));

  t.ok('Windows: 区切りは \\ と / のどちらも・大文字小文字を区別しない', insideFolder('D:\\dev\\pleiad', 'd:/DEV/Pleiad/web') && insideFolder('D:/dev/pleiad', 'D:\\dev\\pleiad\\core\\x.mjs'));
  t.ok('Windows: 前方一致の別の名前・別のドライブは中ではない', !insideFolder('D:\\dev\\pleiad', 'D:\\dev\\pleiad2') && !insideFolder('D:\\dev\\pleiad', 'C:\\dev\\pleiad') && !insideFolder('D:\\dev', 'E:\\dev\\x'));
  t.ok('Windows: ドライブの根は同じドライブのすべての親', insideFolder('D:\\', 'D:\\a\\b') && insideFolder('D:', 'D:\\a') && !insideFolder('D:\\', 'E:\\a'));
  t.ok('Windows: 末尾の区切りと `..` を吸収する', insideFolder('D:\\dev\\pleiad\\', 'D:\\dev\\pleiad') && !insideFolder('D:\\dev\\pleiad', 'D:\\dev\\pleiad\\..\\other'));
  t.ok('Windows: UNC は サーバー・共有まで同じなら中', insideFolder('\\\\srv\\share\\proj', '\\\\SRV\\Share\\proj\\src') && !insideFolder('\\\\srv\\share\\proj', '\\\\srv\\other\\proj') && !insideFolder('\\\\srv\\share\\proj', '\\\\srv\\share\\proj2'));
  t.ok('POSIX の絶対パスと Windows のパスは混ざらない', !insideFolder('/work/a', 'D:\\work\\a') && !insideFolder('D:\\work', '/work/a'));

  // --- 判定と理由 ---
  const owl = { folders: [{ path: '/work/a', access: 'rw' }, { path: '/work/b', access: 'ro' }] };
  const pick = (over) => workPlace({ folders: owl.folders, home: HOME, ...over });
  t.ok('cwd が無ければ先頭のフォルダー（unset）', JSON.stringify(pick({})) === JSON.stringify({ cwd: '/work/a', uses: 'bot', reason: 'unset' }) && pick({ channelCwd: '' }).reason === 'unset' && pick({ channelCwd: null }).uses === 'bot');
  t.ok('cwd が bot のフォルダーの中ならそれ（inside。2 つ目のフォルダーでも）', JSON.stringify(pick({ channelCwd: '/work/a/sub' })) === JSON.stringify({ cwd: '/work/a/sub', uses: 'channel', reason: 'inside' }) && pick({ channelCwd: '/work/b' }).cwd === '/work/b');
  t.ok('cwd が外なら先頭のフォルダー（outside）。前方一致の別の名前も外', JSON.stringify(pick({ channelCwd: '/elsewhere' })) === JSON.stringify({ cwd: '/work/a', uses: 'bot', reason: 'outside' }) && pick({ channelCwd: '/work/ab' }).reason === 'outside');
  t.ok('範囲を限れないモードなら cwd のまま（unrestricted）', JSON.stringify(pick({ channelCwd: '/elsewhere', unrestricted: true })) === JSON.stringify({ cwd: '/elsewhere', uses: 'channel', reason: 'unrestricted' }));
  t.ok('フォルダーが無い bot は cwd のまま（noFolders）、cwd も無ければホーム', JSON.stringify(workPlace({ folders: [], channelCwd: '/x', home: HOME })) === JSON.stringify({ cwd: '/x', uses: 'channel', reason: 'noFolders' })
    && JSON.stringify(workPlace({ folders: [], home: HOME })) === JSON.stringify({ cwd: HOME, uses: 'home', reason: 'unset' }) && workPlace({ home: HOME }).uses === 'home');
  t.ok('Windows のパスでも同じ判定（大文字小文字の違う cwd は中）', workPlace({ folders: [{ path: 'D:\\dev\\pleiad' }], channelCwd: 'd:\\DEV\\pleiad\\web', home: 'C:\\Users\\x' }).reason === 'inside'
    && workPlace({ folders: [{ path: 'D:\\dev\\pleiad' }], channelCwd: 'D:\\dev\\other', home: 'C:\\Users\\x' }).cwd === 'D:\\dev\\pleiad');

  // --- モード ---
  const modes = { claude: claude.modes(), codex: codex.modes() };
  t.ok('実際のモード表: 範囲を限れないか（web）は core の unrestrictedMode と同じ（Claude・Codex の全モードと、宣言の無い・不明な値）',
    [...Object.values(modes.claude), ...Object.values(modes.codex), undefined, null, {}, { scope: 'bogus' }, { scope: 'none' }, { scope: 'readonly' }, { scope: 'workspace' }, { scope: 'full' }]
      .every((m) => unrestrictedEntry(m) === unrestrictedMode(m) && unrestrictedEntry(m) === foldersUnlimited(m)));
  t.ok('実際のモード表: 語彙に無い id は core の defaultMode が選ぶモードと同じエントリ（空の表は null）',
    Object.values(modes).every((m) => modeEntryFor(m, 'no-such-mode') === m[defaultMode(m)] && modeEntryFor(m, undefined) === m[defaultMode(m)])
    && modeEntryFor({}, 'x') === null && modeEntryFor(undefined, 'x') === null);
  t.ok('語彙にある id はそのエントリ', Object.keys(modes.claude).every((id) => modeEntryFor(modes.claude, id) === modes.claude[id]));
  const odd = { a: { scope: 'full', autonomy: 'never' }, b: {}, c: { scope: 'workspace', autonomy: 'ask' } };
  t.ok('宣言の無いモードは「作業場所に書けて毎回聞く」扱い・該当が無ければ先頭（core と同じ）', modeEntryFor(odd, 'zz') === odd.b && defaultMode(odd) === 'b'
    && modeEntryFor({ a: { scope: 'full' } }, 'q')?.scope === 'full' && defaultMode({ a: { scope: 'full' } }) === 'a');

  // --- core の pickCwd との一致（フォルダー × cwd × モードの総当たり。実際のモード表） ---
  const botsList = [
    { folders: [] }, { folders: undefined }, owl,
    { folders: [{ path: '/work/a' }] }, { folders: [{ path: '/work/a/' }, { path: '/work/a/sub' }] },
  ];
  const cwds = [undefined, null, '', '/work/a', '/work/a/', '/work/a/sub/deep', '/work/ab', '/work/b/x', '/elsewhere', '/', '/work/a/../b'];
  const entries = [undefined, ...Object.values(modes.claude), ...Object.values(modes.codex)];
  let same = 0, diff = [];
  for (const bot of botsList) for (const cwd of cwds) for (const entry of entries) {
    const a = pickCwd(bot, cwd === undefined ? null : { cwd }, entry);
    const b = workPlace({ folders: bot.folders, channelCwd: cwd, unrestricted: unrestrictedEntry(entry), home: HOME }).cwd;
    if (a === b) same++; else diff.push([bot.folders, cwd, entry, a, b]);
  }
  t.ok(`core の pickCwd と web の workPlace は ${same} 通りすべて同じ作業場所（違い ${diff.length} 件）`, diff.length === 0 && same > 100);

  // --- 設定の「各 bot の動く場所」の行（web/channels/work-places.mjs） ---
  const host = { state: { homeDir: HOME }, cmd: async (op, { backend }) => (op === 'modes' ? modes[backend] : null) };
  const places = createWorkPlaces({ host });
  const guarded = { id: 'g', name: 'Guarded', backend: 'claude', mode: Object.keys(modes.claude).find((id) => !unrestrictedEntry(modes.claude[id])), folders: [{ path: '/work/a', access: 'rw' }] };
  const open = { id: 'o', name: 'Open', backend: 'claude', mode: Object.keys(modes.claude).find((id) => unrestrictedEntry(modes.claude[id])), folders: [{ path: '/work/a', access: 'rw' }] };
  const bare = { id: 'n', name: 'Bare', backend: 'claude', mode: guarded.mode, folders: [] };
  const plain = { id: 'p', name: 'Plain', plain: true, backend: 'claude', folders: [] };
  t.ok('実際のモード表に、範囲を限れるモードと限れないモードがある（以降の前提）', !!guarded.mode && !!open.mode);
  await places.ensure([guarded, open, bare]);
  const rows = (cwd, bots = [guarded, open, bare, plain]) => whereRows(places, bots, cwd);
  const byId = (rs) => Object.fromEntries(rs.map((r) => [r.bot.id, r]));
  const out = byId(rows('/elsewhere'));
  t.ok('素の bot は行に出さない（モードもフォルダーもスレッドごと）', rows('/elsewhere').length === 3 && !('p' in out));
  t.ok('チャンネルのフォルダーが bot のフォルダーの外: 範囲を限れる bot は自分のフォルダーを使い、理由つき（outside）', out.g.cwd === '/work/a' && out.g.outside === true && out.g.reason === 'outside');
  t.ok('範囲を限れないモードの bot はチャンネルのフォルダーのまま（理由は付けない）', out.o.cwd === '/elsewhere' && out.o.outside === false && out.o.reason === 'unrestricted');
  t.ok('フォルダーの無い bot もチャンネルのフォルダーのまま', out.n.cwd === '/elsewhere' && out.n.outside === false && out.n.reason === 'noFolders');
  const inside = byId(rows('/work/a/sub'));
  t.ok('bot のフォルダーの中ならそこを使い、理由は付けない', inside.g.cwd === '/work/a/sub' && inside.g.outside === false && inside.g.reason === 'inside');
  const none = byId(rows(''));
  t.ok('チャンネルのフォルダーを指定しなければ、どの行も理由は付けない（先頭のフォルダー・ホーム）', Object.values(none).every((r) => r.outside === false)
    && none.g.cwd === '/work/a' && none.n.uses === 'home' && byId(rows('   ')).g.outside === false && byId(rows(null)).g.outside === false);
  t.ok('画面の行は workPlace の答えと同じ（core の pickCwd と同じ作業場所）', rows('/elsewhere').every((r) => r.cwd === pickCwd({ folders: r.bot.folders }, { cwd: '/elsewhere' }, modes.claude[r.bot.mode])));
  t.ok('宛先が空・欠けた要素があっても落ちない', whereRows(places, [], '/x').length === 0 && whereRows(places, undefined, '/x').length === 0 && whereRows(places, [null, guarded], '/x').length === 1);
  const cold = createWorkPlaces({ host: { state: { homeDir: HOME }, cmd: async () => ({}) } });
  t.ok('モードの表が取れていない間は範囲を限れる扱い（取れたあとに判定し直す）', cold.of(open, '/elsewhere').cwd === '/work/a' && cold.loaded('claude') === false);
}
