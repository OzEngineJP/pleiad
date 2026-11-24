// 入力欄の下の設定（docs/design-system.md「入力欄の設定」）。
//
// 「どこで」（作業ディレクトリ）「誰が・どれだけ考えて」（エージェント・モデル・エフォート・アカウント）
// 「どこまで任せるか」（承認モード）を 2 つのチップにまとめる。モデルの面は 2 段（1 段目の行を押すと一覧。承認モードは最後の行）で、
// 既定から外れているときだけモデルのチップに印を出す（ADR 0252）。チップは押すと上へ浮く面（ポップオーバー）を開く。
//
//   - チップの字は全部同じ色・太さ。「既定から外れている」を色で示さない（既定が見えないと意味が伝わらないため）。
//     代わりにチップは**実際に使う値**を出す（例: Opus 5.5 · high）。一覧では「既定」は札として添えるだけ。
//     承認モードの印だけは既定から外れたときに出す（盾と名前を --ink-blue。Bypass（範囲 full・自律 never）は ⚠ と強い字）
//   - 値はここでは持たない。get() が毎回 client.mjs の状態から読み、変更は on.*() で client.mjs に返す
//   - キーボード: チップは button（Enter / Space で開く）。Esc は 1 段戻り、1 段目なら閉じてチップへ戻る。一覧の中は ↑↓ で移る。
//     面の外を押すと閉じる。面は画面の幅に収める（360px の画面でもはみ出さない）
import { el, svgEl, relTime } from "./dom.mjs";
import { isComposingKey } from "./keyboard.mjs";
import { resolvedModel, effortStops, modelChipLabel, modelRowIds, holdsDefault, endpointChipLabel, splitModelRows, agentRowUsage } from "./composer-labels.mjs";
import { compatModelLabel, modelCandidates, searchModels, resolveTyped, moreText, ONE_M_TITLE } from "./compat-models.mjs";
import { t } from "./i18n.mjs";
import { splitChipLabel } from "./composer-layout.mjs";
import { runMark } from "./arc.mjs";
import { botIcon } from "./channels/bot-icon.mjs";
import { backendLogo } from "./side.mjs";
import { percentText } from "./header-usage.mjs";

/** 一覧の「既定」の札 */
const DEFAULT_TAG = () => t("chat.model.default");

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const FOLDER_ADD = "M12 11v5M9.5 13.5h5";
// 入れ替わりの印（⇄。安全装置でモデルが替わったとき）
const SWITCH = ["M5 8.5h14M15.5 5l3.5 3.5-3.5 3.5", "M19 15.5H5M8.5 12L5 15.5 8.5 19"];
const SHIELD = "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z";
// Bypass のときに盾と入れ替える ⚠ の線画（字には ⚠ を書かない。記号は 1 つ）
const WARN = ["M12 3.5l9.5 16.5h-19z", "M12 10v4.5M12 17.2v.3"];
// モデルのアイコン（チップの形を 3 つそろえるため。2026-09-23 に足した）
const MODEL = ["M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z", "M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"];
const CARET = "M7 10l5 5 5-5";
/** チップのアイコン（作業フォルダー・モデル・承認モード。スレッドの欄も同じ絵を使う。web/channels/thread-composer.mjs） */
export const chipGlyph = (kind) => glyph(...(kind === "cwd" ? [FOLDER] : kind === "model" ? MODEL : kind === "danger" ? WARN : [SHIELD]));
/** チップの ▾（480px 以下は CSS が消す） */
export function chipCaret() {
  const caret = glyph(CARET);
  caret.classList.add("caret");
  return caret;
}


let measureCtx = null;
/** チップの幅と、名前の先頭 N 字（と …）の幅を返す。frame は名前以外（アイコン・余白・▾・札） */
function nameBox(chip) {
  const name = chip.querySelector(".v .mn") ?? chip.querySelector(".v") ?? chip;
  const whole = chip.getBoundingClientRect().width;
  const frame = whole - name.getBoundingClientRect().width;
  const chars = [...(name.textContent ?? "").trim()];
  const font = getComputedStyle(name).font;
  return { whole, frame, prefix(n) {
    if (chars.length <= n) return Infinity;
    measureCtx ??= document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    return measureCtx.measureText(`${chars.slice(0, n).join("")}…`).width + 1;
  } };
}

const FIT_CLASSES = ["fit-nosplit", "fit-nobranch", "fit-short", "fit-noef", "fit-nomodel", "fit-cwd-icon", "fit-mode-icon", "fit-model-icon"];
/**
 * 入力欄の下の行を 1 行に収める（Chats とスレッドで同じ。docs/design-system.md「入力欄の設定」）。
 * ① ブランチ・段を外す・承認モードを短い名前に ② bot なら「· モデル」を外して名前だけ
 * ③ 作業ディレクトリ 9 → 7 字・宛先とモデル 6 字（bot なしのモデル名は 4 字）まで … で詰める
 * ④ それでも入らなければ 作業ディレクトリ → 承認モード → 宛先とモデル の順にアイコンだけ。送信は常に右端
 * 承認モードは、スレッドの欄ではチップ（.chip.mode）、Chats の欄ではモデルのチップの中の印（.mk）。どちらも同じ段で縮む
 */
export function fitComposerRow(row, { cwd, who }) {
  if (!row || !row.isConnected || !row.offsetParent) return;
  row.classList.remove(...FIT_CLASSES);
  cwd.style.minWidth = ""; who.style.minWidth = "";
  // スマホは両方の名前を同じ行で省略する。最小字数やアイコンだけにする段は使わない。
  if (matchMedia("(max-width:700px)").matches) return;
  row.classList.add("measuring");
  // 最後の部品（送信）の右端が行の右端に収まるか（scrollWidth は整数に丸められ、1px 足りないのを見逃す）
  const fits = () => {
    const last = [...row.children].reverse().find((n) => n.offsetParent);
    return !last || last.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.01;
  };
  for (const cls of ["fit-nosplit", "fit-nobranch", "fit-short", "fit-noef"]) if (!fits()) row.classList.add(cls);
  const bot = who.classList.contains("with-bot");
  if (!fits() && bot) row.classList.add("fit-nomodel");
  let size = null;
  if (!fits()) size = { cwd: nameBox(cwd), who: nameBox(who) };
  row.classList.remove("measuring");
  if (!size) return;
  // 名前の最小の幅は、名前の先頭 N 字と … を実際の書体で測った幅（ch では日本語・プロポーショナルの字の幅に合わない）。
  // もともと N 字以下の名前は削らない
  const min = (box, chars) => `${Math.ceil(Math.min(box.whole, box.frame + box.prefix(chars)))}px`;
  for (const [a, b] of [[9, 6], [7, bot ? 6 : 4]]) {
    cwd.style.minWidth = min(size.cwd, a);
    who.style.minWidth = min(size.who, b);
    if (fits()) return;
  }
  // アイコンだけにする段でも、宛先とモデルの名前は 6 字（bot なしは 4 字）より削らない（自分がアイコンだけになるまで）
  cwd.style.minWidth = "";
  for (const cls of ["fit-cwd-icon", "fit-mode-icon", "fit-model-icon"]) {
    if (cls === "fit-model-icon") who.style.minWidth = "";
    row.classList.add(cls);
    if (fits()) return;
  }
}

// git のブランチの線画（円 3 つと線。glyph は path だけなので別に作る）
function branchGlyph() {
  const svg = svgEl("svg", { class: "i", viewBox: "0 0 24 24", "aria-hidden": "true" });
  for (const [cx, cy] of [[6.75, 5.4], [6.75, 18.6], [17.25, 8.1]]) svg.append(svgEl("circle", { cx, cy, r: 2.4 }));
  svg.append(svgEl("path", { d: "M6.75 7.8v8.4M17.25 10.5c0 3.3-2.4 4.35-5.4 4.8-2.85.45-5.1 1.05-5.1 2.1" }));
  return svg;
}

function glyph(...paths) {
  const svg = svgEl("svg", { class: "i", viewBox: "0 0 24 24", "aria-hidden": "true" });
  for (const d of paths) svg.append(svgEl("path", { d }));
  return svg;
}

/** ひとつ上のフォルダー（D:\work\my-app → D:\work、D:\work → D:\）。根なら null */
export function parentOf(p) {
  const s = String(p ?? "").replace(/[\\/]+$/, "");
  const at = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (at < 0) return null;
  const up = s.slice(0, at);
  if (/^[A-Za-z]:$/.test(up)) return `${up}\\`;
  return up || (s.startsWith("/") ? "/" : null);
}

/** パスの末尾（D:\work\my-app → my-app）。ドライブの根はそのまま */
export function baseName(p) {
  const parts = String(p ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] + (parts.length === 1 && /:$/.test(parts[0]) ? "\\" : "") : String(p ?? "");
}

/** 承認モードが「確認なし・制限なし」か（core/modes.mjs の軸: 範囲 full・自律 never） */
export const isDanger = (m) => m?.scope === "full" && m?.autonomy === "never";

/** 既定の承認モード。client.mjs の selectedMode と同じ規則（default が無ければ先頭） */
export const defaultModeOf = (modes) => ("default" in (modes ?? {}) ? "default" : Object.keys(modes ?? {})[0] ?? "");

// 字を決める関数は DOM を触らない別の口（web/composer-labels.mjs。テストから直接呼ぶ）
export { resolvedModel, effortStops, modelChipLabel } from "./composer-labels.mjs";

// ---------------------------------------------------------------- 浮く面

let openPanel = null;   // 同時に開くのは 1 枚だけ

/**
 * チップ（押すもの）の上に浮く面。同時に開くのは 1 枚だけで、面の外を押すと閉じる。
 * width は面の幅（px。関数なら開くたび・置き直すたびに読む）。添付のメニュー（web/attach-menu.mjs）も使う。
 * when は開いてよいか（false なら押しても開かない）。
 * onHide は閉じたとき（Esc・面の外・チップ・選んで閉じた、のどれでも）
 */
export function panel(chip, pop, { align = "left", render, onShow, onHide, width: wantWidth = 360, when, flip = false, initialFocus, beforeShow }) {
  const self = {
    chip, pop,
    get open() { return !pop.hidden; },
    show(focus = true) {
      if (openPanel && openPanel !== self) openPanel.hide(false);
      openPanel = self;
      beforeShow?.();
      pop.hidden = false;
      chip.setAttribute("aria-expanded", "true");
      views.delete(pop);   // モデルの面は開くたびに 1 段目から
      render();
      self.place();
      onShow?.();
      if (focus) ((initialFocus ? pop.querySelector(initialFocus) : null) ?? pop.querySelector('[aria-selected="true"]') ?? pop.querySelector(".cpath") ?? pop.querySelector("input:not([type=range]):not(:disabled), button:not(:disabled), [tabindex='0']"))?.focus();
    },
    hide(returnFocus = true) {
      if (pop.hidden) return;
      pop.hidden = true;
      chip.setAttribute("aria-expanded", "false");
      if (openPanel === self) openPanel = null;
      onHide?.();
      if (returnFocus) chip.focus();
    },
    /** チップの上に浮かせる。幅は画面に収め、チップの端に揃える（右のチップは右端） */
    place() {
      if (pop.hidden) return;
      const r = chip.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(typeof wantWidth === "function" ? wantWidth() : wantWidth, vw - 16);
      pop.style.width = `${width}px`;
      const want = align === "right" ? r.right - width : r.left;
      const left = Math.round(Math.max(8, Math.min(want, vw - 8 - width)));
      const bottom = Math.round(window.innerHeight - r.top + 6);
      pop.style.left = `${left}px`;
      if (flip) {
        const above = r.top - 12;
        const below = window.innerHeight - r.bottom - 12;
        const down = below > above && above < pop.scrollHeight;
        pop.style.top = down ? `${Math.round(r.bottom + 6)}px` : '';
        pop.style.bottom = down ? '' : `${bottom}px`;
        pop.style.maxHeight = `${Math.max(0, Math.round(down ? below : above))}px`;
        return;
      }
      pop.style.bottom = `${bottom}px`;
      pop.style.maxHeight = `${Math.max(160, Math.round(r.top - 12))}px`;
      // 変形した祖先（スレッドの板の transform）の中では、fixed の位置がその祖先に対して決まる。ずれた分を戻す
      const got = pop.getBoundingClientRect();
      const dx = got.left - left, dy = got.bottom - (window.innerHeight - bottom);
      if (Math.abs(dx) > 0.5) pop.style.left = `${Math.round(left - dx)}px`;
      if (Math.abs(dy) > 0.5) pop.style.bottom = `${Math.round(bottom + dy)}px`;
    },
    render,
  };
  const may = () => !when || when();
  if (may()) { chip.setAttribute("aria-haspopup", "dialog"); chip.setAttribute("aria-expanded", "false"); }
  chip.addEventListener("click", () => (self.open ? self.hide() : may() && self.show()));
  chip.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !self.open && may()) { e.preventDefault(); self.show(); }
  });
  pop.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      // モデルの面の 2 段目なら 1 段目へ戻り、開いた行へ。1 段目なら閉じる
      const v = views.get(pop);
      if (v && v.view !== "top") {
        views.set(pop, { view: "top", q: "" });
        self.render();
        self.place();
        pop.querySelector(`[data-key="nav:${v.view}"]`)?.focus({ preventScroll: true });
        return;
      }
      self.hide();
      return;
    }
    const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // モデルの面（2 段の面）: ↑↓ で行・エフォートの棒・検索の欄を上から順に移る（端で止まる）。
    // 押せない行の中の操作（使えないエージェントの「入れる」など）からは、その前後の行へ
    if (e.target.closest?.(".prow, .eslider, .psearch")) {
      e.preventDefault();
      const items = [...pop.querySelectorAll("button.prow:not([aria-disabled=true]), .eslider:not([aria-disabled=true]), .psearch input")];
      const down = e.key === "ArrowDown";
      const at = items.indexOf(e.target);
      const next = at >= 0 ? items[Math.max(0, Math.min(items.length - 1, at + (down ? 1 : -1)))]
        : down ? items.find((n) => after(e.target, n)) : items.filter((n) => after(n, e.target)).pop();
      next?.focus({ preventScroll: false });
      return;
    }
    // 一覧の中を移る。入力欄からは ↓ で入力欄より後ろにある最初の一覧の先頭へ（互換の接続先のモデルの欄は
    // 接続先の一覧の下にあるので、面の最初の一覧ではなく直下のモデルの候補へ）。一覧の先頭で ↑ は直前の入力欄、無ければ選んでいる宛先の札へ
    const from = e.target.closest?.("[role=option]");
    const list = from?.closest("[role=listbox]");
    if (!from && e.target.matches?.("input:not([type=range])") && e.key === "ArrowDown") {
      const first = [...pop.querySelectorAll("[role=listbox]:not([hidden]) [role=option]:not(:disabled):not([aria-disabled=true])")].find((o) => after(e.target, o));
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }
    if (!list) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll("[role=option]:not(:disabled):not([aria-disabled=true])")];
    const i = rows.indexOf(from) + (e.key === "ArrowDown" ? 1 : -1);
    if (i < 0) {
      const input = [...pop.querySelectorAll("input:not([type=range])")].filter((n) => after(n, list)).pop();
      input?.focus();
      return;
    }
    rows[Math.min(i, rows.length - 1)]?.focus();
  });
  return self;
}

// 面の外を押したら閉じる。チップ自身は click で開け閉めするので除く（画面の無い所で読み込まれても落ちない: 単体テストが部品を読む）
globalThis.document?.addEventListener?.("pointerdown", (e) => {
  if (!openPanel) return;
  if (openPanel.pop.contains(e.target) || openPanel.chip.contains(e.target)) return;
  openPanel.hide(false);
}, true);
globalThis.addEventListener?.("resize", () => openPanel?.place());

/** 一覧の行。main（名前）+ sub（補足）+ right（札・時刻）。選ばれていれば ✓ */
function row({ on, main, sub, right, tag, mono, danger, onPick, title, key, disabled, badge, mark }) {
  const b = el("button", "copt" + (mono ? " cmono" : "") + (danger ? " danger" : ""));
  b.type = "button";
  // 選べない行（互換の接続先を選んでいる間の Claude のアカウント）。弱い字で ✓ を付けない
  if (disabled) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
  if (key) b.dataset.key = key;
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", on ? "true" : "false");
  if (title) b.title = title;
  b.append(el("span", "tick", on ? "✓" : ""));
  const mid = el("span", "cbody");
  if (mark) {
    // エージェントの行: ロゴ + 名前（名前だけを詰める）
    const m = el("span", "main hasmark");
    m.append(mark, el("span", "txt", main));
    mid.append(m);
  } else if (badge) {
    // 字の横の小さな札（互換の接続先のモデルの「1M」）。字だけを詰め、札は残す
    const m = el("span", "main hasb");
    const b = el("span", "cbadge", badge.text);
    if (badge.title) b.title = badge.title;
    m.append(el("span", "txt", main), b);
    mid.append(m);
  } else mid.append(el("span", "main", main));
  if (sub) mid.append(el("span", "sub", sub));
  b.append(mid);
  if (tag) b.append(el("span", "tag", tag));
  // right は字か、組み立て済みの部品
  if (right) b.append(typeof right === "object" ? right : el("span", "r", right));
  b.onclick = onPick;
  return b;
}

function listbox(label, rows) {
  const box = el("div", "clistbox");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", label);
  box.append(...rows);
  return box;
}

const head = (text) => el("div", "chead", text);

/** チップの title と読み上げに一言を足す（押せない理由など） */
const addNote = (chip, note) => {
  chip.title = `${chip.title} · ${note}`;
  chip.setAttribute("aria-label", `${chip.getAttribute("aria-label")} · ${note}`);
};

/**
 * フォルダーの簡易ブラウザー（ブラウザー版の「フォルダーを選ぶ…」。docs/design-system.md「入力欄の設定」）。
 * box にパンくず・フォルダーの一覧（..・ドライブ・中のフォルダー）・「このフォルダーにする」を描き、返す browse(dir) で辿る。
 * 入力欄の作業ディレクトリの面と、初回の案内（web/onboarding.mjs）が使う。
 *   onChoose(path): 「このフォルダーにする」 / onAt(path): 開いているフォルダーが変わった / closed(): 面が閉じたか（閉じたら描かない）
 */
export function folderBrowser({ cmd, box, err, onChoose, onAt = () => {}, closed = () => false }) {
  let seq = 0, at = null;
  const move = (dir) => { at = dir; onAt(dir); };
  async function browse(dir, { keepError = false } = {}) {
    const mine = ++seq;
    const prev = box.querySelector(".crumb") ? at : null;
    move(dir);
    box.hidden = false;
    box.setAttribute("aria-busy", "true");
    let r;
    try { r = await cmd("listDirs", { path: dir }); }
    catch (e) {
      if (mine !== seq) return;
      box.removeAttribute("aria-busy");
      err.textContent = e.message;
      // 開けなかったら、開けていたところに留まる（最初から開けなければホーム）
      move(prev);
      if (prev == null && dir) browse("", { keepError: true });
      return;
    }
    if (mine !== seq || !box.isConnected || closed()) return;
    box.removeAttribute("aria-busy");
    if (!keepError) err.textContent = "";
    move(r.path);
    const rows = [];
    if (r.parent) rows.push(row({ main: "..", sub: t("composer.cwd.up"), mono: true, onPick: () => browse(r.parent) }));
    for (const root of r.roots ?? []) if (root !== r.path) rows.push(row({ main: root, sub: t("composer.cwd.drive"), mono: true, onPick: () => browse(root) }));
    for (const name of r.dirs) {
      const full = r.path.replace(/[\\/]+$/, "") + (r.path.includes("\\") ? "\\" : "/") + name;
      rows.push(row({ main: name, mono: true, title: full, onPick: () => browse(full) }));
    }
    const crumb = el("div", "crumb", r.path);
    crumb.title = r.path;
    const go = el("div", "go");
    const choose = el("button", "btn btn-primary", t("composer.cwd.useThis"));
    choose.type = "button";
    choose.onclick = () => onChoose(r.path);
    go.append(choose);
    box.replaceChildren(crumb,
      rows.length ? listbox(t("composer.cwd.foldersIn", { path: r.path }), rows) : el("p", "cnote", t("composer.cwd.noFolders")),
      ...(r.truncated ? [el("p", "cnote", t("composer.cwd.truncated"))] : []),
      go);
    (box.querySelector("[role=option]") ?? choose).focus();
  }
  return browse;
}

// ---- エージェント・モデル・エフォート・アカウント・承認モード（モデルの面）
/** エージェントのロゴ（読み上げない。名前は横の字で読む） */
function logo(id) {
  const mark = backendLogo(id, '');
  mark.removeAttribute('title');
  mark.setAttribute('aria-hidden', 'true');
  for (const node of mark.querySelectorAll('[aria-label],[alt]')) {
    node.removeAttribute('aria-label');
    if (node.tagName === 'IMG') node.alt = '';
  }
  return mark;
}

/** Chats とスレッドで同じ「宛先とモデル」のチップを描く。 */
export function paintWhoChip(chip, { bot = null, backend, backendLabel = backend, model, effort = '', changed = false, sent = false, endpoint = false, oneM = false, title = null, pending = false }) {
  // bot はアイコン、互換の接続先は ◇（バックグラウンドの札と同じ）、それ以外はエージェントのロゴ
  const icon = bot ? botIcon(bot, 'av xs') : endpoint ? el('span', 'row-be compat-mark', '◇') : logo(backend);
  icon.setAttribute('aria-hidden', 'true');
  const name = el('span', 'v split');
  // モデルの一覧を取っている間は名前の場所に … を置く（前のエージェントのモデルを出さない）
  const modelName = pending ? '…' : model || t('chat.model.default');
  const effortName = pending ? '' : String(effort).replace(/^\s*·\s*/, '').trim();
  if (bot) name.append(el('span', 'mn', bot.name), el('span', 'mdl', ` · ${modelName}`));
  else name.append(el('span', 'mn', modelName));
  // 互換の接続先の 1M のモデルは名前の横に札（web/compat-models.mjs）
  if (oneM) { const badge = el('span', 'cbadge', '1M'); badge.title = ONE_M_TITLE; name.append(badge); }
  if (effortName) name.append(el('span', 'ef', ` · ${effortName}`));
  const caret = glyph(CARET); caret.classList.add('caret');
  chip.replaceChildren(icon, name, caret);
  if (changed) { const dot = el('span', 'entry-dot'); dot.setAttribute('aria-hidden', 'true'); chip.append(dot); }
  chip.classList.toggle('changed', changed);
  chip.classList.toggle('with-bot', Boolean(bot));
  const effortPart = effortName ? ` · ${effortName}` : '';
  const label = sent ? t('composer.destination.sentAria', { backend: backendLabel, model: modelName, effort: effortPart })
    : bot ? t('composer.destination.botAria', { name: bot.name, backend: backendLabel, model: modelName, effort: effortPart })
      : t('composer.destination.plainAria', { backend: backendLabel, model: modelName, effort: effortPart });
  const full = changed ? `${label} · ${t('composer.destination.changedAria')}` : label;
  chip.title = pending ? t('composer.model.loadingAria', { backend: backendLabel }) : title ?? full;
  chip.setAttribute('aria-label', pending ? t('composer.model.loadingAria', { backend: backendLabel }) : full);
  chip.classList.toggle('checking', pending);
  if (pending) chip.setAttribute('aria-busy', 'true'); else chip.removeAttribute('aria-busy');
}

const botMark = (bot) => { const mark = botIcon(bot, 'av xs'); mark.setAttribute('aria-hidden', 'true'); return mark; };

// ---- 2 段の面（承認済み（2026-11-18）。docs/design-system.md「入力欄の設定」）
//
// 1 段目は 1 種類の行（アイコン・見出し・今の値・右端の ›）を Bot → エージェント → 接続先 → アカウント → モデル → エフォート →
// 承認モード の順に並べる（承認モードは常に最後。ADR 0252）。行を押すとその項目の一覧（2 段目）に替わり、先頭の「‹ 見出し」か Esc で戻る。
// 一覧で選ぶと 1 段目に戻り、押した行へフォーカスを戻す。エフォートだけは 1 段目の行の中の棒で選ぶ（1 つの role=slider）。
// どの段にいるかは面ごとに覚える（views。面を開くたびに 1 段目から）

const GO = "M10 7l5 5-5 5";
const BACK = "M14 7l-5 5 5 5";
const CHECK = "M5 12.5l4.5 4.5L19 7.5";
const SEARCH = ["M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z", "M20 20l-4.2-4.2"];
const AT = "M4 12h12M12 6l6 6-6 6";
const CUBE = ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5M12 12v9"];
const GAUGE = ["M4 18a8 8 0 1 1 16 0", "M12 18l4-5"];
const CHART = "M5 19V11M12 19V5M19 19v-6";
const PLUG = "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5";
const PERSON = ["M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M5 20a7 7 0 0 1 14 0"];
const RESET = ["M5 12a7 7 0 1 0 2.1-5", "M5 4v4h4"];

/** 面 -> { view, q }（view は top / bot / agent / endpoint / account / model / mode。q はモデルの検索の字） */
const views = new WeakMap();

const icon = (node) => { const s = el("span", "ic"); if (node) s.append(node); return s; };
/** 右端の印。go は ›、ok は ✓（--ink-blue）、無しは幅だけ取る */
function endMark(kind) {
  const s = el("span", `end${kind === "ok" ? " ok" : ""}`);
  s.setAttribute("aria-hidden", "true");
  if (kind === "go") s.append(glyph(GO));
  else if (kind === "ok") s.append(glyph(CHECK));
  return s;
}
/** 週の使用量（小さな棒＋「週 N%」）。字で率を出すので、色だけに頼らない */
function weekMeta(usage) {
  if (!usage) return null;
  const m = el("span", `meta${usage.high ? " hot" : ""}`);
  const bar = el("span", "usage-mini"); bar.setAttribute("aria-hidden", "true");
  const fill = el("i"); fill.style.width = `${Math.min(100, Math.max(0, usage.used))}%`; bar.append(fill);
  m.append(bar, t("composer.account.week", { percent: percentText(usage.used) }));
  return m;
}
/** 1 段目の行。onClick が無ければ押せない行（値を見せるだけ。右端の印を出さない） */
function navRow({ key, ic, label, value, note, two, warn, meta, danger, onClick, title }) {
  const r = el(onClick ? "button" : "div", `prow${danger ? " danger" : ""}`);
  if (onClick) { r.type = "button"; r.onclick = onClick; } else r.setAttribute("aria-disabled", "true");
  if (key) r.dataset.key = key;
  if (title) r.title = title;
  const val = el("span", `val${two ? " two" : ""}`);
  val.append(el("span", "nm", value));
  if (note) val.append(el("span", `nt${warn ? " warn" : ""}`, note));
  r.append(icon(ic), el("span", "lb", label), val);
  if (meta) r.append(meta);
  r.append(endMark(onClick ? "go" : ""));
  return r;
}
/** 2 段目の選ぶ行。選んでいれば右端に ✓ */
function optRow({ key, sel, ic, name, note, two, warn, tag, meta, badge, danger, title, aria, onPick, disabledReason }) {
  const r = el("button", `prow popt${danger ? " danger" : ""}`);
  r.type = "button";
  r.setAttribute("role", "option");
  r.setAttribute("aria-selected", sel ? "true" : "false");
  if (key) r.dataset.key = key;
  if (title) r.title = title;
  if (aria) r.setAttribute("aria-label", aria);
  const val = el("span", `val${two ? " two" : ""}`);
  val.append(el("span", "nm", name));
  // 字の横の小さな札（互換の接続先のモデルの「1M」）
  if (badge) { const b = el("span", "cbadge", badge.text); if (badge.title) b.title = badge.title; val.append(b); }
  if (note) val.append(el("span", `nt${warn ? " warn" : ""}`, note));
  r.append(icon(ic), val);
  if (tag) r.append(el("span", "tag", tag));
  if (meta) r.append(meta);
  r.append(endMark(sel ? "ok" : ""));
  if (disabledReason) {
    r.disabled = true;
    r.setAttribute("aria-disabled", "true");
    val.append(el("span", "nt", disabledReason));
    val.classList.add("two");
  } else r.onclick = onPick;
  return r;
}
/** 一覧の外の操作の行（「使用量」「接続先を管理…」など） */
function linkRow({ key, ic, text, onClick }) {
  const r = el("button", "prow link");
  r.type = "button";
  if (key) r.dataset.key = key;
  const val = el("span", "val");
  val.append(el("span", "nm", text));
  r.append(icon(ic), val, endMark("go"));
  r.onclick = onClick;
  return r;
}
function plist(rows, label) {
  const box = el("div", "plist");
  if (label) { box.setAttribute("role", "listbox"); box.setAttribute("aria-label", label); }
  box.append(...rows.filter(Boolean));
  return box;
}
const pnote = (text) => el("p", "pnote", text);
const inHead = (text) => el("div", "chead inlist", text);
function skeleton(n, text) {
  const box = el("div", "cskel");
  box.setAttribute("role", "status");
  box.setAttribute("aria-busy", "true");
  for (let i = 0; i < n; i++) { const bar = el("span", "cskel-row"); bar.setAttribute("aria-hidden", "true"); box.append(bar); }
  if (text) box.append(pnote(text));
  return box;
}

/** 2 段目に入ったときのフォーカス: 検索の欄 → 選んでいる行 → 最初の行 */
function focusView(pop) {
  (pop.querySelector(".psearch input") ?? pop.querySelector('.prow.popt[aria-selected="true"]')
    ?? pop.querySelector("button.prow:not(.backhead):not([aria-disabled=true]), .eslider:not([aria-disabled=true])"))?.focus({ preventScroll: true });
}

/** 使えないエージェントの行（選べない。右に状態の言葉とその場の操作）。状態は「本体 · SDK」の 1 行 */
function unusableAgentRow(b, v) {
  const r = el("div", "prow popt agent-off");
  r.setAttribute("role", "option");
  r.setAttribute("aria-selected", "false");
  r.setAttribute("aria-disabled", "true");
  r.dataset.key = `backend:${b.id}`;
  const val = el("span", "val two");
  val.append(el("span", "nm", b.label));
  // 状態が 1 つだけの行は、操作の左に置く。本体と SDK の 2 つがある行（Claude Code）は名前の下に並べる
  if (!v.state && v.status) val.append(el("span", "nt", v.status));
  if (v.terms) val.append(v.terms);
  r.append(icon(logo(b.id)), val);
  if (v.state) { const st = el("span", "meta agent-off-st"); st.append(v.state); r.append(st); }
  if (v.op) { v.op.classList.add("agent-off-op"); r.append(v.op); }
  return r;
}

/**
 * モデルの面を描く（入力欄・スレッド・bot のページ・子の会話のモーダル）。保存先には依存しない。
 * @param {object} o
 * @param {HTMLElement} o.pop 描画先（面の開閉は panel() で呼び出し側が扱う）
 * @param {object} o.target 今の値と候補。backend/backends/backendSwitchable、model/models、effort/efforts/effortDisabled。
 *   endpoint と account/accounts、modes/mode、destination は任意。省けばその行を出さない。
 *   週の使用量は backendUsage(id)。棒を出す行は composer-labels.mjs の agentRowUsage（アカウントの行・互換の接続先があれば
 *   エージェントの行に出さない。一覧のほかのエージェントは backendHasAccounts(id)）。
 * @param {object} o.on 変更先 { backend, model, effort, endpoint?, account?, mode? }。保存後、更新した target で描き直す。
 *   既定に戻す model/effort は空文字を渡す。
 * @param {(returnFocus?: boolean) => void} o.hide 面の外へ移るとき（接続先の管理・使用量・bot のページ）、面を閉じる
 */
export function renderModel(args) {
  const { pop, target: d } = args;
  const st = views.get(pop) ?? { view: "top", q: "" };
  const ctx = {
    ...args, d, st,
    /** 2 段目へ */
    go(view) { views.set(pop, { view, q: "" }); renderModel(args); pop.scrollTop = 0; focusView(pop); },
    /** 1 段目へ戻り、押した行へ */
    back(view) {
      views.set(pop, { view: "top", q: "" });
      renderModel(args);
      pop.querySelector(`[data-key="nav:${view}"]`)?.focus({ preventScroll: true });
    },
    /** 選んで 1 段目へ戻る（戻してから変更先を呼ぶ。呼び出し側の描き直しは押した行へフォーカスを戻す） */
    pick(view, apply) { ctx.back(view); apply(); },
  };
  const sub = st.view !== "top" ? subView(ctx) : null;
  if (st.view !== "top" && !sub) views.set(pop, { view: "top", q: "" });
  pop.replaceChildren(...(sub ?? topView(ctx)));
  args.afterRender?.();
}

function topView(ctx) {
  const { d, on, hide, go } = ctx;
  const dest = d.destination;
  const rows = [];
  // Bot（送る前だけ。送った会話では行ごと出さない。ADR 0160）
  const options = (dest?.groups ?? []).flatMap((g) => g.options ?? []);
  if (dest && !dest.sent && options.length) {
    const picked = options.find((o) => o.id === dest.selected) ?? options.find((o) => o.id == null);
    rows.push(navRow({ key: "nav:bot", ic: glyph(AT), label: t("composer.destination.title"), value: picked?.name ?? t("channels:homeDest.none"), onClick: () => go("bot") }));
  }
  if (dest?.chooseOnly) return [plist(rows)];
  const labelOf = (id) => d.backends?.find((b) => b.id === id)?.label ?? dest?.backendLabel?.(id) ?? id;
  // bot を選んだ未送信の会話: その bot の既定で動く（ここでは変えない。送った後、スレッドの中で変える）
  if (dest?.readOnlyBot) {
    const bot = dest.readOnlyBot;
    rows.push(navRow({ ic: logo(bot.backend), label: t("composer.agent"), value: dest.backendLabel?.(bot.backend) ?? labelOf(bot.backend) }));
    const out = [plist(rows), pnote(t("composer.destination.botRuns", { name: bot.name, setup: dest.botSetup }))];
    if (dest.openBot) out.push(plist([linkRow({ key: "destination:openBot", ic: botMark(bot), text: t("composer.destination.openBot"), onClick: () => { hide(false); dest.openBot(bot.id); } })]));
    return out;
  }
  if (d.backend) {
    rows.push(navRow({ key: "nav:agent", ic: logo(d.backend), label: t("composer.agent"), value: labelOf(d.backend),
      meta: weekMeta(agentRowUsage(d, d.backend)), onClick: d.backendSwitchable ? () => go("agent") : null }));
  }
  // 接続先（Claude Code・Codex）。「公式」だけのときは出さない（「接続先を管理…」はエージェントの一覧の下と設定から）
  const ep = d.endpoint;
  if (ep && (ep.options.length > 1 || ep.row)) {
    const cur = ep.options.find((o) => o.value === ep.selected);
    rows.push(navRow({ key: "nav:endpoint", ic: glyph(PLUG), label: t("composer.endpoint.title"), value: cur?.label ?? ep.selected, title: cur?.title, onClick: () => go("endpoint") }));
  }
  // アカウント。互換の接続先では使わない（接続先のキーで送る）。行は残し、理由を出す
  if (d.accounts) {
    const off = Boolean(ep?.row);
    const cur = d.accounts.find((a) => a.value === d.account);
    rows.push(off
      ? navRow({ key: "nav:account", ic: glyph(...PERSON), label: t("composer.account.title"), value: "", note: t("composer.account.compatOff") })
      : navRow({ key: "nav:account", ic: glyph(...PERSON), label: t("composer.account.title"), value: cur?.label ?? "", note: cur?.conn?.text, two: Boolean(cur?.conn), warn: cur?.conn?.warn,
        meta: weekMeta(cur?.usage), onClick: () => go("account") }));
  }
  // モデル
  const modelValue = ep?.row ? compatModelLabel(d.model || ep.row.roles?.main || "").text || t("chat.model.default")
    : d.modelsPending ? "…" : resolvedModel(d.models ?? {}, d.model).label;
  rows.push(navRow({ key: "nav:model", ic: glyph(...CUBE), label: t("composer.model.title"), value: modelValue, onClick: () => go("model") }));
  // エフォート（行の中の棒）
  rows.push(effortRow(d, on.effort, ctx.effortControl));
  const follow = ctx.effortControl?.follow;
  // 承認モード（常に最後）
  if (d.modesPending) rows.push(navRow({ key: "nav:mode", ic: glyph(SHIELD), label: t("chat.composer.mode"), value: "…" }));
  else if (Object.keys(d.modes ?? {}).length) {
    const m = d.modes[d.mode], danger = isDanger(m);
    const name = m?.label ?? d.mode;
    rows.push(navRow({ key: "nav:mode", ic: glyph(...(danger ? WARN : [SHIELD])), label: t("chat.composer.mode"), value: name, danger,
      title: d.modeDisabled ? d.lockedNote : danger ? t("composer.mode.dangerTitle") : null,
      onClick: d.modeDisabled || !on.mode ? null : () => go("mode") }));
  }
  const out = [plist(rows)];
  if (follow) out.push(plist([optRow({ key: "effort:conversation", sel: follow.selected, name: follow.label, onPick: follow.pick })]));
  if (ctx.footer) out.push(ctx.footer());
  // スレッドの設定はそのスレッドだけに効く。bot の既定から変えていれば戻す口
  if (dest?.threadPlain || dest?.bot) {
    out.push(pnote(t("channels:thread.settings.note")));
    if (dest.changed && dest.onReset) out.push(plist([linkRow({ key: "destination:reset", ic: glyph(...RESET), text: t("composer.destination.resetBot"), onClick: dest.onReset })]));
  }
  return out;
}

/** 2 段目。出せない（行が無くなった）ときは null（1 段目に戻る） */
function subView(ctx) {
  const { d, st } = ctx;
  const backRow = (title) => {
    const r = el("button", "prow backhead");
    r.type = "button";
    r.dataset.key = "back";
    r.append(icon(glyph(BACK)), el("span", "val", title), endMark(""));
    r.onclick = () => ctx.back(st.view);
    return r;
  };
  const wrap = (title, parts) => { const box = el("div", "view-in"); box.append(backRow(title), ...parts.filter(Boolean)); return [box]; };
  switch (st.view) {
    case "bot": {
      const dest = d.destination;
      if (!dest || dest.sent || !dest.groups?.some((g) => g.options?.length)) return null;
      const title = t("composer.destination.title");
      const parts = [];
      for (const group of dest.groups ?? []) {
        if (!group.options?.length) continue;
        if (group.heading) parts.push(inHead(group.heading));
        parts.push(plist(group.options.map((o) => {
          const picked = o.id === dest.selected;
          const state = o.state ? ` · ${o.state}` : "";
          const meta = o.waiting ? el("span", "meta wait", "◆") : o.working ? runMark() : null;
          return optRow({ key: `destination:${o.id ?? "none"}`, sel: picked, ic: o.bot ? botMark(o.bot) : o.backend ? logo(o.backend) : null, name: o.name, meta,
            aria: o.bot ? t("composer.destination.optionAria", { name: o.name, backend: o.backendLabel ?? o.backend ?? "", state }) : null,
            onPick: () => ctx.pick("bot", () => { if (!picked) dest.onPick(o.id); }) });
        }), group.heading || title));
      }
      return wrap(title, parts);
    }
    case "agent": {
      if (!d.backendSwitchable) return null;
      const usable = [], other = [];
      for (const b of d.backends ?? []) {
        const v = d.agentView?.(b.id) ?? null;
        if (!v || v.usable) {
          usable.push(optRow({ key: `backend:${b.id}`, sel: b.id === d.backend, ic: logo(b.id), name: b.label, meta: weekMeta(agentRowUsage(d, b.id)),
            disabledReason: b.id === d.backend ? null : ctx.blocked?.("agent", b.id),
            onPick: () => ctx.pick("agent", () => { if (b.id !== d.backend) ctx.on.backend(b.id); }) }));
        } else other.push(unusableAgentRow(b, v));
      }
      const links = [];
      if (d.destination?.openUsage) links.push(linkRow({ key: "agent:usage", ic: glyph(CHART), text: t("composer.usage"), onClick: () => { ctx.hide(false); d.destination.openUsage(); } }));
      if (d.endpoint) links.push(linkRow({ key: "epmanage", ic: glyph(PLUG), text: t("composer.endpoint.manage"), onClick: () => { ctx.hide(false); d.endpoint.manage(); } }));
      const rest = other.length ? plist(other, t("composer.agent")) : null;
      rest?.classList.add("unusable");
      return wrap(t("composer.agent"), [plist(usable, t("composer.agent")), rest, links.length ? plist(links) : null]);
    }
    case "endpoint": {
      const ep = d.endpoint;
      if (!ep) return null;
      return wrap(t("composer.endpoint.title"), [
        plist(ep.options.map((o) => optRow({ key: `endpoint:${o.value}`, sel: o.value === ep.selected, ic: o.warn ? glyph(...WARN) : null, name: o.label, note: o.sub,
          tag: o.isDefault ? DEFAULT_TAG() : "", title: o.title ?? o.label,
          onPick: () => ctx.pick("endpoint", () => { if (o.value !== ep.selected && !o.gone) ctx.on.endpoint(o.value); }) })), t("composer.endpoint.title")),
        ep.row && ep.lost ? pnote(t("composer.endpoint.lost", { items: ep.lost })) : null,
        plist([linkRow({ key: "epmanage", ic: glyph(PLUG), text: t("composer.endpoint.manage"), onClick: () => { ctx.hide(false); ep.manage(); } })]),
      ]);
    }
    case "account": {
      if (!d.accounts || d.endpoint?.row) return null;
      return wrap(t("composer.account.title"), [plist(d.accounts.map((a) => optRow({ key: `account:${a.value}`, sel: a.value === d.account, name: a.label,
        disabledReason: a.value === d.account ? null : ctx.blocked?.("account", a.value),
        note: a.conn?.text || (a.usage ? "" : a.hint), two: Boolean(a.conn), warn: a.conn?.warn, tag: a.value === "" ? DEFAULT_TAG() : "", meta: weekMeta(a.usage),
        onPick: () => ctx.pick("account", () => { if (a.value !== d.account) ctx.on.account?.(a.value); }) })), t("composer.account.title"))]);
    }
    case "model":
      return wrap(t("composer.model.title"), d.endpoint?.row ? compatModelView(ctx) : officialModelView(ctx));
    case "mode": {
      if (d.modesPending || d.modeDisabled || !ctx.on?.mode || !Object.keys(d.modes ?? {}).length) return null;
      const def = defaultModeOf(d.modes);
      return wrap(t("chat.composer.mode"), [plist(Object.entries(d.modes).map(([id, m]) => {
        const danger = isDanger(m), sel = id === d.mode;
        return optRow({ key: `mode:${id}`, sel, ic: danger ? glyph(...WARN) : null, name: m.label ?? id, note: m.note, two: true, danger: danger && sel,
          tag: id === def ? DEFAULT_TAG() : "", aria: danger ? t("composer.mode.chipAriaDanger", { mode: m.label ?? id }) : null,
          onPick: () => ctx.pick("mode", () => { if (!sel) ctx.on.mode(id); }) });
      }), t("chat.composer.mode"))]);
    }
    default:
      return null;
  }
}

/** モデルの検索の欄。打つたびに list() で一覧だけを描き直す（欄のフォーカスと字を保つ）。Enter は commit() */
function searchBox(ctx, { placeholder, list, commit }) {
  const box = el("div", "psearch");
  const input = el("input");
  input.value = ctx.st.q ?? "";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", t("composer.model.searchLabel"));
  input.dataset.key = "model-q";
  input.autocomplete = "off"; input.spellcheck = false;
  input.addEventListener("focus", () => { const n = input.value.length; input.setSelectionRange(n, n); });
  input.addEventListener("input", () => { views.set(ctx.pop, { view: ctx.st.view, q: input.value }); ctx.st.q = input.value; list(); });
  input.addEventListener("keydown", (e) => {
    if (isComposingKey(e) || e.key !== "Enter") return;
    e.preventDefault();     // フォームの送信にしない
    commit(input.value.trim());
  });
  box.append(glyph(...SEARCH), input);
  return box;
}

/**
 * 公式のモデルの一覧: 検索の欄（大文字小文字を区別しない部分一致、空白区切りは AND。名前・補足・ID のどれでも）＋一覧。
 * 古いモデルは「ほかのモデル」の見出しの下へ（composer-labels.mjs の splitModelRows）。当たらなければ打った ID をそのまま使える
 */
function officialModelView(ctx) {
  const { d } = ctx;
  // 取っている間は、前のエージェントの一覧の代わりに骨組みと一言
  if (d.modelsPending) return [skeleton(3, t("composer.model.loading"))];
  const models = d.models ?? {};
  const { id: resolved, entry: current } = resolvedModel(models, d.model);
  const selected = ctx.explicitModels ? d.model : resolved;
  const def = models[""]?.resolvesTo;
  // 段違いを系統にまとめた一覧（antigravity）は系統ごとに 1 行（composer-labels.mjs の modelRowIds）
  const ids = ctx.explicitModels ? Object.keys(models).filter(Boolean) : modelRowIds(models, d.model);
  const { main, other, quiet } = splitModelRows(models, ids);
  // 宛先が bot なら、bot の既定のモデルに「<名前> の既定」の札（エージェントの既定の札は出さない）
  const botDefault = d.destination?.bot && d.destination.defaults ? d.destination.defaults.model || def : null;
  const tagOf = (id) => botDefault !== null ? (id === botDefault ? t("channels:thread.settings.botDefault", { name: d.destination.bot.name }) : "")
    : holdsDefault(models, id) ? DEFAULT_TAG() : "";
  // 既定が一覧のどれにも当たらない（分からない）ときは「既定に従う」の行を残す
  const follow = !ctx.explicitModels && (!def || !ids.some((id) => holdsDefault(models, id)));
  const words = () => String(ctx.st.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (id) => { const m = models[id] ?? {}; const s = `${m.label ?? ""} ${m.note ?? ""} ${id}`.toLowerCase(); return words().every((w) => s.includes(w)); };
  const blocked = id => id === selected ? null : ctx.blocked?.("model", id);
  const choose = (v, id) => {
    if (!blocked(id)) ctx.pick("model", () => { if (v !== d.model && id !== selected) ctx.on.model(v); });
  };
  const modelRow = (id, showNote) => {
    const m = models[id];
    return optRow({ key: `model:${id}`, sel: id === selected || Boolean(!ctx.explicitModels && m.family && m.family === current?.family), name: m.label ?? id,
      disabledReason: blocked(id),
      note: showNote ? m.note : "", tag: tagOf(id), title: id,
      // 既定の行を選ぶと '' を保存する（既定が変われば追従する）。選んでいる系統の行は何もしない
      onPick: () => choose(!ctx.explicitModels && id === def ? "" : id, id) });
  };
  const box = el("div", "plist-wrap");
  const list = () => {
    const q = words().length > 0;
    const top = main.filter(hits), old = other.filter(hits);
    const rows = [];
    if (follow && !q) rows.push(optRow({ key: "model:", sel: !d.model, name: models[""]?.resolvedLabel ?? models[""]?.label ?? t("chat.next.useDefault"),
      note: models[""]?.note, tag: DEFAULT_TAG(), onPick: () => ctx.pick("model", () => { if (d.model) ctx.on.model(""); }) }));
    rows.push(...top.map((id) => modelRow(id, true)));
    if (old.length) rows.push(inHead(t("composer.model.other")), ...old.map((id) => modelRow(id, q || !quiet.has(id))));
    const parts = [plist(rows, t("composer.model.title"))];
    if (!top.length && !old.length) parts.push(pnote(t("composer.model.notListed")));
    box.replaceChildren(...parts);
  };
  const commit = (typed) => {
    if (!typed) return;
    const low = typed.toLowerCase();
    const exact = ids.find((id) => id.toLowerCase() === low || String(models[id]?.label ?? "").toLowerCase() === low);
    const first = exact ?? main.find(hits) ?? other.find(hits);
    if (first) choose(!ctx.explicitModels && first === def ? "" : first, first);
    else if (!blocked(typed)) ctx.pick("model", () => { if (typed !== d.model) ctx.on.model(typed); });
  };
  list();
  return [searchBox(ctx, { placeholder: t("composer.model.search"), list, commit }), box];
}

/**
 * 互換の接続先のモデル: 検索と ID の入力を兼ねる欄＋接続先の一覧。空はメインのモデル（「既定」の札）。
 * 字は表示名（web/compat-models.mjs。`anthropic/` の名前空間と [1m] を隠し、1M は札）、送るのは一覧どおりの ID（title）。
 * 描くのは先頭の SHOW_LIMIT 件だけ。Enter は打った字（一覧の ID か表示名に当たればその ID、無ければそのまま）
 */
function compatModelView(ctx) {
  const { d } = ctx;
  const ep = d.endpoint;
  const main = ep.row.roles?.main ?? "";
  const cur = d.model || main;
  // メイン → 今のモデル → 一覧の順
  const cands = modelCandidates(ep.row.models ?? [], ep.row.modelInfo ?? {}, [main, cur]);
  const roleOf = (id) => ep.roleNames.filter(([k]) => ep.row.roles?.[k] === id && k !== "main").map(([, n]) => n).join("・");
  const commit = (id) => {
    const v = String(id ?? "").trim();
    if (!v) return;
    const next = v === main ? "" : v;
    ctx.pick("model", () => { if (next !== (d.model ?? "")) ctx.on.model(next); });
  };
  const box = el("div", "plist-wrap");
  const list = () => {
    const q = String(ctx.st.q ?? "").trim().toLowerCase();
    const { shown, more } = searchModels(cands, q);
    const rows = shown.map((c) => optRow({ key: `model:${c.id}`, sel: c.id === cur, name: c.text, note: c.sub, title: c.id, tag: c.id === main ? DEFAULT_TAG() : "",
      meta: roleOf(c.id) ? el("span", "meta", roleOf(c.id)) : null, badge: c.oneM ? { text: "1M", title: ONE_M_TITLE } : null, onPick: () => commit(c.id) }));
    const parts = rows.length ? [plist(rows, t("composer.model.candidates"))] : [pnote(q ? t("composer.model.notListed") : t("composer.model.noList"))];
    if (more > 0) parts.push(pnote(moreText(more)));
    box.replaceChildren(...parts);
  };
  list();
  const placeholder = main ? t("composer.model.searchMain", { model: compatModelLabel(main).text }) : t("composer.model.search");
  return [searchBox(ctx, { placeholder, list, commit: (typed) => commit(resolveTyped(cands, typed)) }), box];
}

/**
 * エフォートの行（案 A: 右へ高くなる棒。1 つの role=slider）。←→ / Home / End で段を変え、↑↓ は行の間を移る（panel の keydown）。
 * 押す・なぞる間は棒と字だけを塗り、離したときに決める（段は floor(x / 幅 × 段の数)）。既定の段は棒の下に小さな点。
 * 既定の段を選ぶと '' を保存する（既定が変われば追従する）。段を持たないモデルは「このモデルでは選べません」
 */
function effortRow(d, onPick, control) {
  const r = el("div", "prow erow");
  r.append(icon(glyph(...GAUGE)), el("span", "lb", t("composer.effort.label")));
  const { stops, def, current } = effortStops(d.efforts, d.effort);
  if (!stops.length || d.effortDisabled) {
    r.setAttribute("aria-disabled", "true");
    const why = d.effortsPending ? t("composer.effort.loading") : d.efforts?.[""]?.reason ?? t("composer.effort.none");
    const v = el("span", "evalue none", why);
    v.title = why;
    r.append(v, endMark(""));
    return r;
  }
  // 既定に従うときに誰の設定が効くか（既定の段が分からず、どの段も指さないときの読み上げ）
  // i18n-dynamic: composer.effort.defaultFollow.
  const owner = d.endpoint?.row ? "endpoint" : d.backend === "antigravity" ? "agy" : "agent";
  const n = stops.length, dk = stops.indexOf(def);
  const slider = el("span", "eslider ebars");
  slider.setAttribute("role", "slider");
  slider.tabIndex = 0;
  slider.setAttribute("aria-label", control?.label ?? t("composer.effort.label"));
  slider.setAttribute("aria-valuemin", "0");
  slider.setAttribute("aria-valuemax", String(n - 1));
  slider.dataset.key = "effort";
  const bars = stops.map((s, i) => {
    const b = el("i", i === dk ? "def" : null);
    b.style.setProperty("--h", `${Math.round(28 + (72 * i) / Math.max(1, n - 1))}%`);
    slider.append(b);
    return b;
  });
  const value = el("span", "evalue");
  value.setAttribute("aria-hidden", "true");
  let at = stops.indexOf(control ? d.effort : current);   // -1: 既定の段が分からず既定に従っている（どの段も指さない）
  const paint = (k) => {
    bars.forEach((b, i) => b.classList.toggle("on", i <= k));
    slider.setAttribute("aria-valuenow", String(Math.max(0, k)));
    slider.setAttribute("aria-valuetext", k < 0 ? t(`composer.effort.defaultFollow.${owner}`)
      : t("composer.effort.valueText", { level: stops[k], n, k: k + 1, def: k === dk ? t("composer.effort.defMark") : "" }));
    value.textContent = k < 0 ? DEFAULT_TAG() : stops[k];
  };
  const commit = (k) => {
    if (k < 0 || k >= n) return;
    at = k;
    const v = stops[k];
    const next = v === def ? "" : v;
    if (control || next !== (d.effort ?? "")) onPick(next);
  };
  const indexAt = (x) => { const box = slider.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.floor(((x - box.left) / box.width) * n))); };
  slider.addEventListener("keydown", (e) => {
    const k = { ArrowLeft: Math.max(0, at - 1), ArrowRight: Math.min(n - 1, at + 1), Home: 0, End: n - 1 }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    paint(k);
    commit(k);
  });
  let drag = null;
  slider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Tab で輪が出ている棒をポインターで押したときは、一度外してポインターのフォーカスとして付け直させる（輪は Tab のときだけ）
    if (document.activeElement === slider && slider.matches(":focus-visible")) slider.blur();
    drag = { id: e.pointerId, k: indexAt(e.clientX) };
    paint(drag.k);
    try { slider.setPointerCapture(e.pointerId); } catch { /* 取れなくても押した段は塗れている */ }
  });
  slider.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = indexAt(e.clientX);
    if (k !== drag.k) { drag.k = k; paint(k); }
  });
  slider.addEventListener("pointerup", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = drag.k;
    drag = null;
    commit(k);
  });
  slider.addEventListener("pointercancel", () => { if (!drag) return; drag = null; paint(at); });
  paint(at);
  r.append(slider, value, endMark(""));
  return r;
}

// ---- 承認モード
/**
 * 承認モードの面を描く（bot のページ・ルーティンのシート。Chats の入力欄はモデルの面の最後の行）。target は { mode, modes }、on.mode(id) が変更先。
 * 選択時は hide() で面を閉じ、今と違う値のときだけ変更先を呼ぶ。
 */
export function renderMode({ pop, target: d, on, hide }) {
  // 取っている間は、前のエージェントのモードの代わりに骨組みと一言（押せる行を出さない）
  if (d.modesPending) {
    const box = el("div", "cskel");
    box.setAttribute("role", "status");
    box.setAttribute("aria-busy", "true");
    for (let i = 0; i < 2; i++) { const bar = el("span", "cskel-row"); bar.setAttribute("aria-hidden", "true"); box.append(bar); }
    box.append(el("p", "cnote", t("composer.model.loading")));
    pop.replaceChildren(head(t("chat.composer.mode")), box);
    return;
  }
  const def = defaultModeOf(d.modes);
  const rows = Object.entries(d.modes ?? {}).map(([id, m]) => row({
    on: id === d.mode, main: (isDanger(m) ? "⚠ " : "") + (m.label ?? id), sub: m.note, tag: id === def ? DEFAULT_TAG() : "", danger: isDanger(m), key: `mode:${id}`,
    onPick: () => { hide(); if (id !== d.mode) on.mode(id); },
  }));
  pop.replaceChildren(head(t("chat.composer.mode")), listbox(t("chat.composer.mode"), rows));
}

// ---------------------------------------------------------------- 本体

/**
 * @param {object} o
 * @param {(command:string, args?:object) => Promise<any>} o.cmd
 * @param {() => object} o.get 今の値と候補（client.mjs の状態を読む）
 * @param {object} o.on 変更を返す口 { cwd, backend, model, effort, account, mode }。openModel はモデルの面を開いたとき
 * @param {{ chips?: { cwd, model }, pops?: { cwd, model } }} [o.els] チップと面の要素。省けば Chats の入力欄の固定の id
 */
export function setupComposerControls({ cmd, get, on, els = {} }) {
  const $ = (id) => document.getElementById(id);
  const chips = els.chips ?? { cwd: $("cwdChip"), model: $("modelChip") };
  const pops = els.pops ?? { cwd: $("cwdPop"), model: $("modelPop") };

  // チップの骨組み（アイコン + 字 + ▾）。2 つとも同じ形（docs/design-system.md「入力欄の設定」）
  const cwdName = el("span", "v");
  // ブランチ（作業場所が git のときだけ。ADR 0085）。狭いときは fitRow が最初に削る
  const gitBranch = el("span", "git-br");
  gitBranch.hidden = true;
  // worktree のとき: アイコンを枝分かれにし、名前の後ろに「· worktree」（狭いと最初に畳む。ADR 0089）
  const folderGlyph = glyph(FOLDER), splitGlyph = branchGlyph();
  const splitSuffix = el("span", "wt-sfx");
  splitSuffix.hidden = true;
  // 別の会話も書き込み中なのは、チップには出さず作業ディレクトリの面の中だけで知らせる（title と読み上げには足す。ADR 0252）
  chips.cwd.append(folderGlyph, cwdName, splitSuffix, gitBranch, glyph(CARET));
  chips.cwd.lastChild.classList.add("caret");
  const modelName = el("span", "v");
  chips.model.append(glyph(...MODEL), modelName, glyph(CARET));
  chips.model.lastChild.classList.add("caret");
  let markedMode;   // 前に描いた承認モード（印が替わったときだけ出る動きを付ける）

  // ---- 作業ディレクトリ
  let browsing = null;          // 簡易ブラウザーで開いているフォルダー（ブラウザー版だけ）
  let checkSeq = 0;             // 打ったパス・最近の行を確かめている番号（新しく確かめ始めたら前の結果は捨てる）
  const commitCwd = (v) => {
    const value = String(v ?? "").trim();
    if (!value) return;
    folder.hide();
    if (value !== get().cwd) on.cwd(value);
  };
  /**
   * 打ったパス・最近の行は、決める前にサーバーでフォルダーがあるか確かめる（listDirs）。無ければ面を開いたまま、
   * 欄の下に理由と、あるところまでのパス・「ここから選ぶ」を出す。150ms を越えたら欄の右端に弧と「確認しています…」
   */
  async function checkAndCommit(value, { input, msg, browse }) {
    value = String(value ?? "").trim();
    if (!value) return;
    if (value === get().cwd) { folder.hide(); return; }
    const seq = ++checkSeq;
    msg.replaceChildren();
    const wrap = input.parentElement;
    const timer = setTimeout(() => {
      if (seq !== checkSeq) return;
      wrap.querySelector(".run")?.remove();
      wrap.append(runMark(t("composer.cwd.checking")));
      msg.replaceChildren(el("p", "cmsg checking", t("composer.cwd.checking")));
    }, 150);
    const done = () => { clearTimeout(timer); wrap.querySelector(".run")?.remove(); };
    let found = null;
    try { found = await cmd("listDirs", { path: value }); }
    catch (e) {
      if (seq !== checkSeq) return;
      // あるところまで上へたどる（ENOENT のときだけ。権限などはそのフォルダーの理由を出す）
      let nearest = null;
      if (e.code === "ENOENT") {
        for (let dir = parentOf(value), n = 0; dir && n < 12; dir = parentOf(dir), n++) {
          const r = await cmd("listDirs", { path: dir }).catch(() => null);
          if (seq !== checkSeq) return;
          if (r) { nearest = r.path; break; }
        }
      }
      done();
      const fail = el("p", "cmsg fail", `✕ ${e.code === "ENOENT" ? t("composer.cwd.notFound") : e.message}`);
      const out = [fail];
      if (nearest) {
        const hint = el("p", "cmsg hint");
        const from = el("button", "btn link", t("composer.cwd.chooseFrom"));
        from.type = "button";
        from.onclick = () => browse(nearest);
        hint.append(el("code", null, nearest), ` ${t("composer.cwd.exists")}`, from);
        out.push(hint);
      }
      msg.replaceChildren(...out);
      input.setAttribute("aria-invalid", "true");
      if (pops.cwd.contains(document.activeElement) || document.activeElement === document.body) input.focus();
      return;
    }
    if (seq !== checkSeq) return;
    done();
    msg.replaceChildren();
    input.removeAttribute("aria-invalid");
    commitCwd(found?.path || value);
  }
  function renderFolder() {
    const d = get();
    const pop = pops.cwd;
    const input = el("input", "cpath");
    input.value = d.cwd ?? "";
    input.placeholder = t("composer.cwd.placeholder");
    input.setAttribute("aria-label", t("composer.cwd.inputLabel"));
    input.autocomplete = "off"; input.spellcheck = false;
    // 欄と弧（確かめている間）の入れ物。欄の下に確かめた結果（無いフォルダー・あるところまで）
    const inputWrap = el("div", "cpath-wrap");
    inputWrap.append(input);
    const msg = el("div", "cmsgs");
    msg.setAttribute("role", "status");
    const check = (value) => checkAndCommit(value, { input, msg, browse: (dir) => browse(dir) });
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e) || e.key !== "Enter") return;
      e.preventDefault();     // フォームの送信にしない
      check(input.value);
    });
    input.addEventListener("input", () => { checkSeq++; input.removeAttribute("aria-invalid"); msg.replaceChildren(); inputWrap.querySelector(".run")?.remove(); });
    const recent = (d.recent ?? []).map((r) => row({
      on: r.value === d.cwd, main: baseName(r.value), sub: r.value, right: r.time ? relTime(r.time) : "", mono: true, title: r.value,
      onPick: () => { input.value = r.value; check(r.value); },
    }));
    const pick = el("button", "caction");
    pick.type = "button";
    pick.append(glyph(FOLDER, FOLDER_ADD), el("span", null, t("composer.cwd.choose")));
    const err = el("p", "cerr");
    err.setAttribute("role", "alert");
    pick.onclick = async () => {
      err.textContent = "";
      // デスクトップ版は OS のダイアログ。ブラウザー版はサーバーが返す一覧を面の中で辿る
      if (window.plyDesktop?.chooseFolder) {
        const picked = await window.plyDesktop.chooseFolder().catch(() => null);
        const chosen = typeof picked === "string" ? picked : picked?.path ?? picked?.[0];
        if (chosen) commitCwd(chosen);
        return;
      }
      browse(d.cwd || "");
    };
    const box = el("div", "cbrowse");
    box.hidden = true;
    const browse = folderBrowser({ cmd, box, err, onChoose: commitCwd, onAt: (dir) => { browsing = dir; }, closed: () => pops.cwd.hidden });
    // worktree（ADR 0089）: いるときは面の先頭に元の場所と「元の場所に戻す」、git の場所には末尾に「worktree で始める」
    const current = d.worktree?.current;
    const bar = current ? splitBar(current) : null;
    // worktree を作れる場所では、末尾から明示的に始められる
    const start = d.worktree?.canSplit ? splitItem() : null;
    const busy = d.worktreeBusy ? el("p", "wt-busy-note", t("worktree.busyNote", { who: d.worktreeBusy.who })) : null;
    pop.replaceChildren(...(bar ? [bar] : []), inputWrap, msg, head(t("composer.cwd.recent")),
      recent.length ? listbox(t("composer.cwd.recent"), recent) : el("p", "cnote", t("composer.cwd.noRecent")),
      pick, ...(busy ? [busy] : []), ...(start ? [start] : []), box, err);
    if (browsing != null) browse(browsing);
  }
  function splitBar(current) {
    const bar = el("div", "wt-splitbar");
    const back = el("button", "btn btn-quiet", t("worktree.back"));
    back.type = "button";
    back.onclick = () => { folder.hide(); on.worktreeBack?.(); };
    const orig = el("span", "wt-orig");
    orig.append("· ", ...t("worktree.from", { path: "\u2063p\u2063" }).split("\u2063").map((piece) => (piece === "p" ? el("code", null, current.origin) : piece)).filter((x) => x !== ""));
    bar.append(branchGlyph(), el("b", null, t("worktree.label")), orig, back);
    return bar;
  }
  function splitItem() {
    const b = el("button", "caction wt-start");
    b.type = "button";
    b.append(branchGlyph(), el("span", null, t("worktree.start")));
    b.onclick = () => { folder.hide(); on.worktreeSplit?.(); };
    return b;
  }
  // 閉じたら確かめている途中のパスは取り消す（Esc・面の外で閉じたのに、後から確かめが通って変わらないように）
  const folder = panel(chips.cwd, pops.cwd, { align: "left", render: renderFolder, onHide: () => { checkSeq++; } });
  chips.cwd.addEventListener("click", () => { if (!folder.open) browsing = null; });
  /** 面の欄にパスを入れて選んだ状態にする（保存できなかった作業ディレクトリを「選び直す」） */
  function typeCwd(value) {
    const input = pops.cwd.querySelector(".cpath");
    if (!input) return;
    input.value = String(value ?? "");
    input.focus();
    input.select?.();
  }

  // ---- エージェント・モデル・エフォート・アカウント・承認モード（2 段の面。承認モードは 1 段目の最後の行）
  const model = panel(chips.model, pops.model, {
    align: "right",
    render: () => renderModel({ pop: pops.model, target: get(), on, hide: (focus) => model.hide(focus) }),
    onShow: () => on.openModel?.(),
  });

  /** チップの字を今の値に合わせる。開いている面も描き直す（値が変わった・候補が届いた） */
  function paint() {
    const d = get();
    // 作業ディレクトリ
    const cwd = d.cwd ?? "";
    const split = d.worktree?.current ?? (d.worktreePending ? { origin: cwd } : null);
    cwdName.textContent = split ? baseName(split.origin) : cwd ? baseName(cwd) : t("chat.composer.cwd");
    chips.cwd.title = cwd ? t("composer.cwd.chipTitle", { cwd }) : t("chat.composer.cwd");
    if (split) chips.cwd.title = `${chips.cwd.title} · ${t("worktree.chipTitle", { origin: split.origin })}`;
    chips.cwd.classList.toggle("wt", Boolean(split));
    splitSuffix.hidden = !split;
    splitSuffix.textContent = split ? `· ${t("worktree.chipSuffix")}` : "";
    const busy = d.worktreeBusy ?? null;
    // 確認中（'checking'）・取得失敗（'failed'）は、確定した「書き込み中」とも「なし」とも別に出す
    const check = busy ? "confirmed" : d.worktreeCheck ?? "confirmed";
    const lead = split ? splitGlyph : folderGlyph;
    if (chips.cwd.firstChild !== lead) chips.cwd.firstChild.replaceWith(lead);
    chips.cwd.setAttribute("aria-label", t("composer.cwd.chipAria", { cwd: cwd || t("composer.cwd.unset") }));
    chips.cwd.dataset.value = cwd;
    chips.cwd.disabled = Boolean(d.cwdDisabled);
    if (d.cwdDisabled && d.lockedNote) addNote(chips.cwd, d.lockedNote);
    // ブランチ。名前は title と読み上げにも足す
    const gitName = d.git ? (d.git.branch ?? (d.git.head ? t("git.detached", { hash: d.git.head }) : "")) : "";
    gitBranch.hidden = !gitName || Boolean(split);
    gitBranch.replaceChildren(...(gitName ? [branchGlyph(), gitName] : []));
    if (gitName) {
      chips.cwd.title = `${chips.cwd.title} · ${t("git.chipBranch", { branch: gitName })}`;
      chips.cwd.setAttribute("aria-label", `${chips.cwd.getAttribute("aria-label")} · ${t("git.chipBranch", { branch: gitName })}`);
    }
    // 別の会話が書き込み中なら、誰かを title と読み上げに足す。確認中・失敗もその旨を足す（字は「…」だけなので）
    const why = busy ? t("worktree.busyTitle", { who: busy.who }) : check === "checking" ? t("worktree.checkingTitle") : check === "failed" ? t("worktree.unknownTitle") : "";
    if (why) {
      chips.cwd.title = `${chips.cwd.title} · ${why}`;
      chips.cwd.setAttribute("aria-label", `${chips.cwd.getAttribute("aria-label")} · ${why}`);
    }
    // モデル
    // 互換の接続先は「接続先 · モデル · 段」。モデルは表示名（web/compat-models.mjs）で、1M は札。送る ID を含む全体は title に出す
    const row = d.endpoint?.row;
    const epModel = row ? compatModelLabel(d.model || row.roles?.main || "") : null;
    const epLabel = row ? endpointChipLabel({ connection: row.name, model: epModel.text, fullModel: epModel.id, effort: effortStops(d.efforts, d.effort).current }) : null;
    const label = epLabel ? epLabel.text : modelChipLabel(d.models, d.model, d.efforts, d.effort);
    const full = epLabel ? epLabel.full : label;
    const { head: modelHead, tail: modelTail } = splitChipLabel(label);
    paintWhoChip(chips.model, { bot: d.destination?.bot, backend: d.backend,
      backendLabel: d.destination?.backendLabel?.(d.backend) ?? d.backend,
      model: epLabel ? epLabel.head : modelHead, effort: epLabel ? epLabel.tail : modelTail,
      sent: Boolean(d.destination?.sent), endpoint: Boolean(row), oneM: Boolean(epLabel && epModel.oneM), pending: Boolean(d.modelsPending && !row),
      // 互換の接続先は送る ID を含む全体を title に
      title: epLabel ? t("composer.model.chipTitle", { label: full }) : null });
    chips.model.dataset.value = d.model ?? "";
    chips.model.dataset.backend = d.backend ?? "";
    // 承認モード。既定から外れているときだけ、モデルのチップの ▾ の前に「· 盾 名前」を --ink-blue で出す（ADR 0252）。
    // Bypass は盾を ⚠ の線画に替え、強い字にする（字の頭に ⚠ は書かない・太字にしない）。
    // 狭い行では短い名前（サーバーの short。「都度」など）に替える（fitRow）。読み上げは長い名前のまま。
    // 切り替えた直後でモードの一覧が取れるまでは、前のエージェントのモードを出さない
    const m = d.modesPending ? null : d.modes?.[d.mode];
    const danger = isDanger(m);
    chips.model.dataset.mode = d.mode ?? "";
    if (m) {
      const modeFull = m.label ?? d.mode ?? "";
      const modeAria = danger ? t("composer.mode.chipAriaDanger", { mode: modeFull }) : t("composer.mode.chipAria", { mode: modeFull });
      chips.model.setAttribute("aria-label", `${chips.model.getAttribute("aria-label")} · ${modeAria}`);
      chips.model.title = `${chips.model.title} · ${danger ? t("composer.mode.dangerTitle") : modeAria}`;
      // 危険なモード（確認なし・制限なし）は既定のモードでも印を出す。Antigravity の yolo だけの会話で
      // 「既定だから」と印を消すと、承認を聞かないまま走ることが目に見えない（#147）
      if (danger || d.mode !== defaultModeOf(d.modes)) {
        const modeShort = m.short && m.short !== modeFull ? m.short : "";
        const mark = el("span", `mk${danger ? " danger" : ""}${markedMode !== undefined && markedMode !== d.mode ? " in" : ""}`);
        mark.setAttribute("aria-hidden", "true");
        mark.append(glyph(...(danger ? WARN : [SHIELD])), el("span", "full", modeFull), ...(modeShort ? [el("span", "short", modeShort)] : []));
        const sep = el("span", "dotsep", "·");
        sep.setAttribute("aria-hidden", "true");
        chips.model.querySelector(".caret")?.before(sep, mark);
      }
      markedMode = d.mode;
    }
    // 安全装置で別のモデルが答えているあいだ（承認済み 2026-11-13）。選んだモデルは残し、承認モードの印と同じ形で「⇄ 答えているモデル」を足す
    if (d.switched?.label) {
      const why = t("composer.model.switchedTitle", { model: d.switched.label });
      chips.model.setAttribute("aria-label", `${chips.model.getAttribute("aria-label")} · ${why}`);
      chips.model.title = `${chips.model.title} · ${why}`;
      const mark = el("span", "mk sw");
      mark.setAttribute("aria-hidden", "true");
      mark.append(glyph(...SWITCH), el("span", "full", d.switched.label));
      const sep = el("span", "dotsep", "·");
      sep.setAttribute("aria-hidden", "true");
      chips.model.querySelector(".caret")?.before(sep, mark);
    }
    // 開いている面も描き直す。触っていた部品へフォーカスを戻す（data-key で引き直す）。
    // 戻すときは面をスクロールさせない（開いたときに焦点を置いた上の行へ、なぞって下げた一覧が引き戻される）。
    // 作業ディレクトリの面は打ち込み中・辿っている途中を消さないよう、位置だけ合わせる
    for (const p of [model]) {
      if (!p.open) continue;
      const key = p.pop.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
      p.render(); p.place();
      if (key) (p.pop.querySelector(`[data-key="${CSS.escape(key)}"]:not([hidden]):not(:disabled)`) ?? p.pop.querySelector('[aria-selected="true"]'))?.focus({ preventScroll: true });
    }
    folder.place();
    fitRow();
  }

  /**
   * チップの行を 1 行に収める（docs/design-system.md「入力欄と上端」）。短い値は詰めない。足りない分だけ、この順に削る:
   *   0. worktree の札と競合の知らせを畳み、次に作業場所のブランチを外す（ADR 0136）
   *   1. 承認モードの印を短い名前に（都度確認 → 都度）  2. モデルの「 · 段」を外す
   *   3. モデル名を … で詰める（「Smart…」くらいまで）  4. 作業ディレクトリの名前を … で詰める（9 字くらいまでは残す）
   * 縮める前の幅は、チップを縮めない状態（.measuring）で測る。行の幅・中身が変わるたびに呼ぶ（paint・窓の幅・中断の出入り）
   */
  function fitRow() { fitComposerRow(chips.cwd.parentElement, { cwd: chips.cwd, who: chips.model }); }
  window.addEventListener("resize", fitRow);
  const rowObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitRow()) : null;
  rowObserver?.observe(chips.cwd.parentElement);

  /** 入力欄を外すとき。開いている面がこの入力欄のものなら閉じ、行の見張りを外す */
  function destroy() {
    window.removeEventListener("resize", fitRow);
    rowObserver?.disconnect();
    if (openPanel && Object.values(pops).includes(openPanel.pop)) openPanel.hide(false);
  }

  return { paint, fit: fitRow, close: () => openPanel?.hide(false), panels: { folder, model }, typeCwd, destroy };
}
