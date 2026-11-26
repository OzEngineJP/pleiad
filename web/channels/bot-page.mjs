// bot のページと作成（W4。ADR 0109・docs/channels.md「bot のページ」・承認済みのモック 05）。
// #channelsBody の中に section#botView.bot-page を作る。見せるのは show({ kind: 'bot', id }) のとき（id が 'new' なら作る画面）。
//
// 設定は Chats の入力欄と同じ程度に簡単にする:
//   名前・アイコン（絵文字ピッカー）・人格（自由文）… 離れたときに bots.update
//   エージェント・モデル・エフォート … 入力欄と同じ 1 つの選択（composer-controls.mjs の renderModel）。bots.update
//   承認モード … 入力欄と同じ選択（renderMode）。bots.setMode（人だけ。ADR 0082）
//   接続先 … モデルの面の「接続先」の行（入力欄と同じ 1 つの一覧: CLI のログイン → 登録したアカウント → 互換の接続先。週の使用量は公式の枠の行だけ）。
//     bots.setAccount（人だけ。ADR 0224・0359）。そのエージェントが接続先を選べ（capabilities.accounts・compatEndpoints。
//     Claude はトークン・Codex などは資格情報。ADR 0222）、登録があるか bot が選んでいるときだけ出す。「既定」の札は新しい会話の既定の印なので出さない
//   触れてよいフォルダー … 行（パス・読み書き/読み取り）と［フォルダーを足す］。bots.update の folders（置き換え）
//     実際に書き込みの範囲を限れないモード（範囲 full: Claude の Bypass・Codex の Bypass・Antigravity）だけ「すべてのフォルダー」で非活性（計画 §7.2-2）
//   他の会話に送る … スイッチ（既定 ON）。bots.update の sendToOthers
// 右に思考の流れ（brain-panel.mjs。心拍の入り切り・欲求・気がかり。ADR 0126）、記憶の一覧（memory-list.mjs）と今週の使用量。操作はすべて host.invoke(op, args)。出来事は botsChanged・memoryChanged・channelsChanged。
// 認証・1 日の上限・長い注記は出さない（接続先は、どれで動くかを選ぶ行だけ。登録・トークン・資格情報・互換の接続先は設定の各エージェントの「接続先」）。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { openEmojiPicker, closeEmojiPicker } from '../emoji-picker.mjs';
import { panel, renderModel, renderMode, folderBrowser, isDanger, modelChipLabel, resolvedModel, effortStops, connShown } from '../composer-controls.mjs';
import { endpointChipLabel } from '../composer-labels.mjs';
import { compatModelLabel } from '../compat-models.mjs';
import { weekUsage } from '../header-usage.mjs';
import { splitChipLabel } from '../composer-layout.mjs';
import { createMemoryList } from './memory-list.mjs';
import { botIcon } from './bot-icon.mjs';
import { sendAttachment } from '../attach-upload.mjs';
import { createBrainPanel } from './brain-panel.mjs';
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
async function resizeIcon(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('WebP encoding failed')), 'image/webp', 0.8));
    if (blob.type !== 'image/webp') throw new Error('WebP encoding failed');
    return new File([blob], 'bot-icon.webp', { type: 'image/webp' });
  } finally { bitmap.close(); }
}

export function createBotPage(host) {
  const body = document.getElementById('channelsBody');
  if (!body) return {};

  const S = {
    id: null,             // 見せている bot の id。'new' = 作る画面
    bot: null,            // bots.get の行（Bot + state）
    draft: null,          // 作る画面の下書き（M.newDraft）
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
  // メインの頭（#channelsView > .top）は、bot のページを見せている間は見出しを引っ込める（bot のページ自身の頭が見出し。汎用の「Channels」は出さない）。
  // 流れの部品が show/hide で見出しを替える順（流れ → 自分）の後に付け外しする。頭は流れの有無で置き場所が動くので、その都度引く
  const topEl = () => document.getElementById('channelsPageTitle')?.closest('.top') ?? null;
  const navigate = (detail) => document.dispatchEvent(new CustomEvent('channels:show', { detail }));
  const vm = () => S.draft ?? S.bot;
  const unlimited = () => M.foldersUnlimited(S.v?.modes?.[vm()?.mode]);

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'bot-page');
  root.id = 'botView';
  root.hidden = true;

  const av = el('button', 'bp-av');
  av.type = 'button';
  av.setAttribute('aria-label', t('channels:bot.iconLabel'));
  av.title = t('channels:bot.iconLabel');
  av.setAttribute('aria-haspopup', 'dialog');
  const avatar = el('span', 'bp-av-icon');
  const badge = el('span', 'bp-av-edit');
  badge.setAttribute('aria-hidden', 'true');
  badge.append(glyph(PENCIL));
  av.append(avatar, badge);
  const imageInput = el('input');
  imageInput.type = 'file'; imageInput.accept = '.png,.jpg,.jpeg,.webp'; imageInput.hidden = true;
  const iconDialog = el('dialog', 'bp-icon-dialog');
  iconDialog.setAttribute('aria-label', t('channels:bot.iconLabel'));
  const iconClose = el('button', 'btn btn-icon');
  iconClose.type = 'button';
  iconClose.setAttribute('aria-label', t('channels:bot.iconClose'));
  iconClose.append(glyph(CLOSE));
  const iconTitle = el('div', 'bp-icon-head');
  iconTitle.append(el('strong', null, t('channels:bot.iconTitle')), iconClose);
  const unset = el('button', 'bp-icon-choice', t('channels:bot.iconUnset'));
  const emojiPick = el('button', 'bp-icon-choice', t('channels:bot.emojiPick'));
  const imagePick = el('button', 'bp-icon-choice');
  imagePick.type = 'button';
  const imageRemove = el('button', 'bp-icon-choice', t('channels:bot.imageRemove'));
  unset.type = emojiPick.type = imageRemove.type = 'button';
  const imageHelp = el('p', 'bp-icon-help', t('channels:bot.imageHelp'));
  iconDialog.append(iconTitle, unset, emojiPick, imagePick, imageRemove, imageHelp);
  root.append(iconDialog);
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
  const moreBtn = el('button', 'btn bp-more', '⋮');   // 「…」は縦の 3 点（docs/design-system.md「「…」の形」）
  moreBtn.type = 'button';
  moreBtn.setAttribute('aria-label', t('channels:botDelete.more'));
  moreBtn.setAttribute('aria-haspopup', 'menu');
  dmBtn.type = 'button';
  dmBtn.append(glyph(REPLY), t('channels:bot.openDm'));
  const createBtn = el('button', 'btn btn-primary bp-create', t('channels:bot.createButton'));
  createBtn.type = 'button';
  const idBox = el('div', 'bp-id');
  idBox.append(nameIn, sub);
  const head = el('div', 'bp-head');
  head.append(av, imageInput, idBox, el('span', 'bp-spacer'), dmBtn, moreBtn, createBtn);

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
  // 思考の流れ（モデルの出力の記録）。心拍の ON・間隔は bots.update の pulse なので、ここの保存の列に乗せる
  const brain = createBrainPanel(host, { update: (patch) => update(patch) });
  // 触る頻度の低い 3 つ（他の会話に送る・ルーティン・活動メモ）は 1 つのカードの畳んだ 3 行にする。右に今の値だけを出し、説明文は置かない（ADR 0358）。
  // ルーティンの行は routine-sheet.mjs が #botRoutinesSlot へ差し込む（2 番目）
  const foldSend = foldRow({ id: 'botSendFold', title: t('channels:bot.send.label') });
  foldSend.body.append(sendRow, sendTargets);
  const routinesSlot = el('div', 'bp-frow-slot');
  routinesSlot.id = 'botRoutinesSlot';
  const foldBrain = foldRow({ id: 'botBrainFold', title: t('channels:bot.brain.title') });
  foldBrain.body.append(brain.el);
  const foldBlk = el('div', 'bp-blk bp-folds');
  foldBlk.append(foldSend.el, routinesSlot, foldBrain.el);
  const memHead = el('h4', null, t('channels:bot.memory.title'));
  memHead.append(memory.route);   // 「自動整理: …」= 設定 › 記憶 への導線（memory-list.mjs が短い状態を出す）
  const memBlk = el('div', 'bp-blk bp-memory');
  memBlk.append(memHead, memory.el);

  const left = el('div', 'bp-col');
  left.append(personaBlk, runBlk);
  const right = el('div', 'bp-col');
  right.append(foldBlk, memBlk);
  const grid = el('div', 'bp-grid');
  grid.append(left, right);
  root.append(head, err, connWarn, notice, grid, modelPop, modePop, addPop);
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
  const closePanels = () => { modelPanel.hide(false); modePanel.hide(false); addPanel.hide(false); closeEmojiPicker(); if (iconDialog.open) iconDialog.close(); };

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
    if (!cur || S.draft) return;
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
    if (!cur || S.draft) return;
    sw.setAttribute('aria-checked', String(cur.sendToOthers !== false));
    foldSend.setValue(cur.sendToOthers !== false ? t('channels:bot.fold.on') : t('channels:bot.fold.off'));
    const pulse = cur.pulse;
    foldBrain.setValue(pulse?.on ? t('channels:bot.fold.pulseOn', { n: pulse.everyMin ?? 10 }) : t('channels:bot.fold.pulseOff'));
    sendTargets.replaceChildren(el('h3', 'bp-send-title', t('channels:bot.send.targets')));
    const details = new Map((cur.sendTargetDetails ?? []).map((row) => [row.sessionId, row]));
    if (!cur.sendTargets?.length) sendTargets.append(el('p', 'bp-nt', t('channels:bot.send.empty')));
    for (const id of cur.sendTargets ?? []) {
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
    show(dmBtn, !creating);
    show(moreBtn, !creating && !S.bot?.plain);
    show(createBtn, creating);
    show(folderTitle, !creating);
    show(folderBox, !creating);
    show(addBtn, !creating);
    show(foldBlk, !creating);
    show(memBlk, !creating);
    show(notice, S.gone);
    show(grid, !S.gone);
    show(head, !S.gone);
    const cur = vm();
    if (cur && document.activeElement !== persona) persona.value = cur.persona ?? '';
    growPersona();
    paintRun();
    if (!creating && S.bot) memory.setBot(S.bot);
    else memory.setBot(null);
    brain.setBot(!creating && S.bot ? S.bot : null);
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
    if (S.draft) { await draftUpdate(patch); return; }
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
    if (S.draft) { S.draft.mode = mode; paintChips(); return; }
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
   * 接続先を変えるとモデル・エフォートは既定へ戻る（サーバーと同じ。互換のモデルは公式では通らない）。作る画面では下書きに持ち、作った後に付ける
   */
  async function setConn({ endpoint = '', account = '' }) {
    if (S.draft) {
      const moved = endpoint !== (S.draft.endpoint ?? '');
      Object.assign(S.draft, { endpoint, account }, moved ? { model: '', effort: '' } : {});
      paintRun(); loadVocab(); return;
    }
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

  /** 作る画面の下書きを変える（保存はしない）。エージェントを替えたら、モデル・エフォート・接続先は既定へ（アカウント・接続先の id はエージェントごと）、承認モードは同じ id があれば保つ */
  async function draftUpdate(patch) {
    const d = S.draft;
    Object.assign(d, patch);
    if ('backend' in patch) {
      d.model = ''; d.effort = ''; d.account = ''; d.endpoint = '';
      const v = await vocabOf(d.backend, '', botCwd(d), d.account ?? '', d.endpoint ?? '');
      if (S.draft !== d) return;
      d.mode = M.modeAfterBackend(v.modes, d.mode);
      S.v = v;
    } else if ('model' in patch) {
      d.effort = '';
      const v = await vocabOf(d.backend, d.model, botCwd(d), d.account ?? '', d.endpoint ?? '');
      if (S.draft !== d) return;
      S.v = v;
    } else if ('effort' in patch) {
      /* そのまま */
    }
    paintRun();
  }

  let imageBusy = false;
  let createBusy = false;
  const paintBusy = () => { av.disabled = imageBusy || createBusy; createBtn.disabled = imageBusy || createBusy; };

  async function create() {
    if (imageBusy || createBusy) return;
    const d = S.draft;
    if (!d) return;
    const name = nameIn.value.trim();
    d.name = name;
    d.persona = persona.value;
    if (!name) { setError(t('channels:bot.nameRequired')); nameIn.focus(); return; }
    setError('');
    createBusy = true;
    paintBusy();
    // bots.create が返した bot（続く段の返りで置き替える）。作れたあとの段で落ちても bot はもうある（同じ名前では作り直せない）ので、
    // この画面に「作れませんでした」と留めず、できた bot の画面へ移して、効かなかった設定をそこで選び直してもらう。自動では消さない
    let bot = null;
    try {
      // 接続先（アカウント・互換）は作った後に付ける（モデル・エフォートは接続先ごとに通るものが違うので、その後に付ける）
      const withConn = Boolean((d.account || d.endpoint) && takesConn(d.backend));
      const deferModel = withConn && Boolean(d.model || d.effort);
      const args = { name, icon: d.icon, backend: d.backend, ...(d.iconImage ? { iconImage: d.iconImage } : {}), ...(d.persona.trim() ? { persona: d.persona } : {}), ...(deferModel ? {} : { ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}) }) };
      bot = await host.invoke('bots.create', args);
      if (d.mode && d.mode !== bot.mode) bot = await host.invoke('bots.setMode', { botId: bot.id, mode: d.mode });
      if (withConn) bot = await host.invoke('bots.setAccount', { botId: bot.id, account: d.account ?? '', ...(d.endpoint ? { endpoint: d.endpoint } : {}) });
      if (deferModel) bot = await host.invoke('bots.update', { botId: bot.id, ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}) });
      S.bots.set(bot.id, bot);
      // 作った後は話しかける場面（DM）を開く。入力欄へのカーソルは DM の流れが開くときに置く（feed.mjs の show）。DM がまだ無ければ bot のページ
      navigate(bot.dmChannelId ? { kind: 'channel', id: bot.dmChannelId } : { kind: 'bot', id: bot.id });
    } catch (e) {
      if (!bot) setError(t('channels:bot.createFailed', { error: message(e) }));
      else {
        S.bots.set(bot.id, bot);
        navigate({ kind: 'bot', id: bot.id });   // 開き直し（open）が表示中のエラーを消すので、移した後に出す
        setError(t('channels:bot.createPartial', { error: message(e) }));
      }
    } finally {
      createBusy = false;
      paintBusy();
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
  const restoreAvatarFocus = () => { if (!root.hidden) av.focus({ preventScroll: true }); };
  iconDialog.addEventListener('close', restoreAvatarFocus);
  iconClose.onclick = () => iconDialog.close();
  iconDialog.addEventListener('click', (e) => { if (e.target === iconDialog) { const r = iconDialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) iconDialog.close(); } });
  unset.onclick = () => { iconDialog.close(); update({ icon: '', iconImage: null }); };
  imageRemove.onclick = () => { iconDialog.close(); update({ iconImage: null }); };
  emojiPick.onclick = (e) => {
    e.stopPropagation();
    iconDialog.close();
    openEmojiPicker({ anchor: av, current: vm()?.icon, title: t('channels:bot.emojiPick'),
      onPick: (emoji) => update({ icon: emoji, iconImage: null }), onClose: restoreAvatarFocus });
  };
  av.addEventListener('click', (e) => {
    e.stopPropagation();   // 脇の document の click が、開いたばかりのピッカーを閉じないように（web/side.mjs の closePops）
    imagePick.textContent = vm()?.iconImage ? t('channels:bot.imageChange') : t('channels:bot.imagePick');
    imageRemove.hidden = !vm()?.iconImage;
    unset.setAttribute('aria-pressed', String(!vm()?.icon && !vm()?.iconImage));
    iconDialog.showModal();
    unset.focus();
  });
  imagePick.addEventListener('click', () => { iconDialog.close(); imageInput.click(); });
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError(t('channels:bot.imageTooLarge')); return; }
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) { setError(t('channels:bot.imageType')); return; }
    const target = vm();
    const targetId = S.id;
    const stillHere = () => S.id === targetId && (!target?.isNew || S.draft === target);
    if (imageBusy || createBusy) return;
    imageBusy = true;
    paintBusy();
    try {
      let iconFile;
      try { iconFile = await resizeIcon(file); }
      catch { if (stillHere()) setError(t('channels:bot.imageReadFailed')); return; }
      if (iconFile.size > 1024 * 1024) { setError(t('channels:bot.imageOutputTooLarge')); return; }
      const upload = await sendAttachment({ cmd: host.cmd, file: iconFile, sessionId: 'bot-icon-upload' });
      if (upload?.path && stillHere()) await update({ iconImage: upload.path });
    } catch (e) { if (stillHere()) setError(t('channels:bot.saveFailed', { error: message(e) })); }
    finally { imageBusy = false; paintBusy(); if (stillHere()) restoreAvatarFocus(); }
  });

  nameIn.addEventListener('input', () => { if (S.draft) { S.draft.name = nameIn.value; paintAvatar(); } });

  const commitName = async () => {
    const cur = vm();
    const name = nameIn.value.trim();
    if (S.draft) { S.draft.name = name; paintAvatar(); return; }
    if (!cur || name === cur.name) { nameIn.value = cur?.name ?? ''; return; }
    if (!name) { nameIn.value = cur.name; return; }
    await update({ name });
    if (document.activeElement !== nameIn) nameIn.value = S.bot?.name ?? '';
  };
  nameIn.addEventListener('blur', commitName);
  nameIn.addEventListener('keydown', (e) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); if (S.draft) create(); else nameIn.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameIn.value = vm()?.name ?? ''; nameIn.blur(); }
  });
  persona.addEventListener('input', growPersona);
  persona.addEventListener('blur', () => {
    const cur = vm();
    if (S.draft) { S.draft.persona = persona.value; return; }
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
  createBtn.addEventListener('click', create);

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
    S.id = id;
    S.gone = false;
    S.v = null;
    S.seq += 1;
    setError('');
    if (id === 'new') {
      S.bot = null;
      const first = backends().find((b) => b.id === host.state?.backendId)?.id ?? backends()[0]?.id ?? '';
      const v = await vocabOf(first);
      if (S.id !== 'new') return;
      S.draft = M.newDraft(first, v.modes);
      S.v = v;
      nameIn.value = '';
      persona.value = '';
      paintAll();
      nameIn.focus();
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
      topEl()?.classList.add('bot-top');
      open(view.id);
    },
    hide() {
      topEl()?.classList.remove('bot-top');
      if (root.hidden) return;
      closePanels();
      root.hidden = true;
      S.id = null;
      S.draft = null;
      memory.setBot(null);
      brain.setBot(null);
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
          if (!root.hidden && ev.botId === S.id) brain.refresh();
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
