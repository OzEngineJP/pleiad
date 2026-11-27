// チャンネル・スレッドの入力欄（.ch-composer。流れは #chFeedComposer、スレッドは #chThreadComposer）。
// Chats の入力欄と同じ操作を持つ（ADR 0116）: 字の欄は Chats と同じ編集欄（web/md-editor.mjs。要素を渡せば何個でも作れる）、
// 送信は Ctrl+Enter（Enter は改行）、行は 1 行から中身に合わせて伸びる（上限はマウス 10 行・タッチ 6 行。web/composer-layout.mjs）、
// 添付はクリップ・貼り付け・ドロップ（ch-attachments.mjs）、書きかけは入力欄ごと（流れはチャンネル・スレッドはスレッド）に端末へ残す。
// チップは無い（bot の動かし方は bot が持つ）。「@」で bot とメンバーを補完（mention-complete.mjs）、「/」でスキルを補完（slash-skills.mjs。options.skills）。
// 誰も @ していない文では、淡い提案（「@Owl を呼ぶ」）を欄の上に出す。DM は宛先が決まっているので出さない。
import { createMarkdownEditor } from '../md-editor.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { promptMaxHeight } from '../composer-layout.mjs';
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { setupMentionComplete } from './mention-complete.mjs';
import { setupMentionBlocks } from './mention-blocks.mjs';
import { setupSlashSkills } from '../slash-skills.mjs';
import { createChAttachments } from './ch-attachments.mjs';
import { DRAFT_STORE, parseDrafts, serializeDrafts } from './ch-attach-model.mjs';

const sendIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M21 3L10 14M21 3l-7 18-4-7-7-4z' }));
  return svg;
};

// ---- 書きかけ（端末の localStorage。入力欄どうしで共有する 1 つの入れ物。スレッドの入力欄 thread-composer.mjs も同じものを使う）
let drafts = null;
export const draftStore = () => (drafts ??= parseDrafts((() => { try { return localStorage.getItem(DRAFT_STORE); } catch { return null; } })()));
export const persistDrafts = () => { try { localStorage.setItem(DRAFT_STORE, serializeDrafts(draftStore())); } catch { /* 入れ物がいっぱい・使えない: 画面の中の写しだけで続ける */ } };
const SAVE_WAIT_MS = 400;

/**
 * @param {object} o
 * @param {string} o.id 入力欄の id（#chFeedComposer / #chThreadComposer）
 * @param {object} o.host setupChannels の host（cmd・whenOnline・openImage・filePreview を添付が使う）
 * @param {() => string|null} o.bucket 添付の置き場の分け先（チャンネルの id）
 * @param {() => object[]} o.candidates @ の候補（mention-complete.mjs の形）
 * @param {() => { id: string, name: string, color?: number }[]} [o.blockBots] 本文の `@名前` を「顔＋名前」の塊に見せる bot（mention-blocks.mjs。呼べる bot の全員）
 * @param {() => { id: string, name: string, icon: string }|null} [o.suggest] 誰も @ していないときに勧める bot（無ければ提案を出さない）
 * @param {{ key: (text: string) => string, load: (key: string) => Promise<object[]>, headLabel?: (key: string) => Node|string|null, badge?: (skill: object) => Node|null }|null} [o.skills]
 *   「/」のスキル候補（スレッドの返信欄と同じ web/slash-skills.mjs）。key は今の本文から決まる引き先の印、load はその印の候補（web/channels/feed-skills.mjs）。
 *   無ければ「/」の候補は出さない
 * @param {(backend: string) => string} [o.backendLabel]
 * @param {(text: string) => Promise<{required: boolean, botIds: string[]}>} [o.wakePreview] 集団宛てを投稿前に数える
 * @param {(post: { text: string, attachments: { path: string, name: string, mime: string }[], confirmedWake?: string[] }) => Promise<void>} o.onSend 投稿する。失敗したら投げる（字と添付は残る）
 * @returns {{ el: HTMLFormElement, input: HTMLElement, focus(): void, setPlaceholder(text: string): void, setDisabled(on: boolean, reason?: string): void, refresh(): void, clear(): void,
 *   setDraftKey(key: string|null): void, saveDraft(): void, bindDropZone(zone: HTMLElement): void }}
 */
export function createChComposer({ id, host, bucket = () => null, candidates, blockBots = () => [], suggest = () => null, skills = null, backendLabel, wakePreview, onSend, idPrefix = id }) {
  const form = el('form', 'ch-composer');
  form.id = id;
  form.noValidate = true;
  const hint = el('div', 'ch-hint');
  hint.hidden = true;
  const wakeCard = el('div', 'ch-wake-confirm card');
  wakeCard.hidden = true;
  wakeCard.setAttribute('role', 'group');
  wakeCard.setAttribute('aria-label', t('channels:feed.wakeConfirm.label'));
  const wakeText = el('span', 'ch-wake-count');
  const wakeCancel = el('button', 'btn', t('channels:feed.wakeConfirm.cancel'));
  wakeCancel.type = 'button';
  const wakeButton = el('button', 'btn btn-primary', t('channels:feed.wakeConfirm.wake'));
  wakeButton.type = 'button';
  wakeCard.append(wakeText, wakeCancel, wakeButton);
  const list = el('ul', 'mention-list');
  list.id = `${id}Mentions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('channels:feed.mention.label'));
  list.hidden = true;
  // 「/」の候補の一覧（行の形・中身は Chats・スレッドと同じ web/slash-skills.mjs。置く場所は @ の候補と同じ、欄のすぐ上）
  const skillList = el('ul', 'clist ch-skill-list');
  skillList.id = `${id}Skills`;
  skillList.setAttribute('role', 'listbox');
  skillList.setAttribute('aria-label', t('chat.composer.skills'));
  skillList.hidden = true;
  const box = el('div', 'ch-box');
  const input = el('div', 'ch-input');
  input.id = `${id}Input`;
  input.setAttribute('aria-label', t('channels:feed.composer.label'));
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-controls', skills ? `${list.id} ${skillList.id}` : list.id);
  const row = el('div', 'ch-row');
  const note = el('span', 'ch-note');
  note.setAttribute('role', 'status');
  const send = el('button', 'btn btn-primary ch-send');
  send.type = 'submit';
  send.title = t('channels:feed.composer.send');
  send.setAttribute('aria-label', t('channels:feed.composer.send'));
  send.append(sendIcon());

  let disabled = false, noteTimer = null, draftKey = null, saveTimer = null, pendingWake = null;
  // 送っている持ち主（チャンネル）。送信中はその持ち主だけのもの: 別のチャンネルへ移れば、そこではすぐ書いて送れる
  const sending = new Set();
  // 持ち主を離れている間に届いた失敗。戻ったときに入力欄の下へ出す
  const failures = new Map();
  const busy = () => sending.has(draftKey ?? '');
  const dismissWake = () => { pendingWake = null; wakeCard.hidden = true; };
  wakeCancel.onclick = dismissWake;

  const say = (text, sticky = false) => {
    clearTimeout(noteTimer);
    note.textContent = text;
    if (text && !sticky) noteTimer = setTimeout(() => { note.textContent = ''; }, 6000);
  };

  // ---- 書きかけ
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!draftKey) return;
    const d = { text: input.value ?? '', attached: attach.items, editing: input.editor.snapshotEditing(), at: Date.now() };
    if (!d.text.trim() && !d.attached.length) draftStore().delete(draftKey); else draftStore().set(draftKey, d);
    persistDrafts();
  }
  const saveDraftSoon = () => { if (saveTimer === null) saveTimer = setTimeout(saveDraft, SAVE_WAIT_MS); };
  /** 送っている間に別の入力欄へ移った後に届いた添付を、持ち主の下書きへ入れる（位置は持たない: 文末に付く） */
  function adopt(owner, item) {
    const d = draftStore().get(owner) ?? { text: '', attached: [], at: 0 };
    draftStore().set(owner, { ...d, attached: [...d.attached, item], at: Date.now() });
    persistDrafts();
  }

  const attach = createChAttachments({
    host, bucket, owner: () => draftKey ?? '', accepts: () => !disabled, say, adopt,
    onChange: () => { dismissWake(); saveDraft(); paintHint(); },
  });
  row.append(attach.button, note, send);
  box.append(input, row);
  form.append(hint, wakeCard, list, ...(skills ? [skillList] : []), box, attach.fileInput);

  const editor = createMarkdownEditor(input, { resolve: () => null, ...attach.editorOptions });
  attach.bind(editor, input);
  const mention = setupMentionComplete({ input, list, candidates, idPrefix: `${idPrefix}-mention`, backendLabel, onChange: () => paintHint() });
  // 本文の `@名前` を、顔＋名前の 1 つの塊に見せる（文書は `@名前` のまま。ADR 0362）
  const blocks = setupMentionBlocks({ input, bots: blockBots });
  // 「/」のスキル候補。候補は宛先の bot の動く場所から（@ した bot。誰も @ していなければ呼べるメンバー）。流れには圧縮する会話が無いので /compact は出さない
  const slash = skills
    ? setupSlashSkills({
      input, list: skillList, load: skills.load, cwd: () => skills.key(input.value ?? ''), off: () => editor.inCode(),
      idPrefix: `${idPrefix}-slash`, compact: false, headLabel: skills.headLabel, badge: skills.badge,
    })
    : null;

  // ---- 高さ。1 行から始めて中身に合わせて伸び（CSS）、上限はマウス 10 行・タッチ 6 行（Chats の fitPrompt と同じ決まり）
  function fit() {
    if (!input.isConnected) return;
    const css = getComputedStyle(input);
    const line = parseFloat(css.lineHeight) || 22;
    const pad = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
    form.style.setProperty('--ch-input-max', `${promptMaxHeight({ line, pad, touch: matchMedia('(pointer:coarse)').matches, viewport: innerHeight })}px`);
  }
  addEventListener('resize', fit);
  const onHidden = () => { if (document.visibilityState === 'hidden') saveDraft(); };
  form.addEventListener('focusin', fit);

  function paintHint() {
    const text = input.value.trim();
    const bot = text && !disabled ? suggest() : null;
    if (!bot || /@/.test(text)) { hint.hidden = true; return; }
    hint.replaceChildren(el('span', null, t('channels:feed.hint.nobody')));
    const b = el('button', null, t('channels:feed.hint.call', { name: bot.name }));
    b.type = 'button';
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      input.setRangeText(`@${bot.name} `, 0, 0, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    };
    hint.append(b);
    hint.hidden = false;
  }

  // 送った版（押した時の字と添付）。応答が届いたとき、片付けてよいのはこの版のままの下書きだけ
  const versionOf = (text, items) => JSON.stringify([text ?? '', items ?? []]);
  function clearSent(owner, version) {
    if ((draftKey ?? '') === owner) {
      if (versionOf(input.value, attach.items) !== version) return;   // 送っている間に書き足した: 残す
      input.value = '';
      attach.clear();
      dismissWake();
      saveDraft();
      paintHint();
      return;
    }
    const d = draftStore().get(owner);
    if (d && versionOf(d.text, d.attached) === version) { draftStore().delete(owner); persistDrafts(); }
  }
  async function sendBody(body, confirmedWake) {
    // 送り先（持ち主）と版は押した時に決める。応答を待つ間に別のチャンネルへ移っても、片付けと失敗の知らせはこの持ち主へ
    const owner = draftKey ?? '';
    const version = versionOf(input.value, attach.items);
    sending.add(owner);
    failures.delete(owner);
    send.disabled = true;
    wakeButton.disabled = true;
    say('');
    try {
      if (host.botEnablement && !await host.botEnablement.request(input)) return;
      if ((draftKey ?? '') !== owner) return;
      await onSend({ ...body, ...(confirmedWake ? { confirmedWake } : {}) });
      clearSent(owner, version);
    } catch (err) {
      const message = t('channels:feed.composer.failed', { error: err?.message ?? String(err) });
      if ((draftKey ?? '') === owner) { dismissWake(); say(message, true); } else failures.set(owner, message);
    } finally {
      sending.delete(owner);
      send.disabled = disabled || busy();
      wakeButton.disabled = false;
    }
  }

  async function submit() {
    if (busy() || disabled || pendingWake) return;
    // 送っている途中・失敗の添付があるうちは送らない（欠けた添付を前提に bot が動き出さないように）。札が理由と外す・再試行を持つ
    const body = attach.compose(input.value);
    if (!body.text.trim() && !body.attachments.length) return;
    const block = attach.blockReason();
    if (block) { say(block); attach.flash(); return; }
    if (wakePreview && /[@＠](?:here|everyone)(?![\p{L}\p{N}_-])/iu.test(body.text)) {
      const owner = draftKey ?? '';
      sending.add(owner);
      send.disabled = true;
      try {
        const preview = await wakePreview(body.text);
        if (owner !== (draftKey ?? '') || JSON.stringify(attach.compose(input.value)) !== JSON.stringify(body)) return;
        if (preview.required) {
          pendingWake = { body, botIds: preview.botIds };
          wakeText.textContent = t('channels:feed.wakeConfirm.count', { count: preview.botIds.length });
          wakeCard.hidden = false;
          wakeButton.focus();
          return;
        }
      } catch (err) { if (owner === (draftKey ?? '')) say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true); return; }
      finally { sending.delete(owner); send.disabled = disabled || busy(); }
    }
    await sendBody(body);
  }
  wakeButton.onclick = () => { if (pendingWake && !busy() && !disabled) sendBody(pendingWake.body, pendingWake.botIds); };

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (isComposingKey(e)) return;
    if (mention.keydown(e)) return;
    if (slash?.keydown(e)) return;
    if (blocks.keydown(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => { dismissWake(); if (note.textContent && !busy()) say(''); paintHint(); saveDraftSoon(); });
  input.addEventListener('blur', saveDraft);
  document.addEventListener('visibilitychange', onHidden);
  addEventListener('pagehide', saveDraft);
  // 箱のどこを押しても字の欄へ（Chats の入力欄と同じ）
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .md-b, [contenteditable]')) return;
    e.preventDefault();
    input.focus();
  });

  return {
    el: form,
    input,
    editor,
    attach,
    focus: () => input.focus({ preventScroll: true }),
    setPlaceholder(text) { input.placeholder = text; },
    setDisabled(on, reason = '') {
      dismissWake();
      disabled = on;
      input.disabled = on;
      send.disabled = on || busy();
      attach.button.disabled = on;
      form.classList.toggle('disabled', on);
      say(on ? reason : '', true);
      paintHint();
    },
    refresh() { blocks.decorate(); paintHint(); fit(); },
    /** 入力欄の下の一行（失敗など）。sticky でなければ数秒で消える */
    say,
    clear() { dismissWake(); input.value = ''; attach.clear(); say(''); saveDraft(); paintHint(); },
    mention,
    slash,
    /**
     * この入力欄の書きかけの持ち主（流れ = チャンネル・スレッド = スレッド）。変わったら、今の書きかけを元の持ち主へ残し、
     * 新しい持ち主の書きかけ（字と添付）を出す。null は持ち主のいない間（何も残さない）
     */
    setDraftKey(key) {
      if (key === draftKey) return;
      dismissWake();
      saveDraft();
      draftKey = key;
      const d = key ? draftStore().get(key) : null;
      attach.restore(d?.attached);   // 添付の実体が先（本文の印は、ここにあるものだけが札になる）
      input.editor.restoreDraft(d?.text ?? '', d?.editing);
      attach.placeTail();   // 文中に無い添付は末尾に札で（一覧の面が無いので）
      blocks.decorate();
      say(failures.get(key ?? '') ?? '', true);
      failures.delete(key ?? '');
      send.disabled = disabled || busy();
      paintHint();
    },
    saveDraft,
    /** zone（流れ・スレッドの板）に落としたファイルをこの入力欄の添付にする */
    bindDropZone: (zone) => attach.bindDropZone(zone),
    /** 入力欄を外すとき。書きかけを残し、窓・文書に付けた見張りを外す */
    destroy() {
      saveDraft();
      slash?.close();
      removeEventListener('resize', fit);
      document.removeEventListener('visibilitychange', onHidden);
      removeEventListener('pagehide', saveDraft);
      editor.destroy?.();
    },
  };
}
