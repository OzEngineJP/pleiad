// bot のページと作成（W4。ADR 0109・docs/channels.md「bot のページ」・承認済みのモック 05）。
// #channelsBody の中に section#botView.bot-page を作る。見せるのは show({ kind: 'bot', id }) のとき。
// id が 'new' なら作る 3 段（名前 → 色 → 人格。エージェント・モデル・承認モードは既定。作ったら DM を開く。ADR 0362）。
//
// 設定は Chats の入力欄と同じ程度に簡単にする:
//   名前・色（顔を押すと 8 色の面）・人格（自由文）… 離れたときに bots.update。前の版の絵文字・画像は保存に残すが読まない（ADR 0362）
//   エージェント・モデル・エフォート … 入力欄と同じ 1 つの選択（composer-controls.mjs の renderModel）。bots.update
//   承認モード … 入力欄と同じ選択（renderMode）。bots.setMode（人だけ。ADR 0082）
//   接続先 … モデルの面の「接続先」の行（入力欄と同じ 1 つの一覧: CLI のログイン → 登録したアカウント → 互換の接続先。週の使用量は公式の枠の行だけ）。
//     bots.setAccount（人だけ。ADR 0224・0359）。そのエージェントが接続先を選べ（capabilities.accounts・compatEndpoints。
//     Claude はトークン・Codex などは資格情報。ADR 0222）、登録があるか bot が選んでいるときだけ出す。「既定」の札は新しい会話の既定の印なので出さない
//   触れてよいフォルダー … 行（パス・読み書き/読み取り）と［フォルダーを足す］。bots.update の folders（置き換え）
//     実際に書き込みの範囲を限れないモード（範囲 full: Claude の Bypass・Codex の Bypass・Antigravity）だけ「すべてのフォルダー」で非活性（計画 §7.2-2）
//   他の会話に送る … スイッチ（既定 ON）。bots.update の sendToOthers
// 右に記憶の一覧（memory-list.mjs）と今週の使用量。操作はすべて host.invoke(op, args)。出来事は botsChanged・memoryChanged・channelsChanged。
// 認証・1 日の上限・長い注記は出さない（接続先は、どれで動くかを選ぶ行だけ。登録・トークン・資格情報・互換の接続先は設定の各エージェントの「接続先」）。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { moreIcon } from '../icons.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { panel, renderModel, renderMode, folderBrowser, isDanger, modelChipLabel, resolvedModel, effortStops, connShown } from '../composer-controls.mjs';
import { endpointChipLabel } from '../composer-labels.mjs';
import { compatModelLabel } from '../compat-models.mjs';
import { weekUsage } from '../header-usage.mjs';
import { splitChipLabel } from '../composer-layout.mjs';
import { createMemoryList } from './memory-list.mjs';
import { botIcon, BOT_COLOR_COUNT } from './bot-icon.mjs';
import { foldRow } from './fold-row.mjs';
import * as M from './bot-model.mjs';

// 線画（composer-controls.mjs のチップと同じ。あちらは内部の定数）
const MODEL = ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3'];
const SHIELD = ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z'];
const WARN = ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5M12 17.2v.3'];
const CARET = ['M7 10l5 5 5-5'];
const FOLDER = ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'];
const FOLDER_ADD = ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 11v5M9.5 13.5h5'];
const LOCK = ['M7 11V8a5 5 0 0 1 10 0v3', 'M6 11h12v9H6z'];
const REPLY = ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v3'];
const CLOSE = ['M6 6l12 12M18 6L6 18'];
const PENCIL = ['m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z'];

function glyph(paths, cls = 'i') {
  const svg = svgEl('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths) svg.append(svgEl('path', { d }));
  return svg;
}
const caret = () => { const g = glyph(CARET); g.classList.add('caret'); return g; };
const message = (e) => (e && typeof e === 'object' && 'message' in e ? e.message : String(e));
const show = (node, on) => { node.hidden = !on; };
// 8 色の名前（作る順: 青 → 橙 → 緑 → 桃 → 紫 → 黄 → 青緑 → 赤。ADR 0362）
// i18n-dynamic: channels:bot.color.
const COLOR_NAMES = ['blue', 'orange', 'green', 'pink', 'purple', 'yellow', 'teal', 'red'].map((k) => `channels:bot.color.${k}`);
/** 8 色の見本（作る 3 段の 2 段目と、bot のページの顔の面で同じもの）。押した色を onPick に渡す */
function swatches(current, onPick) {
  const box = el('div', 'bp-swatches');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', t('channels:bot.color.title'));
  for (let c = 1; c <= BOT_COLOR_COUNT; c++) {
    const b = el('button', 'bp-swatch');
    b.type = 'button';
    b.dataset.color = String(c);
    b.title = t(COLOR_NAMES[c - 1]);
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(c === current));
    b.append(botIcon({ color: c }, 'bp-swatch-face', 32));
    b.onclick = () => onPick(c);
    box.append(b);
  }
  return box;
}

export function createBotPage(host) {
  const body = document.getElementById('channelsBody');
  if (!body) return {};

  const S = {
    id: null,             // 見せている bot の id。'new' = 作る画面
    bot: null,            // bots.get の行（Bot + state）
    draft: null,          // 作る 3 段の下書き（M.newDraft）。{ step, name, color, persona }
    v: null,              // 今の backend の語彙 { modes, models, efforts }
    vocab: new Map(),     // backend → { modes, models, efforts: Map<model, efforts> }
    bots: new Map(),      // id → Bot（記憶の出どころの字に使う）
    channels: new Map(),  // id → Channel
    sessions: () => new Map((host.state?.sessions ?? []).map((s) => [s.id, s])),
    gone: false,
    connAsked: new Set(), // 接続先の候補（アカウント・互換）を読み始めた backend（host.conn.load。登録が変わったら捨てる）
    connDone: new Set(),  // 読み終えた backend（読み終えるまでは「削除された接続先」と見せない）
    quotaAsked: new Set(),// 面を開いている間に使用量を頼んだ backend（閉じたら忘れ、次に開いたとき読み直す）
    seq: 0,
    chain: Promise.resolve(),   // 保存を 1 本ずつ流す（続けて押しても順番を保つ）
  };
  // メインの頭（#channelsView > .top）は、ほかの面と同じ頭の行のまま使う。bot のページを見せている間は、題（汎用の「Channels」）の代わりに
  // bot の名前の欄、右に ⋮ を置く（docs/design-system.md「メインの頭」。承認済み（2026-11-26））。h2 は読み上げにだけ残す。
  // 流れの部品が show/hide で見出しを替える順（流れ → 自分）の後に付け外しする。頭は流れの有無で置き場所が動くので、その都度引く
  const topEl = () => document.getElementById('channelsPageTitle')?.closest('.top') ?? null;
  const navigate = (detail) => document.dispatchEvent(new CustomEvent('channels:show', { detail }));
  const vm = () => S.bot;
  const unlimited = () => M.foldersUnlimited(S.v?.modes?.[vm()?.mode]);

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'bot-page');
  root.id = 'botView';
  root.hidden = true;

  const av = el('button', 'bp-av');
  av.type = 'button';
  av.setAttribute('aria-label', t('channels:bot.iconLabel'));
  av.title = t('channels:bot.iconLabel');
  const avatar = el('span', 'bp-av-icon');
  const badge = el('span', 'bp-av-edit');
  badge.setAttribute('aria-hidden', 'true');
  badge.append(glyph(PENCIL));
  av.append(avatar, badge);
  // 顔を押すと 8 色の面（題「アイコン」。選ぶとすぐ bots.update の color）
  const colorPop = el('div', 'pop cpop bp-color-pop');
  colorPop.id = 'botColorPop';
  colorPop.setAttribute('role', 'dialog');
  colorPop.setAttribute('aria-label', t('channels:bot.iconTitle'));
  colorPop.hidden = true;
  const nameIn = el('input', 'bp-name');
  nameIn.id = 'botName';
  nameIn.type = 'text';
  nameIn.maxLength = 64;
  nameIn.autocomplete = 'off';
  nameIn.spellcheck = false;
  nameIn.setAttribute('aria-label', t('channels:bot.nameLabel'));
  nameIn.placeholder = t('channels:bot.namePlaceholder');
  const sub = el('div', 'bp-sub');
  const dmBtn = el('button', 'btn bp-dm');
  const moreBtn = el('button', 'btn btn-icon bp-more');
  moreBtn.innerHTML = moreIcon;   // 「…」は縦の 3 点（docs/design-system.md「「…」の形」。web/icons.mjs）
  moreBtn.type = 'button';
  moreBtn.title = t('channels:botDelete.more');
  moreBtn.setAttribute('aria-label', t('channels:botDelete.more'));
  moreBtn.setAttribute('aria-haspopup', 'menu');
  dmBtn.type = 'button';
  dmBtn.append(glyph(REPLY), t('channels:bot.openDm'));
  const idBox = el('div', 'bp-id');
  idBox.append(sub);
  // ページの頭（顔・所属と状態・［DM を開く］）。名前と ⋮ はメインの頭の行に置く（show で移し、hide で外す）
  const head = el('div', 'bp-head');
  head.append(av, idBox, el('span', 'bp-spacer'), dmBtn);
  const placeInTop = () => {
    const top = topEl();
    if (!top) return;
    top.classList.add('bot-top');
    top.querySelector(':scope > h2')?.after(nameIn);
    top.append(moreBtn);
  };
  const takeFromTop = () => {
    topEl()?.classList.remove('bot-top');
    nameIn.remove();
    moreBtn.remove();
  };

  // 作る 3 段（名前 → 色 → 人格）。右の面の中ほどに置く。段は点で示す（ADR 0362）
  const obFace = el('div', 'bp-ob-face');
  const obDots = el('div', 'bp-ob-dots');
  obDots.setAttribute('aria-hidden', 'true');
  obDots.append(el('i'), el('i'), el('i'));
  const obStep = el('div', 'bp-ob-step');
  const obErr = el('p', 'bp-err');
  obErr.setAttribute('role', 'alert');
  obErr.hidden = true;
  const ob = el('div', 'bp-ob');
  ob.hidden = true;
  ob.append(obFace, el('h3', 'bp-ob-t', t('channels:side.newBot')), obDots, obStep, obErr);

  const err = el('p', 'bp-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  // 選んだ接続先が消えた・使えない（入力欄の上の一文と同じ文。保存の失敗とは別に、直すまで出したままにする）
  const connWarn = el('p', 'bp-err bp-conn-warn');
  connWarn.setAttribute('role', 'status');
  connWarn.hidden = true;
  const notice = el('p', 'bp-gone');
  notice.tabIndex = -1;
  notice.hidden = true;

  // 人格
  const persona = el('textarea', 'bp-persona');
  persona.id = 'botPersona';
  persona.rows = 3;
  persona.maxLength = 6000;
  persona.spellcheck = false;
  persona.setAttribute('aria-label', t('channels:bot.persona.label'));
  persona.placeholder = t('channels:bot.persona.placeholder');
  const personaBlk = el('div', 'bp-blk');
  personaBlk.append(el('h4', null, t('channels:bot.persona.title')), persona);

  // 動かし方: モデルと承認モードのチップ（入力欄と同じ面）
  const modelName = el('span', 'v');
  const modelChip = el('button', 'chip fieldish model');
  modelChip.type = 'button';
  modelChip.id = 'botModelChip';
  modelChip.append(glyph(MODEL), modelName, caret());
  const modelPop = el('div', 'pop cpop');
  modelPop.id = 'botModelPop';
  modelPop.setAttribute('role', 'dialog');
  modelPop.setAttribute('aria-label', t('chat.composer.model'));
  modelPop.hidden = true;
  const modeName = el('span', 'v');
  const shield = glyph(SHIELD);
  const warn = glyph(WARN);
  const modeChip = el('button', 'chip fieldish mode');
  modeChip.type = 'button';
  modeChip.id = 'botModeChip';
  modeChip.append(shield, modeName, caret());
  const modePop = el('div', 'pop cpop');
  modePop.id = 'botModePop';
  modePop.setAttribute('role', 'dialog');
  modePop.setAttribute('aria-label', t('chat.composer.mode'));
  modePop.hidden = true;
  const chips = el('div', 'bp-kvr bp-chips');
  chips.append(modelChip, modeChip);
  const lockNote = el('span', 'bp-locknote');
  const lockText = document.createTextNode(t('channels:bot.modeHumanOnly'));
  lockNote.append(glyph(LOCK), lockText);
  const modeFact = el('p', 'bp-nt bp-fact');
  modeFact.hidden = true;

  // フォルダー
  const folderTitle = el('h4', 'bp-h-folders', t('channels:bot.folders.title'));
  const folderBox = el('div', 'bp-folders');
  const addBtn = el('button', 'btn bp-addfolder');
  addBtn.type = 'button';
  addBtn.id = 'botAddFolder';
  addBtn.append(glyph(FOLDER_ADD), t('channels:bot.folders.add'));
  const addPop = el('div', 'pop cpop');
  addPop.id = 'botFolderPop';
  addPop.setAttribute('role', 'dialog');
  addPop.setAttribute('aria-label', t('channels:bot.folders.add'));
  addPop.hidden = true;
  const folderNote = el('p', 'bp-locknote bp-folder-note');
  folderNote.hidden = true;

  // 他の会話に送る（畳んだ行の中身。題は行の見出し。ADR 0358）
  const sw = el('button', 'bp-sw');
  sw.type = 'button';
  sw.id = 'botSendSwitch';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('channels:bot.send.label'));
  const sendRow = el('div', 'bp-kvr bp-send');
  sendRow.append(el('span', 'k', t('channels:bot.send.label')), sw);

  const runBlk = el('div', 'bp-blk');
  const runHead = el('h4', null, t('channels:bot.run.title'));
  let removingTarget = false;
  const sendTargets = el('div', 'bp-send-targets');
  sendTargets.setAttribute('aria-label', t('channels:bot.send.targets'));
  runBlk.append(runHead, chips, lockNote, modeFact, folderTitle, folderBox, folderNote, addBtn);

  // 記憶・使用量
  const memory = createMemoryList(host, {
    lookup: () => ({ channels: S.channels, bots: S.bots, sessions: S.sessions() }),
    openSource: (target) => {
      if (target.sessionId) host.openSession?.(target.sessionId);
      else navigate({ kind: 'channel', id: target.channelId, ...(target.threadId ? { threadId: target.threadId } : {}), ...(target.postId ? { postId: target.postId } : {}) });
    },
  });
  const routinesSlot = el('div', 'bp-frow-slot');
  routinesSlot.id = 'botRoutinesSlot';
  const activity = el('button', 'bp-sw');
  activity.type = 'button';
  activity.setAttribute('role', 'switch');
  const activityName = t('channels:bot.brain.activity');
  activity.setAttribute('aria-label', activityName);
  const activityRow = el('div', 'bp-kvr bp-activity');
  activityRow.append(el('span', 'k', activityName), activity);
  const every = el('select', 'mem-control');
  const intervalName = t('channels:bot.brain.activityInterval');
  every.setAttribute('aria-label', intervalName);
  const intervalRow = el('div', 'bp-kvr bp-activity');
  intervalRow.append(el('span', 'k', intervalName), every);
  const openMemory = el('button', 'btn link', t('channels:bot.memory.open'));
  openMemory.type = 'button';
  openMemory.onclick = () => { memHead.focus({ preventScroll: true }); memHead.scrollIntoView({ block: 'start' }); };
  const foldBlk = el('div', 'bp-blk bp-folds');
  foldBlk.append(sendRow, sendTargets, activityRow, intervalRow, openMemory, routinesSlot);
  let activitySeq = 0;
  let paused = null;
  function paintActivity() {
    const pulse = S.bot?.pulse;
    activity.disabled = !pulse || paused == null;
    activity.setAttribute('aria-checked', String(pulse?.on === true && paused === false));
    const value = pulse?.everyMin ?? 10;
    const minutes = [...new Set([5, 10, 15, 30, 60, value])].sort((a, b) => a - b);
    every.replaceChildren(...minutes.map((n) => {
      const option = el('option', null, t('channels:bot.brain.intervalMin', { n }));
      option.value = String(n);
      return option;
    }));
    every.value = String(value);
  }
  async function loadActivity() {
    if (!S.bot || S.bot.plain) return;
    const botId = S.bot.id;
    const seq = ++activitySeq;
    try {
      const value = await host.invoke('brain.view', { botId, limit: 1 });
      if (seq === activitySeq && S.bot?.id === botId) { paused = Boolean(value.status?.paused); paintActivity(); }
    } catch { /* 設定を読めない間は操作を止める */ }
  }
  every.onchange = () => update({ pulse: { everyMin: Number(every.value) } });
  activity.onclick = async () => {
    const botId = S.bot?.id;
    if (!botId || activity.disabled) return;
    const on = activity.getAttribute('aria-checked') !== 'true';
    activity.disabled = true;
    if (!on || !S.bot.pulse.on) await update({ pulse: { on } });
    if (on && paused && S.bot?.id === botId && S.bot.pulse.on) {
      try { await host.invoke('brain.pause', { botId, paused: false }); }
      catch (error) { setError(t('channels:bot.saveFailed', { error: message(error) })); }
    }
    if (S.bot?.id === botId) await loadActivity();
  };
  const memHead = el('h4', null, t('channels:bot.memory.title'));
  memHead.tabIndex = -1;
  const memBlk = el('div', 'bp-blk bp-memory');
  memBlk.append(memHead, memory.el);

  const left = el('div', 'bp-col');
  left.append(personaBlk, runBlk);
  const right = el('div', 'bp-col');
  right.append(foldBlk, memBlk);
  const grid = el('div', 'bp-grid');
  grid.append(left, right);
  root.append(head, ob, err, connWarn, notice, grid, modelPop, modePop, addPop, colorPop);
  body.append(root);

  // ---------------------------------------------------------------- 浮く面（入力欄と同じ。チップは画面の途中にあるので、広い方（なるべく下）に置き直す）
  const place = (p) => {
    const base = p.place.bind(p);
    p.place = () => {
      if (p.pop.hidden) return;
      base();
      const r = p.chip.getBoundingClientRect();
      const above = r.top - 12;
      const below = window.innerHeight - r.bottom - 14;
      if (below >= 400 || below > above) {
        p.pop.style.bottom = 'auto';
        p.pop.style.top = `${Math.round(r.bottom + 6)}px`;
        p.pop.style.maxHeight = `${Math.max(160, Math.round(below))}px`;
      } else p.pop.style.top = 'auto';
    };
    return p;
  };
  // 使用量はホストの 1 本の取得口（usageSource）を購読する。新しい値が届いたら開いている面を描き直す
  host.onUsage?.(() => { if (modelPanel.open) { modelPanel.render(); modelPanel.place(); } });
  const modelPanel = place(panel(modelChip, modelPop, { width: 360, onHide: () => S.quotaAsked.clear(),
    render: () => { askQuota(); askConn(); renderModel({ pop: modelPop, target: modelTarget(), on: modelOn, hide: (f) => modelPanel.hide(f) }); } }));
  const modePanel = place(panel(modeChip, modePop, { width: 360, align: 'right', render: paintModePop }));
  const addPanel = place(panel(addBtn, addPop, { width: 360, render: renderAddPop, when: () => !unlimited(), onHide: () => { addPop.replaceChildren(); } }));
  const colorPanel = place(panel(av, colorPop, { width: 212, initialFocus: '[aria-pressed="true"]', render: () => {
    colorPop.replaceChildren(el('h4', 'bp-color-t', t('channels:bot.iconTitle')), swatches(S.bot?.color, (c) => { colorPanel.hide(); if (c !== S.bot?.color) update({ color: c }); }));
  } }));
  const closePanels = () => { modelPanel.hide(false); modePanel.hide(false); addPanel.hide(false); colorPanel.hide(false); };

  // ---------------------------------------------------------------- 語彙（バックエンドごとの承認モード・モデル・エフォート）
  /** bot が走る作業場所（最初のフォルダー。core/bots/sessions.mjs の pickCwd）。モデルの一覧・段はその場所のプロジェクト設定で変わる */
  const botCwd = (b) => b?.folders?.[0]?.path ?? '';
  async function vocabOf(backend, model = '', cwd = '', account = '', endpoint = '') {
    // 互換の接続先で動く bot はアカウントを使わない（サーバーは接続先を先に見る）。モデルの一覧は接続先の行（面の compatModelView）が持つので取らない。段は接続先の段
    const acct = endpoint ? '' : account;
    const key = JSON.stringify([backend, acct, cwd, endpoint]);
    let v = S.vocab.get(key);
    if (!v) {
      const [modes, models] = await Promise.all([
        host.cmd('modes', { backend }).catch(() => ({})),
        endpoint ? {} : host.cmd('models', { backend, ...(acct ? { account: acct } : {}), ...(cwd ? { cwd } : {}) }).catch(() => ({})),
      ]);
      v = { modes: modes ?? {}, models: models ?? {}, efforts: new Map() };
      if (Object.keys(v.modes).length && (endpoint || Object.keys(v.models).length)) S.vocab.set(key, v);
    }
    if (!v.efforts.has(model)) {
      const efforts = await host.cmd('efforts', { backend, model, cwd: cwd || undefined, ...(endpoint ? { endpoint } : acct ? { account: acct } : {}) }).catch(() => ({ '': { label: t('chat.next.useDefault') } }));
      v.efforts.set(model, efforts ?? {});
    }
    return { modes: v.modes, models: v.models, efforts: v.efforts.get(model) };
  }
  /** 今の bot（か下書き）の語彙を読み、読み終えたら描き直す。読んでいる間に替わっていたら捨てる */
  async function loadVocab() {
    const cur = vm();
    if (!cur) return;
    const seq = ++S.seq;
    const v = await vocabOf(cur.backend, cur.model ?? '', botCwd(cur), cur.account ?? '', cur.endpoint ?? '');
    if (seq !== S.seq) return;
    S.v = v;
    paintRun();
  }
  const backends = () => host.state?.backends ?? [];
  const backendLabel = (id) => backends().find((b) => b.id === id)?.label ?? id;

  // ---------------------------------------------------------------- bot の接続先（ADR 0224・0359）
  // 入力欄・子の会話のモーダルと同じ部品（web/composer-controls.mjs の「接続先」の行と一覧）。候補はホストの 1 つの取得口（host.conn）から読む
  const caps = (backend) => backends().find((b) => b.id === backend)?.capabilities ?? {};
  /** 接続先を選べるエージェントか（アカウントを使える・互換の接続先を持てる） */
  const takesConn = (backend) => Boolean(caps(backend).accounts || caps(backend).compatEndpoints);
  /** そのエージェントの接続先の候補（アカウント・互換）を読む。読み終えたら描き直す（開いている面も）。読んでいる最中・読み終えたものは読まない */
  function connLoad(backend) {
    if (!host.conn || !backend || !takesConn(backend) || S.connAsked.has(backend)) return;
    S.connAsked.add(backend);
    Promise.resolve(host.conn.load(backend)).catch(() => {}).finally(() => {
      S.connDone.add(backend);
      if (!vm()) return;
      if (vm().backend === backend) paintRun();
      // 面を開いた後に届いたら、行を足して描き直す（使用量が届いたときと同じ）
      if (modelPanel.open) { modelPanel.render(); modelPanel.place(); }
    });
  }
  /** モデルの面を描くとき、一覧のほかのエージェントの登録も読んでおく（棒を出すかの判定） */
  function askConn() { for (const b of backends()) connLoad(b.id); }
  /**
   * 今の bot（か下書き）の接続先の見え方。入力欄の面と同じ 2 つの口（アカウントの候補・互換の接続先の値）。bot なし（組み込み）には出さない。
   * 「既定」の札は新しい会話の既定の印なので外す。互換を選んでいる間は、アカウントの選び（別に覚えている）を見せない
   */
  function connView() {
    const cur = vm();
    if (!cur || cur.plain || !host.conn) return { accounts: null, endpoint: null };
    const plain = (o) => ({ ...o, isDefault: false });
    const accounts = host.conn.accounts(cur.backend, cur.endpoint ? '' : cur.account ?? '');
    const endpoint = host.conn.endpointView(cur.backend, cur.endpoint ?? '');
    return { accounts: accounts ? accounts.map(plain) : null, endpoint: endpoint ? { ...endpoint, options: endpoint.options.map(plain) } : null };
  }
  const connDone = () => S.connDone.has(vm()?.backend);
  /** チップと見出しに添える接続先の名前（CLI のログイン＝既定と、まだ読んでいないときは出さない） */
  function connName() {
    const cur = vm();
    if (!cur || cur.plain || !connDone()) return '';
    const view = connView();
    if (cur.endpoint) return view.endpoint?.row?.name ?? t('chat.endpoint.deleted');
    if (!cur.account || !view.accounts) return '';
    const chosen = view.accounts.find((a) => a.value === cur.account);
    return chosen && !chosen.gone ? chosen.label : t('chat.endpoint.deleted');
  }
  /** 選んだ接続先が消えた・使えない（アカウントのトークン・資格情報が無い・互換の確認に失敗）ときの一文（入力欄と同じ文） */
  function connWarning() {
    const cur = vm();
    if (!cur || cur.plain || !connDone()) return '';
    const view = connView();
    if (cur.endpoint) {
      const row = view.endpoint?.row;
      return !row ? t('chat.endpoint.deletedWarning') : row.ready === false ? t('chat.endpoint.failedWarning', { name: row.name }) : '';
    }
    if (!cur.account || !view.accounts) return '';
    const chosen = view.accounts.find((a) => a.value === cur.account);
    return !chosen || chosen.gone ? t('chat.endpoint.deletedWarning') : chosen.warn ? t('chat.account.noTokenWarning', { name: chosen.label }) : '';
  }
  function paintConnWarn() {
    const text = connWarning();
    connWarn.textContent = text;
    show(connWarn, Boolean(text) && !S.gone);
  }
  /** 互換の接続先で動く bot の行（読む前・消えているときは null） */
  const endpointRowOf = () => (vm()?.endpoint ? connView().endpoint?.row ?? null : null);
  /** モデルの表示名（互換は接続先の表示名。web/compat-models.mjs） */
  function modelText(cur) {
    const row = endpointRowOf();
    if (row) return compatModelLabel(cur.model || row.roles?.main || '').text;
    return S.v ? resolvedModel(S.v.models, cur.model ?? '').label : '';
  }
  /** モデルの面を開いている間に 1 度ずつ、エージェントの使用量を読みに行く（アカウントの行とエージェントの行の週の使用量。結果は host.onUsage の購読で届き、面を描き直す） */
  function askQuota() {
    if (typeof host.quota !== 'function') return;
    for (const b of backends()) {
      if (S.quotaAsked.has(b.id)) continue;
      S.quotaAsked.add(b.id);
      Promise.resolve(host.quota(b.id)).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 描画
  function paintHead() {
    const cur = vm();
    if (!cur) return;
    paintAvatar();
    if (document.activeElement !== nameIn) nameIn.value = cur.name ?? '';
    // 「Claude · Opus 5.5 · 作業中」
    const parts = [];
    if (cur.backend) {
      parts.push(backendLogo(cur.backend, backendLabel(cur.backend)));
      const model = modelText(cur);
      parts.push(document.createTextNode(`${backendLabel(cur.backend)}${model ? ` · ${model}` : ''}`));
      // CLI のログインでない接続先（アカウント・互換）で動くなら、その名前（「Claude Code · Opus 5.5 · OZ · 待機」）
      const conn = connName();
      if (conn) parts.push(document.createTextNode(' · '), el('span', 'conn-sub', conn));
    }
    if (!S.draft && S.bot) {
      parts.push(el('span', 'dot', '·'));
      if (S.bot.state === 'working') parts.push(runMark(t('channels:bot.state.working')), document.createTextNode(t('channels:bot.state.working')));
      else if (S.bot.state === 'waiting') parts.push(el('span', 'wait', t('channels:bot.state.waiting')));
      // 使用量の上限で休んでいる（ADR 0119）。解除の時刻は見出しの title に
      else if (Number(S.bot.restingUntil) > Date.now()) {
        const rest = el('span', null, t('channels:bot.state.resting'));
        rest.title = t('channels:bot.state.restingUntil', { time: new Date(S.bot.restingUntil).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
        parts.push(rest);
      }
      else parts.push(document.createTextNode(t('channels:bot.state.idle')));
    }
    sub.replaceChildren(...parts);
    dmBtn.disabled = !S.bot?.dmChannelId;
  }

  function paintChips() {
    const cur = vm();
    if (!cur) return;
    const v = S.v;
    // 互換の接続先は入力欄と同じ「接続先 · モデル · 段」。CLI のログインでないアカウントは、チップの末尾に名前（「Opus 5.5 · high · OZ」）。読み上げと title にも入れる
    const row = endpointRowOf();
    let head, tail, full, conn = '';
    if (row) {
      const m = compatModelLabel(cur.model || row.roles?.main || '');
      ({ head, tail, full } = endpointChipLabel({ connection: row.name, model: m.text, fullModel: m.id, effort: effortStops(v?.efforts, cur.effort ?? '').current }));
    } else {
      const label = v ? modelChipLabel(v.models, cur.model ?? '', v.efforts, cur.effort ?? '') : cur.model || '…';
      ({ head, tail } = splitChipLabel(label));
      conn = connName();
      full = conn ? `${label} · ${conn}` : label;
    }
    modelName.classList.add('split');
    modelName.replaceChildren(el('span', 'mn', head), ...(tail ? [el('span', 'ef', tail)] : []), ...(conn ? [el('span', 'ef conn-chip', ` · ${conn}`)] : []));
    modelChip.title = t('composer.model.chipTitle', { label: full });
    modelChip.setAttribute('aria-label', t('composer.model.chipAria', { label: full }));
    // 接続先も人だけが変えられる（bots.setAccount）。行を出しているときだけ注記に足す
    const view = connView();
    lockText.data = connShown({ accounts: view.accounts, account: cur.account ?? '', endpoint: view.endpoint }) ? t('channels:bot.modeAccountHumanOnly') : t('channels:bot.modeHumanOnly');
    paintConnWarn();
    modelChip.dataset.value = cur.model ?? '';
    modelChip.dataset.backend = cur.backend ?? '';
    const m = v?.modes?.[cur.mode];
    const danger = isDanger(m);
    modeName.replaceChildren(el('span', 'full', m?.label ?? cur.mode ?? ''));
    const icon = danger ? warn : shield;
    if (modeChip.firstChild !== icon) modeChip.firstChild.replaceWith(icon);
    modeChip.classList.toggle('danger', danger);
    modeChip.title = danger ? t('composer.mode.dangerTitle') : t('chat.composer.mode');
    modeChip.setAttribute('aria-label', danger ? t('composer.mode.chipAriaDanger', { mode: m?.label ?? cur.mode ?? '' }) : t('composer.mode.chipAria', { mode: m?.label ?? cur.mode ?? '' }));
    modeChip.dataset.value = cur.mode ?? '';
    // 承認モードが 1 つしか選べないバックエンド（Antigravity）は、事実を 1 行添える
    const only = v ? M.onlyMode(v.modes) : null;
    show(modeFact, Boolean(only));
    if (only) modeFact.textContent = t('channels:bot.modeOnly', { backend: backendLabel(cur.backend), mode: v.modes[only]?.label ?? only });
    // 開いている面も描き直す（語彙が届いた・選んだ直後）
    for (const p of [modelPanel, modePanel]) if (p.open) { p.render(); p.place(); }
  }

  function folderRow(f, disabled) {
    const row = el('div', 'bp-fold');
    row.dataset.path = f.path;
    const p = el('span', 'p', f.path);
    p.title = f.path;
    const acc = el('button', 'bp-fold-acc', f.access === 'rw' ? t('channels:bot.folders.rw') : t('channels:bot.folders.ro'));
    acc.type = 'button';
    acc.title = t('channels:bot.folders.toggle');
    acc.setAttribute('aria-label', t('channels:bot.folders.toggleAria', { path: f.path, access: acc.textContent }));
    acc.disabled = disabled;
    acc.onclick = () => update({ folders: M.toggleAccess(S.bot.folders, f.path) });
    const rm = el('button', 'bp-fold-rm');
    rm.type = 'button';
    rm.append(glyph(CLOSE));
    rm.title = t('channels:bot.folders.remove');
    rm.setAttribute('aria-label', t('channels:bot.folders.removeAria', { path: f.path }));
    rm.disabled = disabled;
    rm.onclick = () => update({ folders: M.removeFolder(S.bot.folders, f.path) });
    row.append(glyph(FOLDER), p, acc, rm);
    return row;
  }

  function paintFolders() {
    const cur = vm();
    if (!cur) return;
    const lim = unlimited();
    const rows = (cur.folders ?? []).map((f) => folderRow(f, lim));
    folderBox.classList.toggle('all', lim);
    if (lim) {
      const all = el('div', 'bp-fold allf');
      all.append(glyph(FOLDER), el('span', 'p all-name', t('channels:bot.folders.all')));
      const off = el('div', 'folders-off');
      off.setAttribute('aria-disabled', 'true');
      off.append(...rows);
      folderBox.replaceChildren(all, ...(rows.length ? [off] : []));
      folderNote.textContent = t('channels:bot.folders.unlimited', { mode: S.v?.modes?.[cur.mode]?.label ?? cur.mode });
    } else {
      folderBox.replaceChildren(...(rows.length ? rows : [el('p', 'bp-empty', t('channels:bot.folders.none'))]));
    }
    show(folderNote, lim);
    addBtn.disabled = lim;
    if (lim) addPanel.hide(false);
  }

  function paintSend() {
    const cur = vm();
    if (!cur) return;
    sw.setAttribute('aria-checked', String(cur.sendToOthers !== false));
    paintActivity();
    sendTargets.replaceChildren();
    show(sendTargets, Boolean(cur.sendTargets?.length));
    if (!cur.sendTargets?.length) return;
    sendTargets.append(el('h3', 'bp-send-title', t('channels:bot.send.targets')));
    const details = new Map((cur.sendTargetDetails ?? []).map((row) => [row.sessionId, row]));
    for (const id of cur.sendTargets) {
      const detail = details.get(id);
      const title = detail?.title || id;
      const row = el('div', 'bp-send-target');
      const open = el('button', 'btn bp-send-open', title);
      open.type = 'button'; open.title = id;
      open.onclick = () => host.openSession(id);
      const source = detail?.source === 'shown' ? t('channels:bot.send.shown')
        : detail?.source === 'created' ? t('channels:bot.send.created') : t('channels:bot.send.manual');
      const info = el('div', 'bp-send-info');
      info.append(open, el('span', 'bp-nt', source));
      const remove = el('button', 'btn btn-quiet', t('channels:bot.send.remove'));
      remove.type = 'button';
      remove.setAttribute('aria-label', t('channels:bot.send.removeLabel', { title }));
      remove.disabled = removingTarget;
      remove.onclick = async () => {
        if (removingTarget) return;
        removingTarget = true;
        for (const button of sendTargets.querySelectorAll('.btn-quiet')) button.disabled = true;
        try { await update({ sendTargets: S.bot.sendTargets.filter((target) => target !== id) }); }
        finally { removingTarget = false; paintSend(); }
      };
      row.append(info, remove); sendTargets.append(row);
    }
  }

  function paintRun() {
    connLoad(vm()?.backend);
    paintChips();
    paintHead();
    paintFolders();
    paintSend();
  }

  function paintAll() {
    const creating = Boolean(S.draft);
    root.classList.toggle('is-new', creating);
    root.classList.toggle('is-gone', S.gone);
    show(ob, creating);
    show(notice, S.gone);
    show(grid, !S.gone && !creating);
    show(head, !S.gone && !creating);
    show(nameIn, !S.gone && !creating);
    show(moreBtn, !S.gone && !creating && !S.bot?.plain);
    if (creating) { memory.setBot(null); paused = null; paintOb(); return; }
    const cur = vm();
    if (cur && document.activeElement !== persona) persona.value = cur.persona ?? '';
    growPersona();
    paintRun();
    memory.setBot(S.bot ?? null);
    loadActivity();
  }

  const growPersona = () => {
    persona.style.height = 'auto';
    persona.style.height = `${Math.min(persona.scrollHeight + 2, 480)}px`;
  };

  const setError = (text) => { err.textContent = text; show(err, Boolean(text)); };

  // ---------------------------------------------------------------- 保存
  /** bots.get の行を取り込む（自分の画面の bot なら描き直す） */
  function applyBot(bot) {
    S.bots.set(bot.id, bot);
    if (S.id !== bot.id) return;
    S.bot = { ...S.bot, ...bot };
    paintAll();
    loadVocab();
  }

  /** 保存を 1 本ずつ流す。失敗は理由を出して、入力欄を保存済みの値に戻す */
  function queue(task) {
    const run = S.chain.catch(() => {}).then(task);
    S.chain = run;
    return run;
  }

  async function update(patch) {
    if (S.draft) return;
    const botId = S.id;
    setError('');
    await queue(async () => {
      try {
        const bot = await host.invoke('bots.update', { botId, ...patch });
        if (S.id === botId) applyBot(bot);
      } catch (e) {
        if (S.id === botId) { setError(t('channels:bot.saveFailed', { error: message(e) })); paintAll(); }
      }
    });
  }

  async function setMode(mode) {
    if (S.draft) return;
    const botId = S.id;
    setError('');
    await queue(async () => {
      try {
        const bot = await host.invoke('bots.setMode', { botId, mode });
        if (S.id === botId) applyBot(bot);
      } catch (e) {
        if (S.id === botId) { setError(t('channels:bot.saveFailed', { error: message(e) })); paintAll(); }
      }
    });
  }

  /**
   * bot の接続先を変える（人だけ。bots.setAccount）。互換の接続先を選ぶ（endpoint）か、CLI のログイン（account ''）・アカウント（endpoint '' で公式へ戻す）。
   * 接続先を変えるとモデル・エフォートは既定へ戻る（サーバーと同じ。互換のモデルは公式では通らない）。作る 3 段には接続先の欄が無い（作った後に bot のページで選ぶ。ADR 0362）
   */
  async function setConn({ endpoint = '', account = '' }) {
    if (S.draft) return;
    const botId = S.id;
    setError('');
    await queue(async () => {
      try {
        const bot = await host.invoke('bots.setAccount', { botId, account, endpoint });
        if (S.id === botId) applyBot(bot);
      } catch (e) {
        if (S.id === botId) { setError(t('channels:bot.saveFailed', { error: message(e) })); paintAll(); }
      }
    });
  }

  // ---------------------------------------------------------------- 作る 3 段（名前 → 色 → 人格。ADR 0362）
  let createBusy = false;
  const obButton = (label, primary, onClick) => {
    const b = el('button', primary ? 'btn btn-primary' : 'btn', label);
    b.type = 'button';
    b.onclick = onClick;
    return b;
  };
  /** 段を描き直す。段が変わったら（focus = true）その段の入力へカーソルを置く */
  function paintOb(focus = false) {
    const d = S.draft;
    if (!d) return;
    obFace.replaceChildren(botIcon(d, 'bp-ob-av', 32));
    obDots.querySelectorAll('i').forEach((dot, i) => dot.classList.toggle('on', i === d.step - 1));
    const actions = el('div', 'bp-ob-actions');
    let first = null;
    if (d.step === 1) {
      const input = el('input', 'bp-ob-in');
      input.id = 'botObName';
      input.type = 'text';
      input.maxLength = 64;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = t('channels:bot.namePlaceholder');
      input.value = d.name;
      const next = obButton(t('channels:bot.onboard.next'), true, () => go(2));
      next.disabled = !d.name.trim();
      input.addEventListener('input', () => { d.name = input.value; next.disabled = !d.name.trim(); });
      input.addEventListener('keydown', (e) => {
        if (isComposingKey(e) || e.key !== 'Enter') return;
        e.preventDefault();
        if (d.name.trim()) go(2);
      });
      const label = el('label', 'bp-ob-l', t('channels:bot.nameLabel'));
      label.htmlFor = input.id;
      actions.append(next);
      obStep.replaceChildren(label, input, actions);
      first = input;
    } else if (d.step === 2) {
      const pick = swatches(d.color, (c) => { d.color = c; paintOb(); obStep.querySelector(`[data-color="${c}"]`)?.focus(); });
      actions.append(obButton(t('channels:bot.onboard.back'), false, () => go(1)), obButton(t('channels:bot.onboard.next'), true, () => go(3)));
      obStep.replaceChildren(el('span', 'bp-ob-l', t('channels:bot.color.title')), pick, actions);
      first = pick.querySelector('[aria-pressed="true"]');
    } else {
      const area = el('textarea', 'bp-ob-in bp-ob-persona');
      area.id = 'botObPersona';
      area.rows = 4;
      area.maxLength = 6000;
      area.spellcheck = false;
      area.placeholder = t('channels:bot.persona.placeholder');
      area.value = d.persona;
      area.addEventListener('input', () => { d.persona = area.value; });
      const label = el('label', 'bp-ob-l', t('channels:bot.persona.label'));
      label.htmlFor = area.id;
      const make = obButton(t('channels:bot.createButton'), true, create);
      make.classList.add('bp-create');
      make.disabled = createBusy;
      actions.append(obButton(t('channels:bot.onboard.back'), false, () => go(2)), make);
      obStep.replaceChildren(label, area, actions);
      first = area;
    }
    if (focus) first?.focus();
  }
  function go(step) {
    if (!S.draft || createBusy) return;
    S.draft.step = step;
    obErr.hidden = true;
    paintOb(true);
  }

  async function create() {
    const d = S.draft;
    if (!d || createBusy) return;
    const name = d.name.trim();
    if (!name) { go(1); return; }
    obErr.hidden = true;
    createBusy = true;
    paintOb();
    try {
      // エージェント・モデル・承認モードは既定（エージェントは今の入力欄のもの。後から bot のページで変える）
      const backend = backends().find((b) => b.id === host.state?.backendId)?.id ?? backends()[0]?.id;
      const bot = await host.invoke('bots.create', { name, color: d.color, ...(backend ? { backend } : {}), ...(d.persona.trim() ? { persona: d.persona } : {}) });
      S.bots.set(bot.id, bot);
      // 作った後は話しかける場面（DM）を開く。入力欄へのカーソルは DM の流れが開くときに置く（feed.mjs の show）。DM がまだ無ければ bot のページ
      navigate(bot.dmChannelId ? { kind: 'channel', id: bot.dmChannelId } : { kind: 'bot', id: bot.id });
    } catch (e) {
      if (S.draft === d) { obErr.textContent = t('channels:bot.createFailed', { error: message(e) }); obErr.hidden = false; }
    } finally {
      createBusy = false;
      if (S.draft === d) paintOb();
    }
  }

  const modelOn = {
    backend: (id) => update({ backend: id }),
    model: (id) => update({ model: id }),
    effort: (v) => update({ effort: v }),
    // 互換の接続先を選ぶ（アカウントの選びは別に覚えたまま）／CLI のログイン・アカウントを選ぶ（互換は外れて公式へ戻る）
    endpoint: (id) => setConn({ endpoint: id, account: vm()?.account ?? '' }),
    conn: ({ endpoint, account }) => setConn({ endpoint, account }),
  };
  function modelTarget() {
    const cur = vm();
    const v = S.v ?? { modes: {}, models: {}, efforts: {} };
    const view = connView();
    return {
      backends: backends(), backend: cur.backend, backendSwitchable: backends().length > 1,
      backendUsage: (id) => weekUsage(host.usageOf?.(id)?.quota, ''),
      // 一覧のほかのエージェントがアカウントを登録しているか（今のエージェントは accounts・endpoint で決まる。composer-labels.mjs の agentRowUsage）
      backendHasAccounts: (id) => Boolean(host.conn?.hasAccounts(id)),
      agentView: (id) => host.agentView?.(id) ?? null,
      models: v.models, model: cur.model ?? '',
      efforts: v.efforts, effort: cur.effort ?? '', effortDisabled: Object.keys(v.efforts ?? {}).length <= 1,
      ...(view.accounts ? { accounts: view.accounts, account: cur.account ?? '' } : {}),
      ...(view.endpoint ? { endpoint: view.endpoint } : {}),
    };
  }
  function paintModePop() {
    const cur = vm();
    renderMode({ pop: modePop, target: { mode: cur.mode, modes: S.v?.modes ?? {} }, on: { mode: (id) => setMode(id) }, hide: () => modePanel.hide() });
  }

  // ---------------------------------------------------------------- フォルダーを足す
  async function addPath(path) {
    await update({ folders: M.addFolder(S.bot.folders ?? [], path) });
  }
  function renderAddPop() {
    const input = el('input', 'cpath');
    input.placeholder = t('channels:bot.folders.placeholder');
    input.setAttribute('aria-label', t('channels:bot.folders.inputLabel'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    const wrap = el('div', 'cpath-wrap');
    wrap.append(input);
    const msg = el('p', 'cerr');
    msg.setAttribute('role', 'alert');
    const box = el('div', 'cbrowse');
    box.hidden = true;
    const done = async (path) => { addPanel.hide(); await addPath(path); };
    const check = async (value) => {
      const v = value.trim();
      if (!v) return;
      msg.textContent = '';
      try { const r = await host.cmd('listDirs', { path: v }); await done(r.path || v); }
      catch (e) { msg.textContent = e.code === 'ENOENT' ? t('composer.cwd.notFound') : message(e); input.setAttribute('aria-invalid', 'true'); }
    };
    input.addEventListener('keydown', (e) => { if (isComposingKey(e) || e.key !== 'Enter') return; e.preventDefault(); check(input.value); });
    input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); msg.textContent = ''; });
    const browse = folderBrowser({ cmd: (c, a) => host.cmd(c, a), box, err: msg, onChoose: (p) => done(p), closed: () => addPop.hidden });
    const pick = el('button', 'caction');
    pick.type = 'button';
    pick.append(glyph(FOLDER_ADD), el('span', null, t('composer.cwd.choose')));
    pick.onclick = async () => {
      msg.textContent = '';
      if (window.plyDesktop?.chooseFolder) {
        const picked = await window.plyDesktop.chooseFolder().catch(() => null);
        const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
        if (chosen) await done(chosen);
        return;
      }
      browse('');
    };
    addPop.replaceChildren(wrap, pick, box, msg);
  }

  // ---------------------------------------------------------------- 入力
  function paintAvatar() {
    avatar.replaceChildren(botIcon(vm(), 'bp-av-face'));
  }

  const commitName = async () => {
    const cur = vm();
    const name = nameIn.value.trim();
    if (!cur || name === cur.name) { nameIn.value = cur?.name ?? ''; return; }
    if (!name) { nameIn.value = cur.name; return; }
    await update({ name });
    if (document.activeElement !== nameIn) nameIn.value = S.bot?.name ?? '';
  };
  nameIn.addEventListener('blur', commitName);
  nameIn.addEventListener('keydown', (e) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); nameIn.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameIn.value = vm()?.name ?? ''; nameIn.blur(); }
  });
  persona.addEventListener('input', growPersona);
  persona.addEventListener('blur', () => {
    const cur = vm();
    if (cur && persona.value !== (cur.persona ?? '')) update({ persona: persona.value });
  });
  sw.addEventListener('click', () => {
    if (S.draft || !S.bot) return;
    const next = S.bot.sendToOthers === false;
    sw.setAttribute('aria-checked', String(next));
    update({ sendToOthers: next });
  });
  dmBtn.addEventListener('click', () => { if (S.bot?.dmChannelId) navigate({ kind: 'channel', id: S.bot.dmChannelId }); });
  moreBtn.addEventListener('click', () => {
    const r = moreBtn.getBoundingClientRect();
    host.showMenu?.(r.left, r.bottom, [{ label: t('channels:botDelete.menu'), danger: true, onClick: () => host.deleteBot(S.bot, moreBtn) }], S.bot?.name);
  });

  // ---------------------------------------------------------------- 読み込み
  async function loadChannels() {
    try {
      const r = await host.invoke('channels.list', {});
      S.channels = new Map((r?.channels ?? []).map((c) => [c.id, c]));
      memory.repaint();
    } catch { /* 出どころの字が簡略になるだけ */ }
  }
  async function loadBots() {
    try {
      const r = await host.invoke('bots.list', {});
      for (const b of r?.bots ?? []) S.bots.set(b.id, b);
      if (S.id && S.id !== 'new' && S.bots.has(S.id)) S.bot = { ...S.bot, ...S.bots.get(S.id) };
    } catch { /* 同上 */ }
  }

  async function open(id) {
    closePanels();
    for (const d of root.querySelectorAll('details.bp-frow')) d.open = false;   // 畳んだ行は開き直すたびに閉じる
    if (S.id !== id) { paused = null; activitySeq++; }
    S.id = id;
    S.gone = false;
    S.v = null;
    S.seq += 1;
    setError('');
    if (id === 'new') {
      // 色は作った順に回すので、先に今の bot を読む（core の bots.create の nextColor と同じ選び方）
      S.bot = null;
      S.draft = M.newDraft([...S.bots.values()]);
      paintAll();
      paintOb(true);
      await loadBots();
      if (S.id !== 'new' || !S.draft || S.draft.step !== 1 || S.draft.name) return;
      S.draft.color = M.nextColor([...S.bots.values()]);
      paintOb(true);
      return;
    }
    S.draft = null;
    const have = S.bots.get(id) ?? null;
    S.bot = have;
    if (have) { paintAll(); loadVocab(); }
    try {
      const bot = await host.invoke('bots.get', { botId: id });
      if (S.id !== id) return;
      S.bot = bot;
      S.bots.set(id, bot);
      nameIn.value = bot.name;
      persona.value = bot.persona ?? '';
      paintAll();
      await loadVocab();
    } catch (e) {
      if (S.id !== id) return;
      S.gone = true;
      notice.textContent = e?.code === 'BOT_NOT_FOUND' ? t('channels:bot.notFound') : t('channels:bot.loadFailed', { error: message(e) });
      paintAll();
    }
    loadBots();
    loadChannels();
  }

  let refetch = null;
  const refetchSoon = () => {
    clearTimeout(refetch);
    refetch = setTimeout(async () => {
      const id = S.id;
      if (!id || id === 'new' || root.hidden) return;
      try { const bot = await host.invoke('bots.get', { botId: id }); if (S.id === id) applyBot(bot); }
      catch (e) { if (S.id === id && e?.code === 'BOT_NOT_FOUND') { S.gone = true; notice.textContent = t('channels:bot.removed'); paintAll(); } }
    }, 200);
  };

  return {
    show(view) {
      if (view?.kind !== 'bot' || !view.id) { this.hide(); return; }
      root.hidden = false;
      placeInTop();
      open(view.id).then(() => {
        if (view.memory && !root.hidden && S.id === view.id) openMemory.click();
      });
    },
    hide() {
      takeFromTop();
      if (root.hidden) return;
      closePanels();
      root.hidden = true;
      S.id = null;
      S.draft = null;
      memory.setBot(null);
      paused = null;
      activitySeq++;
    },
    onEvent(ev) {
      switch (ev?.type) {
        case 'botsChanged':
          if (ev.removed) { S.bots.delete(ev.removed); if (S.id === ev.removed) { S.gone = true; notice.textContent = t('channels:bot.removed'); paintAll(); } return; }
          if (ev.bot) { S.bots.set(ev.bot.id, { ...S.bots.get(ev.bot.id), ...ev.bot }); if (S.id === ev.bot.id) refetchSoon(); }
          return;
        case 'memoryChanged':
          if (!root.hidden) memory.refresh(ev.layer);
          return;
        case 'brainChanged':
          if (!root.hidden && ev.botId === S.id) {
            loadActivity();
            if (ev.loopsChanged) memory.refresh(ev.botId);
          }
          return;
        case 'channelsChanged':
          if (!root.hidden) loadChannels();
          return;
        default:
      }
    },
    /**
     * 接続先の登録が変わった（アカウント・互換の接続先。web/client.mjs が一覧を取り直せる状態にしてから呼ぶ）。
     * 候補と語彙を忘れ、見えていれば今の bot の分を読み直す
     */
    connChanged() {
      S.connAsked.clear(); S.connDone.clear(); S.vocab.clear();
      if (!root.hidden && vm()) { connLoad(vm().backend); loadVocab(); }
    },
  };
}
