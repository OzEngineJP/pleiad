// ==================== 設定 › プラグイン / 会話の右パネル: タブ・フォルダーのまとまり・絞り込み ====================
// 承認済みモック（2026-11-15）の段 1 で共有する UI 部品（web/context.mjs・web/session-context.mjs）。
// バックエンドの id は直書きせず、エージェントのブランド情報は web/agent-brands.mjs から動的に引く。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { agentBrand, agentShortLabel } from './agent-brands.mjs';
import { ensureBrandMark } from './brand-marks.mjs';
import { hideLockTip } from './lock-tip.mjs';

export const CONTEXT_TABS = ['instruction', 'skill', 'mcp', 'hooks'];
export const BUNDLE_COLLAPSE_AFTER = 8;

const TAB_FALLBACK = new Map();
const ICON_CHEVRON = '<path d="m9 6 6 6-6 6"/>';
const ICON_FIND = '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>';

function svgIcon(d) {
  const s = document.createElementNS?.('http://www.w3.org/2000/svg', 'svg') ?? el('span');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = d;
  return s;
}

export const chevronIcon = () => svgIcon(ICON_CHEVRON);
export const findIcon = () => svgIcon(ICON_FIND);

/** 最後に開いていたタブを読む（localStorage が使えない環境はメモリへ退避） */
export function readTabStorage(key, valid = CONTEXT_TABS, fallback = CONTEXT_TABS[0]) {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (saved && valid.includes(saved)) return saved;
  } catch {}
  const cached = TAB_FALLBACK.get(key);
  return cached && valid.includes(cached) ? cached : fallback;
}

export function writeTabStorage(key, id) {
  TAB_FALLBACK.set(key, id);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, id);
  } catch {}
}

export const pathNorm = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const parentDir = p => String(p ?? '').replace(/[\\/][^\\/]+$/, '');

function lastSegment(p) {
  const clean = String(p ?? '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? clean;
}

/** エージェントのロゴ。ロゴの無いエージェントは ◇（web/mcp-matrix.mjs と同じ規則） */
export function brandMark(id) {
  const brand = agentBrand(id);
  if (brand?.mark) {
    const s = document.createElementNS?.('http://www.w3.org/2000/svg', 'svg') ?? el('span');
    s.setAttribute('class', 'mk');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = `<use href="#${ensureBrandMark(brand.logo)}"/>`;
    return s;
  }
  if (brand) {
    const img = el('img', 'mk');
    img.src = `./brand/${brand.logo}`;
    img.alt = '';
    img.draggable = false;
    return img;
  }
  return el('span', 'mk', '◇');
}

/** 行・まとまりが持つ「元のエージェント設定」の id（共通ルール common は省く） */
export function entryOrigins(entry) {
  const items = entry?.group ?? [entry];
  const out = [];
  for (const item of items) {
    for (const o of item?.origins ?? []) {
      if (o?.source && o.source !== 'common' && !out.includes(o.source)) out.push(o.source);
    }
  }
  return out;
}

/** 名前の右に置く小さなロゴ列（読まれる 1 つの img で、押せない） */
export function originMarks(sources) {
  if (!sources?.length) return null;
  const joiner = t('sessionContext.chip.join');
  const names = sources.map(id => agentShortLabel(id, id)).join(joiner);
  const label = t('mcp.matrix.originAgent', { agents: names });
  const box = el('span', 'cx-src');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', label);
  box.title = label;
  for (const id of sources) {
    const sm = el('span', `sm be-${id}`);
    sm.append(brandMark(id));
    box.append(sm);
  }
  return box;
}

/**
 * 指示・Skill の置き場フォルダーと、まとまりの中で表示する短い名前を返す。
 * rules（入れ子を含む）は最寄りの rules フォルダーまでを親にし、子は相対パスにする。
 */
export function bundleFolder(kind, entry) {
  const full = String(entry?.path ?? '');
  if (kind === 'skill') {
    const skillDir = parentDir(full);
    const rootDir = parentDir(skillDir);
    return { folder: rootDir || skillDir || full, childLabel: entry?.name ?? lastSegment(skillDir) };
  }
  const sep = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  const dirPart = sep >= 0 ? full.slice(0, sep) : '';
  if (entry?.rule && dirPart) {
    const re = /(?:^|[\\/])rules(?=$|[\\/])/gi;
    let m, last = null;
    while ((m = re.exec(dirPart)) !== null) last = m;
    if (last) {
      const end = last.index + last[0].length;
      const folder = dirPart.slice(0, end);
      const rel = full.slice(folder.length + 1).replace(/\\/g, '/');
      return { folder, childLabel: rel || (entry?.name ?? lastSegment(full)) };
    }
  }
  return { folder: dirPart || full, childLabel: entry?.name ?? lastSegment(full) };
}

/** まとまり行の見出し。Skills の `.../skills` は親セグメントも含める（例: `.claude/skills`） */
export function bundleLabel(folder, kind) {
  const clean = String(folder ?? '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  if (kind === 'skill' && parts.length >= 2 && /^skills$/i.test(parts.at(-1))) {
    const sep = clean.includes('\\') && !clean.includes('/') ? '\\' : '/';
    return `${parts.at(-2)}${sep}${parts.at(-1)}`;
  }
  return parts.at(-1) ?? clean;
}

/**
 * 項目をフォルダーごとにまとめる。
 * - Skill: すべての置き場フォルダーを 1 行のまとまりにする
 * - 指示: 同じフォルダーに 2 件以上あるときだけまとまりにし、1 件なら単独の行にする
 * 8 件を超えるまとまりは初期状態で畳む（defaultOpen = false）。
 */
export function groupEntries(kind, entries) {
  const buckets = new Map();
  for (const entry of entries ?? []) {
    const { folder, childLabel } = bundleFolder(kind, entry);
    const key = pathNorm(folder);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, folder, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push({ entry, childLabel });
  }
  const out = [];
  for (const bucket of buckets.values()) {
    if (kind === 'skill' || bucket.items.length >= 2) {
      const origins = [];
      for (const { entry } of bucket.items) {
        for (const s of entryOrigins(entry)) if (!origins.includes(s)) origins.push(s);
      }
      out.push({
        type: 'bundle',
        key: bucket.key,
        folder: bucket.folder,
        label: bundleLabel(bucket.folder, kind),
        items: bucket.items,
        origins,
        defaultOpen: bucket.items.length <= BUNDLE_COLLAPSE_AFTER,
      });
    } else {
      out.push({
        type: 'row',
        entry: bucket.items[0].entry,
        childLabel: bucket.items[0].childLabel,
      });
    }
  }
  return out;
}

/**
 * まとまりのオン/オフ集計。
 * 混在時は 'mixed'（role="checkbox" + 読み上げ名に件数入りで「一部」を伝える）。
 */
export function bundleSwitchState(items, isEnabled, baseLabel) {
  let on = 0;
  for (const item of items) if (isEnabled(item)) on++;
  const total = items.length;
  const checked = total > 0 && on === total ? 'true' : on > 0 ? 'mixed' : 'false';
  const ariaLabel = checked === 'mixed'
    ? t('context.bundle.partialAria', { label: baseLabel, on, total })
    : baseLabel;
  return { checked, ariaLabel, on, total };
}

/** キーボード（←/→・Home/End）つきの tablist を作る */
export function createTabBar({ tabs, active, idPrefix = 'cx', ariaLabel, onSelect }) {
  const root = el('div', 'cx-tabs');
  root.setAttribute('role', 'tablist');
  if (ariaLabel) root.setAttribute('aria-label', ariaLabel);
  const buttons = new Map();
  let current = active;

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const btn = el('button', 'cx-tab');
    btn.type = 'button';
    btn.id = `${idPrefix}-tab-${tab.id}`;
    btn.dataset.tab = tab.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', `${idPrefix}-panel-${tab.id}`);
    btn.setAttribute('aria-selected', String(tab.id === active));
    btn.tabIndex = tab.id === active ? 0 : -1;
    const label = el('span', 'l', tab.label);
    const cnt = el('span', 'c');
    cnt.hidden = true;
    btn.append(label, cnt);
    btn.onclick = () => onSelect?.(tab.id, { focus: false });
    btn.onkeydown = e => {
      let next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        onSelect?.(tabs[next].id, { focus: true });
      }
    };
    buttons.set(tab.id, { btn, cnt });
    root.append(btn);
  }

  function setActive(id, { focus = false } = {}) {
    current = id;
    hideLockTip();
    for (const [tid, { btn }] of buttons) {
      const on = tid === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    }
  }

  function setCounts(counts) {
    if (!counts) return;
    for (const [tid, { cnt }] of buttons) {
      const val = counts[tid];
      if (val == null) {
        cnt.textContent = '';
        cnt.hidden = true;
      } else {
        cnt.textContent = String(val);
        cnt.hidden = false;
      }
    }
  }

  return { root, get active() { return current; }, setActive, setCounts };
}

/** 絞り込み欄。input 要素を保つため一覧の枠だけを外から描き直す設計 */
export function createFindBar({ placeholder, ariaLabel, value = '', onInput }) {
  const root = el('label', 'cx-find');
  const icon = findIcon();
  const input = el('input');
  input.type = 'search';
  input.placeholder = placeholder ?? '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  input.value = value;
  input.oninput = () => onInput?.(input.value.trim());
  input.onkeydown = e => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      onInput?.('');
    }
  };
  root.append(icon, input);
  return {
    root,
    input,
    get value() { return input.value.trim(); },
    clear() { input.value = ''; },
  };
}
