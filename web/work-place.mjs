// bot が実際にどこで動くか（作業場所）を決める、DOM にも Node にも触れない 1 つの判定。
//
// core（core/bots/sessions.mjs の pickCwd。ターンの始めに使う）と web（チャンネルの設定の「各 bot の動く場所」・スレッドの返信先の推定・
// 入力欄「/」の候補の探し先）が同じこの関数で決める。画面の案内と実際の動きがずれないようにするためで、ここ以外に判定を書かない。
//
// 判定（ADR 0109・計画 §7.2-2）:
//   チャンネルの cwd が決まっていて、かつ
//     ・モードが書き込みの範囲を限れない（scope が full）→ cwd のまま          reason: unrestricted
//     ・bot がフォルダーを 1 つも持たない               → cwd のまま          reason: noFolders
//     ・cwd が bot のフォルダーのどれかの中            → cwd のまま          reason: inside
//   そうでなければ bot の先頭のフォルダー（無ければホーム）。cwd が決まっていたのに使わないときの reason は outside、決まっていなければ unset。

// core/modes.mjs の SCOPES と同じ並び（web は core を import できないので写す。tests/unit/work-place.mjs が同じ結果になることを確かめる）
const SCOPES = ['none', 'readonly', 'workspace', 'full'];
const AUTONOMIES = ['ask', 'judge', 'never'];

/**
 * パスを「根 + 区切りごとの名前」に分ける。OS に依らず同じ結果にする（core は Windows、web はブラウザー）。
 * Windows の形（`C:\` `C:/` `\\server\share`）は大文字小文字を区別せず、`\` も `/` も区切り。それ以外は `/` だけが区切りで大文字小文字を区別する。
 * `.` と空の区切りは捨て、`..` は 1 つ戻る。空の入力は null
 */
function split(p) {
  const raw = String(p ?? '').trim();
  if (!raw) return null;
  let win = false, root = '', rest = raw;
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(raw);
  if (drive) {
    win = true;
    root = `${drive[1].toLowerCase()}:`;
    rest = raw.slice(2);
  } else if (raw.startsWith('\\\\')) {
    win = true;
    const unc = /^\\\\([^\\/]+)[\\/]+([^\\/]+)(.*)$/.exec(raw);
    root = unc ? `\\\\${unc[1].toLowerCase()}\\${unc[2].toLowerCase()}` : '\\\\';
    rest = unc ? unc[3] : raw.slice(2);
  } else if (raw[0] === '/') {
    root = '/';
  }
  const names = [];
  for (const name of rest.split(win ? /[\\/]+/ : /\/+/)) {
    if (!name || name === '.') continue;
    if (name === '..') {
      if (names.length && names.at(-1) !== '..') names.pop();
      else if (!root) names.push('..');
      continue;
    }
    names.push(win ? name.toLowerCase() : name);
  }
  return { root, names };
}

/** wanted が folder と同じか、その中か（`/work/ab` は `/work/a` の中ではない。末尾の区切り・`..`・Windows の大文字小文字を吸収） */
export function insideFolder(folder, wanted) {
  const f = split(folder);
  const w = split(wanted);
  if (!f || !w || f.root !== w.root) return false;
  return f.names.every((name, i) => w.names[i] === name);
}

/** そのモード（host の modes() の 1 エントリ）が書き込みの範囲を限れないか。core/bots/sessions.mjs の unrestrictedMode と同じ答え */
export const unrestrictedEntry = (entry) => entry?.scope === 'full';

/**
 * bot のモード id から、そのバックエンドの modes() のエントリを引く。語彙に無い id は既定のモード
 * （作業場所に書けて毎回聞くもの、無ければ先頭）。core の defaultMode と同じ選び方（モードが取れていなければ null）
 */
export function modeEntryFor(modes, modeId) {
  if (modes?.[modeId]) return modes[modeId];
  const entries = Object.values(modes ?? {});
  const weak = entries.find((m) => {
    const scope = SCOPES.includes(m?.scope) ? m.scope : 'workspace';
    const autonomy = AUTONOMIES.includes(m?.autonomy) ? m.autonomy : 'ask';
    return scope === 'workspace' && autonomy === 'ask';
  });
  return weak ?? entries[0] ?? null;
}

/**
 * 作業場所を決める。
 * @param {object} o
 * @param {Array<{path:string}>} [o.folders] bot のフォルダー（先頭が既定の作業場所）
 * @param {string|null} [o.channelCwd] チャンネルの既定の作業フォルダー（無ければ null / 空）
 * @param {boolean} [o.unrestricted] モードが書き込みの範囲を限れないか（unrestrictedEntry）
 * @param {string} [o.home] ホームのフォルダー（bot がフォルダーを持たず cwd も無いときの最後の行き先）
 * @returns {{ cwd: string, uses: 'channel'|'bot'|'home', reason: 'unrestricted'|'noFolders'|'inside'|'outside'|'unset' }}
 *   uses: cwd がどこ由来か（channel = チャンネルの cwd、bot = bot の先頭のフォルダー、home = ホーム）
 */
export function workPlace({ folders = [], channelCwd = null, unrestricted = false, home = '' } = {}) {
  const list = folders ?? [];
  const wanted = channelCwd ? String(channelCwd) : null;
  if (wanted) {
    if (unrestricted) return { cwd: wanted, uses: 'channel', reason: 'unrestricted' };
    if (!list.length) return { cwd: wanted, uses: 'channel', reason: 'noFolders' };
    if (list.some((f) => insideFolder(f.path, wanted))) return { cwd: wanted, uses: 'channel', reason: 'inside' };
  }
  const reason = wanted ? 'outside' : 'unset';
  const first = list[0]?.path;
  return first == null ? { cwd: home, uses: 'home', reason } : { cwd: first, uses: 'bot', reason };
}
