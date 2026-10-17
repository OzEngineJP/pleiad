// 設定 › 秘密情報と変数（承認済み 2026-10-17。docs/design-system.md「設定 › 秘密情報と変数」、ADR 0215・0155）。
//
// 人が預けた値を 1 か所に登録し、項目ごとに使い道を選ぶ。登録しただけでは、どこにも渡さない。
//   - 秘密情報（カード）: API キー（ADR 0155 のまま。接続先・通話・委譲・wait_until の問いは「どのキーを使うか」を選ぶだけ）・ログイン情報・秘密の値。値は画面に出さない
//   - 変数（1 行ずつ）: 値を画面に出す。.env を貼って取り込める
//   - 使い道: 環境変数として渡す（名前と渡す場所）・サイトで入力する（ログイン情報）・Pleiad の機能（API キーの使っている所）
// カードの［編集］で値・名前・使い道・メモを 1 か所で変える。API キーの値を差し替えると、使っている所を順に確かめ直して ✓ / ⚠ で並べる。
// 削除は使っている所と、削除後に起きることを並べて聞き直す。値の違う同じプロバイダーのキーが移行で見つかったときだけ、先頭に案内の節を一度だけ出す。
// 値は入力欄に打ったものを送って捨てる（ホストも返さない）。状態はホストが持つ（invoke の apiKeys.list・secrets.list と、変わるたびに届く apiKeysChanged・secretsChanged）。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*・.nf-*、web/api-keys.css の .ak-*）。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { providerName } from './api-keys-model.mjs';
import { apiKeyList, keyName, statusLine, spinner, keyInput, keepFocus, CHEV } from './api-key-ui.mjs';
import { parseDotenv, ENV_NAME, reservedName, looksSecret } from './dotenv.mjs';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };
const JUDGE_NAME = { jev: 'Jev / Qwen' };
/** 使っている所が多いカードは先頭 3 件と［ほか N か所］に畳む（4 件までは全部出す） */
const FOLD_AT = 4;
const FOLD_SHOWN = 3;
const SETTLE_MS = 240;
const PROVIDER_CHOICES = ['openrouter', 'custom'];
const KINDS = ['api', 'login', 'secret', 'var'];

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, reduced() ? 0 : ms));
const when = iso => fmt.dateTime(iso, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let counter = 0;
const uid = prefix => `${prefix}${++counter}`;
const sameScope = (a, b) => JSON.stringify(a ?? 'all') === JSON.stringify(b ?? 'all');

/**
 * @param {object} o
 * @param {(command: string, args?: object) => Promise<any>} o.cmd  WS コマンド
 * @param {(page: string) => void} o.page  設定のページを切り替える（onboarding.page）
 * @param {(agent: string) => void} [o.openEndpoints]  設定 › エージェント設定の接続先の面を開く
 * @param {() => string[]} [o.recentFolders]  最近の会話のフォルダー（渡す場所の候補）
 */
export function setupApiKeysSettings({ cmd, page, openEndpoints = () => {}, recentFolders = () => [] }) {
  const $ = id => document.getElementById(id);
  const root = $('apiKeysPanel');
  const tab = $('apiKeysTab');
  if (!root || !tab) return { event() {}, load() {} };
  const invoke = (op, args = {}) => cmd('invoke', { op, args });

  let data = null, sec = null, loadError = '';
  const ui = { adding: null, editing: null, deleting: '', importing: null, result: null, merge: null, expanded: new Set(), checking: new Set(), message: '', shown: new Set(), focus: null };
  let pending = [];

  const findKey = id => data?.keys.find(k => k.id === id) ?? null;
  const findItem = id => sec?.items.find(i => i.id === id) ?? null;
  const keyUse = id => sec?.keyUses?.[id] ?? null;
  const say = text => { ui.message = text; };
  const fail = e => { say(t('apiKeys.failed', { error: e?.message ?? String(e) })); };

  async function load() {
    try {
      [data, sec] = await Promise.all([apiKeyList(cmd), invoke('secrets.list').catch(e => ({ items: [], keyUses: {}, broken: false, error: e?.message ?? String(e) }))]);
      loadError = '';
    } catch (e) { loadError = e?.message ?? String(e); }
    paint();
  }

  // ---- 開閉（高さと不透明度。240ms · ease-out。prefers-reduced-motion では 0）
  function region(key, child, seen) {
    seen.add(key);
    const instant = ui.shown.has(key);
    ui.shown.add(key);
    const inner = el('div', 'ak-fold-in'); inner.append(child);
    const box = el('div', 'ak-fold' + (instant ? ' open' : '')); box.dataset.region = key; box.append(inner);
    if (!instant) pending.push(box);
    return box;
  }
  async function collapse(key) {
    const box = root.querySelector(`[data-region="${CSS.escape(key)}"]`);
    if (box) { box.classList.remove('open'); await wait(SETTLE_MS); }
    ui.shown.delete(key);
  }

  const button = (label, onclick, cls = 'btn', attrs = {}) => {
    const b = el('button', cls, label); b.type = 'button'; b.onclick = onclick;
    for (const [k, v] of Object.entries(attrs)) if (v != null) b.setAttribute(k, v);
    return b;
  };
  const link = (label, onclick, attrs = {}) => button(label, onclick, 'ak-link', attrs);
  const field = (label, control, hint) => {
    const f = el('label', 'mp-field'); f.append(el('span', null, label), control);
    if (hint) f.append(el('small', null, hint));
    return f;
  };
  const textInput = ({ value = '', aria, placeholder = '', mono = false, max = 200, onInput, fk }) => {
    const i = el('input'); i.type = 'text'; i.autocomplete = 'off'; i.spellcheck = false; i.value = value; i.maxLength = max;
    if (placeholder) i.placeholder = placeholder;
    if (aria) i.setAttribute('aria-label', aria);
    if (mono) i.classList.add('ak-mono');
    if (fk) i.dataset.fk = fk;
    i.oninput = () => onInput?.(i.value);
    return i;
  };
  const secretInput = ({ value = '', aria, placeholder = '', fk, onInput }) => {
    const { row, input } = keyInput({ ariaLabel: aria, placeholder, focusKey: fk });
    input.value = value;
    input.oninput = () => onInput?.(input.value);
    return { row, input };
  };

  // ---- 渡す場所の選択（すべてのフォルダー・最近のフォルダー・フォルダーを選ぶ…）。.pop のリストボックス
  const scopeText = scope => (!scope || scope === 'all' ? t('secrets.scope.all')
    : scope.folders.length > 1 ? t('secrets.scope.more', { folder: scope.folders[0], count: scope.folders.length - 1 }) : scope.folders[0]);
  function folderChoices(current) {
    const list = [];
    const add = f => { if (f && !list.some(x => x.toLowerCase() === f.toLowerCase())) list.push(f); };
    if (current && current !== 'all') current.folders.forEach(add);
    for (const item of sec?.items ?? []) if (item.env?.scope && item.env.scope !== 'all') item.env.scope.folders.forEach(add);
    for (const f of recentFolders()) add(f);
    return list.slice(0, 12);
  }
  function scopeSelect({ value, onChange, label, fk }) {
    const wrap = el('span', 'ak-selwrap');
    const btn = el('button', 'ak-selbtn'); btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', `${label}: ${scopeText(value)}`);
    if (fk) btn.dataset.fk = fk;
    const chev = el('span', 'ak-chev'); chev.setAttribute('aria-hidden', 'true'); chev.innerHTML = CHEV;
    btn.append(el('span', 'ak-seltxt' + (value && value !== 'all' ? ' ak-mono' : ''), scopeText(value)), chev);
    wrap.append(btn);
    let pop = null, typed = null;
    const onDoc = e => { if (pop && (!wrap.isConnected || !wrap.contains(e.target))) close(false); };
    function close(refocus) {
      if (!pop) return;
      pop.remove(); pop = null; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onDoc, true);
      if (refocus) btn.focus();
    }
    const pick = scope => { close(false); btn.focus(); onChange(scope); };
    function open() {
      if (pop) { close(true); return; }
      pop = el('div', 'pop ak-pop left'); pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', label);
      const opts = [];
      const item = (text, on, act, mono = false) => {
        const li = el('button', 'li' + (on ? ' on' : '')); li.type = 'button'; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(on)); li.tabIndex = -1;
        li.append(el('span', 'lbl' + (mono ? ' ak-mono' : ''), text)); li.onclick = act; opts.push(li); return li;
      };
      pop.append(item(t('secrets.scope.all'), !value || value === 'all', () => pick('all')));
      const folders = folderChoices(value);
      if (folders.length) pop.append(el('div', 'sep'));
      for (const f of folders) pop.append(item(f, value !== 'all' && value?.folders?.length === 1 && value.folders[0] === f, () => pick({ folders: [f] }), true));
      pop.append(el('div', 'sep'));
      pop.append(item(t('secrets.scope.choose'), false, async () => {
        close(false);
        if (window.plyDesktop?.chooseFolder) {
          const picked = await window.plyDesktop.chooseFolder().catch(() => null);
          const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
          if (chosen) onChange({ folders: [chosen] }); else btn.focus();
          return;
        }
        // ブラウザー版はパスを打つ
        typed = textInput({ aria: t('secrets.scope.pathAria'), placeholder: t('secrets.scope.pathPlaceholder'), mono: true, max: 1024 });
        typed.onkeydown = e => {
          if (e.key === 'Enter') { e.preventDefault(); const v = typed.value.trim(); if (v) onChange({ folders: [v] }); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); typed.remove(); typed = null; btn.focus(); }
        };
        wrap.append(typed); typed.focus();
      }));
      wrap.append(pop);
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onDoc, true);
      (opts.find(x => x.classList.contains('on')) ?? opts[0]).focus();
      pop.onkeydown = e => {
        const i = opts.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'Tab') close(false);
      };
    }
    btn.onclick = open;
    btn.onkeydown = e => { if (e.key === 'ArrowDown' && !pop) { e.preventDefault(); open(); } };
    return wrap;
  }

  // ---- 使っている所（API キーの Pleiad の機能）
  function useLabel(u) {
    if (u.kind === 'endpoint') return t('apiKeys.uses.endpoint', { agent: AGENT_NAME[u.agent] ?? u.agent, name: u.name });
    if (u.kind === 'voice') return t('apiKeys.uses.voice');
    if (u.kind === 'computer') return t('apiKeys.uses.computer');
    return t('apiKeys.uses.judge', { judge: JUDGE_NAME[u.judge] ?? u.judge });
  }
  // i18n-dynamic: apiKeys.effect.
  const useEffect = u => t(`apiKeys.effect.${['endpoint', 'voice', 'computer'].includes(u.kind) ? u.kind : 'judge'}`);
  const navOf = u => (u.kind === 'voice' ? 'voice' : u.kind === 'judge' ? 'delegation' : u.kind === 'computer' ? 'computer' : 'agents');
  function openUse(u) {
    if (u.kind === 'endpoint') { openEndpoints(u.agent); return; }
    $(u.kind === 'voice' ? 'voiceTab' : u.kind === 'computer' ? 'computerTab' : 'delegationTab')?.click();
  }
  function pleiadUses(k) {
    const uses = k.uses;
    const fold = uses.length >= FOLD_AT + 1;
    const open = ui.expanded.has(k.id);
    const list = fold && !open ? uses.slice(0, FOLD_SHOWN) : uses;
    const ul = el('ul', 'ak-inline'); ul.setAttribute('aria-label', t('apiKeys.uses.aria', { name: keyName(k) }));
    list.forEach((u, i) => {
      const li = el('li');
      // i18n-dynamic: settings.nav.
      li.append(link(useLabel(u), () => openUse(u), { 'data-fk': `use:${k.id}:${i}`, title: t('apiKeys.uses.open', { page: t(`settings.nav.${navOf(u)}`) }) }));
      ul.append(li);
    });
    if (fold) {
      const li = el('li');
      li.append(link(open ? t('apiKeys.uses.less') : t('apiKeys.uses.more', { count: uses.length - FOLD_SHOWN }), () => {
        if (open) ui.expanded.delete(k.id); else ui.expanded.add(k.id);
        ui.focus = open ? `more:${k.id}` : `use:${k.id}:${FOLD_SHOWN}`; paint();
      }, { 'data-fk': `more:${k.id}`, 'aria-expanded': String(open) }));
      ul.append(li);
    }
    return ul;
  }

  /** カードの使い道の行（見出し · 値）。何も無ければ「どこにも使われていません」 */
  function usesRows(rows, name) {
    if (!rows.length) return el('div', 'ak-uses ak-none', t('secrets.uses.none'));
    const dl = el('dl', 'ak-uses-grid'); dl.setAttribute('aria-label', t('secrets.uses.aria', { name }));
    for (const [label, value] of rows) { const dd = el('dd'); dd.append(value); dl.append(el('dt', null, label), dd); }
    return dl;
  }
  const envValue = env => { const s = el('span'); s.append(el('span', 'ak-mono', env.name), ` · `, el('span', env.scope === 'all' ? '' : 'ak-mono', scopeText(env.scope))); return s; };
  function keyRows(k) {
    const rows = [];
    const use = keyUse(k.id);
    if (use?.env) rows.push([t('secrets.uses.env'), envValue(use.env)]);
    if (k.uses.length) rows.push([t('secrets.uses.pleiad'), pleiadUses(k)]);
    return rows;
  }
  function itemRows(item) {
    const rows = [];
    if (item.env) rows.push([t('secrets.uses.env'), envValue(item.env)]);
    if (item.kind === 'login' && item.sites.length) rows.push([t('secrets.uses.sites'), el('span', 'ak-mono', item.sites.join(', '))]);
    if (item.lastUse) rows.push([t('secrets.uses.lastUse'), el('span', null, item.lastUse.site ? t('secrets.uses.lastUseAt', { when: when(item.lastUse.at), site: item.lastUse.site }) : when(item.lastUse.at))]);
    return rows;
  }
  const keyUsed = k => k.uses.length > 0 || Boolean(keyUse(k.id)?.env);
  const itemUsed = item => Boolean(item.env) || (item.kind === 'login' && item.sites.length > 0);

  // ---- 確かめ直した結果（差し替え・まとめた後。使っている所を順に）
  const summaryOf = rows => {
    const ng = rows.filter(r => r.state === 'ng').length;
    if (!rows.length) return t('apiKeys.result.noUses');
    return ng ? t('apiKeys.result.partial', { total: rows.length, ok: rows.length - ng, ng }) : t('apiKeys.result.all', { total: rows.length });
  };
  async function runChecks(keyId, title) {
    const k = findKey(keyId);
    ui.result = { keyId, title, done: false, rows: [], summary: '' };
    ui.message = '';
    paint();
    let keyCheck = null;
    for (const u of k?.uses ?? []) {
      const row = { u, state: 'run', text: t('apiKeys.result.checking'), shown: false };
      ui.result.rows.push(row); paint();
      try {
        if (u.kind === 'endpoint') {
          const r = await invoke('compatEndpoints.recheck', { id: u.id });
          Object.assign(row, r.ok ? { state: 'ok', text: t('apiKeys.result.endpointOk', { count: r.models?.length ?? 0 }) } : { state: 'ng', text: t('apiKeys.result.endpointFailed', { error: r.error ?? '' }) });
        } else {
          keyCheck ??= await invoke('apiKeys.check', { id: keyId });
          Object.assign(row, keyCheck.ok === false ? { state: 'ng', text: t('apiKeys.result.keyFailed') } : { state: 'ok', text: t('apiKeys.result.keyOk') });
        }
      } catch (e) { Object.assign(row, { state: 'ng', text: t('apiKeys.result.error', { error: e?.message ?? String(e) }) }); }
      paint();
    }
    ui.result.done = true;
    ui.result.summary = summaryOf(ui.result.rows);
    // 終わったときに 1 回だけ読み上げる（途中の行は読み上げない）
    say(`${title}。${ui.result.summary}`);
    await load();
  }
  function rowEl(row) {
    const mark = el('span', 'ak-mark');
    if (row.state === 'run') mark.append(spinner()); else { mark.textContent = row.state === 'ok' ? '✓' : '⚠'; mark.setAttribute('aria-hidden', 'true'); }
    const text = el('span', 't' + (row.state === 'run' ? ' weak' : '')); text.append(el('b', null, useLabel(row.u)), ` — ${row.text}`);
    const li = el('li', row.shown ? '' : 'enter'); li.append(mark, text);
    if (row.state === 'ng') li.append(link(row.u.kind === 'endpoint' ? t('apiKeys.result.openEndpoint') : t('apiKeys.result.openSettings'), () => openUse(row.u)));
    row.shown = true;
    return li;
  }
  function resultBlock(k) {
    const r = ui.result;
    const box = el('div', 'mp-result ak-result'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', t('apiKeys.result.aria'));
    box.append(el('strong', null, `✓ ${r.title}`), el('span', 'mp-ln', r.done ? r.summary : t('apiKeys.result.running')));
    if (r.rows.length) { const ul = el('ul', 'ak-rows'); ul.append(...r.rows.map(rowEl)); box.append(ul); }
    if (r.done) {
      const actions = el('div', 'mp-card-actions'); actions.style.marginTop = '8px';
      actions.append(button(t('apiKeys.result.close'), async () => { await collapse('res:' + k.id); ui.result = null; ui.focus = 'edit:' + k.id; paint(); }, 'btn', { 'data-fk': 'resx:' + k.id }));
      box.append(actions);
    }
    return box;
  }

  async function check(k) {
    if (ui.checking.has(k.id)) return;
    ui.checking.add(k.id); ui.focus = 'chk:' + k.id; say(''); paint();
    try {
      const r = await invoke('apiKeys.check', { id: k.id });
      await load();
      const now = findKey(k.id) ?? k;
      say(r.ok === false ? t('apiKeys.check.failed', { name: keyName(now) }) : t('apiKeys.check.ok', { name: keyName(now) }));
    } catch (e) { fail(e); }
    ui.checking.delete(k.id); ui.focus = 'chk:' + k.id;
    paint();
  }

  // ---- 使い道の箱（追加と編集で同じ。draft の envOn・envName・scope・sitesOn を書き換える）
  function usesBox(d, { kind, pleiad = null, idp }) {
    const box = el('fieldset', 'ak-usebox');
    box.append(el('legend', null, t('secrets.uses.title')));
    const envId = uid('ake');
    const envRow = el('div', 'ak-radio');
    const envCheck = el('input'); envCheck.type = 'checkbox'; envCheck.id = envId; envCheck.checked = d.envOn; envCheck.dataset.fk = `${idp}:envon`;
    const envLabel = el('label'); envLabel.htmlFor = envId; envLabel.textContent = t('secrets.uses.envOn');
    envRow.append(envCheck, envLabel);
    box.append(envRow);
    const envFields = el('div', 'ak-indent');
    const name = textInput({ value: d.envName, aria: t('secrets.uses.envName'), mono: true, max: 128, fk: `${idp}:envname`, onInput: v => { d.envName = v; } });
    envFields.append(field(t('secrets.uses.envName'), name),
      (() => { const f = el('div', 'mp-field'); f.append(el('span', null, t('secrets.uses.scope')), scopeSelect({ value: d.scope, label: t('secrets.uses.scope'), fk: `${idp}:scope`, onChange: s => { d.scope = s; ui.focus = `${idp}:scope`; paint(); } })); return f; })());
    const envFold = el('div', 'ak-fold' + (d.envOn ? ' open' : '')); const envIn = el('div', 'ak-fold-in'); envIn.append(envFields); envFold.append(envIn);
    box.append(envFold);
    envCheck.onchange = () => { d.envOn = envCheck.checked; envFold.classList.toggle('open', d.envOn); if (d.envOn) name.focus(); };
    if (kind === 'login') {
      const siteId = uid('aks');
      const siteRow = el('div', 'ak-radio');
      const siteCheck = el('input'); siteCheck.type = 'checkbox'; siteCheck.id = siteId; siteCheck.checked = d.sitesOn; siteCheck.dataset.fk = `${idp}:siteon`;
      siteCheck.onchange = () => { d.sitesOn = siteCheck.checked; };
      const text = el('span', 't'); const label = el('label'); label.htmlFor = siteId; label.textContent = t('secrets.uses.sitesOn');
      text.append(label, el('small', 'ak-mono', d.site || t('secrets.uses.sitesEmpty')));
      siteRow.append(siteCheck, text);
      box.append(siteRow);
    }
    if (pleiad) {
      const row = el('div', 'ak-radio ak-static'); const text = el('span', 't');
      text.append(el('span', null, t('secrets.uses.pleiadTitle')), pleiad);
      row.append(el('span', 'ak-gap'), text);
      box.append(row);
    }
    return box;
  }
  /** draft の使い道を送る形に。環境変数の名前を確かめ、だめなら理由の文を返す */
  function envOf(d) {
    if (!d.envOn) return { env: null };
    const name = d.envName.trim();
    if (!ENV_NAME.test(name)) return { error: t('secrets.errors.name', { name }) };
    if (reservedName(name)) return { error: t('secrets.errors.reserved', { name }) };
    return { env: { name, scope: d.scope ?? 'all' } };
  }
  const siteOf = d => d.site.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

  // ---- 追加（種類の 4 択 → 種類ごとの欄 → 使い道 → メモ）
  const providerTaken = p => p !== 'custom' && data.keys.some(k => k.provider === p);
  const firstFree = () => PROVIDER_CHOICES.find(p => !providerTaken(p)) ?? 'custom';
  function newDraft(kind) {
    return { kind, provider: firstFree(), name: '', label: '', site: '', username: '', value: '', note: '',
      envOn: kind === 'secret' || kind === 'var', envName: '', scope: 'all', sitesOn: true, error: '' };
  }
  function addBlock(forced) {
    const a = ui.adding;
    const form = el('form', 'mp-card ak-add'); form.setAttribute('aria-label', t('secrets.add.title'));
    form.append(el('strong', null, t('secrets.add.title')));
    const grid = el('div', 'mp-presets'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', t('secrets.add.kind'));
    for (const kind of KINDS) {
      const b = el('button', 'mp-preset'); b.type = 'button'; b.setAttribute('aria-pressed', String(a.kind === kind)); b.dataset.fk = 'kind:' + kind;
      // i18n-dynamic: secrets.kinds.
      b.append(el('span', null, t(`secrets.kinds.${kind}.name`)), el('small', null, t(`secrets.kinds.${kind}.hint`)));
      b.onclick = () => {
        const keep = { note: a.note };
        ui.adding = { ...newDraft(kind), ...keep };
        ui.focus = 'kind:' + kind; paint();
      };
      grid.append(b);
    }
    form.append(grid);
    let valueInput = null;
    if (a.kind === 'api') {
      const pgrid = el('div', 'mp-presets ak-providers'); pgrid.setAttribute('role', 'group'); pgrid.setAttribute('aria-label', t('apiKeys.add.provider'));
      for (const p of PROVIDER_CHOICES) {
        const taken = providerTaken(p);
        const b = el('button', 'mp-preset'); b.type = 'button'; b.setAttribute('aria-pressed', String(a.provider === p)); b.disabled = taken;
        // i18n-dynamic: apiKeys.add.providers.
        b.append(el('span', null, t(`apiKeys.add.providers.${p}.name`)), el('small', null, taken ? t('apiKeys.add.taken') : t(`apiKeys.add.providers.${p}.hint`)));
        b.onclick = () => { a.provider = p; ui.focus = 'addin'; paint(); };
        pgrid.append(b);
      }
      // ボタンの並びは label で包まない（包むと、ボタンの読み上げの名前が見出しの字になる）
      const pf = el('div', 'mp-field'); pf.append(el('span', null, t('apiKeys.add.provider')), pgrid); form.append(pf);
      if (a.provider === 'custom') form.append(field(t('apiKeys.add.name'), textInput({ value: a.label, aria: t('apiKeys.add.nameAria'), placeholder: t('apiKeys.add.namePlaceholder'), max: 60, onInput: v => { a.label = v; } })));
      const { row, input } = secretInput({ value: a.value, aria: a.provider === 'custom' ? t('apiKeys.add.keyAriaCustom') : t('apiKeys.add.keyAria', { provider: providerName(a.provider) }),
        placeholder: a.provider === 'openrouter' ? 'sk-or-…' : '', fk: 'addin', onInput: v => { a.value = v; } });
      valueInput = input;
      const f = el('div', 'mp-field'); f.append(el('span', null, t('apiKeys.add.key')), row); form.append(f);
    } else if (a.kind === 'login') {
      form.append(field(t('secrets.fields.label'), textInput({ value: a.label, aria: t('secrets.fields.label'), max: 60, fk: 'addin', onInput: v => { a.label = v; } })));
      form.append(field(t('secrets.fields.site'), textInput({ value: a.site, aria: t('secrets.fields.site'), placeholder: 'example.com', mono: true, max: 300, onInput: v => { a.site = v; } })));
      const grid2 = el('div', 'mp-grid');
      grid2.append(field(t('secrets.fields.username'), textInput({ value: a.username, aria: t('secrets.fields.username'), max: 200, onInput: v => { a.username = v; } })));
      const { row, input } = secretInput({ value: a.value, aria: t('secrets.fields.password'), fk: 'addpw', onInput: v => { a.value = v; } });
      valueInput = input;
      const f = el('div', 'mp-field'); f.append(el('span', null, t('secrets.fields.password')), row); grid2.append(f);
      form.append(grid2);
    } else if (a.kind === 'secret') {
      form.append(field(t('secrets.fields.envName'), textInput({ value: a.envName, aria: t('secrets.fields.envName'), placeholder: 'STRIPE_SECRET_KEY', mono: true, max: 128, fk: 'addin', onInput: v => { a.envName = v; } })));
      const { row, input } = secretInput({ value: a.value, aria: t('secrets.fields.value'), fk: 'addval', onInput: v => { a.value = v; } });
      valueInput = input;
      const f = el('div', 'mp-field'); f.append(el('span', null, t('secrets.fields.value')), row); form.append(f);
    } else {
      const grid2 = el('div', 'mp-grid');
      grid2.append(field(t('secrets.fields.envName'), textInput({ value: a.envName, aria: t('secrets.fields.envName'), placeholder: 'NODE_ENV', mono: true, max: 128, fk: 'addin', onInput: v => { a.envName = v; } })),
        field(t('secrets.fields.value'), textInput({ value: a.value, aria: t('secrets.fields.value'), mono: true, max: 16000, onInput: v => { a.value = v; } })));
      form.append(grid2);
    }
    // 秘密の値・変数は、名前が環境変数の名前（使い道の名前の欄は出さない）。API キー・ログイン情報は使い道の箱で名前を入れる
    if (a.kind === 'api' || a.kind === 'login') form.append(usesBox(a, { kind: a.kind, idp: 'add' }));
    else {
      const box = el('fieldset', 'ak-usebox'); box.append(el('legend', null, t('secrets.uses.title')));
      const f = el('div', 'mp-field'); f.append(el('span', null, t('secrets.uses.scope')), scopeSelect({ value: a.scope, label: t('secrets.uses.scope'), fk: 'add:scope', onChange: s => { a.scope = s; ui.focus = 'add:scope'; paint(); } }));
      box.append(f);
      form.append(box);
    }
    form.append(field(t('secrets.fields.note'), textInput({ value: a.note, aria: t('secrets.fields.note'), placeholder: t('secrets.fields.notePlaceholder'), max: 300, onInput: v => { a.note = v; } })));
    if (a.error) { const p = el('p', 'mp-warn ak-warn', a.error); p.setAttribute('role', 'alert'); form.append(p); }
    const actions = el('div', 'mp-actions'); actions.style.marginTop = '12px';
    if (!forced) actions.append(button(t('apiKeys.cancel'), closeAdd));
    const submit = el('button', 'btn btn-primary', t('secrets.add.submit')); submit.type = 'submit'; actions.append(submit);
    form.append(actions);
    form.onsubmit = async e => { e.preventDefault(); await register(a, valueInput); };
    form.onkeydown = e => { if (e.key === 'Escape' && !forced) { e.stopPropagation(); closeAdd(); } };
    return form;
  }
  async function closeAdd() { await collapse('add'); ui.adding = null; ui.focus = 'add'; paint(); }
  async function register(a, valueInput) {
    a.error = '';
    const forget = () => { a.value = ''; if (valueInput) valueInput.value = ''; };
    try {
      if (a.kind === 'api') {
        const value = a.value.trim();
        if (!value) return;
        const uses = envOf(a);
        if (uses.error) { a.error = uses.error; paint(); return; }
        const { id } = await cmd('setApiKey', { provider: a.provider, label: a.provider === 'custom' ? a.label.trim() : '', key: value });
        forget();
        if (uses.env || a.note.trim()) await invoke('secrets.setUses', { id, env: uses.env, note: a.note.trim() }).catch(e => fail(e));
        await afterAdd({ keyId: id });
        return;
      }
      if (a.kind === 'login') {
        const uses = envOf(a);
        if (uses.error) { a.error = uses.error; paint(); return; }
        const site = siteOf(a);
        if (!a.value) { a.error = t('secrets.errors.password'); paint(); return; }
        const { id } = await invoke('secrets.save', { kind: 'login', label: a.label.trim() || site, username: a.username.trim(), password: a.value,
          sites: a.sitesOn && site ? [site] : [], env: uses.env, note: a.note.trim() });
        forget();
        await afterAdd({ itemId: id });
        return;
      }
      const name = a.envName.trim();
      if (!ENV_NAME.test(name)) { a.error = t('secrets.errors.name', { name }); paint(); return; }
      if (reservedName(name)) { a.error = t('secrets.errors.reserved', { name }); paint(); return; }
      if (a.kind === 'secret' && !a.value) { a.error = t('secrets.errors.value'); paint(); return; }
      const { id } = await invoke('secrets.save', { kind: a.kind, label: name, value: a.value, env: { name, scope: a.scope ?? 'all' }, note: a.note.trim() });
      forget();
      await afterAdd({ itemId: id });
    } catch (e) { forget(); a.error = e?.message ?? String(e); paint(); }
  }
  async function afterAdd({ keyId = null, itemId = null }) {
    await collapse('add');
    ui.adding = null;
    if (keyId) { ui.checking.add(keyId); ui.focus = 'chk:' + keyId; }
    else ui.focus = 'edit:' + itemId;
    await load();
    const name = keyId ? (findKey(keyId) ? keyName(findKey(keyId)) : '') : findItem(itemId)?.label ?? '';
    say(t('secrets.add.done', { name }));
    paint();
    root.querySelector(`[data-id="${keyId ?? itemId}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    // 確かめ方のあるプロバイダーは、登録の直後に確かめる（接続先の確認と違い、料金はかからない）
    const k = keyId ? findKey(keyId) : null;
    if (k?.checkable) {
      try { await invoke('apiKeys.check', { id: keyId }); } catch { /* 確かめられなくても登録はできている */ }
      ui.checking.delete(keyId);
      await load();
      const done = findKey(keyId);
      if (done) say(done.lastCheck?.ok === false ? t('apiKeys.add.registeredFailed', { name: keyName(done) }) : t('apiKeys.add.registeredChecked', { name: keyName(done) }));
    }
    if (keyId) ui.checking.delete(keyId);
    paint();
  }

  // ---- 編集（カードの中。値・名前・使い道・メモ）
  function openEdit(id) {
    const k = findKey(id);
    if (k) {
      const use = keyUse(id);
      ui.editing = { id, kind: 'api', value: '', note: use?.note ?? '', envOn: Boolean(use?.env), envName: use?.env?.name ?? '', scope: use?.env?.scope ?? 'all', error: '' };
    } else {
      const item = findItem(id);
      if (!item) return;
      ui.editing = { id, kind: item.kind, label: item.label, username: item.username ?? '', site: item.sites?.[0] ?? '', sitesOn: (item.sites ?? []).length > 0,
        value: item.kind === 'var' ? item.value ?? '' : '', note: item.note ?? '', envOn: Boolean(item.env), envName: item.env?.name ?? '', scope: item.env?.scope ?? 'all', toSecret: false, error: '' };
    }
    ui.deleting = ''; ui.result = null; ui.focus = 'editin:' + id;
    paint();
  }
  async function closeEdit(id) { await collapse('edit:' + id); ui.editing = null; ui.focus = 'edit:' + id; paint(); }
  function editForm(id) {
    const d = ui.editing;
    const form = el('form', 'rt-key-form ak-form');
    let valueInput = null;
    if (d.kind === 'api') {
      const k = findKey(id);
      form.setAttribute('aria-label', t('secrets.edit.aria', { name: keyName(k) }));
      const { row, input } = secretInput({ value: d.value, aria: t('apiKeys.replace.input', { name: keyName(k) }), placeholder: t('secrets.edit.replacePlaceholder'), fk: 'editin:' + id, onInput: v => { d.value = v; } });
      valueInput = input;
      const f = el('div', 'mp-field'); f.append(el('span', null, t('apiKeys.add.key')), row);
      if (k.uses.some(u => u.kind === 'endpoint')) f.append(el('small', 'ak-cost', t('apiKeys.replace.cost')));
      form.append(f, usesBox(d, { kind: 'api', pleiad: k.uses.length ? pleiadUses(k) : null, idp: 'edit:' + id }));
    } else {
      const item = findItem(id);
      form.setAttribute('aria-label', t('secrets.edit.aria', { name: item.label }));
      form.append(field(t('secrets.fields.label'), textInput({ value: d.label, aria: t('secrets.fields.label'), max: 60, fk: 'editin:' + id, onInput: v => { d.label = v; } })));
      if (d.kind === 'login') {
        form.append(field(t('secrets.fields.site'), textInput({ value: d.site, aria: t('secrets.fields.site'), placeholder: 'example.com', mono: true, max: 300, onInput: v => { d.site = v; } })));
        const grid2 = el('div', 'mp-grid');
        grid2.append(field(t('secrets.fields.username'), textInput({ value: d.username, aria: t('secrets.fields.username'), max: 200, onInput: v => { d.username = v; } })));
        const { row, input } = secretInput({ value: d.value, aria: t('secrets.fields.password'), placeholder: t('secrets.edit.replacePlaceholder'), onInput: v => { d.value = v; } });
        valueInput = input;
        const f = el('div', 'mp-field'); f.append(el('span', null, t('secrets.fields.password')), row); grid2.append(f);
        form.append(grid2);
      } else if (d.kind === 'secret') {
        const { row, input } = secretInput({ value: d.value, aria: t('secrets.fields.value'), placeholder: t('secrets.edit.replacePlaceholder'), onInput: v => { d.value = v; } });
        valueInput = input;
        const f = el('div', 'mp-field'); f.append(el('span', null, t('secrets.fields.value')), row); form.append(f);
      } else {
        form.append(field(t('secrets.fields.value'), textInput({ value: d.value, aria: t('secrets.fields.value'), mono: true, max: 16000, onInput: v => { d.value = v; } })));
        const pid = uid('akp');
        const row = el('div', 'ak-radio');
        const c = el('input'); c.type = 'checkbox'; c.id = pid; c.checked = d.toSecret; c.onchange = () => { d.toSecret = c.checked; };
        const text = el('span', 't'); const label = el('label'); label.htmlFor = pid; label.textContent = t('secrets.edit.toSecret');
        text.append(label, el('small', null, t('secrets.edit.toSecretHint')));
        row.append(c, text); form.append(row);
      }
      form.append(usesBox(d, { kind: d.kind, idp: 'edit:' + id }));
    }
    form.append(field(t('secrets.fields.note'), textInput({ value: d.note, aria: t('secrets.fields.note'), placeholder: t('secrets.fields.notePlaceholder'), max: 300, onInput: v => { d.note = v; } })));
    if (d.error) { const p = el('p', 'mp-warn ak-warn', d.error); p.setAttribute('role', 'alert'); form.append(p); }
    const actions = el('div', 'mp-card-actions');
    const submit = el('button', 'btn btn-primary', t('secrets.edit.save')); submit.type = 'submit';
    actions.append(button(t('apiKeys.cancel'), () => closeEdit(id)), submit);
    form.append(actions);
    form.onsubmit = async e => { e.preventDefault(); await saveEdit(id, valueInput); };
    form.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); closeEdit(id); } };
    return form;
  }
  async function saveEdit(id, valueInput) {
    const d = ui.editing;
    d.error = '';
    const forget = () => { if (d.kind !== 'var') { d.value = ''; if (valueInput) valueInput.value = ''; } };
    const uses = d.kind === 'secret' || d.kind === 'var' ? (d.envOn ? envOf({ ...d, envName: d.envName || d.label }) : { env: null }) : envOf(d);
    if (uses.error) { d.error = uses.error; paint(); return; }
    try {
      if (d.kind === 'api') {
        const k = findKey(id);
        const value = d.value.trim();
        if (value) await cmd('setApiKey', { id, key: value });
        forget();
        await invoke('secrets.setUses', { id, env: uses.env, note: d.note.trim() });
        await collapse('edit:' + id);
        ui.editing = null; ui.focus = 'edit:' + id;
        await load();
        if (value) await runChecks(id, t('apiKeys.replace.done', { name: keyName(k) }));
        else { say(t('secrets.edit.saved', { name: keyName(k) })); paint(); }
        return;
      }
      const site = siteOf(d);
      await invoke('secrets.save', { id, label: d.label.trim(), note: d.note.trim(), env: uses.env,
        ...(d.kind === 'login' ? { username: d.username.trim(), sites: d.sitesOn && site ? [site] : [], ...(d.value ? { password: d.value } : {}) } : {}),
        ...(d.kind === 'secret' && d.value ? { value: d.value } : {}),
        ...(d.kind === 'var' ? { value: d.value, ...(d.toSecret ? { toSecret: true } : {}) } : {}) });
      forget();
      await collapse('edit:' + id);
      ui.editing = null; ui.focus = 'edit:' + id;
      await load();
      say(t('secrets.edit.saved', { name: findItem(id)?.label ?? '' }));
      paint();
    } catch (e) { forget(); d.error = e?.message ?? String(e); paint(); }
  }

  // ---- 削除（使っている所と、削除後に起きることを並べて聞き直す）
  function confirmBlock(id) {
    const k = findKey(id), item = k ? null : findItem(id);
    const name = k ? keyName(k) : item.label;
    const effects = [];
    if (k) for (const u of k.uses) effects.push([useLabel(u), useEffect(u)]);
    const env = k ? keyUse(id)?.env : item.env;
    if (env) effects.push([t('secrets.delete.envLabel', { name: env.name }), t('secrets.delete.envEffect')]);
    if (item?.kind === 'login' && item.sites.length) effects.push([t('secrets.delete.sitesLabel', { sites: item.sites.join(', ') }), t('secrets.delete.sitesEffect')]);
    const body = el('div', 'ak-confirm-body');
    if (effects.length) {
      const ul = el('ul', 'ak-effects');
      for (const [label, effect] of effects) { const li = el('li'); li.append(el('b', null, label), ` — ${effect}`); ul.append(li); }
      body.append(el('p', null, t('apiKeys.delete.withUses', { name })), ul);
    } else body.append(el('p', null, t('apiKeys.delete.noUses', { name })));
    const box = el('div', 'mp-confirm ak-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', t('apiKeys.delete.aria', { name }));
    const actions = el('div', 'mp-card-actions');
    actions.append(button(t('apiKeys.cancel'), () => closeDelete(id), 'btn', { 'data-fk': 'delno:' + id }), button(t('apiKeys.delete.yes'), () => doDelete(id), 'btn', { 'data-fk': 'delyes:' + id }));
    box.append(body, actions);
    box.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); closeDelete(id); } };
    return box;
  }
  async function closeDelete(id) { await collapse('del:' + id); ui.deleting = ''; ui.focus = 'del:' + id; paint(); }
  async function doDelete(id) {
    const k = findKey(id);
    const name = k ? keyName(k) : findItem(id)?.label ?? '';
    const uses = k ? [...k.uses] : [];
    const card = root.querySelector(`[data-id="${id}"]`);
    try {
      if (k) await cmd('deleteApiKey', { id }); else await invoke('secrets.delete', { id });
      if (card && !reduced()) {
        // カードは高さ・不透明度・余白を 240ms · ease-out で畳んで消す
        card.style.height = card.offsetHeight + 'px'; card.style.overflow = 'hidden';
        card.style.transition = `height ${SETTLE_MS}ms var(--ease-out),opacity ${SETTLE_MS}ms var(--ease-out),margin ${SETTLE_MS}ms var(--ease-out),padding ${SETTLE_MS}ms var(--ease-out)`;
        void card.offsetHeight;
        Object.assign(card.style, { height: '0px', opacity: '0', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' });
        await wait(SETTLE_MS + 20);
      }
      ui.deleting = ''; if (ui.result?.keyId === id) ui.result = null;
      const uses2 = uses.map(useLabel).join(t('apiKeys.listSeparator'));
      say(uses.length ? t('apiKeys.delete.doneWithUses', { name, uses: uses2 }) : t('apiKeys.delete.done', { name }));
      ui.focus = 'add';
      await load();
    } catch (e) { fail(e); paint(); }
  }

  // ---- 移行の案内（節。値の違う同じプロバイダーのキーが見つかったときだけ、一度だけ）
  function guideBlock(g) {
    const name = providerName(g.provider) || g.provider;
    const keys = g.keyIds.map(findKey).filter(Boolean);
    const id = uid('akg');
    const secEl = el('section', 'nf-section ak-guide'); secEl.setAttribute('aria-labelledby', id);
    const h = el('h4', null, t('apiKeys.guide.title', { name, count: keys.length })); h.id = id;
    secEl.append(h);
    const card = el('div', 'nf-card');
    card.append(el('p', null, t('apiKeys.guide.body', { name })));
    if (!ui.merge) {
      const actions = el('div', 'mp-card-actions');
      actions.append(
        button(t('apiKeys.guide.merge'), () => { ui.merge = { pick: null }; ui.focus = 'pick:' + keys[0].id; paint(); }, 'btn btn-primary', { 'data-fk': 'gmerge' }),
        button(t('apiKeys.guide.keep'), async () => {
          try { await cmd('resolveApiKeyGuide', { keep: null }); await collapse('guide'); say(t('apiKeys.guide.kept')); ui.focus = 'add'; await load(); } catch (e) { fail(e); paint(); }
        }, 'btn', { 'data-fk': 'gkeep' }));
      card.append(actions);
    } else {
      const fs = el('fieldset', 'mp-field'); fs.append(el('legend', null, t('apiKeys.guide.pick')));
      for (const k of keys) {
        const rid = uid('pk');
        const radio = el('div', 'ak-radio');
        const input = el('input'); input.type = 'radio'; input.id = rid; input.name = 'ak-keep'; input.checked = ui.merge.pick === k.id; input.dataset.fk = 'pick:' + k.id;
        input.onchange = () => { ui.merge.pick = k.id; ui.focus = 'pick:' + k.id; paint(); };
        const text = el('span', 't'); const label = el('label'); label.htmlFor = rid; label.append(el('b', null, keyName(k)));
        text.append(label, el('small', null, k.uses.length ? t('apiKeys.guide.usedBy', { uses: k.uses.map(useLabel).join(' · ') }) : t('apiKeys.uses.none')));
        radio.append(input, text); fs.append(radio);
      }
      const go = el('button', 'btn btn-primary', t('apiKeys.guide.mergeGo')); go.type = 'button'; go.disabled = !ui.merge.pick; go.onclick = () => doMerge();
      const actions = el('div', 'mp-card-actions'); actions.style.marginTop = '10px';
      actions.append(button(t('apiKeys.cancel'), () => { ui.merge = null; ui.focus = 'gmerge'; paint(); }), go);
      card.append(fs, el('p', 'mp-note', t('apiKeys.guide.note')), actions);
    }
    secEl.append(card);
    return secEl;
  }
  async function doMerge() {
    const keep = ui.merge?.pick;
    if (!keep) return;
    try {
      await cmd('resolveApiKeyGuide', { keep });
      await collapse('guide');
      ui.merge = null; ui.focus = 'edit:' + keep;
      await load();
      const k = findKey(keep);
      await runChecks(keep, t('apiKeys.guide.merged', { name: k ? keyName(k) : '' }));
    } catch (e) { fail(e); paint(); }
  }

  // ---- カード（API キーと、ログイン情報・秘密の値）
  function card(entry, seen) {
    const { id, isKey } = entry;
    const k = isKey ? findKey(id) : null, item = isKey ? null : findItem(id);
    const name = isKey ? keyName(k) : item.label;
    const nid = uid('akn');
    const busy = ui.editing?.id === id || ui.deleting === id;
    const li = el('li', 'mp-card ak-card'); li.setAttribute('role', 'group'); li.setAttribute('aria-labelledby', nid); li.dataset.id = id;
    const info = el('div', 'mp-card-info'); const strong = el('strong', null, name); strong.id = nid;
    info.append(strong);
    if (isKey) {
      if (ui.checking.has(id)) { const s = el('small', 'ak-status'); s.append(spinner(), ` ${t('apiKeys.checking')}`); info.append(s); }
      else {
        const s = statusLine(k, 'ak-status');
        s.prepend(`${t('secrets.kinds.api.name')} · `);
        const note = keyUse(id)?.note;
        if (note) s.append(` · ${note}`);
        info.append(s);
      }
    } else {
      // i18n-dynamic: secrets.kinds.
      const parts = [t(`secrets.kinds.${item.kind}.name`)];
      if (item.kind === 'login' && item.username) parts.push(t('secrets.card.username', { name: item.username }));
      if (item.note) parts.push(item.note);
      if (item.by === 'ai') parts.push(t('secrets.card.byAi'));
      info.append(el('small', 'ak-status', parts.join(' · ')));
    }
    const actions = el('div', 'mp-card-actions'); actions.hidden = busy;
    actions.append(button(t('secrets.actions.edit'), () => openEdit(id), 'btn', { 'data-fk': 'edit:' + id, 'aria-label': t('secrets.actions.editAria', { name }), 'aria-expanded': String(ui.editing?.id === id) }));
    if (isKey && k.checkable) actions.append(button(t('apiKeys.actions.check'), () => check(k), 'btn',
      { 'data-fk': 'chk:' + id, 'aria-label': t('apiKeys.actions.checkAria', { name }), 'aria-disabled': ui.checking.has(id) ? 'true' : null }));
    actions.append(button(t('apiKeys.actions.delete'), () => { ui.deleting = id; ui.editing = null; ui.result = null; ui.focus = 'delno:' + id; paint(); }, 'btn',
      { 'data-fk': 'del:' + id, 'aria-label': t('apiKeys.actions.deleteAria', { name }), 'aria-expanded': String(ui.deleting === id) }));
    const head = el('div', 'mp-row'); head.append(info, actions);
    li.append(head, usesRows(isKey ? keyRows(k) : itemRows(item), name));
    if (ui.editing?.id === id) li.append(region('edit:' + id, editForm(id), seen));
    if (ui.deleting === id) li.append(region('del:' + id, confirmBlock(id), seen));
    if (isKey && ui.result?.keyId === id) li.append(region('res:' + id, resultBlock(k), seen));
    return li;
  }

  // ---- 変数（1 行ずつ。値を出す）
  function varRow(item, seen) {
    const li = el('li', 'ak-var'); li.dataset.id = item.id;
    const nid = uid('akv');
    const kv = el('span', 'ak-kv');
    const n = el('span', 'ak-k', item.env?.name ?? item.label); n.id = nid;
    const v = el('span', 'ak-v', item.value ?? ''); v.title = item.value ?? '';
    kv.append(n, v);
    const where = el('span', 'ak-w' + (item.env && item.env.scope !== 'all' ? ' ak-mono' : ''), item.env ? scopeText(item.env.scope) : t('secrets.uses.none'));
    const actions = el('span', 'mp-card-actions');
    actions.hidden = ui.editing?.id === item.id || ui.deleting === item.id;
    actions.append(button(t('secrets.actions.edit'), () => openEdit(item.id), 'btn', { 'data-fk': 'edit:' + item.id, 'aria-label': t('secrets.actions.editAria', { name: n.textContent }), 'aria-expanded': String(ui.editing?.id === item.id) }));
    li.setAttribute('aria-labelledby', nid);
    li.append(kv, actions, where);
    if (ui.editing?.id === item.id) { const box = el('div', 'ak-var-more'); box.append(region('edit:' + item.id, editForm(item.id), seen)); li.append(box); }
    if (ui.deleting === item.id) { const box = el('div', 'ak-var-more'); box.append(region('del:' + item.id, confirmBlock(item.id), seen)); li.append(box); }
    return li;
  }
  function varEditDelete(item) {
    // 変数の編集の欄の中に削除を置く（行を短く保つ）
    return button(t('apiKeys.actions.delete'), () => { ui.deleting = item.id; ui.editing = null; ui.focus = 'delno:' + item.id; paint(); }, 'btn', { 'data-fk': 'del:' + item.id, 'aria-label': t('apiKeys.actions.deleteAria', { name: item.env?.name ?? item.label }) });
  }

  // ---- .env の取り込み
  function importBlock() {
    const im = ui.importing;
    const form = el('form', 'mp-card ak-add ak-import'); form.setAttribute('aria-label', t('secrets.import.title'));
    form.append(el('strong', null, t('secrets.import.title')));
    const area = el('textarea', 'ak-mono'); area.rows = 6; area.spellcheck = false; area.value = im.text; area.dataset.fk = 'impin';
    area.setAttribute('aria-label', t('secrets.import.text')); area.placeholder = 'NODE_ENV=development\nAPI_TOKEN=…';
    const f = el('label', 'mp-field'); f.append(el('span', null, t('secrets.import.text')), area); form.append(f);
    const table = el('table', 'ak-imp'); table.setAttribute('aria-label', t('secrets.import.preview'));
    const count = el('span');
    const existing = new Map((sec?.items ?? []).filter(i => i.env && sameScope(i.env.scope, im.scope)).map(i => [i.env.name.toUpperCase(), i.kind]));
    const keyNames = new Set(Object.values(sec?.keyUses ?? {}).filter(u => u.env).map(u => u.env.name.toUpperCase()));
    const rowsOf = () => {
      const { entries, malformed } = parseDotenv(im.text);
      return { malformed, rows: entries.map(e => {
        const upper = e.name.toUpperCase();
        const was = existing.get(upper);
        const status = reservedName(e.name) ? 'reserved' : keyNames.has(upper) || was === 'login' ? 'skip' : was ? (im.overwrite ? 'overwrite' : 'exists') : 'new';
        const secret = was === 'secret' ? true : im.secret.has(e.name) ? im.secret.get(e.name) : looksSecret(e.name);
        return { ...e, status, secret, locked: was === 'secret' };
      }) };
    };
    const go = el('button', 'btn btn-primary'); go.type = 'submit';
    const draw = () => {
      const { rows, malformed } = rowsOf();
      table.replaceChildren();
      for (const r of rows) {
        const tr = el('tr');
        // i18n-dynamic: secrets.import.status.
        tr.append(el('td', 'k ak-mono', r.name), el('td', 's', t(`secrets.import.status.${r.status}`)));
        const td = el('td', 'c');
        if (['new', 'overwrite'].includes(r.status)) {
          const lab = el('label'); const c = el('input'); c.type = 'checkbox'; c.checked = r.secret; c.disabled = r.locked;
          c.setAttribute('aria-label', t('secrets.import.secretAria', { name: r.name }));
          c.onchange = () => { im.secret.set(r.name, c.checked); };
          lab.append(c, t('secrets.import.secret')); td.append(lab);
        }
        tr.append(td); table.append(tr);
      }
      const n = rows.filter(r => ['new', 'overwrite'].includes(r.status)).length;
      go.textContent = t('secrets.import.submit', { count: n }); go.disabled = !n;
      count.textContent = malformed.length ? t('secrets.import.malformed', { count: malformed.length }) : '';
    };
    area.oninput = () => { im.text = area.value; draw(); };
    form.append(table, el('small', 'ak-cost', ''), count);
    const ow = el('div', 'ak-radio'); const owId = uid('ako');
    const owc = el('input'); owc.type = 'checkbox'; owc.id = owId; owc.checked = im.overwrite; owc.onchange = () => { im.overwrite = owc.checked; draw(); };
    const owl = el('label'); owl.htmlFor = owId; owl.textContent = t('secrets.import.overwrite');
    ow.append(owc, owl); form.append(ow);
    const sf = el('div', 'mp-field'); sf.append(el('span', null, t('secrets.uses.scope')), scopeSelect({ value: im.scope, label: t('secrets.uses.scope'), fk: 'imp:scope', onChange: s => { im.scope = s; ui.focus = 'imp:scope'; paint(); } }));
    form.append(sf);
    if (im.error) { const p = el('p', 'mp-warn ak-warn', im.error); p.setAttribute('role', 'alert'); form.append(p); }
    const actions = el('div', 'mp-actions'); actions.style.marginTop = '12px';
    actions.append(button(t('apiKeys.cancel'), closeImport), go);
    form.append(actions);
    draw();
    form.onsubmit = async e => {
      e.preventDefault();
      const { rows } = rowsOf();
      const entries = rows.filter(r => ['new', 'overwrite'].includes(r.status)).map(r => ({ name: r.name, value: r.value, secret: r.secret }));
      if (!entries.length) return;
      try {
        const r = await invoke('secrets.import', { entries, scope: im.scope, overwrite: im.overwrite });
        im.text = ''; area.value = '';
        await collapse('import');
        ui.importing = null; ui.focus = 'import';
        await load();
        say(t('secrets.import.done', { created: r.created.length, updated: r.updated.length, skipped: r.skipped.length }));
        paint();
      } catch (err) { im.error = err?.message ?? String(err); paint(); }
    };
    form.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); closeImport(); } };
    return form;
  }
  async function closeImport() { await collapse('import'); ui.importing = null; ui.focus = 'import'; paint(); }

  const lead = () => el('p', 'ak-lead', t('secrets.lead'));

  function paint() {
    const restore = keepFocus(root, ui.focus);
    ui.focus = null;
    pending = [];
    const seen = new Set();
    const out = [];
    if (!data) {
      out.push(lead());
      if (loadError) out.push(el('p', 'mp-state mp-warn', t('apiKeys.loadFailed', { error: loadError })));
      root.replaceChildren(...out);
      return;
    }
    out.push(lead());
    const panel = el('div', 'mp-panel ak-panel');
    const deferred = data.migration?.state === 'deferred';
    if (deferred) {
      // 古い置き場の暗号化されたキーを、この起動では読めない。移行を保留して、古い置き場のまま使う（API キーの編集は出さない）
      // i18n-dynamic: apiKeys.deferred.
      panel.append(el('h3', null, t('apiKeys.deferred.title')), el('p', 'mp-warn', t(`apiKeys.deferred.${data.migration.reason === 'locked' ? 'locked' : 'other'}`)));
    }
    if (sec?.broken) panel.append(el('p', 'mp-warn', t('secrets.broken')));
    const keys = deferred ? [] : data.keys;
    const items = sec?.items ?? [];
    const secretItems = items.filter(i => i.kind !== 'var');
    const vars = items.filter(i => i.kind === 'var');
    const entries = [...keys.map(k => ({ id: k.id, isKey: true, used: keyUsed(k) })), ...secretItems.map(i => ({ id: i.id, isKey: false, used: itemUsed(i) }))];
    const forced = !entries.length && !vars.length && !deferred && !sec?.broken;
    if (forced && !ui.adding) ui.adding = newDraft('api');
    const g = deferred ? null : data.guide;
    if (g && g.keyIds.map(findKey).filter(Boolean).length > 1) panel.append(region('guide', guideBlock(g), seen));
    const head = el('div', 'mp-row ak-head');
    const title = el('h3'); title.append(forced ? t('secrets.empty') : t('secrets.heading'));
    if (!forced) title.append(el('span', 'ak-count', String(entries.length)));
    head.append(title);
    if (!forced && !sec?.broken) head.append(button(ui.adding ? t('apiKeys.cancel') : t('secrets.add.open'), () => (ui.adding ? closeAdd() : (ui.adding = newDraft(deferred ? 'login' : 'api'), ui.focus = 'kind:' + ui.adding.kind, paint())), 'btn mp-link', { 'data-fk': 'add', 'aria-expanded': String(Boolean(ui.adding)) }));
    panel.append(head);
    if (ui.adding) panel.append(region('add', addBlock(forced), seen));
    const used = entries.filter(e => e.used), unused = entries.filter(e => !e.used);
    const listOf = (arr, label) => { const ul = el('ul', 'ak-list'); ul.setAttribute('aria-label', label); ul.append(...arr.map(e => card(e, seen))); return ul; };
    if (used.length && unused.length) panel.append(listOf(used, t('secrets.list.used')), el('div', 'ak-sub', t('secrets.list.unusedHeading')), listOf(unused, t('secrets.list.unused')));
    else if (entries.length) panel.append(listOf(entries, t('secrets.list.all')));

    // 変数
    if (!forced) {
      const vhead = el('div', 'mp-row ak-head ak-vars-head');
      const vtitle = el('h3'); vtitle.append(t('secrets.vars.heading'), el('span', 'ak-count', String(vars.length)));
      const vacts = el('span', 'mp-card-actions');
      if (!sec?.broken) vacts.append(
        button(t('secrets.import.open'), () => { if (ui.importing) closeImport(); else { ui.importing = { text: '', overwrite: false, scope: 'all', secret: new Map(), error: '' }; ui.focus = 'impin'; paint(); } }, 'btn mp-link', { 'data-fk': 'import', 'aria-expanded': String(Boolean(ui.importing)) }),
        button(t('secrets.vars.add'), () => { ui.adding = newDraft('var'); ui.focus = 'addin'; paint(); root.querySelector('[data-region="add"]')?.scrollIntoView({ block: 'nearest' }); }, 'btn mp-link', { 'data-fk': 'addvar' }));
      vhead.append(vtitle, vacts);
      panel.append(vhead);
      if (ui.importing) panel.append(region('import', importBlock(), seen));
      if (vars.length) {
        const ul = el('ul', 'ak-vars'); ul.setAttribute('aria-label', t('secrets.vars.heading'));
        ul.append(...vars.map(v => varRow(v, seen)));
        panel.append(ul);
      } else panel.append(el('p', 'mp-note ak-vars-empty', t('secrets.vars.empty')));
    }
    const state = el('p', 'mp-state' + (ui.result?.done ? ' visually-hidden' : '')); state.setAttribute('role', 'status'); state.textContent = ui.message;
    panel.append(state);
    const storage = sec?.storage ?? data.storage;
    panel.append(storage?.encrypted === false ? el('p', 'mp-note mp-warn', `⚠ ${t('apiKeys.notEncrypted')}`) : el('p', 'mp-note', t('secrets.encryptedNote')));
    out.push(panel);
    root.replaceChildren(...out);
    // 変数の編集の欄に削除を足す（行の［編集］から開いたとき）
    if (ui.editing && findItem(ui.editing.id)?.kind === 'var') root.querySelector(`[data-region="edit:${CSS.escape(ui.editing.id)}"] .mp-card-actions`)?.prepend(varEditDelete(findItem(ui.editing.id)));
    pending.forEach(box => { void box.offsetHeight; box.classList.add('open'); });
    for (const key of [...ui.shown]) if (!seen.has(key)) ui.shown.delete(key);
    restore();
  }

  tab.onclick = () => { page('apiKeys'); load(); };
  return {
    /** apiKeysChanged・secretsChanged が届いたとき。開いているときだけ取り直す（編集の途中は描き直さない） */
    event(ev) { if (!root.hidden && ['apiKeysChanged', 'secretsChanged'].includes(ev?.type) && !ui.editing && !ui.adding && !ui.importing) load(); },
    load,
  };
}
