// スレッドの入力欄（docs/design-system.md「入力欄と上端」「スレッドの空間モデル」、ADR 0157）。Chats の会話の入力欄と同じ部品
// （web/composer/composer.mjs。骨組みは Chats の欄の写しで、id の頭は th: thPrompt・thSend…）に、スレッドの持ち物を足す:
//   - 「@」の補完と宛先の塊（mention-complete.mjs・mention-blocks.mjs）・誰も @ していない文への提案・@here / @everyone の人数の確認（ADR 0121）
//   - 書きかけはスレッドごとに端末へ（流れの入力欄と同じ入れ物。ch-composer.mjs の draftStore）
// 宛先のチップと、スレッドごとの設定のチップ（作業フォルダー・モデル・承認モード）は持たない。宛先は本文の @ だけで決まり、
// @ が無ければ前に答えた bot が受ける。設定は bot のページでだけ変える（ADR 0359）。行は添付と送信だけ。
// まだ使わない部品（送信の日時、待ち行列、文脈の帯、中断・再開）は隠す（段ごとに開ける）。
// 口は流れの入力欄（createChComposer）と同じ形にしてある（thread.mjs がそのまま使う）。
import { buildComposer, composerEls, createComposer } from '../composer/composer.mjs';
import { renderOutbox } from '../outbox.mjs';
import { setupMentionComplete } from './mention-complete.mjs';
import { draftStore, persistDrafts } from './ch-composer.mjs';
import { runMark } from '../arc.mjs';
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { announce } from '../message-actions.mjs';

const PREFIX = 'th';
const SAVE_WAIT_MS = 400;
/** スレッドではまだ使わない部品（段ごとに開ける） */
const UNUSED = ['armedChip', 'draftSaved', 'resume', 'contextStrip', 'usageChip', 'nextSettings',
  'resumeNote', 'armedNote', 'draftFail', 'connNote', 'cwdChip', 'modelChip'];

/**
 * @param {object} o
 * @param {object} o.host setupChannels の host
 * @param {() => string|null} o.bucket 添付の置き場の分け先（チャンネルの id）
 * @param {() => object[]} o.candidates @ の候補
 * @param {() => object|null} [o.suggest] 誰も @ していないときに勧める bot
 * @param {(backend: string) => string} [o.backendLabel]
 * @param {(text: string) => Promise<{required: boolean, botIds: string[]}>} [o.wakePreview]
 * @param {(post: { text: string, attachments: object[], confirmedWake?: string[] }) => Promise<void>} o.onSend
 * @param {() => object|null} [o.receiver] @ の無い文を受ける bot（前に答えた bot。DM ならその bot）。いなければ null（誰も起きない）
 * @param {() => ({ sessionId: string|null, cwd: string }|null)} [o.session] 受ける bot の、このスレッドの会話（「/」の候補・`!`・/compact が使う）
 * @param {() => object[]} [o.schedules] このスレッドへの返信の予定（schedule.json の kind post。時刻順）
 * @param {(sessionId: string) => Promise<void>} [o.compact] 宛先の bot の会話を圧縮する（/compact）
 * @param {() => { id: string, text: string }[]} [o.pending] bot へ届く前のあなたの投稿（送信待ちの行。投稿の順）
 * @param {(postId: string) => Promise<void>} [o.withdrawPending] 送信待ちの投稿を取り下げる（［取り消し］・［編集］）
 * @param {() => void} [o.onStop] 送信の横の ■（作業中の返事を止める。通常の会話の中断と同じ形。出し入れは setStop）
 * @param {object} [o.edit] 「編集して再送信」の持ち分（web/composer/edit-mode.mjs の host）: target(id) → { time, tail } か null、send(ctx)、branch(ctx)、decorate(id, on, tail)、locate(id)
 */
export function createThreadComposer({ host, bucket = () => null, candidates, suggest = () => null, backendLabel, wakePreview, onSend, receiver = () => null, session = () => null, onStop = () => {},
  schedules = () => [], compact = async () => {}, pending = () => [], withdrawPending = async () => {}, edit: editHost = {} }) {
  const form = buildComposer(PREFIX);
  form.classList.add('th-composer');
  form.noValidate = true;
  const els = composerEls(PREFIX, form);
  for (const part of UNUSED) if (els[part]) els[part].hidden = true;
  els.abort.hidden = true;
  els.abort.onclick = () => onStop();

  // ---- スレッドの持ち物（提案・集団宛ての確認・@ の候補）。入力の箱の上に置く
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
  list.id = `${PREFIX}Mentions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('channels:feed.mention.label'));
  list.hidden = true;
  els.cbox.before(hint, wakeCard, list);
  const input = els.prompt;
  input.setAttribute('aria-controls', list.id);

  let disabled = false, noteTimer = null, draftKey = null, saveTimer = null, pendingWake = null, pendingEdit = null;
  // 送っている持ち主（スレッド）。送信中はそのスレッドだけのもの: 別のスレッドへ移れば、そこではすぐ書いて送れる
  const sending = new Set();
  // 持ち主を離れている間に届いた失敗。戻ったときに入力欄の下へ出す
  const failures = new Map();
  const busy = () => sending.has(draftKey ?? '');
  const dismissWake = () => { pendingWake = null; wakeCard.hidden = true; };
  wakeCancel.onclick = dismissWake;
  const say = (text, sticky = false) => {
    clearTimeout(noteTimer);
    els.settingsError.textContent = text ?? '';
    if (text && !sticky) noteTimer = setTimeout(() => { els.settingsError.textContent = ''; }, 6000);
  };

  // ---- 書きかけ
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!draftKey) return;
    // 「編集中」も下書きと一緒に残す。スレッドを開き直した直後（投稿を読むまで）は、読み込んだままの状態を持ち越す
    const snap = edit.snapshot() ?? pendingEdit;
    const d = { text: input.value ?? '', attached: c.attach.items, editing: input.editor.snapshotEditing(), at: Date.now(), ...(snap ? { edit: snap } : {}) };
    if (!d.text.trim() && !d.attached.length && !snap) draftStore().delete(draftKey); else draftStore().set(draftKey, d);
    persistDrafts();
    saveServerDraft();
  }
  // 下書きのサーバーの写し（drafts.*。ADR 0157 の F35）。端末の写しが先で、ここは 1.5 秒まとめて追いかける。端末に無いスレッドを開いたら読む
  let serverTimer = 0;
  const saveServerDraft = () => {
    clearTimeout(serverTimer);
    const key = draftKey;
    // 編集中の字は、まだ送っていない書きかけではない（ほかの端末の下書きにしない。戻したあとの保存が上書きする）
    if (!key || edit.active || pendingEdit) return;
    const text = input.value, editing = input.editor.snapshotEditing();
    serverTimer = setTimeout(() => { host.invoke('drafts.save', { key, text, editing, at: Date.now() }).catch(() => {}); }, 1500);
  };
  async function loadServerDraft(key) {
    if (!key || input.value.trim()) return;
    const got = await host.invoke('drafts.load', { key }).catch(() => null);
    if (draftKey !== key || input.value.trim() || !got?.text) return;
    input.editor.restoreDraft(got.text, got.editing);
    c.fit();
  }

  const saveDraftSoon = () => { if (saveTimer === null) saveTimer = setTimeout(saveDraft, SAVE_WAIT_MS); };
  function adopt(owner, item) {
    const d = draftStore().get(owner) ?? { text: '', attached: [], at: 0 };
    draftStore().set(owner, { ...d, attached: [...d.attached, item], at: Date.now() });
    persistDrafts();
  }

  const c = createComposer({
    canSubmit: () => !disabled,
    els, prefix: PREFIX, t,
    attach: {
      host, bucket, owner: () => draftKey ?? '', accepts: () => !disabled, say, adopt,
      onChange: () => { dismissWake(); saveDraft(); paintHint(); },
    },
    wait: { runMark, onChange: () => syncSend() },
    keys: [(e) => mention.keydown(e), (e) => c.slash?.keydown(e)],
    onSubmit: () => submit(),
    onSchedule: () => c.sendMenu?.open(),
  });
  const att = c.attach;
  const mention = setupMentionComplete({ input, list, candidates, idPrefix: `${PREFIX}-mention`, backendLabel, onChange: () => paintHint() });
  // 送信の日時（▾・送信の円の右クリックと長押し・Ctrl+Shift+Enter。ADR 0103）。時刻が来たら人の投稿として 1 回だけ投稿する（channels.schedulePost）
  c.useSchedule({
    context: () => ({ available: Boolean(input.value.trim() || att.items.length) && !disabled }),
    environment: async () => (await host.scheduleEnvironment?.().catch(() => null)) ?? { persistent: true, hostZone: null },
    onSchedule: (at) => submit({ at }),
    onSendNow: () => submit({ at: null }),
  });
  // 発言の ⋯ › 「編集して再送信」「再送信」: いつもの入力欄を「編集中」にする（web/composer/edit-mode.mjs。ADR 0178）。
  // 何を送るか・元の投稿の見せ方は thread.mjs（options.edit）。投稿を読み込むまでは、保存した状態を持っておく（syncEdit）
  const edit = c.useEdit({
    kind: 'reply', texts: { running: t('channels:thread.resend.running') }, announce: (text) => announce(text),
    host: {
      read: () => ({ text: input.value, attached: att.ordered(), editing: input.editor.snapshotEditing() }),
      write: ({ text, attached, editing }) => { c.shell?.reset?.(); att.restore(attached); input.editor.restoreDraft(text, editing); att.placeTail(); c.fit(); paintHint(); },
      send: (ctx) => editHost.send(ctx), branch: (ctx) => editHost.branch(ctx),
      decorate: (id, on, tail) => editHost.decorate?.(id, on, tail), locate: (id) => editHost.locate?.(id),
      change: () => saveDraftSoon(),
    },
  });
  // 欄の「/」のスキル候補。候補は受ける bot の会話の作業フォルダーから（/compact は受ける bot の会話を圧縮する）
  const destSession = () => session();
  c.useSlash({
    cwd: () => destSession()?.cwd ?? '',
    canCompact: () => Boolean(destSession()?.sessionId),
    load: (cwd) => host.cmd('slashSkills', { cwd: cwd || undefined }),
    off: () => c.editor.inCode(),
  });
  // 欄の `!`: 宛先の bot の、このスレッドの会話の作業場所で走らせる（結果は次の配達に付く。ADR 0157・0054）
  c.useShell({
    availability: () => (destSession()?.sessionId ? { ok: true } : { ok: false, text: t('channels:thread.shellNoSession') }),
    where: () => ({ cwd: destSession()?.cwd ?? '' }),
    touch: () => matchMedia('(pointer:coarse)').matches,
    onAsText: () => submit(),
    onChange: () => c.fit(),
  });
  async function runShell() {
    const command = input.value;
    const s = destSession();
    if (!command.trim() || !s?.sessionId) return;
    input.value = '';
    c.shell.exit();
    saveDraft();
    try { await host.cmd('runShell', { sessionId: s.sessionId, runId: `th-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, command, ...(s.cwd ? { cwd: s.cwd } : {}) }); say(''); }
    catch (err) { c.shell.enter(); input.value = command; say(t('chat.shell.runFailed', { error: err?.message ?? String(err) }), true); }
  }
  // このスレッドへの返信の予定の行（送信待ちの行と同じ部品。今すぐ送る・編集・取り消す）
  const restoreOutboxText = text => {
    if (input.value.trim()) input.setRangeText(text + '\n\n', 0, 0);
    else input.value = text;
    input.focus();
    saveDraft();
  };
  const scheduleActions = {
    now: async (entry) => { await host.invoke('sessions.sendScheduledNow', { id: entry.id }); },
    cancel: async (entry) => { await host.invoke('sessions.cancelSchedule', { id: entry.id }); },
    // 本文を欄へ戻す（取り出した予定は時刻が来ても動かない）
    edit: async (entry) => {
      const taken = await host.invoke('sessions.cancelSchedule', { id: entry.id });
      const text = taken?.entry?.args?.prompt ?? entry.args?.prompt ?? '';
      restoreOutboxText(text);
    },
  };
  // 送信待ち（bot へ届く前のあなたの投稿）は、その投稿の下の 1 行（web/channels/thread.mjs の decorate）。
  // ［編集］は取り下げて本文を入力欄へ戻す、［取り消す］は取り下げる
  const pendingAction = async (postId, name) => {
    const row = pending().find((p) => p.id === postId);
    await withdrawPending(postId);
    if (name === 'edit' && row) restoreOutboxText(row.text);
  };
  /** 入力欄の上は送信予定だけ */
  function paintSchedules() {
    renderOutbox(els.outbox, schedules(), scheduleActions);
  }

  // クリップ: この端末のファイルを選ぶ（出どころの面はチャンネルには無い。ADR 0116）
  els.attach.addEventListener('pointerdown', att.rememberAt, true);
  els.attach.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') att.rememberAt(); }, true);
  els.attach.addEventListener('click', () => { if (!disabled) els.fileIn.click(); });
  els.fileIn.onchange = () => { att.attachFiles([...els.fileIn.files]); els.fileIn.value = ''; };

  function syncSend() { els.send.disabled = busy() || disabled || Boolean(att.blockReason()); }

  // ---- 提案（誰も @ していない文に）。@ が無くても受ける bot がいる（前に答えた bot・DM の bot）ときは出さない
  function paintHint() {
    const text = input.value.trim();
    const bot = text && !disabled && !receiver() ? suggest() : null;
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

  // ---- 送る
  // 送り直し（応答が届かなかった）でも二重に投稿しないよう、同じ中身には同じ clientId を使う（サーバーが同じ id の投稿を作らない）
  // 送り直しの id はスレッドごと（並べて送ったほかのスレッドの応答で消さない）
  const attempts = new Map();
  const clientIdOf = (owner, body, at) => {
    const key = JSON.stringify([body, at ?? null]);
    if (attempts.get(owner)?.key !== key) attempts.set(owner, { key, id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` });
    return attempts.get(owner).id;
  };
  // 送った版（押した時の字と添付）。応答が届いたとき、片付けてよいのはこの版のままの下書きだけ
  const versionOf = (text, items) => JSON.stringify([text ?? '', items ?? []]);
  function clearSent(owner, version) {
    if ((draftKey ?? '') === owner) {
      if (versionOf(input.value, c.attach.items) !== version) return;   // 送っている間に書き足した: 残す
      input.value = '';
      att.clear();
      dismissWake();
      saveDraft();
      paintHint();
      c.fit();
      return;
    }
    const d = draftStore().get(owner);
    if (!d || versionOf(d.text, d.attached) !== version) return;
    if (d.edit) draftStore().set(owner, { text: '', attached: [], at: Date.now(), edit: d.edit }); else draftStore().delete(owner);
    persistDrafts();
    if (owner) host.invoke('drafts.save', { key: owner, text: '', at: Date.now() }).catch(() => {});
  }
  async function sendBody(body, confirmedWake, at = null) {
    // 送り先（持ち主）と版は押した時に決める。応答を待つ間に別のスレッドへ移っても、片付けと失敗の知らせはこのスレッドへ
    const owner = draftKey ?? '';
    const version = versionOf(input.value, c.attach.items);
    const clientId = clientIdOf(owner, body, at);
    sending.add(owner);
    failures.delete(owner);
    syncSend();
    wakeButton.disabled = true;
    say('');
    try {
      await onSend({ ...body, ...(confirmedWake ? { confirmedWake } : {}), clientId, ...(at ? { at } : {}) });
      attempts.delete(owner);
      clearSent(owner, version);
    } catch (err) {
      const message = t('channels:feed.composer.failed', { error: err?.message ?? String(err) });
      if ((draftKey ?? '') === owner) { dismissWake(); say(message, true); } else failures.set(owner, message);
    } finally {
      sending.delete(owner);
      syncSend();
      wakeButton.disabled = false;
    }
  }
  async function submit({ at = null } = {}) {
    if (edit.active) return edit.send();
    if (busy() || disabled || pendingWake) return;
    if (c.shell?.active) return runShell();
    if (c.shell?.blocked) return c.shell.flash?.();
    c.slash?.close();
    const body = att.compose(input.value);
    if (!body.text.trim() && !body.attachments.length) return;
    const block = att.blockReason();
    if (block) { say(block); att.flash(); return; }
    // /compact: 受ける bot の、このスレッドの会話を圧縮する（投稿にはしない）
    if (body.text.trim() === '/compact' && !body.attachments.length) {
      const s = destSession();
      if (!s?.sessionId) { say(t('channels:thread.compactNoSession')); return; }
      const owner = draftKey ?? '';
      sending.add(owner); syncSend();
      try { await compact(s.sessionId); if (owner === (draftKey ?? '') && input.value.trim() === '/compact') { input.value = ''; saveDraft(); } }
      catch (err) { if (owner === (draftKey ?? '')) say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true); }
      finally { sending.delete(owner); syncSend(); }
      return;
    }
    if (at) { await sendBody(body, null, at); return; }
    if (wakePreview && /[@＠](?:here|everyone)(?![\p{L}\p{N}_-])/iu.test(body.text)) {
      const owner = draftKey ?? '';
      sending.add(owner);
      syncSend();
      try {
        const preview = await wakePreview(body.text);
        if (owner !== (draftKey ?? '') || JSON.stringify(att.compose(input.value)) !== JSON.stringify(body)) return;
        if (preview.required) {
          pendingWake = { body, botIds: preview.botIds };
          wakeText.textContent = t('channels:feed.wakeConfirm.count', { count: preview.botIds.length });
          wakeCard.hidden = false;
          wakeButton.focus();
          return;
        }
      } catch (err) { if (owner === (draftKey ?? '')) say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true); return; }
      finally { sending.delete(owner); syncSend(); }
    }
    await sendBody(body);
  }
  wakeButton.onclick = () => { if (pendingWake && !busy() && !disabled) sendBody(pendingWake.body, pendingWake.botIds); };

  input.addEventListener('input', () => { dismissWake(); if (els.settingsError.textContent && !busy()) say(''); paintHint(); saveDraftSoon(); });
  input.addEventListener('blur', saveDraft);
  const onHidden = () => { if (document.visibilityState === 'hidden') saveDraft(); };
  document.addEventListener('visibilitychange', onHidden);
  addEventListener('pagehide', saveDraft);
  // 箱のどこを押しても字の欄へ（Chats の入力欄と同じ）
  els.cbox.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .md-b, [contenteditable], input')) return;
    e.preventDefault();
    input.focus();
  });

  return {
    el: form,
    input,
    editor: c.editor,
    attach: att,
    composer: c,
    focus: () => input.focus({ preventScroll: true }),
    setPlaceholder(text) { input.placeholder = text; },
    setDisabled(on, reason = '') {
      disabled = Boolean(on);
      input.disabled = disabled;
      form.classList.toggle('disabled', disabled);
      syncSend();
      say(on ? reason : '', true);
      paintHint();
    },
    refresh() { paintHint(); paintSchedules(); c.fit(); },
    /** 送信の横の ■ を出し入れする。disabled は止めている最中 */
    setStop({ show = false, disabled = false } = {}) {
      els.abort.hidden = !show;
      els.abort.disabled = disabled;
      c.fit();
    },
    /** 予定が動いた */
    paintSchedules,
    /** 送信待ちの投稿の下の［編集］［取り消す］ */
    pendingAction,
    say,
    clear() { dismissWake(); input.value = ''; att.clear(); say(''); saveDraft(); paintHint(); },
    mention,
    setDraftKey(key) {
      if (key === draftKey) return;
      dismissWake();
      saveDraft();
      edit.reset();
      pendingEdit = null;
      draftKey = key;
      const d = key ? draftStore().get(key) : null;
      att.restore(d?.attached);
      input.editor.restoreDraft(d?.text ?? '', d?.editing);
      att.placeTail();
      // 編集中だったスレッドは、投稿を読み込んだあと（syncEdit）に「編集中」へ戻す
      if (d?.edit) pendingEdit = d.edit;
      if (!d) void loadServerDraft(key);   // この端末に写しが無い: サーバーの写しを読む（ほかの端末で書いた続き）
      say(failures.get(key ?? '') ?? '', true);
      failures.delete(key ?? '');
      syncSend();
      paintHint();
    },
    saveDraft,
    /** 「編集して再送信」の状態（begin・cancel など） */
    edit,
    /** 投稿を読み込んだ・増減した: 保存した編集中を戻す。元の投稿が無くなっていたら編集をやめ、消えるものの見立てが変わっていたら帯を直す */
    syncEdit() {
      if (edit.sending) return;
      if (pendingEdit) {
        const saved = pendingEdit;
        pendingEdit = null;
        edit.restore(saved, (id) => editHost.target?.(id) ?? null);
        return;
      }
      if (!edit.active) return;
      const found = editHost.target?.(edit.id);
      if (!found) edit.targetLost(); else edit.setTail(found.tail);
    },
    bindDropZone: (zone) => att.bindDropZone(zone),
    /** 通話モードの差し込み口の composer（web/voice/index.mjs）。マイクとスピーカーは送信の左のスロット */
    voiceSlot: () => c.voiceSlot(),
    destroy() { saveDraft(); document.removeEventListener('visibilitychange', onHidden); removeEventListener('pagehide', saveDraft); c.destroy(); },
  };
}
