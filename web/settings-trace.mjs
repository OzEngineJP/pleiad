// 作業中に設定を変えた跡の行（present kind: 'settingsChange'。docs/design-system.md「作業中の設定の変更」・ADR 0341）。
//   「Claude Code から OpenAI Codex に切り替えました」「エフォートを high から xhigh に変えました」
//   「作業の途中でエフォートを medium から max に変えました」（止めずに切り替えたとき）
// 止めたことは行にも開いた中身にも出さない。エージェントの切り替えだけ、開くと引き継ぐもの・引き継がないもの・変わるものが読める（chat.next.handoff.*）。
// 値は id のまま届くので、表示名は setSettingsTraceLabels で渡された引き方で今の言語に引く（web/client.mjs）。
import { el, chevron } from './dom.mjs';
import { t } from './i18n.mjs';
import { localTime, toolTimeShort } from './server-clock.mjs';

const FIELDS = ['backend', 'model', 'effort', 'mode'];
// logo: エージェントのロゴの要素（web/side.mjs の backendLogo）。render の側から side.mjs を読まないよう、client が渡す
let labels = { backend: (id) => id, model: (id) => id, effort: (id) => id, mode: (id) => id, logo: null };

/** 値の表示名の引き方（client が state の一覧から引く）。'' は「既定」 */
export function setSettingsTraceLabels(next) { labels = { ...labels, ...next }; }

const valueText = (field, id) => (id ? String(labels[field]?.(id) ?? id) : t('chat.settingsTrace.default'));

// 値を太字にするための印。訳文の中の {{from}} などをこの印で包んだ値に置き換えてから、印で切って要素にする
const OPEN = '\u0001', CLOSE = '\u0002';
const mark = (text, logo = '') => `${OPEN}${logo}\u0003${text}${CLOSE}`;

/** 印つきの文を、値（太字・エージェントはロゴつき）と地の文の要素に分ける */
function richNodes(text) {
  const out = [];
  for (const part of text.split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`))) {
    if (!part) continue;
    if (!part.startsWith(OPEN)) { out.push(document.createTextNode(part)); continue; }
    const [logo, value] = part.slice(1, -1).split('\u0003');
    const b = el('b', 'st-v');
    if (logo && labels.logo) b.append(labels.logo(logo));
    b.append(document.createTextNode(value));
    out.push(b);
  }
  return out;
}

/** 行の文（印つき）。エージェントの切り替えがあればそれだけを言う（モデル・承認モードは切り替え先の設定になる。開いた中身の「変わる」） */
function traceTemplate(change) {
  const changes = (change?.changes ?? []).filter((c) => FIELDS.includes(c?.field));
  const agent = changes.find((c) => c.field === 'backend');
  if (agent) {
    // i18n-dynamic: chat.settingsTrace.switched
    return t(change.live ? 'chat.settingsTrace.switchedLive' : 'chat.settingsTrace.switched', {
      from: mark(valueText('backend', agent.from), agent.from), to: mark(valueText('backend', agent.to), agent.to),
    });
  }
  const items = changes.map((c) => t('chat.settingsTrace.item', {
    // i18n-dynamic: chat.settingsTrace.name.
    name: t(`chat.settingsTrace.name.${c.field}`), from: mark(valueText(c.field, c.from)), to: mark(valueText(c.field, c.to)),
  }));
  if (!items.length) return '';
  // i18n-dynamic: chat.settingsTrace.changed
  return t(change.live ? 'chat.settingsTrace.changedLive' : 'chat.settingsTrace.changed', { items: items.join(t('chat.settingsTrace.sep')) });
}

/** 行の文（素の文字列。読み上げ・試験用） */
export function settingsTraceText(change) {
  return traceTemplate(change).replace(new RegExp(`${OPEN}[^\u0003]*\u0003([^${CLOSE}]*)${CLOSE}`, 'g'), '$1');
}

export function renderSettingsChangeLine(ev) {
  const change = ev?.settingsChange ?? {};
  const agent = (change.changes ?? []).find((c) => c?.field === 'backend');
  const text = el('span', 'st-line-t');
  text.append(...richNodes(traceTemplate(change)));
  const time = el('span', 'st-line-time', toolTimeShort(localTime(ev?.at)));
  if (!agent) {
    const row = el('div', 'st-line');
    row.append(text, time);
    return row;
  }
  // エージェントの切り替え: 開くと引き継ぐもの・引き継がないもの・変わるものが読める
  const box = el('details', 'st-line st-line-more');
  const summary = el('summary', 'st-line-sum');
  const chev = el('span', 'st-line-chev'); chev.setAttribute('aria-hidden', 'true'); chev.append(chevron());
  summary.append(chev, text, time);
  const from = valueText('backend', agent.from), to = valueText('backend', agent.to);
  const list = el('dl', 'st-line-dl');
  for (const [k, v] of [
    [t('chat.next.handoff.keep'), t('chat.next.handoff.keepValue')],
    [t('chat.next.handoff.drop'), t('chat.next.handoff.dropValue', { from, to })],
    [t('chat.next.handoff.change'), t('chat.next.handoff.changeValue', { to })],
  ]) list.append(el('dt', '', k), el('dd', '', v));
  box.append(summary, list);
  return box;
}
