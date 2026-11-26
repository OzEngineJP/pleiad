// bot のページの、DOM に触れない決まりごと（テストから直接呼ぶ。ADR 0109・docs/channels.md）。
// 画面の部品は bot-page.mjs・memory-list.mjs。

/** 読み書きの範囲を限れないモードか。範囲 full（Claude の Bypass・Antigravity の yolo・Codex の sandbox なしの yolo）だけ。
 *  Codex の「全部自動」(full) は sandbox が作業場所に書き込みを限るので、限れる扱いのまま（実際の動きと表示を合わせる。計画 §7.2-2） */
export const foldersUnlimited = (mode) => mode?.scope === 'full';

/** 承認モードの id が語彙に無いとき、その語彙の既定（default があれば default、無ければ先頭） */
export function validMode(modes, id) {
  const ids = Object.keys(modes ?? {});
  if (id in (modes ?? {})) return id;
  return ids.includes('default') ? 'default' : ids[0] ?? '';
}

/** 承認モードが 1 つしか選べないバックエンドか（Antigravity は全部自動だけ）。その 1 つの id を返す。複数あれば null */
export function onlyMode(modes) {
  const ids = Object.keys(modes ?? {});
  return ids.length === 1 ? ids[0] : null;
}

/** 「M/D」。今日は null を返す（呼び出し側が「今日」と書く） */
export function shortDate(at, now = Date.now()) {
  const d = new Date(at);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return null;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 時刻の短い書き方: 今日は「HH:MM」、ほかの日は「M/D HH:MM」 */
export function shortTime(at, now = Date.now()) {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const date = shortDate(at, now);
  return date ? `${date} ${hm}` : hm;
}

/**
 * 夜の記憶の整理の様子（memory.learnStatus の返り）を、記憶の見出しの下の 1 行の材料にする（ADR 0118）。
 * 返りは辞書の部品の並び [{ key, params }]（channels:memory.learn.<key>）と、目立たせるか（warn: 失敗・飛ばした）。null は出さない
 */
export function learnStatusView(status, now = Date.now()) {
  if (!status) return null;
  const parts = [];
  const result = status.lastResult;
  if (status.running) parts.push({ key: 'running' });
  else if (status.lastRunAt && result) parts.push({ key: result.changed ? 'ran' : 'ranNone', params: { when: shortTime(result.at ?? status.lastRunAt, now), n: result.changed } });
  else if (!status.lastRunAt) parts.push({ key: 'never' });
  if (result?.retiered) parts.push({ key: 'retiered', params: { n: result.retiered } });   // 段を付け直した数（夜の整理は増やすだけでなく選び直す。ADR 0363）
  if (result?.more) parts.push({ key: 'more' });
  if (result?.deferred) parts.push({ key: 'deferred', params: { n: result.deferred } });
  if (status.failure) parts.push({ key: 'failed', params: { error: status.failure.message } });
  if (status.skip?.count) parts.push({ key: 'skipped', params: { n: status.skip.count, reasonKey: status.skip.reason } });
  if (status.paused) parts.push({ key: 'paused' });
  else if (status.nextAt) parts.push({ key: 'next', params: { when: shortTime(status.nextAt, now) } });
  return { parts, warn: Boolean(status.failure || status.skip?.count) };
}

/** 記憶の出どころ 1 件の行き先と、字の材料。
 *  返り: { kind: 'post'|'message'|'none', where, date, target } 。target は { channelId, threadId?, postId? } か { sessionId }（開けるとき）か null */
export function sourceView(src, { channels = new Map(), bots = new Map(), sessions = new Map() } = {}, now = Date.now()) {
  if (!src) return { kind: 'none', where: '', date: null, target: null };
  const date = shortDate(src.at ?? 0, now);
  if (src.kind === 'post') {
    const ch = channels.get(src.channelId);
    const dmBot = ch?.kind === 'dm' ? bots.get(ch.botId) : null;
    return {
      kind: 'post',
      where: ch ? { type: ch.kind === 'dm' ? 'dm' : 'channel', name: ch.name, icon: dmBot?.icon ?? '', iconImage: dmBot?.iconImage ?? '' } : { type: 'channel', name: '' },
      date,
      target: src.channelId ? { channelId: src.channelId, ...(src.threadId ? { threadId: src.threadId } : {}), ...(src.postId ? { postId: src.postId } : {}) } : null,
    };
  }
  const s = sessions.get(src.sessionId);
  return { kind: 'message', where: { type: 'chat', name: s?.title ?? '' }, date, target: s ? { sessionId: src.sessionId } : null };
}

const COLOR_COUNT = 8;   // web/channels/bot-icon.mjs の BOT_COLOR_COUNT と同じ
const colorOf = (bot) => (Number.isInteger(bot?.color) && bot.color >= 1 && bot.color <= COLOR_COUNT ? bot.color : null);

/** 次に作る bot の色（1〜8）。最後に作った bot の次の色から、まだ誰も使っていない色を選ぶ（core/bots/service.mjs の nextColor と同じ） */
export function nextColor(bots) {
  const rows = [...(bots ?? [])].filter((b) => !b.plain).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  if (!rows.length) return 1;
  const last = colorOf(rows.at(-1)) ?? ((rows.length - 1) % COLOR_COUNT) + 1;
  const first = (last % COLOR_COUNT) + 1;
  const used = new Set(rows.map(colorOf).filter(Boolean));
  for (let step = 0; step < COLOR_COUNT; step++) {
    const color = ((first - 1 + step) % COLOR_COUNT) + 1;
    if (!used.has(color)) return color;
  }
  return first;
}

/** 作る 3 段（名前 → 色 → 人格）の下書きの初期値。エージェント・モデル・承認モードは既定のまま作る（ADR 0362） */
export function newDraft(bots) {
  return { step: 1, name: '', color: nextColor(bots), persona: '' };
}

/** フォルダー 1 行の読み書きを切り替えた新しい配列（bots.update の folders は置き換え） */
export function toggleAccess(folders, path) {
  return folders.map((f) => (f.path === path ? { ...f, access: f.access === 'rw' ? 'ro' : 'rw' } : f));
}

/** フォルダーを足した新しい配列。同じパスは足さない（大文字小文字を区別せず、末尾の区切りは無視） */
export function addFolder(folders, path, access = 'rw') {
  const key = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  if (!path || folders.some((f) => key(f.path) === key(path))) return folders;
  return [...folders, { path, access }];
}

export const removeFolder = (folders, path) => folders.filter((f) => f.path !== path);
