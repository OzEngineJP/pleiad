// 子の会話のモーダルの入力欄（docs/design-system.md「バックグラウンド」、ADR 0315 段 4）。メインの会話の入力欄と同じ部品
// （web/composer/composer.mjs。骨組みは Chats の欄の写しで、id の頭は wk: wkPrompt・wkSend…）を、モーダルの会話の面の下に置く。
//   - 送る先は「いま詳細に出している子」。下書き・添付・送信中・送信待ちは子ごとに持ち、メインの下書きとも混ざらない
//   - 送る核はメインと同じ（web/composer/sender.mjs）。受け取り（receipts）は会話の id で引くので、メインと共用できる
//   - まだ使わない部品（通話・バックグラウンドの入口・編集して再送信・`!`・再開）は出さない
// 入力欄は #workBody の外に置く。詳細の読み直し（refreshDetail）は #workBody の中身だけを作り直すので、打っている途中の文字・
// カーソル・IME の変換・添付は、子が流れている間も消えない。
import { buildComposer, composerEls, createComposer } from './composer.mjs';
import { createSender } from './sender.mjs';
import { renderOutbox } from '../outbox.mjs';
import { runMark } from '../arc.mjs';
import { t } from '../i18n.mjs';

const PREFIX = 'wk';
const SAVE_WAIT_MS = 400;
/** モーダルでは使わない部品（メインでだけ出る）。中断は setStop、帯の文脈は setContext で出し入れする */
const UNUSED = ['armedChip', 'draftSaved', 'resume', 'resumeNote', 'armedNote', 'draftFail', 'connNote', 'workEntry'];

/**
 * @param {object} h 呼び出し側（web/client.mjs）が渡す持ち分
 * @param {HTMLElement} h.slot 入力欄を置く場所（#workComposerSlot）
 * @param {(command: string, args?: object) => Promise<any>} h.cmd
 * @param {{ get: (id: string) => object|undefined, set: (id: string, value: object) => Promise<void> }} h.drafts 会話ごとの下書き（メインと同じ入れ物）
 * @param {object} h.attachHost 添付が使うホスト（cmd・whenOnline・openImage・filePreview）
 * @param {(owner: string, item: object) => Promise<void>} h.adopt 送っている間に別の子へ移った添付を、持ち主の下書きへ積む
 * @param {(text: string) => void} h.notify
 * @param {(childId: string) => string} h.agentLang 添付の印を書く言語
 * @param {{ attachedKey: (p: string) => string, attachmentLine: (lang: string, p: string) => string }} h.format
 * @param {object} h.send メインと同じ送る核の道具（cmd・limitOp・randomId・receipts・saveReceipts・refreshOutbox）
 * @param {Set<string>} h.submitting 送っている途中の会話（メインと共有。二重に送らない）
 * @param {() => Promise<void>} h.settled 設定の保存が済むのを待つ
 * @param {(childId: string) => { cwd?: string, mode?: string }} h.sendOptions 送るときに添える作業場所・承認モード
 * @param {{ get: (childId: string) => object, on: Record<string, (childId: string, ...args: any[]) => void> }} h.controls チップ（モデル・effort・作業場所・承認モード）
 * @param {{ list: (id: string) => object[], schedules: (id: string) => object[], cancelSchedule: (id: string) => Promise<any>, sendScheduledNow: (id: string) => Promise<any> }} h.outbox
 * @param {() => Promise<object>} h.environment 送信の日時の面の前提（常駐しているか）
 * @param {(childId: string) => string} h.cwdOf スキル候補を引く作業場所
 * @param {(childId: string) => string} h.compactNote /compact を使えない理由
 * @param {(item: object) => void} h.onStop 中断ボタンを押した（送るものは呼び出し側が決める。web/work-stop.mjs）
 */
export function createWorkComposer(h) {
  const form = buildComposer(PREFIX);
  form.classList.add('wk-composer');
  form.noValidate = true;
  const els = composerEls(PREFIX, form);
  for (const part of UNUSED) if (els[part]) els[part].hidden = true;
  form.hidden = true;
  // 帯の文脈は表示だけ（圧縮のメニューは今の会話＝メインのもの。子には開かない）。メニューと、押せる印は外す
  els.contextStrip.hidden = true;
  els.contextMeterPop?.remove();
  for (const name of ['aria-haspopup', 'aria-expanded', 'aria-controls']) els.contextMeter.removeAttribute(name);
  els.contextMeter.setAttribute('role', 'img');
  els.contextMeter.tabIndex = -1;
  h.slot.append(form);
  const input = els.prompt;
  // 入力欄の無い子（ホストに任せた根）には、入力欄の位置に中断だけを出す。入力欄の中断と同じ部品（同じ形）
  const solo = document.createElement('div');
  solo.className = 'work-stop-only';
  solo.hidden = true;
  const soloButton = els.abort.cloneNode(true);
  soloButton.id = 'wkStopOnly';
  soloButton.hidden = false;
  solo.append(soloButton);
  h.slot.append(solo);
  els.abort.hidden = true;
  els.abort.onclick = soloButton.onclick = () => { if (shownItem) h.onStop?.(shownItem); };

  let childId = null, shownItem = null, saveTimer = null, noteTimer = null;
  const attachedBy = new Map();   // 子 -> 添付の札（子ごと。メインの state.attached とは別）
  const loaded = new Set();       // 下書きを欄に入れ終えた子（読み直しのたびに入れ直さない）

  const say = (text, sticky = false) => {
    clearTimeout(noteTimer);
    els.settingsError.textContent = text ?? '';
    if (text && !sticky) noteTimer = setTimeout(() => { els.settingsError.textContent = ''; }, 6000);
  };

  const paintSolo = (visible, disabled) => { solo.hidden = !visible; soloButton.disabled = disabled; };

  // ---- 書きかけ（子ごと。メインの下書きと同じ入れ物に、子の id で置く）
  const snapshot = () => ({ text: input.value ?? '', attached: att.items.slice(), editing: c.editor.snapshotEditing(), version: 2, dirty: true });
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!childId || !loaded.has(childId)) return Promise.resolve();
    return h.drafts.set(childId, snapshot()).catch(() => {});
  }
  const saveDraftSoon = () => { if (saveTimer === null) saveTimer = setTimeout(() => { saveDraft(); }, SAVE_WAIT_MS); };

  const c = createComposer({
    els, prefix: PREFIX, t,
    canSubmit: () => Boolean(childId),
    attach: {
      host: h.attachHost,
      owner: () => childId,
      store: { get: () => attachedBy.get(childId) ?? [], set: (items) => { if (childId) attachedBy.set(childId, items); } },
      accepts: () => c.wait.accepts(),
      say: (text) => say(text),
      notify: (text) => h.notify(text),
      onChange: () => saveDraftSoon(),
      changeOnAtoms: false,
      onRender: () => sync(),
      adopt: (owner, item) => h.adopt(owner, item),
      thumbnails: true,
      locale: () => (childId ? h.agentLang(childId) : undefined),
    },
    wait: { runMark, onChange: () => sync() },
    keys: [(e) => c.slash?.keydown(e)],
    onSubmit: () => submit(),
    onSchedule: () => c.sendMenu?.open(),
  });
  const att = c.attach;

  // 設定のチップ（モデルと effort・作業場所・承認モード）。値は子の行、変えると次のターンから効く（メインと同じ予約）
  c.useControls({
    cmd: h.cmd,
    get: () => h.controls.get(childId),
    on: Object.fromEntries(Object.keys(h.controls.on).map((name) => [name, (...args) => h.controls.on[name](childId, ...args)])),
  });
  c.useSchedule({
    context: () => ({ available: Boolean(childId && (input.value.trim() || att.items.length)) }),
    environment: () => h.environment(),
    onSchedule: (at) => submit({ at }),
    onSendNow: () => submit({ at: null }),
  });
  c.useSlash({
    cwd: () => (childId ? h.cwdOf(childId) : ''),
    canCompact: () => false,
    compactNote: () => (childId ? h.compactNote(childId) : ''),
    load: (cwd) => h.cmd('slashSkills', { cwd: cwd || undefined }),
    off: () => c.editor.inCode(),
  });

  // クリップ: この端末のファイルを選ぶ（メインの添付のメニューのうち、ホストのファイルの面はここでは出さない）
  els.attach.addEventListener('pointerdown', att.rememberAt, true);
  els.attach.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') att.rememberAt(); }, true);
  els.attach.addEventListener('click', () => { if (childId) els.fileIn.click(); });
  els.fileIn.onchange = () => { att.attachFiles([...els.fileIn.files]); els.fileIn.value = ''; };
  // 箱のどこを押しても字の欄へ（チップ・ボタンは除く）
  els.cbox.addEventListener('pointerdown', (e) => {
    if (e.target === input || e.target.closest?.('button, a, [role=button], input')) return;
    queueMicrotask(() => input.focus());
  });
  input.addEventListener('blur', () => { saveDraft(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });
  addEventListener('pagehide', () => { saveDraft(); });

  // ---- 送信待ち・予定
  const restoreText = (text, attached = []) => {
    if (input.value.trim()) input.setRangeText(`${text}\n\n`, 0, 0);
    else input.value = text;
    for (const a of attached) if (!att.byPath?.(a.path)) att.restore([...att.items, a]);
    att.placeTail?.();   // 文中に無い添付は字の欄の末尾に札で置く（一覧の面が無いので、置かないと見えない）
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    saveDraft();
  };
  /** 送るとき末尾に足した添付の印（composeSend）を外す。添付は札で戻すので、残すともう一度送ったとき印が二重になる */
  const withoutTailMarks = (prompt, list, id) => {
    let rest = prompt;
    for (const a of [...list].reverse()) {
      const line = h.format.attachmentLine(h.agentLang(id), a.path);
      if (rest.endsWith(line)) rest = rest.slice(0, -line.length).replace(/\s+$/, '');
    }
    return rest;
  };
  const scheduleActions = {
    now: async (entry) => { await h.outbox.sendScheduledNow(entry.id); },
    cancel: async (entry) => { await h.outbox.cancelSchedule(entry.id); },
    edit: async (entry) => {
      const taken = await h.outbox.cancelSchedule(entry.id);
      const args = taken?.entry?.args ?? entry.args ?? {};
      restoreText(args.prompt ?? '', (args.attachments ?? []).map((a) => ({ path: a.path, name: a.name, kind: 'file', mime: a.mime ?? '', from: 'host' })));
    },
  };
  /** 送信待ちの行を描く。メインの送信待ちと同じ部品（取り消す・編集・今すぐ送る） */
  function paintOutbox() {
    if (!childId) { els.outbox.replaceChildren(); return; }
    const id = childId;
    const queued = h.outbox.list(id);
    renderOutbox(els.outbox, queued, async (messageId, action) => {
      const row = queued.find((m) => m.id === messageId);
      await h.cmd('messageAction', { sessionId: id, messageId, action: action === 'edit' ? 'cancel' : action });
      // 送信待ちの項目は { id, status, args: { prompt, attachments } }。取り下げた本文と添付を入力欄へ戻す（予定の［編集］と同じ形）
      if (action === 'edit' && row && childId === id) {
        const list = row.args?.attachments ?? [];
        restoreText(withoutTailMarks(row.args?.prompt ?? '', list, id), list.map((a) => ({ path: a.path, name: a.name, kind: 'file', mime: a.mime ?? '', from: 'host' })));
      }
    }, new Set(), { schedules: h.outbox.schedules(id), scheduleActions, editQueued: true });
  }

  // ---- 送る
  const sender = createSender({
    ...h.send, t,
    scheduled: () => {},
    clearSent: (id, text, attachments) => clearSent(id, text, attachments),
    beforeSend: () => {}, afterSend: () => {},
    say: (text) => say(text),
  });
  const paths = (list) => JSON.stringify(list.map((a) => a.path).sort());
  /** 送った分の下書きを片付ける。送っている間に書き足していたら、書き足した分は残す（メインの clearSentDraft と同じ） */
  async function clearSent(id, text, attachments) {
    const shown = childId === id;
    const draft = shown ? { text: input.value, attached: att.items } : h.drafts.get(id);
    if (draft?.text !== text || paths(draft.attached ?? []) !== paths(attachments)) return;
    if (shown) {
      input.value = ''; att.restore([]); els.slashHint.textContent = ''; c.slash?.close(); c.fit();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else attachedBy.delete(id);
    await h.drafts.set(id, { text: '', attached: [], version: 2, dirty: true });
  }
  async function submit({ at = null } = {}) {
    const id = childId;
    if (!id || h.submitting.has(id)) return;
    if (c.wait.held) { c.wait.point(); return; }
    const blocked = att.blockReason();
    if (blocked) { h.notify(blocked); att.flash(); return; }
    h.submitting.add(id);
    sync();
    try {
      await h.settled(id);
      if (childId !== id) return;   // 待っている間に別の子へ移った。欄はその子の下書きなので送らない
      c.slash?.close();
      const text = input.value;
      const ordered = att.ordered();
      if (!text.trim() && !ordered.length) return;
      await sender.send({ sessionId: id, text, ordered, at, ...h.sendOptions(id), attachedKey: h.format.attachedKey, attachmentLine: h.format.attachmentLine,
        agentLang: h.agentLang(id), inDoc: c.editor.attachmentKeys() });
    } catch (e) {
      say(at ? t('schedule.scheduleFailed', { error: e.message }) : t('chat.send.failed', { error: e.message }), true);
    } finally {
      h.submitting.delete(id);
      sync();
      paintOutbox();
    }
  }

  /** 送信ボタンなどを今に合わせる */
  function sync() {
    if (!childId) return;
    els.send.disabled = h.submitting.has(childId) || c.wait.blocksSend() || Boolean(att.blockReason());
    els.sendMore.disabled = els.send.disabled || !(input.value.trim() || att.items.length);
    h.onSync?.(els, childId);
  }
  input.addEventListener('input', () => { sync(); saveDraftSoon(); });

  // ---- 子の切り替え
  function loadDraftFor(id, serverDraft = null) {
    const local = h.drafts.get(id);
    // 端末の下書きがまだサーバーへ届いていない（dirty）なら端末が正本。そうでなければサーバーの写し（読み込みで届く）
    const d = local?.dirty || !serverDraft ? local : serverDraft;
    att.dropFailed();
    attachedBy.set(id, Array.isArray(d?.attached) ? d.attached.slice() : []);
    c.editor.restoreDraft(typeof d?.text === 'string' ? d.text : '', d?.editing);
    att.restore(attachedBy.get(id));
    att.placeTail?.();
    c.fit();
    loaded.add(id);
  }
  return {
    el: form, composer: c, els,
    /** 詳細に出している子を替える。委譲の子（ホストに任せていない）だけ入力欄を出す */
    show(item) {
      const id = item && item.source === 'task' && !item.host && item.childId ? item.childId : null;
      shownItem = item ?? null;
      // 同じ子の見出しの描き直し（状態・経過時間）では、欄の中身も開いている面も触らない
      if (id === childId) { form.hidden = !id; return; }
      saveDraft();
      c.slash?.close();
      c.sendMenu?.close();
      c.controls?.close();
      childId = id;
      els.contextStrip.hidden = true;   // 次の子の値は呼び出し側が setContext で入れる
      say('');
      form.hidden = !id;
      if (!id) { paintOutbox(); return; }
      loadDraftFor(id);
      c.controls?.paint();
      paintOutbox();
      sync();
    },
    /** 読み込み（loadSession）で届いたサーバーの下書きを、まだ書いていない欄にだけ入れる */
    offerDraft(id, draft) {
      if (id !== childId || !draft || input.value.trim() || att.items.length) return;
      const local = h.drafts.get(id);
      if (local?.dirty || (!draft.text && !(draft.attached ?? []).length)) return;
      loadDraftFor(id, draft);
    },
    /** 設定のチップや送信ボタンを今の値に合わせる（子の行・語彙が変わったとき） */
    paintControls() { if (childId) c.controls?.paint(); },
    paintOutbox,
    sync,
    /** 外から入れる口（メインの入力欄の「会話で使う」・git の文と同じ形）。files は添付に積み、text は書きかけの末尾に足す */
    insert({ text = '', files = [] } = {}) {
      if (!childId) return false;
      let ok = true;
      if (files.length) ok = Boolean(att.attachHost(files));
      if (text) {
        const end = input.value.length;
        input.setRangeText(`${end ? String.fromCharCode(10) : ''}${text}`, end, end);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (ok) input.focus();
      return ok;
    },
    /**
     * 中断ボタンを出し入れする（web/work-stop.mjs の結果）。solo は入力欄の無い子で、入力欄の位置に中断だけを出す
     */
    setStop({ show = false, disabled = false, solo = false } = {}) {
      els.abort.hidden = !(show && !solo);
      els.abort.disabled = disabled;
      paintSolo(show && solo, disabled);
      c.controls?.fit();
    },
    /** 入力欄の上の帯に、この子の文脈の使用量を出す（parts: { nodes, label }。無ければ帯ごと隠す） */
    setContext(parts) {
      const on = Boolean(childId && parts);
      els.contextStrip.hidden = !on;
      els.contextMeterWrap.hidden = !on;
      if (!on) return;
      els.contextMeter.replaceChildren(...parts.nodes);
      els.contextMeter.setAttribute('aria-label', parts.label);
    },
    /** 欄の上の一行（保存できなかった理由など） */
    say,
    get childId() { return childId; },
    get item() { return shownItem; },
    get visible() { return !form.hidden; },
    focus() { if (childId) input.focus(); },
    saveDraft,
    /** 欄に書きかけがあるか（Esc の動きがメインと同じになるよう、呼び出し側が見る） */
    hasDraft() { return Boolean(childId && (input.value.trim() || att.items.length)); },
    hide() { saveDraft(); childId = null; shownItem = null; form.hidden = true; },
    destroy() { c.destroy(); form.remove(); },
  };
}
