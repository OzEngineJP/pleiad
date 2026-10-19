// Pleiad の指示（設定 › コンテキストの「指示」のカード。docs/context-runtime.md「Pleiad の指示」、ADR 0026）。
// 指示ファイル・Skills・外部 MCP の担当（ADR 0014）によらず、能力の印 plyInstructions を持つ会話へ毎ターン入れる。
// 入れる経路は ADR 0023 のまま: core/server.mjs の runTurn が ply_agents の instructions の後ろに足す（印 plyAgents）、
// 橋を持たないバックエンドには addedInstructions で渡す。Claude は append、Codex は developerInstructions、
// ACP の系統（Devin・Grok）と agy は発言の前に足す形で受け取る。保存は prefs.json の plyInstructions（すべての場所に共通。場所ごとには持たない）。
//
// 項目は 3 種類:
//   - 既定（child: 委譲された会話でのコマンドの扱い / codexPolicy: Codex の実行前の拒否（Codex の子だけ））。
//     依頼元に委譲を勧める既定（前の版の delegate: 委譲の進め方）は持たない。委譲するかは利用者が自分で足した指示で決める（ADR 0210）。
//     Pleiad が最初から入れている。編集でき、編集していなければ
//     文面は辞書（agent:guide.*）から会話の言語で引く（Pleiad の更新で新しい文面になる）。編集したら保存した文のまま（「既定に戻す」で戻る）。
//   - 委譲と連動（route: 委譲の振り分けの使い方）。ply_delegate の約束なので編集・スイッチは無く、委譲先の自動選択が有効なときだけ入る。
//     並びはいつも最後。保存もしない。
//   - 自分で足したもの（u-…）。名前・本文・入れる会話（すべて／依頼元だけ／委譲された会話だけ）・エージェント（Claude Code・Codex）。
//
// 保存の形 { items: [{ id, on, name?, body?, target?, agents? }] }（並びが入る順）。既定の項目は編集したときだけ name などを持つ。
// plyInstructions が無い間は、前の版の addedContext（{ delegation: false } で委譲の指示を切っていた）から作る（child のスイッチに写す。
// codexPolicy は前の版に無かった項目なので入れたまま）。
// 保存に残った delegate は、本文を編集していなければ捨て、編集していれば自分で足した指示（u-delegate）に変えて残す（ADR 0210）。
import crypto from 'node:crypto';
import { z } from 'zod';
import { agentT, t } from './i18n.mjs';
import { estimateTokens } from '../web/token-estimate.mjs';
import { DEFAULT_AGENT_IDS, agentOf } from './backends/agents.mjs';

export const TARGETS = ['all', 'parent', 'child'];
// 項目で選べるエージェント = 本番のエージェント全部（既定の有効一覧。試験用の fake は入らない）。
// 保存済みの項目の agents は広げない: 前の版の ['claude','codex'] は「当時の全部」か「その 2 つだけ」か判別できないので、そのまま残す
export const AGENTS = [...DEFAULT_AGENT_IDS];
// agents を持たない既定の項目はどちらのエージェントにも入る
const BUILTIN = { child: { target: 'child' }, codexPolicy: { target: 'child', agents: ['codex'] } };
const builtinAgents = id => [...(BUILTIN[id].agents ?? AGENTS)];
const LINKED = 'route';
const MAX_ITEMS = 50, MAX_BODY = 32 * 1024, MAX_NAME = 80;

// i18n-dynamic: agent:guide.names.
const builtinName = (locale, id) => agentT(locale, `guide.names.${id}`);
function builtinBody(locale, id) {
  if (id === 'child') return agentT(locale, 'guide.commandLifetime');
  if (id === 'codexPolicy') return agentT(locale, 'guide.codexPolicy');
  return `- ${agentT(locale, 'guide.route')}`;
}
const isBuiltin = id => Object.hasOwn(BUILTIN, id);
const edited = item => ['name', 'body', 'target', 'agents'].some(k => item[k] !== undefined);

const agentsSchema = z.array(z.enum(AGENTS)).min(1).max(AGENTS.length);
const storedSchema = z.object({
  id: z.string().regex(/^(?:child|codexPolicy|u-[a-z0-9]{4,32})$/),
  on: z.boolean().optional(),
  name: z.string().trim().min(1).max(MAX_NAME).optional(),
  body: z.string().min(1).max(MAX_BODY).optional(),
  target: z.enum(TARGETS).optional(),
  agents: agentsSchema.optional(),
});

/** 既定の並び（前の版の委譲の指示のスイッチ on を child に写す） */
const defaults = (on = true) => [{ id: 'child', on }, { id: 'codexPolicy', on: true }];
// 前の版の既定の項目。本文を編集していたら、この id の自分で足した指示に変える
const FORMER_DELEGATE = 'u-delegate';
const formerDelegateSchema = storedSchema.extend({ id: z.literal('delegate') });

/** 前の版の delegate（委譲の進め方）。本文を編集していなければ null（捨てる）。名前を編集していなければ前の版の名前（locale の言語） */
function fromFormerDelegate(value, locale) {
  const parsed = formerDelegateSchema.safeParse(value);
  if (!parsed.success || !parsed.data.body) return null;
  const v = parsed.data;
  return { id: FORMER_DELEGATE, on: v.on !== false, name: v.name ?? agentT(locale, 'guide.formerDelegateName'), body: v.body,
    // 前の版にエージェントの選択が無かった=当時の全部（claude・codex）。今の全エージェントへは広げない
    target: v.target ?? 'parent', agents: v.agents ? AGENTS.filter(x => v.agents.includes(x))
      // backend-allow: 前の版の既定の項目が効いていた範囲（当時の全エージェント）を保つための移行だけの値
      : ['claude', 'codex'] };
}

/**
 * 保存された値（prefs.json の plyInstructions）を読む。壊れた項目は落とし、既定の項目が欠けていれば足す。
 * legacy は前の版の addedContext。plyInstructions が無いときだけ使う。locale は前の版の delegate を変えるときの名前の言語
 */
export function normalizePlyInstructions(raw, legacy = null, locale = 'ja') {
  if (!raw || !Array.isArray(raw.items)) return defaults(legacy?.delegation !== false);
  const out = [], seen = new Set();
  for (const stored of raw.items.slice(0, MAX_ITEMS)) {
    const value = stored?.id === 'delegate' ? fromFormerDelegate(stored, locale) : stored;
    if (!value) continue;
    const parsed = storedSchema.safeParse(value);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const v = parsed.data;
    // 自分で足したものは全部の項目がそろっていること
    if (!isBuiltin(v.id) && (!v.name || !v.body || !v.target || !v.agents)) continue;
    seen.add(v.id);
    out.push({ ...v, on: v.on !== false });
  }
  for (const [i, item] of defaults().entries()) if (!seen.has(item.id)) out.splice(Math.min(i, out.length), 0, item);
  return out;
}

/** 画面と実行時に使う形。既定の項目は編集していなければ辞書の文（locale の言語）。委譲と連動の項目を最後に足す */
export function resolvePlyInstructions(list, locale) {
  const items = list.map(item => {
    if (!isBuiltin(item.id)) return { id: item.id, tag: null, modified: false, name: item.name, body: item.body, target: item.target, agents: [...item.agents], on: item.on };
    return { id: item.id, tag: 'default', modified: edited(item), name: item.name ?? builtinName(locale, item.id), body: item.body ?? builtinBody(locale, item.id),
      target: item.target ?? BUILTIN[item.id].target, agents: item.agents ? [...item.agents] : builtinAgents(item.id), on: item.on };
  });
  items.push({ id: LINKED, tag: 'linked', modified: false, name: builtinName(locale, LINKED), body: builtinBody(locale, LINKED), target: 'parent', agents: [...AGENTS], on: true });
  return items;
}

/** 入れる文。見出し（名前）と本文 */
export const itemText = (locale, item) => `${agentT(locale, 'guide.heading', { name: item.name })}\n${item.body}`;

/**
 * このターンに入れる Pleiad の指示。ply_agents を持たない子にはコマンドの実行指示だけを入れる。
 * 項目ごとに { id, name, target, inserted, text? , reason? }。入れない理由:
 *   off（スイッチで切った）/ target（入れる会話が違う）/ agent（このエージェントは選んでいない）/
 *   readOnly（読み取り・計画モードの依頼元。ply_delegate を受け付けないので委譲の項目は入れない）/ routingOff（委譲先の自動選択が無効）
 * 子の会話は読み取りのモードでもコマンドの扱い（child）を入れる（子はコマンドを実行するので、依頼元が読み取りのモードでも入れる）
 * agent は backend の種類。選べるエージェント（AGENTS）でなければ、全部のエージェントに入れる項目だけを入れる
 * （Codex だけの方針などは入れない。項目のエージェントを選べないエージェントには、絞った項目が当てはまらない）
 */
// bridge … 委譲の橋（ply_agents）を受け取るか。汎用の指示は届いても、橋が無いエージェントに委譲の振り分けの項目は入れない（plyInstructions=true / plyAgents=false の組合せを許す契約のため）
export function turnInstructions({ list, locale, child, routing, supported, canDelegate, bridge, agent = null }) {
  if (!supported) return child ? [{ id: 'childCommand', name: builtinName(locale, 'child'), target: 'child', inserted: true,
    text: agentT(locale, 'guide.commandLifetime') }] : null;
  return resolvePlyInstructions(list, locale).map(item => {
    const base = { id: item.id, name: item.name, target: item.target };
    const skip = reason => ({ ...base, inserted: false, reason });
    if (item.id === LINKED && !routing) return skip('routingOff');
    if (!item.on) return skip('off');
    if ((item.target === 'parent' && child) || (item.target === 'child' && !child)) return skip('target');
    if (agent && (AGENTS.includes(agent) ? !item.agents.includes(agent) : !AGENTS.every(a => item.agents.includes(a)))) return skip('agent');
    if (item.id === LINKED && !bridge) return skip('noBridge');
    if (!child && !canDelegate && item.id === LINKED) return skip('readOnly');
    return { ...base, inserted: true, text: itemText(locale, item) };
  });
}

/** ply_agents の instructions の後ろに足す。入れないときは元のまま（同じバイト列にしてプロンプトのキャッシュを外さない） */
export function withAdded(instructions, items) {
  const texts = (items ?? []).map(i => i?.text).filter(Boolean);
  return texts.length ? [instructions, ...texts].filter(Boolean).join('\n\n') : instructions;
}

/** 見出しの型。名前の位置に NAME_SLOT を置く（画面のシートが、打っている名前で同じ数え方をするため） */
export const NAME_SLOT = '\u0001';
/**
 * 設定の画面に返す形（文は画面の言語）。tokens は項目ごと（見出しを含む。実際に入る文の長さ）、total は今入りうるもの
 * （スイッチが入っているもの。連動は振り分けが有効なとき）の合計。heading は見出しの型
 */
export function screenState(list, locale, { routing = true } = {}) {
  const items = resolvePlyInstructions(list, locale).map(item => ({ ...item, tokens: estimateTokens(itemText(locale, item)) }));
  const total = items.filter(i => i.on && (i.id !== LINKED || routing)).reduce((n, i) => n + i.tokens, 0);
  // agents は画面の選ぶ一覧（エージェントの記述の短い名前。製品名なので訳さない）
  return { items, total, routing, heading: agentT(locale, 'guide.heading', { name: NAME_SLOT }),
    agents: AGENTS.map(id => ({ id, label: agentOf(id)?.shortLabel ?? id })) };
}

const saveSchema = z.object({
  action: z.literal('save'), id: z.string().optional(),
  name: z.string().trim().min(1).max(MAX_NAME), body: z.string().trim().min(1).max(MAX_BODY),
  target: z.enum(TARGETS), agents: agentsSchema,
}).strict();
const actionSchema = z.discriminatedUnion('action', [
  saveSchema,
  z.object({ action: z.literal('toggle'), id: z.string(), on: z.boolean() }).strict(),
  z.object({ action: z.literal('delete'), id: z.string() }).strict(),
  z.object({ action: z.literal('reset'), id: z.string() }).strict(),
  z.object({ action: z.literal('order'), ids: z.array(z.string()).max(MAX_ITEMS) }).strict(),
]);

/**
 * 1 つ変えた新しい並びを返す（元の list は変えない）。locale は既定の項目の編集を「既定と同じか」で比べる言語（画面の言語）。
 *   save   { id?, name, body, target, agents }  id が無ければ足す（連動の項目の前 = 最後）。既定の項目は既定と同じ値なら編集扱いにしない
 *   toggle { id, on } / delete { id }（自分で足したものだけ）/ reset { id }（既定の項目だけ）/ order { ids }（保存した項目の並べ替え）
 */
export function changePlyInstructions(list, args, locale) {
  const parsed = actionSchema.safeParse(args ?? {});
  if (!parsed.success) throw new Error(t('plyInstructions.invalid'));
  const a = parsed.data, next = list.map(item => ({ ...item }));
  const at = id => { const i = next.findIndex(item => item.id === id); if (i < 0) throw new Error(t('plyInstructions.notFound')); return i; };
  if (a.action === 'save') {
    const value = { name: a.name, body: a.body, target: a.target, agents: AGENTS.filter(x => a.agents.includes(x)) };
    if (!a.id) {
      if (next.length >= MAX_ITEMS) throw new Error(t('plyInstructions.tooMany', { count: MAX_ITEMS }));
      next.push({ id: `u-${crypto.randomBytes(6).toString('hex')}`, on: true, ...value });
    } else {
      const i = at(a.id), item = next[i];
      if (!isBuiltin(item.id)) next[i] = { ...item, ...value };
      else {
        const plain = { id: item.id, on: item.on };
        const same = value.name === builtinName(locale, item.id) && value.body === builtinBody(locale, item.id).trim()
          && value.target === BUILTIN[item.id].target && value.agents.join() === builtinAgents(item.id).join();
        next[i] = same ? plain : { ...plain, ...value };
      }
    }
  } else if (a.action === 'toggle') next[at(a.id)].on = a.on;
  else if (a.action === 'delete') {
    if (isBuiltin(a.id)) throw new Error(t('plyInstructions.builtinDelete'));
    next.splice(at(a.id), 1);
  } else if (a.action === 'reset') {
    if (!isBuiltin(a.id)) throw new Error(t('plyInstructions.notFound'));
    const i = at(a.id);
    next[i] = { id: next[i].id, on: next[i].on };
  } else {
    const ids = a.ids.filter(id => id !== LINKED);
    if (ids.length !== next.length || new Set(ids).size !== ids.length || ids.some(id => !next.some(item => item.id === id))) throw new Error(t('plyInstructions.invalid'));
    return ids.map(id => next.find(item => item.id === id));
  }
  return next;
}
