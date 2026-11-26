// 止まっている会話でチップを替えて（予約）から送ると、入力欄の上の帯（#nextSettings）が一瞬出ないこと。
// 再現（temporary/investigations/send-status-flash）と同じ順: 止まっている間は帯が無い → 予約を消す知らせ
// → 取り直し（refresh）が戻る前に「走っている」が帯を描く。Node に DOM は無いので、hidden の代入が
// attributeFilter: ['hidden'] の MutationObserver へ届く要素で、帯が見えたかを記録する。
// 帯を描く関数と nextSettings の case は web/client.mjs から切り出してそのまま走らせる。
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';
import { cutFunction } from '../lib/cut-source.mjs';

export const name = 'send-status-flash';
export const title = '止まっている会話から送った瞬間に、予約の帯が一瞬も出ない';

class MutationObserver {
  constructor(callback) { this.callback = callback; }
  observe(target, options = {}) {
    (target._mo ??= []).push({ obs: this, filter: options.attributeFilter ?? null, attributes: options.attributes !== false });
  }
  disconnect() {}
}

/** hidden の変化だけを属性の変更として知らせる（ブラウザーの hidden 属性と同じ観察） */
function bindHidden(node, initial = true) {
  let value = Boolean(initial);
  if (value) node.setAttribute('hidden', '');
  Object.defineProperty(node, 'hidden', {
    configurable: true,
    get() { return value; },
    set(next) {
      const on = Boolean(next);
      if (on === value) return;
      value = on;
      if (on) node.setAttribute('hidden', '');
      else node.removeAttribute('hidden');
      const record = { type: 'attributes', attributeName: 'hidden', target: node };
      for (const reg of node._mo ?? []) {
        if (!reg.attributes || (reg.filter && !reg.filter.includes('hidden'))) continue;
        reg.obs.callback([record], reg.obs);
      }
    },
  });
  return node;
}

const reservation = () => ({
  backend: 'codex', model: 'new-model', effort: 'high', mode: 'plan', cwd: 'D:/other', account: 'acc-2', endpoint: 'ep-2',
});
const row = (id, extra = {}) => ({
  id, backend: 'claude', model: 'old-model', effort: 'low', mode: 'default', cwd: 'D:/work',
  claudeAccount: 'acc-1', compatEndpoint: 'ep-1', nextSettings: reservation(), ...extra,
});

export default async function (t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const marker = 'case "nextSettings":';
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('client.mjs に case "nextSettings" が無い');
  const rest = source.slice(at + marker.length);
  const nextCase = rest.search(/\n    case /);
  if (nextCase < 0) throw new Error('case "nextSettings" の終わりが見つからない');
  const code = `
let refreshVersion = 0;
const inflightNext = new Map();
const settledNext = new Map();
${cutFunction(source, 'belongsHere')}
${cutFunction(source, 'isRunningHere')}
${cutFunction(source, 'paintSettingsNotice')}
${cutFunction(source, 'settleNext')}
function onNextSettings(ev) {
${rest.slice(0, nextCase)}
}
`;
  const seen = [];
  const syncs = [];
  const notice = bindHidden(new N('div'), true);
  notice.append(new N('b'));
  const behind = bindHidden(new N('div'), true);
  const apply = bindHidden(new N('button'), true);
  const text = new N('div');
  const cancel = new N('button');
  const nodes = new Map([
    ['nextSettings', notice],
    ['nextSettingsBehind', behind],
    ['nextSettingsText', text],
    ['cancelSettings', cancel],
    ['applySettings', apply],
  ]);
  new MutationObserver((records) => {
    for (const record of records) if (record.attributeName === 'hidden') seen.push(record.target.hidden);
  }).observe(notice, { attributes: true, attributeFilter: ['hidden'] });

  const state = {
    current: 's1', sessions: [], runningIds: new Set(), submitting: false, work: { turns: [] },
    models: {}, modes: {},
  };
  const context = vm.createContext({
    state, seen, syncs,
    $: (id) => nodes.get(id),
    t: (key) => key,
    el: (tag, cls, value) => {
      const node = new N(tag);
      if (cls) node.className = cls;
      if (value != null) node.textContent = value;
      return node;
    },
    document: { createTextNode: (value) => ({ textContent: String(value), outerHTML: String(value), shown: String(value), children: [], parent: null, dataset: {}, matches: () => false, remove() {} }) },
    branchIcon: '<svg></svg>',
    paintHandoffNote: () => {},
    reservedAppliesLive: () => false,
    labelOf: (id) => id,
    resolvedModel: () => ({ label: 'model' }),
    compatEndpoints: { get: () => null },
    compatModelText: (model) => model,
    endpointLabel: (id) => id,
    accountLabel: (id) => id,
    worktreeNextText: () => null,
    syncTopbar: () => { syncs.push(state.current); return Promise.resolve(); },
    refresh: () => new Promise(() => {}),
    shellComposer: { sync: () => {} },
    paintWorktreeLines: () => {},
  });
  vm.runInContext(code, context);
  const run = (script) => vm.runInContext(script, context);

  function begin(session, { running = false, phase = null } = {}) {
    run('inflightNext.clear(); settledNext.clear()');
    state.current = session.id;
    state.sessions = [session];
    state.runningIds = running ? new Set([session.id]) : new Set();
    state.submitting = false;
    state.work = { turns: phase ? [{ sessionId: session.id, phase }] : [] };
    apply.hidden = true;
    behind.hidden = true;
    notice.hidden = true;
    run('paintSettingsNotice()');
    seen.length = 0;
    syncs.length = 0;
  }

  // ---------------------------------------------------------------- 止まっている会話から送る（取り直しは戻さない）
  begin(row('s1'));
  t.ok('止まっている間は、予約があっても帯を出さない', notice.hidden === true && !seen.includes(false));
  run('refreshVersion = 4');
  run('onNextSettings({ type: "nextSettings", sessionId: "s1", nextSettings: null })');
  const clearedNow = state.sessions[0].nextSettings == null;
  state.runningIds.add('s1');
  state.work = { turns: [{ sessionId: 's1', phase: 'running' }] };
  run('paintSettingsNotice()');
  t.ok('予約を消す知らせは、取り直しを待たずに行へ載る', clearedNow, JSON.stringify(state.sessions[0].nextSettings));
  t.ok('消す知らせではチップを描き直さない（選んだモデルが一瞬戻らない）', syncs.length === 0, JSON.stringify(syncs));
  t.ok('止まっている会話から送った瞬間、帯は一度も出ない', notice.hidden === true && !seen.includes(false), JSON.stringify(seen));

  // 新しい会話を作っている間に選んで、最初に送る（sendDraftSettings の予約が同じ知らせで消える）
  begin(row('s-new'));
  run('refreshVersion = 4');
  run('onNextSettings({ type: "nextSettings", sessionId: "s-new", nextSettings: null })');
  state.runningIds.add('s-new');
  state.work = { turns: [{ sessionId: 's-new', phase: 'running' }] };
  run('paintSettingsNotice()');
  t.ok('新しい会話の最初の送信でも、帯は一度も出ない', notice.hidden === true && !seen.includes(false) && state.sessions[0].nextSettings == null, JSON.stringify(seen));

  // ---------------------------------------------------------------- チップ変更の取り直しが、送信より前に始まって後から届く
  begin(row('s1'));
  run('refreshVersion = 4');
  run('onNextSettings({ type: "nextSettings", sessionId: "s1", nextSettings: null })');
  const stale = row('s1');
  state.sessions = [stale];
  state.runningIds = new Set(['s1']);
  state.work = { turns: [{ sessionId: 's1', phase: 'running' }] };
  seen.length = 0;
  run('settleNext(refreshVersion)');
  run('paintSettingsNotice()');
  t.ok('書く前に始まった取り直しが後から届いても、帯は出ず、行は送った予約の値になる',
    notice.hidden === true && !seen.includes(false) && stale.nextSettings == null
    && stale.backend === 'codex' && stale.model === 'new-model' && stale.effort === 'high' && stale.mode === 'plan'
    && stale.cwd === 'D:/other' && stale.claudeAccount === 'acc-2' && stale.compatEndpoint === 'ep-2',
    JSON.stringify({ hidden: notice.hidden, seen, model: stale.model, next: stale.nextSettings, account: stale.claudeAccount, endpoint: stale.compatEndpoint }));
  const fresh = row('s1', {
    backend: 'codex', model: 'new-model', effort: 'high', mode: 'plan', cwd: 'D:/other',
    claudeAccount: 'acc-2', compatEndpoint: 'ep-2', nextSettings: null,
  });
  state.sessions = [fresh];
  run('settleNext(++refreshVersion)');
  t.ok('その後に始まった取り直しは、サーバーの一覧を正本にして控えを捨てる',
    run('settledNext.size') === 0 && fresh.nextSettings == null && fresh.model === 'new-model');

  // ---------------------------------------------------------------- 取り消しは、消した予約を会話の値へ写さない
  begin(row('s1'));
  run('refreshVersion = 4');
  run(`inflightNext.set('s1', [{ patch: { cancel: true } }])`);
  run('onNextSettings({ type: "nextSettings", sessionId: "s1", nextSettings: null })');
  const cancelled = row('s1');
  state.sessions = [cancelled];
  state.runningIds = new Set(['s1']);
  state.work = { turns: [{ sessionId: 's1', phase: 'running' }] };
  seen.length = 0;
  run('settleNext(refreshVersion)');
  run('paintSettingsNotice()');
  t.ok('取り消しの後に古い取り直しが届いても、帯は出ず、行は予約の前の値のまま',
    notice.hidden === true && !seen.includes(false) && cancelled.nextSettings == null
    && cancelled.model === 'old-model' && cancelled.backend === 'claude' && cancelled.claudeAccount === 'acc-1' && cancelled.compatEndpoint === 'ep-1',
    JSON.stringify({ model: cancelled.model, next: cancelled.nextSettings, account: cancelled.claudeAccount }));

  // ---------------------------------------------------------------- 走っている間の予約・worktree・裏の作業待ちは残す
  begin(row('s1', { nextSettings: null }), { running: true, phase: 'running' });
  run(`onNextSettings({ type: "nextSettings", sessionId: "s1", nextSettings: ${JSON.stringify(reservation())}, worktreePending: false })`);
  t.ok('走っている間に選んだ予約は、取り直しを待たずに帯へ出る', notice.hidden === false && seen.includes(false), JSON.stringify(seen));
  t.ok('［今すぐ変える］は、走っている間の予約で残る', apply.hidden === false);
  t.ok('予約の知らせはチップを描き直す', syncs.length === 1, JSON.stringify(syncs));

  begin(row('s1', { nextSettings: null, unsent: true, worktreePending: true }));
  t.ok('送信前の worktree の予定は、止まっていても帯に残る', notice.hidden === false && notice.classList.contains('wt-compact'));

  begin(row('s1'), { phase: 'waiting' });
  t.ok('裏の作業待ちの間は、帯と注記を残し、［今すぐ変える］は出さない',
    notice.hidden === false && behind.hidden === false && apply.hidden === true);
}
