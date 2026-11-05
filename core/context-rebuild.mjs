// 会話の区切りで、Pleiad の記録（conversations.mjs の messages・presents）から引き継ぎを組み立て直す（docs/adr/0287、docs/design.md「自動圧縮」）。
// 区切りの種類（放置後の送信・エージェントの切り替え）に依らず同じ部品を使う。要約はエージェントに頼まず、記録から決まった形に畳む:
//   ・人の発言は全部（収まらなければ先頭と末尾をそのまま、間を一覧に）
//   ・ファイル・コマンド・URL・委譲の結果・成果物の索引（中身の要約ではなく、何があったかの数と先頭の並び）
//   ・直近のやりとり（発言・返答・ツールの結果ごと）
//   ・履歴の全文の写し（handoff-<sha>.json）の場所
// 大きさの上限・一覧化の閾値・直近のターン数は REBUILD_LIMITS の 1 か所にまとめる。
import crypto from 'node:crypto';
import { agentT } from './i18n.mjs';

export const REBUILD_LIMITS = Object.freeze({
  packageChars: 48_000,      // 組み立てた引き継ぎの上限（包みの文を含まない中身）
  userChars: 18_000,         // 「あなたの発言」の節の上限。超えたら先頭と末尾だけそのまま残し、間を一覧に
  userRecent: 8,             // 一覧に畳むとき、末尾からそのまま残す発言の数
  lineChars: 160,            // 一覧・索引の 1 行の上限
  indexChars: 7_000,         // 「索引」の節の上限
  indexItems: 40,            // 索引の 1 項目が並べる行の上限（あふれた分は「ほか N」）
  recentChars: 21_000,       // 「直近のやりとり」の節の上限
  recentTurns: 3,            // 直近のやりとりに載せる往復（人の発言→エージェントの返答）の数
  recentMessageChars: 3_000, // 直近の発言・返答 1 つあたりの上限
  toolResultChars: 800,      // 直近のツールの結果 1 つあたりの上限
  entries: 100,              // 会話に残す区切りの記録の上限（sessionData.rebuilds）
});

/** 設定（prefs.contextRebuild）。既定は OFF */
export const rebuildEnabled = (prefs) => prefs?.contextRebuild === true;

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
};

const oneLine = (text, max) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const limitList = (list) => {
  if (list.length <= REBUILD_LIMITS.indexItems) return { list, more: 0 };
  return { list: list.slice(0, REBUILD_LIMITS.indexItems), more: list.length - REBUILD_LIMITS.indexItems };
};

// ツールの入力から拾うファイルのパスの欄（どのエージェントの道具でも同じ名前で来るものだけ）。ほかの欄名は拾わない
const FILE_KEYS = ['file_path', 'filePath', 'absolute_path', 'notebook_path', 'path'];
const COMMAND_TOOLS = new Set(['bash', 'shell', 'run', 'exec']);
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;

function indexScan(rows, presents, noticeHashes) {
  const files = [], commands = [], urls = new Set(), reports = [];
  const seen = { file: new Set(), command: new Set() };
  const push = (seenSet, list, value) => { if (value && !seenSet.has(value)) { seenSet.add(value); list.push(value); } };
  for (const m of rows) {
    if (typeof m.text === 'string') for (const match of m.text.matchAll(URL_RE)) urls.add(match[0]);
    if (m.role === 'user' && typeof m.text === 'string' && noticeHashes.has(sha(m.text))) reports.push(m.text);
    for (const call of m.toolCalls ?? []) {
      const input = call.input && typeof call.input === 'object' ? call.input : {};
      for (const key of FILE_KEYS) if (typeof input[key] === 'string' && input[key].includes('/')) push(seen.file, files, input[key]);
      const name = String(call.name ?? '').toLowerCase();
      const command = input.command ?? input.cmd;
      if (COMMAND_TOOLS.has(name) && typeof command === 'string') push(seen.command, commands, oneLine(command, 400));
      if (typeof call.result?.text === 'string') for (const match of call.result.text.matchAll(URL_RE)) urls.add(match[0]);
    }
  }
  const deliverables = (presents ?? []).map(p => p.name ?? p.path ?? p.title).filter(v => typeof v === 'string' && v);
  return { files, commands, urlCount: urls.size, reports, deliverables };
}

/** 「あなたの発言」の節。委譲の完了通知（人の発言でないもの）は除く。上限を超えるときは間を一覧に畳む */
function userSection(own, locale) {
  const line = (m) => `- ${oneLine(m.text, REBUILD_LIMITS.lineChars)}`;
  const full = own.map(m => m.text).join('\n').length;
  if (full <= REBUILD_LIMITS.userChars) {
    return agentT(locale, 'handoff.rebuild.userTitle', { count: own.length }) + '\n'
      + own.map((m, i) => `${i + 1}. ${m.text}`).join('\n\n');
  }
  // 間の発言は一覧に畳む（先頭と末尾はそのまま）
  const middle = own.slice(1, Math.max(1, own.length - REBUILD_LIMITS.userRecent));
  const tail = own.slice(Math.max(1, own.length - REBUILD_LIMITS.userRecent));
  let out = agentT(locale, 'handoff.rebuild.userTitle', { count: own.length }) + '\n1. ' + own[0].text;
  out += '\n' + agentT(locale, 'handoff.rebuild.userMiddle', { count: middle.length }) + '\n' + middle.map(line).join('\n');
  out += '\n' + tail.map((m, i) => `${middle.length + 2 + i}. ${m.text}`).join('\n\n');
  return clip(out, REBUILD_LIMITS.userChars);
}

/** 「索引」の節。数と、先頭のいくつか（中身の要約はしない） */
function indexSection(scan, locale) {
  const rows = [];
  const list = (items, format) => {
    const { list: head, more } = limitList(items.map(format));
    return head.join(agentT(locale, 'handoff.rebuild.itemJoin')) + (more ? agentT(locale, 'handoff.rebuild.more', { count: more }) : '');
  };
  if (scan.files.length) rows.push(agentT(locale, 'handoff.rebuild.indexFiles', { count: scan.files.length, list: list(scan.files, f => oneLine(f, 120)) }));
  if (scan.commands.length) rows.push(agentT(locale, 'handoff.rebuild.indexCommands', { count: scan.commands.length, list: list(scan.commands, c => `\`${oneLine(c, REBUILD_LIMITS.lineChars)}\``) }));
  if (scan.urlCount) rows.push(agentT(locale, 'handoff.rebuild.indexUrls', { count: scan.urlCount }));
  if (scan.reports.length) rows.push(agentT(locale, 'handoff.rebuild.indexReports', { count: scan.reports.length, list: list(scan.reports, r => oneLine(r, 120)) }));
  if (scan.deliverables.length) rows.push(agentT(locale, 'handoff.rebuild.indexPresents', { count: scan.deliverables.length, list: list(scan.deliverables, d => oneLine(d, 120)) }));
  if (!rows.length) return '';
  return clip(agentT(locale, 'handoff.rebuild.indexTitle') + '\n' + rows.join('\n'), REBUILD_LIMITS.indexChars);
}

/** 「直近のやりとり」の節。末尾から往復（人→エージェント）を recentTurns 組、ツールの結果ごと */
function recentSection(rows, locale) {
  // 人の発言で区切った束（先頭の束は人の発言が無いこともある）
  const turns = [];
  for (const m of rows) {
    if (m.role === 'user') turns.push([]);
    if (!turns.length) turns.push([]);
    turns.at(-1).push(m);
  }
  const picked = turns.filter(turn => turn.some(m => m.role === 'user')).slice(-REBUILD_LIMITS.recentTurns);
  if (!picked.length) return '';
  const body = picked.map(turn => turn.map(m => {
    if (m.role === 'user') return agentT(locale, 'handoff.rebuild.recentUser', { text: clip(m.text, REBUILD_LIMITS.recentMessageChars) });
    const tools = (m.toolCalls ?? []).map(call => {
      const input = call.input && typeof call.input === 'object' ? oneLine(JSON.stringify(call.input), 200) : '';
      const result = typeof call.result?.text === 'string' ? ` → ${oneLine(call.result.text, REBUILD_LIMITS.toolResultChars)}` : '';
      return `  - ${call.name ?? '?'} ${input}${result}`.trim();
    }).join('\n');
    const head = agentT(locale, 'handoff.rebuild.recentAssistant', { text: clip(m.text ?? '', REBUILD_LIMITS.recentMessageChars) });
    return tools ? `${head}\n${tools}` : head;
  }).join('\n')).join('\n');
  return clip(agentT(locale, 'handoff.rebuild.recentTitle') + '\n' + body, REBUILD_LIMITS.recentChars);
}

/**
 * 引き継ぎの中身（HISTORY の位置に入る文）と、画面の区切りに出す内訳。
 * messages は区切りの前までの記録（conversations.mjs が渡す）。taskNotices は完了通知の本文の sha256 の並び（人の発言と見分ける印）。
 * locale は会話の言語（agentT へ渡す）。失敗したら投げる（呼び出し側が今の経路へ戻す）
 */
export function buildRebuildPackage({ messages, presents = [], taskNotices = [], ref, locale }) {
  const rows = (messages ?? []).filter(m => (m.role === 'user' || m.role === 'assistant') && (typeof m.text === 'string' || m.toolCalls?.length));
  const noticeHashes = new Set(taskNotices ?? []);
  const own = rows.filter(m => m.role === 'user' && typeof m.text === 'string' && !noticeHashes.has(sha(m.text)));
  const scan = indexScan(rows, presents, noticeHashes);
  const sections = [
    agentT(locale, 'handoff.rebuild.note', { ref }),
    own.length ? userSection(own, locale) : '',
    indexSection(scan, locale),
    recentSection(rows, locale),
  ].filter(Boolean);
  let context = sections.join('\n\n');
  if (context.length > REBUILD_LIMITS.packageChars) context = clip(context, REBUILD_LIMITS.packageChars);
  return {
    context,
    stats: {
      users: own.length,
      files: scan.files.slice(0, 3), fileCount: scan.files.length,
      commands: scan.commands.slice(0, 3), commandCount: scan.commands.length,
      urls: scan.urlCount, reports: scan.reports.length, presents: scan.deliverables.length,
      turns: Math.min(REBUILD_LIMITS.recentTurns, rows.filter(m => m.role === 'user').length),
    },
  };
}
