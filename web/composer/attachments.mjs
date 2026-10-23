// 入力欄の添付（Chats の入力欄とチャンネル・スレッドの入力欄が共有する。docs/design-system.md「入力欄の編集欄」・「添付の出どころ」、ADR 0060・0116）。
// 入力欄 1 つ分の持ち物: 添付の実体（パス・名前・出どころ）・送っている途中のもの（仮の ID）・
// 字の欄の札（web/md-editor.mjs の原子）へ渡す口・貼り付け・ドロップ・送れない理由。添付は札だけで見せる（一覧の面・入口は持たない。ADR 0252）。
// 違いは引数で受ける: 持ち主（下書きの key）・置き場の分け先・添付の実体の置き場（Chats は state.attached）・ボタンと隠した file input を
// 自分で作るか（チャンネル）受け取るか（Chats は + の添付の面を持つので client.mjs が配線する）・画像の縮小を作るか。
import { el, icon, randomId } from '../dom.mjs';
import { t, lang } from '../i18n.mjs';
import { sendAttachment, ATTACH_MAX_BYTES, IMAGE_READ_HINT_BYTES } from '../attach-upload.mjs';
import { formatBytes } from '../folder-upload.mjs';
import { createPasteImages } from '../paste-images.mjs';
import { attachFolderHints } from '../composer-layout.mjs';
import { attachedKey, composeBody } from '../channels/ch-attach-model.mjs';

/** 添付の + （入力欄の行の先頭。docs/design-system.md「入力欄と上端」） */
export const PLUS = 'M12 5v14M5 12h14';

/** 添付の画像を大きく見る URL（/local-file。認証はクッキー）。パスが無ければ縮小の data URI */
export const attachedImageSrc = (a) => (a.path ? `/local-file?path=${encodeURIComponent(a.path)}` : a.dataUri);

/** 画像の添付の縮小（入力欄の札に出す 112px）。下書きに残すので小さく作る。作れなければ null */
export async function thumbnailOf(file) {
  if (typeof createImageBitmap !== 'function') return null;
  const bmp = await createImageBitmap(file);
  try {
    const k = Math.min(1, 112 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    // 縦横は、送った直後の吹き出しの枠の大きさに使う（web/attachment-frame.mjs）
    return { dataUri: c.toDataURL('image/jpeg', 0.85), width: bmp.width, height: bmp.height };
  } finally { bmp.close?.(); }
}

/**
 * @param {object} o
 * @param {{ cmd: Function, whenOnline?: Function, openImage?: Function, filePreview?: object }} o.host
 * @param {() => string|null} o.owner いまの下書きの持ち主。送っている間に別の持ち主へ移っても、届いたものは元の持ち主へ入れる
 * @param {() => string|null} [o.bucket] 置き場の分け先（チャンネルの id）。省けば持ち主（会話の id）を置き場の分け先にする
 * @param {{ get: () => object[], set: (items: object[]) => void }} [o.store] 添付の実体の置き場（省けば中に持つ）
 * @param {() => boolean} [o.accepts] 添付を受け付ける間か（書けない待ち・アーカイブでは false）
 * @param {(text: string) => void} o.say 失敗などの一行
 * @param {(text: string) => void} [o.notify] 「もう添付しています」など画面下の短い知らせ（省けば say）
 * @param {() => void} [o.onChange] 添付が増減した（下書きの保存）
 * @param {boolean} [o.changeOnAtoms] 字の欄の札の出入り（Backspace・元に戻す）でも onChange を呼ぶか
 * @param {() => void} [o.onRender] 添付の状態を描き直したあと（送信ボタンの状態を合わせる）
 * @param {(owner: string|null, item: object) => void|Promise<void>} o.adopt 別の持ち主へ移った後に届いた添付を、その持ち主の下書きへ入れる
 * @param {boolean} [o.controls] クリップのボタンと隠した file input を自分で作るか
 * @param {boolean} [o.thumbnails] 画像の縮小を作るか（下書きと送った直後の吹き出しの枠に使う）
 * @param {() => string} [o.locale] 添付の印の言語
 * @param {Function} [o.sendFile] 断片の送り手（web/attach-upload.mjs の sendAttachment。テストが差し替える）
 */
export function createComposerAttachments({ host, owner, bucket = null, store = null, accepts = () => true, say, notify = say, onChange = () => {},
  changeOnAtoms = true, onRender = () => {}, adopt, controls = false, thumbnails = false,
  locale = () => lang, sendFile = sendAttachment }) {
  let own = [];
  const items = store ?? { get: () => own, set: (v) => { own = v; } };
  const uploads = new Map();
  const removed = new Map();   // 元に戻すで札が戻ったとき、添付の実体も戻す
  let editor = null, input = null, hintSig = '', memo = null;
  const bucketOf = (u) => (bucket ? u.bucket : u.owner);

  let button = null, fileInput = null;
  if (controls) {
    fileInput = el('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    button = el('button', 'btn btn-icon ch-attach');
    button.type = 'button';
    button.title = t('chat.composer.attach');
    button.setAttribute('aria-label', t('chat.composer.attach'));
    button.append(icon(PLUS));
  }

  const attached = () => items.get();
  const byPath = (path) => attached().find((a) => attachedKey(a.path) === attachedKey(path)) ?? null;
  const hintsOf = () => attachFolderHints(attached(), { deviceLabel: t('chat.attach.deviceFolder') });
  /**
   * この持ち主の、まだ届いていない添付（送信中・失敗）。札を外した（やめた）ものは数えない。
   * 持ち主がまだ無い間（新しい会話を作っている）に始めたものは owner が null で、できたら adoptOwner が付け替える
   */
  const mine = () => [...uploads.values()].filter((u) => !u.gone && u.owner === (owner() ?? null) && (!u.cancelled || editor?.hasAttachment(`i:${u.id}`)));

  // ---------------------------------------------------------------- 字の欄へ渡すもの（createMarkdownEditor の引数）
  /** 送っている途中の添付（仮の ID）の見え方。札が進み具合（%）と失敗の理由を出す */
  const pending = (pid) => {
    const u = uploads.get(pid);
    if (!u) return null;
    // ホストが取りに行っている画像。失敗の札は無い（取れなければ札ごと静かに消える）
    if (u.import) return { name: u.name, state: 'importing', host: u.import.host };
    const failed = u.failed || u.cancelled;
    return { name: u.name, size: u.size, state: failed ? 'failed' : 'sending', percent: u.size ? Math.floor((u.sent / u.size) * 100) : 0,
      error: u.failed ?? (u.cancelled ? t('chat.composerAtt.cancelled') : '') };
  };
  /** 字の欄の札に出す添付の情報（同じ名前の札には見分けのフォルダー hint を添える） */
  const resolve = (path) => {
    const a = byPath(path);
    return a ? { ...a, hint: hintsOf()[attached().indexOf(a)] || '' } : null;
  };
  /** 利用者の操作（Backspace・切り取り・元に戻す・やり直し・札の ×）で字の欄の添付が出入りした */
  const onAtoms = ({ added, removed: gone }) => {
    for (const key of gone) {
      if (key.startsWith('p:')) {
        const list_ = attached();
        const i = list_.findIndex((a) => attachedKey(a.path) === key);
        if (i >= 0) removed.set(key, list_.splice(i, 1)[0]);
      } else {
        const u = uploads.get(key.slice(2));
        if (u?.import) pasteImages.cancel(u);   // 取り込み中の札を外した・元に戻した: 取得もやめる
        // 送っている途中はやめる。失敗した札（「外す」）も、札が無い間は送信を止めない（元に戻すで札が戻れば、また止める）
        else if (u) u.cancelled = true;
      }
    }
    for (const key of added) {
      if (!key.startsWith('p:')) continue;
      const a = removed.get(key);
      if (a && !byPath(a.path)) { attached().push(a); removed.delete(key); }
    }
    render();
    if (changeOnAtoms) onChange();
  };
  const onAtomAction = (act, key) => {
    if (act === 'retry') { const u = uploads.get(key.slice(2)); if (u) runUpload(u); return; }
    removeAttachment(key);
  };
  const editorOptions = {
    resolve, pending, onAtoms, onAtomAction,
    // 貼り付けた HTML の画像（data: はその場で、https はホストが取りに行く。ADR 0141）。書けない間は取り込まない
    importImages: (images) => (accepts() ? pasteImages.start(images) : []),
    locale,
    onZoom: (info) => host.openImage?.(attachedImageSrc(info), info.name, info.path),
    onOpenFile: (info, anchor) => host.filePreview?.open({ path: info.path, line: null }, anchor),
  };

  // ---------------------------------------------------------------- 描き直し（札の見分けの hint と、送信ボタンの状態）
  function render() {
    // 同じ名前の添付が増えた・減った: 札に添える見分けのフォルダーが変わるので札を描き直す
    const hints = hintsOf().map((h, i) => (h ? `${attachedKey(attached()[i].path)}=${h}` : '')).filter(Boolean).join('|');
    if (hints !== hintSig) { hintSig = hints; editor?.refresh(); }
    onRender();
  }

  /** 添付を外す（札があれば札ごと。文末に付くものは実体だけ）。送っている途中ならやめる */
  function removeAttachment(key) {
    if (editor.removeAttachment(key)) return;
    if (key.startsWith('p:')) {
      const all = attached();
      const i = all.findIndex((a) => attachedKey(a.path) === key);
      if (i >= 0) all.splice(i, 1);
    } else {
      const u = uploads.get(key.slice(2));
      if (u) { u.cancelled = true; if (u.failed) uploads.delete(u.id); }
    }
    render();
    onChange();
  }

  /** 送れない理由を知らせたとき、理由の札（送信中・失敗・取り込み中）を短く強調する */
  function flash() {
    for (const div of input?.querySelectorAll('.md-att[data-pid]') ?? []) {
      div.classList.remove('flash');
      void div.offsetWidth;
      div.classList.add('flash');
      div.addEventListener('animationend', () => div.classList.remove('flash'), { once: true });
    }
  }

  // ---------------------------------------------------------------- 送る
  /** + を押した時点の字の欄の位置（メニューやファイルの選択でフォーカスが移っても、そこへ札を置く。2 分で忘れる） */
  const rememberAt = () => { memo = { at: editor?.rememberCaret(), time: Date.now() }; };
  const takeAt = () => { const m = memo; memo = null; return m && Date.now() - m.time < 120_000 ? m.at : null; };

  /**
   * この端末のファイルを添付として送る（ドロップ・貼り付け・+ の選択）。1 件 100MB まで・件数の上限は無い。
   * 字の欄のカーソル（ドロップは落とした位置、+ は開く前の位置）に仮の札を先に置き、中身は断片で送って（web/attach-upload.mjs）
   * 札が進み具合（%）を出す。終わったらパスを持つ普通の札になる
   */
  async function attachFiles(files, { at = takeAt() } = {}) {
    // 書けない待ち（会話を開いている・送信を予約した）の間に積むと、開いた会話の下書きで消されるか予約した送信に紛れる
    if (!accepts()) return;
    const queue = [];
    for (const file of files) {
      if (file.size > ATTACH_MAX_BYTES) { say(t('chat.attach.tooLarge', { name: file.name, limit: formatBytes(ATTACH_MAX_BYTES) })); continue; }
      const u = { id: randomId(), file, name: file.name, size: file.size, sent: 0, owner: owner() ?? null, bucket: bucket?.() ?? null, cancelled: false, failed: null, placed: false };
      uploads.set(u.id, u);
      u.placed = editor.insertAttachment({ pid: u.id }, { at }) === 'inserted';
      at = null;
      queue.push(u);
    }
    render();
    for (const u of queue) await runUpload(u);
  }

  /** 1 件を送る（最初と「再試行」）。仮の札を、届いたパスを持つ札に替える */
  async function runUpload(u) {
    u.failed = null; u.cancelled = false; u.sent = 0;
    editor.updatePending(u.id);
    render();
    const { file } = u;
    try {
      const isImage = /^image\//.test(file.type);
      const [r, thumb] = await Promise.all([
        sendFile({ cmd: host.cmd, file, sessionId: bucketOf(u), cancelled: () => u.cancelled, online: host.whenOnline,
          onProgress: (sent) => { u.sent = sent; paint(u); } }),
        thumbnails && isImage ? thumbnailOf(file).catch(() => null) : null,
      ]);
      if (!r || u.cancelled) { u.cancelled = true; render(); return false; }   // やめた（札は外れている）
      const item = { name: file.name, path: r.path, kind: r.kind, mime: file.type, from: 'device', size: file.size,
        ...(thumb ? { dataUri: thumb.dataUri, width: thumb.width, height: thumb.height } : {}) };
      await settleUpload(u, item);
      // エージェントは画像をパスから自分の道具で読む。大きな画像は画像として読めないことがある（Claude の API は 1 枚 5MB まで）
      if ((thumbnails ? isImage : r.kind === 'image') && file.size > IMAGE_READ_HINT_BYTES) say(t('chat.attach.largeImage', { name: file.name, size: formatBytes(file.size) }));
      return true;
    } catch (e) {
      u.failed = e?.message ?? String(e);
      // 札が字の欄にあれば札に理由・再試行・外すを出す。札の無い（平文の間など）失敗は一行で
      if (u.placed && editor.hasAttachment(`i:${u.id}`)) editor.updatePending(u.id);
      else { uploads.delete(u.id); say(t('chat.attach.failed', { name: file.name, error: u.failed })); }
      render();
      return false;
    }
  }

  /**
   * 届いた添付（item）を持ち主の下書きへ入れて、仮の札をパスの札に替える（ファイルの送信・貼り付けた画像の取り込みが使う）。
   * 持ち主は届いた時点で読む（新しい会話を作っている間に始めたものは、できた会話の id に付け替わっている: adoptOwner）
   */
  async function settleUpload(u, item) {
    if (u.owner === (owner() ?? null)) {
      uploads.delete(u.id);
      attached().push(item);
      editor.resolvePending(u.id, item.path);
      render();
      onChange();
    } else {
      // 送っている間に別の持ち主へ移った。持ち主の下書きへ積む（位置は持たない: 文末に付く）。保存できたら札を消す
      await adopt(u.owner, item);
      uploads.delete(u.id);
      render();
    }
  }

  /** 貼り付けた HTML の画像の取り込み（web/paste-images.mjs。ADR 0141）。送信中の一覧（uploads）に載せ、送れない間・下書きは添付と同じ扱い */
  const pasteImages = createPasteImages({
    cmd: (command, args) => host.cmd(command, args),
    editor: () => editor,
    entry: (base) => {
      const u = { sent: 0, owner: owner() ?? null, bucket: bucket?.() ?? null, cancelled: false, failed: null, placed: true, ...base };
      uploads.set(u.id, u);
      return u;
    },
    bucketOf,
    uploadFile: (u) => runUpload(u),
    finished: async (u, r) => {
      await settleUpload(u, { name: r.name, path: r.path, kind: 'image', mime: r.mime, from: 'import', size: r.bytes });
      if (r.bytes > IMAGE_READ_HINT_BYTES) say(t('chat.attach.largeImage', { name: r.name, size: formatBytes(r.bytes) }));
    },
    dropped: (u) => { uploads.delete(u.id); render(); },
    registered: () => render(),
  });

  // ---- 送っている途中の添付。字の欄の札に進み具合（%）を出す
  function paint(u) {
    editor.updatePending(u.id);
  }

  /**
   * ホストのファイルをパスのまま添付に積む（送らない。ファイルプレビューの「会話で使う」とホストのファイルの面）。
   * 字の欄の、+ を開く前の位置（無ければ今のキャレット）に札を置く。件数の上限は無い。同じパスは 1 つだけ。積めたら true
   */
  function attachHost(files, { at = takeAt() } = {}) {
    if (input?.disabled || !accepts()) return false;
    let added = 0, already = 0;
    for (const file of files) {
      if (!file?.path) continue;
      const existing = byPath(file.path);
      // 同じパスは札を増やさず、画面下の短い知らせで伝える。文中に置いていない添付（文末に付く）は、ここで位置に置く
      if (existing && editor.hasAttachment(attachedKey(file.path))) { already++; continue; }
      if (!existing) attached().push({ path: file.path, name: file.name, kind: 'file', mime: file.mime ?? '', from: 'host', ...(Number.isFinite(file.size) ? { size: file.size } : {}) });
      editor.insertAttachment({ path: file.path }, { at });
      at = null;
      added++;
    }
    if (added) { render(); onChange(); }
    if (already && !added) notify(t('chat.attach.already'));
    return true;
  }

  // ---------------------------------------------------------------- ドロップ・貼り付け・選択
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

  /** zone に落とされたファイルを添付にする（チャンネル・スレッドの板）。落とした位置が字の欄の上ならその位置へ。フォルダーは添付できないので知らせる */
  function bindDropZone(zone) {
    let depth = 0;
    const show = (on) => zone.classList.toggle('dropping', on);
    // 親（Chats の入力欄の受け口は main 全体）へ伝えない: チャンネルの画面に落としたファイルが Chats の入力欄へ入らないように
    zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); if (accepts()) { depth++; show(true); } });
    zone.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = accepts() ? 'copy' : 'none'; });
    zone.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; e.stopPropagation(); if (--depth <= 0) { depth = 0; show(false); } });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation(); depth = 0; show(false);
      if (!accepts()) return;
      const entries = [...(e.dataTransfer.items ?? [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null));
      const files = [...(e.dataTransfer.files ?? [])].filter((_, i) => !entries[i]?.isDirectory);
      if (files.length < (e.dataTransfer.files?.length ?? 0)) say(t('channels:feed.attach.folder'));
      if (files.length) attachFiles(files, { at: editor.posFromPoint(e.clientX, e.clientY) });
    });
  }

  // ---------------------------------------------------------------- 状態
  /** 字の欄ができた後に結ぶ（字の欄の引数に editorOptions を渡すので、作る順が逆になる）。貼り付け（スクショを撮ってそのまま貼る動線）もここで受ける */
  function bind(ed, el_) {
    editor = ed; input = el_;
    el_.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      attachFiles(files);
    });
    if (!controls) return;
    button.addEventListener('pointerdown', rememberAt, true);
    button.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') rememberAt(); }, true);
    button.addEventListener('click', () => { if (accepts()) fileInput.click(); });
    fileInput.onchange = () => { attachFiles([...fileInput.files]); fileInput.value = ''; };
  }

  return {
    button, fileInput, editorOptions, bind, bindDropZone, render, flash, rememberAt, takeAt,
    attachFiles, attachHost, removeAttachment, byPath, info: resolve,
    get items() { return attached().slice(); },
    /** 送っている途中のもの（仮の ID → 状態）。テストと診断が読む */
    uploads,
    /** この持ち主の、まだ届いていない添付 */
    here: mine,
    /** 送れない理由（送信中・失敗の添付があるとき）。無ければ null。欠けた添付を前提に動き出さないように、届くまで送らない */
    blockReason() {
      const here = mine();
      if (here.some((u) => u.failed || u.cancelled)) return t('chat.composerAtt.blockFailed');
      if (!here.length) return null;
      return here.every((u) => u.import) ? t('chat.composerAtt.blockImporting') : t('chat.composerAtt.blockSending');
    },
    /** 添付を字の欄の位置の順に並べる。文中に無いものは後ろ（文末に付く） */
    ordered() {
      const order = [...editor.attachmentKeys()];
      const rank = (a) => { const i = order.indexOf(attachedKey(a.path)); return i < 0 ? order.length : i; };
      return attached().map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
    },
    /** 送るもの（本文と、channels.post の attachments） */
    compose: (value) => composeBody(value, attached(), editor.attachmentKeys(), locale()),
    /** 持ち主の付け替え（新しい会話の欄で始めた添付 → できた会話・切り離した "" の欄） */
    adoptOwner(from, to) { for (const u of uploads.values()) if (u.owner === from) u.owner = to; },
    /** 下書きを入れ替えた: 失敗・取り消した送信中のものを捨てる */
    dropFailed() { for (const [id, u] of uploads) if (u.cancelled || u.failed) uploads.delete(id); },
    /**
     * 文中に無い添付（古い下書き・別の会話へ移った後に届いたもの・予定から戻したもの）を、字の欄の末尾に札として置く。
     * 一覧の面が無いので、札にしないと見えない。字の欄の値を入れた後に呼ぶ（restore の中では呼ばない: 字の欄はまだ前の文書）。
     * 平文の間は置けない（送るときに文末へ印を足す。composeBody）
     */
    placeTail() {
      if (!editor) return;
      const inDoc = editor.attachmentKeys();
      const tail = attached().filter((a) => !inDoc.has(attachedKey(a.path))).map((a) => a.path);
      if (tail.length) editor.placeAtEnd(tail);
    },
    /** 下書きの添付の実体を置く。字の欄の値を入れる前に呼ぶ（本文の印は、ここにあるものだけが札になる） */
    restore(list_) {
      items.set(Array.isArray(list_) ? list_.filter((a) => a && typeof a.path === 'string').map((a) => ({ ...a })) : []);
      this.dropFailed();
      removed.clear();
      render();
    },
    /** 送った・書き直す前: 添付の実体を空にする（送っている途中のものは持ち主の下書きの分として残る） */
    clear() { items.set([]); removed.clear(); render(); },
    get hasContent() { return attached().length > 0 || mine().length > 0; },
  };
}
