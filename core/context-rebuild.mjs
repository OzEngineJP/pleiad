// 会話の区切りで、Pleiad の記録（conversations.mjs の messages・presents）から引き継ぎを組み立て直す（docs/adr/0287、docs/design.md「自動圧縮」）。
// 区切りの種類（放置後の送信・エージェントの切り替え）に依らず同じ部品を使う。要約はエージェントに頼まず、記録から決まった形に畳む:
//   ・人の発言は全部（収まらなければ先頭と末尾をそのまま、間を一覧に）
//   ・ファイル・コマンド・URL・委譲の結果・成果物の索引（中身の要約ではなく、何があったかの数と先頭の並び）
//   ・直近のやりとり（発言・返答・ツールの結果ごと）
//   ・履歴の全文の写し（handoff-<sha>.json）の場所
// 大きさの上限・一覧化の閾値・直近のターン数は REBUILD_LIMITS の 1 か所にまとめる。
// 渡す messages は、呼び出し側が classifySystemMessages で画面と同じ分類にしてから渡す（`!`・コマンド・要約・包みの行は発言に混ざらない）。
import crypto from 'node:crypto';
import { agentT } from './i18n.mjs';

export const REBUILD_LIMITS = Object.freeze({
  // 枠の値は temporary/reports/context-rebuild-probe.md の試しで決めた（混在の文で 1 字あたり約 0.70 トークン。
  // 発言 1 万〜2 万字・直近 1.5 万〜2 万字＋索引が費用と正しさの釣り合い点。全体約 4 万トークンを超えると今の要約より高くなる）
  packageChars: 57_000,      // 組み立てた引き継ぎの上限（包みの文を含まない中身。0.70 換算で約 4 万トークン）
  userChars: 15_000,         // 「あなたの発言」の節の上限。超えたら先頭と末尾だけそのまま残し、間を一覧に
  userRecent: 8,             // 一覧に畳むとき、末尾からそのまま残す発言の数
  lineChars: 160,            // 一覧・索引の 1 行の上限
  indexChars: 7_000,         // 「索引」の節の上限
  indexItems: 40,            // 索引の 1 項目が並べる行の上限（あふれた分は「ほか N」）
  recentChars: 17_500,       // 「直近のやりとり」の節の上限。超えたら古い往復から落とす
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
// パスらしさ: 区切りが / か \（Windows）。ドライブ文字つき・相対のどちらも拾う
const PATHISH_RE = /[\\/]/;

/** 人が書いた発言（シェル・コマンド・完了通知・包みの行は除く）。classifySystemMessages 済みの行を前提にする */
const isOwn = (m, noticeHashes) =>
  m?.role === 'user' && !m.kind && !m.internalTaskNotice && typeof m.text === 'string' && !noticeHashes.has(sha(m.text));

const urlsOf = (text) => { if (typeof text !== 'string') return []; return [...text.matchAll(URL_RE)].map(m => m[0]); };

function indexScan(rows, presents, noticeHashes) {
  const files = [], commands = [], urls = new Set(), reports = [];
  const seen = { file: new Set(), command: new Set() };
  const push = (seenSet, list, value) => { if (value && !seenSet.has(value)) { seenSet.add(value); list.push(value); } };
  for (const m of rows) {
    for (const url of urlsOf(m.text)) urls.add(url);
    // `!` シェル（kind: 'shell'）とスラッシュコマンド（kind: 'command'）の入力はコマンドの索引へ、出力は URL 走査だけに使う
    if (m.role === 'user' && (m.kind === 'shell' || m.kind === 'command')) {
      push(seen.command, commands, oneLine(m.command, 400));
      for (const url of [...urlsOf(m.stdout), ...urlsOf(m.stderr), ...urlsOf(m.output)]) urls.add(url);
      continue;
    }
    if (m.role === 'user' && typeof m.text === 'string' && (m.internalTaskNotice || noticeHashes.has(sha(m.text)))) reports.push(m.text);
    for (const call of m.toolCalls ?? []) {
      const input = call.input && typeof call.input === 'object' ? call.input : {};
      for (const key of FILE_KEYS) if (typeof input[key] === 'string' && PATHISH_RE.test(input[key])) push(seen.file, files, input[key]);
      const name = String(call.name ?? '').toLowerCase();
      const command = input.command ?? input.cmd;
      if (COMMAND_TOOLS.has(name) && typeof command === 'string') push(seen.command, commands, oneLine(command, 400));
      if (typeof call.result?.text === 'string') for (const match of call.result.text.matchAll(URL_RE)) urls.add(match[0]);
    }
  }
  // 提示の手がかりは path・caption に限らない（題・URL・名前も拾う。落とすと「成果物なし」に見える）
  const deliverables = (presents ?? []).map(p => p.path ?? p.caption ?? p.title ?? p.name ?? p.url).filter(v => typeof v === 'string' && v);
  return { files, commands, urlCount: urls.size, reports, deliverables };
}

/**
 * 「あなたの発言」の節。委譲の完了通知・内部の行は除く。上限を超えるときは、最初の依頼と末尾の発言をそのまま残し、
 * 間を一覧と番号に畳む（末尾を切らない: 直近の発言が消えないよう、先頭・中間・末尾に別の予算を分ける）
 */
function userSection(own, locale) {
  const line = (m) => `- ${oneLine(m.text, REBUILD_LIMITS.lineChars)}`;
  const budget = REBUILD_LIMITS.userChars;
  const full = own.map(m => m.text).join('\n').length;
  if (full <= budget) {
    return agentT(locale, 'handoff.rebuild.userTitle', { count: own.length }) + '\n'
      + own.map((m, i) => `${i + 1}. ${m.text}`).join('\n\n');
  }
  const headBudget = Math.floor(budget * 0.35);
  const tailBudget = Math.floor(budget * 0.45);
  // 末尾から、そのまま入る分だけ取る（直近の発言を優先して残す）
  const tail = [];
  let tailUsed = 0;
  for (let i = own.length - 1; i >= 1 && tail.length < REBUILD_LIMITS.userRecent; i--) {
    const text = tail.length ? own[i].text : clip(own[i].text, tailBudget);
    const cost = text.length + String(i + 1).length + 3;
    if (tail.length && tailUsed + cost > tailBudget) break;
    tail.unshift({ index: i, text });
    tailUsed += cost;
  }
  const tailFrom = tail.length ? tail[0].index : own.length;
  const middle = own.slice(1, tailFrom);
  let out = agentT(locale, 'handoff.rebuild.userTitle', { count: own.length }) + '\n1. ' + clip(own[0].text, headBudget);
  // 間の一覧は残りの予算に収まる分だけ。新しい方（末尾に近いもの）を優先して残す
  const middleBudget = budget - out.length - tailUsed - 200;
  const middleLines = middle.map(line);
  let middleText = middleLines.join('\n');
  while (middleText.length > middleBudget && middleLines.length > 1) {
    middleLines.shift();
    middleText = middleLines.join('\n');
  }
  out += '\n' + agentT(locale, 'handoff.rebuild.userMiddle', { count: middle.length }) + '\n' + middleText;
  out += '\n' + tail.map((m) => `${m.index + 1}. ${m.text}`).join('\n\n');
  return out;
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

/** 「直近のやりとり」の節。末尾から往復（人→エージェント）を recentTurns 組、ツールの結果ごと。枠を超えるときは古い方から落とす */
function recentSection(rows, noticeHashes, locale) {
  // 人の発言で区切った束（先頭の束は人の発言が無いこともある）。内部の行（`!`・コマンド）は束にだけ残す
  const turns = [];
  for (const m of rows) {
    if (isOwn(m, noticeHashes)) turns.push([]);
    if (!turns.length) turns.push([]);
    turns.at(-1).push(m);
  }
  const picked = turns.filter(turn => turn.some(m => isOwn(m, noticeHashes))).slice(-REBUILD_LIMITS.recentTurns);
  if (!picked.length) return '';
  const renderTurn = (turn) => turn.map(m => {
    if (m.role === 'user' && m.kind === 'shell') {
      const output = [m.stdout, m.stderr].filter(Boolean).map(s => oneLine(s, REBUILD_LIMITS.toolResultChars)).join('\n');
      return agentT(locale, 'handoff.rebuild.recentUser', { text: `! ${m.command ?? ''}` }) + (output ? `\n  ${output}` : '');
    }
    if (m.role === 'user' && m.kind === 'command') {
      const output = m.output ? `\n  ${oneLine(m.output, REBUILD_LIMITS.toolResultChars)}` : '';
      return agentT(locale, 'handoff.rebuild.recentUser', { text: m.command ?? m.text ?? '' }) + output;
    }
    if (m.role === 'user') return agentT(locale, 'handoff.rebuild.recentUser', { text: clip(m.text, REBUILD_LIMITS.recentMessageChars) });
    const tools = (m.toolCalls ?? []).map(call => {
      const input = call.input && typeof call.input === 'object' ? oneLine(JSON.stringify(call.input), 200) : '';
      const result = typeof call.result?.text === 'string' ? ` → ${oneLine(call.result.text, REBUILD_LIMITS.toolResultChars)}` : '';
      return `  - ${call.name ?? '?'} ${input}${result}`.trim();
    }).join('\n');
    const head = agentT(locale, 'handoff.rebuild.recentAssistant', { text: clip(m.text ?? '', REBUILD_LIMITS.recentMessageChars) });
    return tools ? `${head}\n${tools}` : head;
  }).join('\n');
  const title = agentT(locale, 'handoff.rebuild.recentTitle');
  // 新しい方から積み、枠を超える往復は古い方から落とす（末尾を切ると直近が消える）
  const blocks = [];
  let used = title.length;
  for (let i = picked.length - 1; i >= 0; i--) {
    const body = renderTurn(picked[i]);
    if (blocks.length && used + body.length + 1 > REBUILD_LIMITS.recentChars) break;
    blocks.unshift(body);
    used += body.length + 1;
  }
  return title + '\n' + blocks.join('\n');
}

/**
 * 引き継ぎの中身（HISTORY の位置に入る文）と、画面の区切りに出す内訳。
 * messages は区切りの前までの記録（conversations.mjs が classifySystemMessages に通してから渡す）。
 * taskNotices は完了通知の本文の sha256 の並び（行の internalTaskNotice と併せて、人の発言と見分ける印）。
 * locale は会話の言語（agentT へ渡す）。失敗したら投げる（呼び出し側が今の経路へ戻す）
 */
export function buildRebuildPackage({ messages, presents = [], taskNotices = [], ref, locale }) {
  // 画面と同じ分類の行から、発言と返答（内部の行は `!`・コマンドに限って残す）を取る
  const rows = (messages ?? []).filter(m =>
    (m.role === 'user' || m.role === 'assistant')
    && (typeof m.text === 'string' || m.toolCalls?.length || m.kind === 'shell' || m.kind === 'command'));
  const noticeHashes = new Set(taskNotices ?? []);
  const own = rows.filter(m => isOwn(m, noticeHashes));
  const scan = indexScan(rows, presents, noticeHashes);
  const sections = [
    agentT(locale, 'handoff.rebuild.note', { ref }),
    own.length ? userSection(own, locale) : '',
    indexSection(scan, locale),
    recentSection(rows, noticeHashes, locale),
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
      turns: Math.min(REBUILD_LIMITS.recentTurns, own.length),
    },
  };
}
