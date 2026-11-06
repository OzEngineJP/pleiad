// 脇の Channels 側（docs/channels.md「画面」・docs/design-system.md「脇」、ADR 0107・0288）。脇の 3 か所を描く:
//   Bots の帯（#botStrip。検索の下）… 名前付きのアイコンを横に並べる（作業中は回る弧、あなた待ちは ◆）。押すと DM、右クリックで bot のページ。
//                                       入りきらない分は「+N」のメニュー、入りきれば最後に ＋（bot を作る画面、W4）
//   ルーティン（木の一番上の畳める見出し）… 次に動く時刻の近い順に全部を 1 行ずつ（件数では絞らない。ADR 0260）。一時停止中は薄く、直近の失敗は「✕ 失敗」。
//                                       畳んだ間は見出しに走っている弧と「✕N」。押すと編集のシート（routine-sheet.mjs）、＋で新規
//   チャンネル（一時チャットの下の見出し）… ＋でその場に名前の欄を出して作る（channels.create）。チャンネルの行は web/side.mjs の木が描く
// 木の節（ルーティン・チャンネル）は #channelsSide に置いておき、絞り込んでいないとき web/side.mjs の channelExtras が #groups へ入れる。
// 検索は Chats と同じ欄（#q）で両方を横断する（side.connectChannels。結果の行に「Chats」「#チャンネル」）。
// 読むのは channels.list・bots.list・channels.search・routines.list（routine-store.mjs）、更新は出来事 channelsChanged・channelPost・channelRead・channelThread・botsChanged・routinesChanged。
// 開く入口は document の channels:show（{ kind: 'channel', id, threadId? } / { kind: 'bot', id }。web/channels/index.mjs）。
import { el, svgEl } from '../dom.mjs';
import { botIcon } from './bot-icon.mjs';
import { t } from '../i18n.mjs';
import { runMark } from '../arc.mjs';
import { botState, tabDots, channelNameRows, postRows, showDetail, selectedRow } from './side-model.mjs';
import { shownBot } from './plain-bot.mjs';
import { getRoutineStore } from './routine-store.mjs';
import { sortForSide, lastFailed } from './routine-model.mjs';
import { openRoutine, whenText, stateText } from './routine-entry.mjs';

const ICONS = {
  clock: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2',
  plus: 'M12 5v14M5 12h14',
};
const RELOAD_WAIT_MS = 150;     // 出来事が続けて来たら 1 回にまとめて読み直す（作業中の投稿は 1 秒に 1 回届く）
const BOT_W = 50;               // 帯の 1 つ分の幅（.bt の 48px と間の 2px。web/channels-side.css）
const STRIP_PAD = 20;           // 帯の左右の余白の和
const ROUTINES_OPEN_KEY = 'agent-host-side-routines-open';   // ルーティンの見出しを開いているか（'1'。既定は畳む）

const icon = (d) => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d }));
  return svg;
};
const chevron = () => {
  const svg = svgEl('svg', { class: 'fam-chev', viewBox: '0 0 10 10', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M3.5 1.5 7 5l-3.5 3.5' }));
  return svg;
};
const message = (e) => String(e?.message ?? e ?? '');

/**
 * @param {object} host  web/channels/index.mjs の host
 * @param {() => { tab: string, setDot(name: string, kind: string|null): void }} getTabs  脇のタブ（部品を並べた後に作られるので関数で受ける）
 */
export function createSidebar(host, getTabs) {
  const panel = document.getElementById('channelsSide');
  if (!panel) return {};
  const side = host.side;
  const S = {
    channels: [],            // channels.list（unread・mentions 付き）
    bots: [],                // bots.list
    loaded: false,           // 一度でも読めた
    stale: true,             // 読み直しが要る（接続の前に読もうとして失敗した・出来事が来た）
    view: null,              // メインに出している面（show の view）。帯の選ばれた bot
    creating: false,         // チャンネルの名前の欄を出している
    createError: '',
    routinesOpen: false,     // ルーティンの見出しを開いている
  };
  try { S.routinesOpen = localStorage.getItem(ROUTINES_OPEN_KEY) === '1'; } catch { /* 覚えていなければ畳む */ }
  const secs = Object.fromEntries(['channels', 'routines'].map((k) => [k, panel.querySelector(`.cs-sec[data-sec="${k}"]`)]));
  const strip = document.getElementById('botStrip');

  const navigate = (detail) => document.dispatchEvent(new CustomEvent('channels:show', { detail }));
  const newRoutine = () => openRoutine(S.view?.kind === 'channel' ? { channelId: S.view.id } : {});

  // ---------------------------------------------------------------- チャンネルの見出し（「チャンネル ＋」。木の treeitem）
  const chan = {};
  if (secs.channels) {
    const sec = secs.channels;
    sec.replaceChildren();
    sec.setAttribute('role', 'none');
    const label = el('div', 'cs-label');
    label.id = 'csChannelsLabel';
    label.dataset.key = 'c:new-channel';
    label.setAttribute('role', 'treeitem');
    label.setAttribute('aria-level', '1');
    label.setAttribute('aria-label', `${t('channels:side.sections.channels')}, ${t('channels:side.newChannel')}`);
    label.treeOpen = () => startCreate();
    // 見出しのどこを押しても欄を出す（ルーティンの見出しが全体で開閉するのと同じく、文字も押せる）
    label.addEventListener('click', () => startCreate());
    const name = el('span', 'cs-label-t', t('channels:side.sections.channels'));
    const add = el('button', 'btn btn-icon cs-add');
    add.type = 'button';
    add.tabIndex = -1;
    add.title = t('channels:side.newChannel');
    add.setAttribute('aria-label', t('channels:side.newChannel'));
    add.append(icon(ICONS.plus));
    add.addEventListener('click', (e) => { e.stopPropagation(); startCreate(); });
    label.append(name, add);
    const rows = el('div', 'cs-rows');
    rows.setAttribute('role', 'none');
    sec.append(label, rows);
    Object.assign(chan, { label, add, rows });
  }

  // ---------------------------------------------------------------- ルーティンの見出し（一時チャット・チャンネルと同じ畳める見出し。木の treeitem）
  const rt = {};
  if (secs.routines) {
    const sec = secs.routines;
    sec.replaceChildren();
    sec.className = 'cs-sec grp chsec cs-rt';
    sec.setAttribute('role', 'none');
    const head = el('div', 'grp-head chsec-head cs-head');
    head.id = 'csRoutinesHead';
    head.dataset.key = 'c:routines';
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-level', '1');
    head.treeOpen = () => setRoutinesOpen(!S.routinesOpen);
    head.treeExpand = (open) => setRoutinesOpen(open);
    const chev = el('button', 'chsec-chev');
    chev.type = 'button';
    chev.tabIndex = -1;
    chev.setAttribute('aria-hidden', 'true');
    chev.append(chevron());
    chev.addEventListener('click', (e) => { e.stopPropagation(); setRoutinesOpen(!S.routinesOpen); });
    const ic = el('span', 'chsec-ic');
    ic.setAttribute('aria-hidden', 'true');
    ic.append(icon(ICONS.clock));
    const name = el('span', 'grp-name chsec-name', t('channels:side.sections.routines'));
    name.setAttribute('role', 'button');
    name.addEventListener('click', () => setRoutinesOpen(!S.routinesOpen));
    const marks = el('span', 'cs-rt-marks');
    const add = el('button', 'btn btn-icon grp-add cs-add');
    add.type = 'button';
    add.tabIndex = -1;
    add.title = t('channels:routines.new');
    add.setAttribute('aria-label', t('channels:routines.new'));
    add.append(icon(ICONS.plus));
    add.addEventListener('click', (e) => { e.stopPropagation(); newRoutine(); });
    head.append(chev, ic, name, marks, add);
    const rows = el('div', 'rows cs-rows');
    rows.setAttribute('role', 'group');
    sec.append(head, rows);
    Object.assign(rt, { sec, head, marks, rows });
  }
  function setRoutinesOpen(open) {
    if (S.routinesOpen === open) return;
    S.routinesOpen = open;
    try { localStorage.setItem(ROUTINES_OPEN_KEY, open ? '1' : '0'); } catch { /* 覚えられなくても開閉はする */ }
    paintRoutines();
  }

  // 検索欄は両方を探す
  const q = document.getElementById('q');
  if (q) { q.placeholder = t('channels:side.searchPlaceholder'); q.setAttribute('aria-label', t('channels:side.searchPlaceholder')); }

  // ---------------------------------------------------------------- 読み込み
  let reloadTimer = 0, loading = null;
  function reloadSoon() {
    S.stale = true;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, RELOAD_WAIT_MS);
  }
  async function load() {
    clearTimeout(reloadTimer);
    if (loading) { S.stale = true; return loading; }
    S.stale = false;
    loading = (async () => {
      try {
        const [c, b] = await Promise.all([host.invoke('channels.list', {}), host.invoke('bots.list', {})]);
        S.channels = c?.channels ?? [];
        S.bots = (b?.bots ?? []).map((x) => shownBot(x, t));
        S.loaded = true;
        side?.setDirectory?.({ channels: S.channels, bots: S.bots });
        paint();
      } catch {
        // まだつながっていない・切れている。次の出来事（つながると一覧の出来事が届く）で読み直す
        S.stale = true;
        if (!S.loaded) paint();
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // ---------------------------------------------------------------- 描画
  const live = () => ({ sessions: host.state?.sessions ?? [], runningIds: host.state?.runningIds ?? new Set(), waitingIds: host.state?.waitingIds ?? new Set() });
  const isSel = (kind, id) => { const s = selectedRow(S.view, S.bots); return s?.kind === kind && s.id === id; };

  function paint() {
    paintCreate();
    paintBots();
    paintRoutines();
    paintDots();
  }

  // ---- Bots の帯
  // 組み込みの bot（bot なし）は出さない（スレッドの宛先の面でだけ選ぶ）。描き直しは中身が変わったときだけ（押している最中・Tab で指している最中に崩さない）
  let stripSig = '';
  let stripAt = 0;            // 帯の中で Tab が止まる位置
  function paintBots(force = false) {
    if (!strip) return;
    const now = live();
    const bots = S.bots.filter((b) => !b.plain).map((b) => ({ b, state: botState(b, now) }));
    const cap = strip.clientWidth ? Math.max(2, Math.floor((strip.clientWidth - STRIP_PAD + 2) / BOT_W)) : 5;
    const over = bots.length + 1 > cap;
    const shown = over ? bots.slice(0, cap - 1) : bots;
    const hidden = over ? bots.slice(cap - 1) : [];
    const sig = JSON.stringify([cap, S.loaded, document.documentElement.lang, selectedRow(S.view, S.bots),
      bots.map(({ b, state }) => [b.id, b.name, b.icon, b.iconImage, b.dmChannelId, state])]);
    if (!force && sig === stripSig) return;
    stripSig = sig;
    const hadFocus = strip.contains(document.activeElement);
    const nodes = shown.map(({ b, state }) => {
      // i18n-dynamic: channels:side.botState.
      const said = t(`channels:side.botState.${state}`);
      const node = el('button', 'bt');
      node.type = 'button';
      node.dataset.id = b.id;
      node.setAttribute('aria-label', `${b.name}, ${said}`);
      node.title = state === 'idle' ? b.name : `${b.name} · ${said}`;
      if (isSel('bot', b.id)) { node.classList.add('sel'); node.setAttribute('aria-current', 'page'); }
      const av = botIcon(b, 'av');
      av.setAttribute('aria-hidden', 'true');
      if (state === 'working') { const m = runMark(); m.classList.add('ring'); m.setAttribute('aria-hidden', 'true'); av.append(m); }
      else if (state === 'waiting') { const w = el('span', 'bw', '◆'); w.setAttribute('aria-hidden', 'true'); av.append(w); }
      const nm = el('span', 'nm', b.name);
      nm.setAttribute('aria-hidden', 'true');
      node.append(av, nm);
      // 押すと DM（bot と 1 対 1 のチャンネル）。bot のページは右クリック・DM の見出しから
      node.addEventListener('click', () => navigate(b.dmChannelId ? { kind: 'channel', id: b.dmChannelId } : { kind: 'bot', id: b.id }));
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); botMenu(b, e.clientX, e.clientY); });
      node.botMenu = (x, y) => botMenu(b, x, y);
      return node;
    });
    if (over) {
      const more = el('button', 'bt more');
      more.type = 'button';
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-label', t('channels:side.moreBots', { count: bots.length }));
      more.title = t('channels:side.moreBots', { count: bots.length });
      const av = el('span', 'av', `+${hidden.length}`);
      av.setAttribute('aria-hidden', 'true');
      // 隠れた bot の中に待っている・走っているものがあれば、「+N」にも同じ印
      if (hidden.some((x) => x.state === 'waiting')) { const w = el('span', 'bw', '◆'); w.setAttribute('aria-hidden', 'true'); av.append(w); }
      else if (hidden.some((x) => x.state === 'working')) { const m = runMark(); m.classList.add('ring'); m.setAttribute('aria-hidden', 'true'); av.append(m); }
      more.append(av, el('span', 'nm', ''));
      more.addEventListener('click', () => { const r = more.getBoundingClientRect(); allBotsMenu(bots, r.left, r.bottom + 4); });
      nodes.push(more);
    } else if (S.loaded) {
      const add = el('button', 'bt add');
      add.type = 'button';
      add.setAttribute('aria-label', t('channels:side.newBot'));
      add.title = t('channels:side.newBot');
      const av = el('span', 'av');
      av.setAttribute('aria-hidden', 'true');
      av.append(icon(ICONS.plus));
      add.append(av, el('span', 'nm', ''));
      add.addEventListener('click', () => navigate({ kind: 'bot', id: 'new' }));
      nodes.push(add);
    }
    strip.replaceChildren(...nodes);
    stripAt = Math.min(stripAt, Math.max(0, nodes.length - 1));
    nodes.forEach((n, i) => { n.tabIndex = i === stripAt ? 0 : -1; });
    if (hadFocus) nodes[stripAt]?.focus({ preventScroll: true });
  }
  if (strip) {
    // ← → Home End で帯の中を移る（Tab は帯に 1 回だけ止まる）。Shift+F10・メニューキーで bot のメニュー
    strip.addEventListener('keydown', (e) => {
      const items = [...strip.querySelectorAll('.bt')];
      const i = items.indexOf(document.activeElement);
      if (i < 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        if (!items[i].botMenu) return;
        e.preventDefault();
        const r = items[i].getBoundingClientRect();
        items[i].botMenu(r.left + 16, r.bottom);
        return;
      }
      const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
      if (to == null) return;
      e.preventDefault();
      stripAt = (to + items.length) % items.length;
      items.forEach((n, j) => { n.tabIndex = j === stripAt ? 0 : -1; });
      items[stripAt].focus();
    });
    strip.addEventListener('focusin', (e) => {
      const items = [...strip.querySelectorAll('.bt')];
      const i = items.indexOf(e.target);
      if (i >= 0) { stripAt = i; items.forEach((n, j) => { n.tabIndex = j === i ? 0 : -1; }); }
    });
    // 脇の幅が変わったら、入る数を数え直す
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => paintBots()).observe(strip);
  }

  function botMenu(b, x, y) {
    host.showMenu?.(x, y, [
      ...(b.dmChannelId ? [{ label: t('channels:side.openDm'), onClick: () => navigate({ kind: 'channel', id: b.dmChannelId }) }] : []),
      { label: t('channels:side.openBot'), onClick: () => navigate({ kind: 'bot', id: b.id }) },
    ], b.name);
  }

  // 「+N」: すべての bot（状態つき）と「bot を作る」
  function allBotsMenu(bots, x, y) {
    const items = bots.map(({ b, state }) => {
      const av = botIcon(b, 'av bt-menu-av');
      av.setAttribute('aria-hidden', 'true');
      // i18n-dynamic: channels:side.botState.
      const said = t(`channels:side.botState.${state}`);
      return { icon: av, label: b.name, hint: state === 'idle' ? '' : said,
        onClick: () => navigate(b.dmChannelId ? { kind: 'channel', id: b.dmChannelId } : { kind: 'bot', id: b.id }) };
    });
    host.showMenu?.(x, y, [...items, { sep: true }, { label: t('channels:side.newBot'), onClick: () => navigate({ kind: 'bot', id: 'new' }) }],
      t('channels:side.sections.bots'));
  }

  // ---- ルーティン
  // 次に動く時刻の近い順に全部（件数では絞らない。ADR 0260）。1 件 1 行: 名前と、右に「✕ 失敗」・走っている弧・時刻（一時停止は「一時停止」で薄く）。
  // #チャンネルは title と読み上げに入れる
  const routineStore = getRoutineStore(host);
  function paintRoutines() {
    if (!rt.sec) return;
    const all = sortForSide(routineStore.list());
    const open = S.routinesOpen;
    rt.sec.classList.toggle('collapsed', !open);
    rt.head.setAttribute('aria-expanded', String(open));
    const running = all.some((r) => r.last?.state === 'working');
    const fails = all.filter(lastFailed).length;
    const marks = [];
    if (!open && running) marks.push(runMark(t('sidebar.somethingRunning')));
    if (!open && fails) {
      const x = el('span', 'cs-rt-fails', `✕${fails}`);
      x.setAttribute('role', 'img');
      x.setAttribute('aria-label', t('channels:side.routinesFailed', { count: fails }));
      x.title = t('channels:side.routinesFailed', { count: fails });
      marks.push(x);
    }
    rt.marks.replaceChildren(...marks);
    rt.head.setAttribute('aria-label', [t('channels:side.sections.routines'), ...marks.map((m) => m.getAttribute('aria-label') || m.title)].filter(Boolean).join(', '));

    const channelName = (id) => S.channels.find((c) => c.id === id)?.name;
    const active = rt.rows.querySelector('.is-active')?.dataset.key;
    const nodes = all.map((r) => {
      const where = channelName(r.channelId);
      const working = r.last?.state === 'working';
      const failed = lastFailed(r);
      const when = r.paused ? t('channels:routines.paused') : whenText(r.nextAt);
      const said = [r.name, where ? `#${where}` : '', working ? stateText('working') : '', failed ? stateText('failed') : '', when].filter(Boolean).join(', ');
      const row = el('div', 'row one cs-row');
      row.id = `cs-rt-${r.id}`;
      row.dataset.kind = 'routine';
      row.dataset.id = r.id;
      row.dataset.key = `rt:${r.id}`;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', '2');
      row.setAttribute('aria-label', said);
      if (where) row.title = `#${where}`;
      row.classList.toggle('paused', Boolean(r.paused));
      if (row.dataset.key === active) row.classList.add('is-active');
      row.append(el('span', 'row-t', r.name));
      if (working) { const m = runMark(stateText('working')); m.setAttribute('aria-hidden', 'true'); row.append(m); }
      if (failed) row.append(el('span', 'cs-rt-fail', stateText('failed')));
      else if (!working) row.append(el('span', 'row-when', when));
      row.treeOpen = () => openRoutine({ routineId: r.id });
      row.treeMenu = (x, y) => routineMenu(r, x, y);
      row.addEventListener('click', () => openRoutine({ routineId: r.id }));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); routineMenu(r, e.clientX, e.clientY); });
      return row;
    });
    if (!nodes.length) nodes.push(el('div', 'empty cs-empty', routineStore.loaded ? t('channels:side.routinesEmpty') : t('channels:side.loading')));
    rt.rows.replaceChildren(...nodes);
  }

  function routineMenu(r, x, y) {
    host.showMenu?.(x, y, [
      { label: t('channels:routines.edit'), onClick: () => openRoutine({ routineId: r.id }) },
      { label: t('channels:routines.openChannel'), onClick: () => navigate({ kind: 'channel', id: r.channelId }) },
      { label: r.paused ? t('channels:routines.state.resume') : t('channels:routines.state.pause'),
        onClick: () => host.invoke(r.paused ? 'routines.resume' : 'routines.pause', { routineId: r.id }).then((res) => routineStore.put({ ...r, ...res })).catch(() => {}) },
    ], r.name);
  }
  routineStore.subscribe(() => paintRoutines());

  // ---------------------------------------------------------------- チャンネルを作る（＋ → その場の名前の欄）
  function startCreate() {
    S.creating = true;
    S.createError = '';
    paintCreate();
    chan.rows?.querySelector('.cs-new input')?.focus();
  }
  function endCreate() {
    S.creating = false;
    S.createError = '';
    S.createDraft = '';
    paintCreate();
  }
  function paintCreate() {
    if (!chan.rows) return;
    // 打っている途中に描き直さない（出来事で paint が呼ばれても、欄はそのまま）
    const shown = chan.rows.querySelector('.cs-new');
    if (S.creating && shown && shown.dataset.err === S.createError) return;
    chan.rows.replaceChildren(...(S.creating ? [createField()] : []));
  }
  function createField() {
    const wrap = el('div', 'cs-new');
    wrap.dataset.err = S.createError;
    const line = el('label', 'cs-new-line');
    const hash = el('span', 'hash', '#');
    hash.setAttribute('aria-hidden', 'true');
    const input = el('input', 'cs-new-input');
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = t('channels:side.newChannelPlaceholder');
    input.setAttribute('aria-label', t('channels:side.newChannel'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    // 打った名前は覚えておき、描き直し（絞り込みを掛けて外すなど）でも戻す
    input.value = S.createDraft ?? '';
    input.addEventListener('input', () => { S.createDraft = input.value; });
    line.append(hash, input);
    wrap.append(line);
    if (S.createError) {
      const err = el('div', 'cs-new-err', S.createError);
      err.id = 'csNewErr';
      err.setAttribute('role', 'alert');
      input.setAttribute('aria-describedby', err.id);
      wrap.append(err);
    }
    let busy = false;
    input.addEventListener('keydown', async (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // 修飾キー付きはアプリの近道（Ctrl+Shift+O・Ctrl+B・Ctrl+Shift+F）へ通す
      e.stopPropagation();   // 木（#groups）の文字での移動・Enter に渡さない
      if (e.key === 'Escape') { e.preventDefault(); endCreate(); chan.add?.focus(); return; }
      if (e.key !== 'Enter' || busy) return;
      e.preventDefault();
      const name = input.value.trim().replace(/^#+/, '').trim();
      if (!name) { endCreate(); return; }
      busy = true;
      try {
        const channel = await host.invoke('channels.create', { name });
        S.creating = false;
        S.createError = '';
        S.createDraft = '';
        S.channels = [...S.channels.filter((c) => c.id !== channel.id), { ...channel, unread: 0, mentions: 0 }];
        side?.setDirectory?.({ channels: S.channels, bots: S.bots });   // 木にすぐ出す（読み直しを待たない）
        paintCreate();
        navigate({ kind: 'channel', id: channel.id });
        reloadSoon();
      } catch (err) {
        S.createError = message(err);
        paintCreate();
        const again = chan.rows?.querySelector('.cs-new input');
        if (again) { again.value = input.value; again.focus(); }
      } finally {
        busy = false;
      }
    });
    // 空のまま離れたら畳む（打った名前があれば残す）
    input.addEventListener('blur', () => { setTimeout(() => { if (S.creating && !input.value.trim() && document.activeElement !== input) endCreate(); }, 0); });
    return wrap;
  }

  // ---------------------------------------------------------------- タブの点
  function paintDots() {
    const tabs = getTabs?.();
    if (!tabs) return;
    const now = live();
    const dots = tabDots({ tab: tabs.tab, channels: S.channels, botStates: S.bots.map((b) => botState(b, now)), chats: side?.attention?.() ?? {} });
    tabs.setDot('chats', dots.chats);
    tabs.setDot('channels', dots.channels);
  }

  // ---------------------------------------------------------------- 検索の横断（web/side.mjs）
  const whoOf = (author) => {
    if (author?.kind === 'human') return t('sidebar.search.who.user');
    if (author?.kind === 'bot') return S.bots.find((b) => b.id === author.botId)?.name ?? '';
    if (author?.kind === 'agent') return t('sidebar.search.who.assistant');
    return '';
  };
  side?.connectChannels?.({
    matchNames: (terms) => channelNameRows(S.channels, terms),
    searchPosts: async (query) => postRows((await host.invoke('channels.search', { query: query.slice(0, 200) }))?.hits ?? [], whoOf),
    open: (row) => navigate(showDetail(row)),
  });
  // Chats の一覧が描き直されたら（走る・待つ・既読が動いた）、bot の状態とタブの点を合わせる
  side?.onRender?.(() => { if (S.stale && !loading) load(); else { paintBots(); paintDots(); } });

  // タブは setupChannels が部品を並べた直後に作る。それを待ってから描く
  queueMicrotask(() => { paint(); load(); });

  const RELOAD_ON = new Set(['channelsChanged', 'channelPost', 'channelRead', 'channelThread', 'botsChanged']);
  return {
    onEvent(ev) {
      if (RELOAD_ON.has(ev?.type)) reloadSoon();
      else if (S.stale && !loading) load();
    },
    show(view) { S.view = view ?? null; paint(); },
    hide() { S.view = null; paint(); },
    sideTabChanged() { paintDots(); if (S.stale) load(); },
    /** ルーティンの見出しを開く（閉じたレールの時計から。中身は次の描き直しで出る） */
    openRoutines() { setRoutinesOpen(true); },
  };
}
