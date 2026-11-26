// チャンネルのメモ・設定の「既定の作業フォルダー」（web/channels/feed-settings.mjs が使う）。
//   ・パスの表示（指定が無ければ「指定しない」）と［フォルダーを選ぶ…］。押すと、入力欄の作業ディレクトリと同じ「最近」の一覧
//     （host.recentCwds）・［ほかのフォルダーを開く…］（デスクトップ版は OS のフォルダー選択、ブラウザー版は bot のページの「フォルダーを足す」と
//     同じ、パスを打つ欄と中を辿る一覧 folderBrowser）・［指定しない］を出す。
//   ・欄の下に、メンバーの bot それぞれが実際に動く場所を出す（判定は core の pickCwd と同じ web/work-place.mjs の workPlace）。
//     チャンネルのフォルダーが bot のフォルダーの外なら、使わない理由を添える。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { folderBrowser } from '../composer-controls.mjs';
import { botIcon } from './bot-icon.mjs';
import { createWorkPlaces, whereRows } from './work-places.mjs';

const RECENT_MAX = 6;

/**
 * @param {object} o
 * @param {object} o.host cmd・recentCwds・state.homeDir
 * @param {string} [o.value] 今のチャンネルの既定の作業フォルダー
 * @param {object[]} o.bots 選べる bot（bots.list の定義）
 * @param {Set<string>} o.members チェックされている bot の id（開いている間に増減する。変わったら refreshWhere を呼ぶ）
 * @returns {{ field: HTMLElement, value: () => string, refreshWhere: () => void, popOpen: () => boolean, closePop: (focus?: boolean) => void, owns: (e: Event) => boolean }}
 */
export function createCwdField({ host, value = '', bots = [], members }) {
  let cwd = String(value ?? '').trim();
  const places = createWorkPlaces({ host });

  const field = el('div', 'cs-field');
  const label = el('span', 'cs-label', t('channels:feed.settings.cwd'));
  label.id = 'csCwdLabel';
  const row = el('div', 'folder-row');
  const shown = el('span', 'cs-input cpath');
  shown.id = 'csCwdPath';
  shown.setAttribute('role', 'textbox');
  shown.setAttribute('aria-readonly', 'true');
  shown.setAttribute('aria-labelledby', 'csCwdLabel');
  const pick = el('button', 'btn btn-quiet cs-pick', t('composer.cwd.choose'));
  pick.type = 'button';
  pick.setAttribute('aria-expanded', 'false');
  pick.setAttribute('aria-controls', 'csCwdPop');
  const pop = el('div', 'cs-pop');
  pop.id = 'csCwdPop';
  pop.hidden = true;
  pop.setAttribute('role', 'group');
  pop.setAttribute('aria-label', t('channels:feed.settings.cwdPicker'));
  row.append(shown, pick, pop);

  const where = el('div', 'where');
  where.setAttribute('role', 'list');
  where.setAttribute('aria-label', t('channels:feed.settings.where'));
  where.hidden = true;
  field.append(label, row, where, el('span', 'cs-hint', t('channels:feed.settings.cwdHint')));

  // ---------------------------------------------------------------- 表示
  function paintShown() {
    shown.textContent = cwd || t('channels:feed.settings.cwdNone');
    shown.classList.toggle('empty', !cwd);
    shown.title = cwd;
  }

  // ---------------------------------------------------------------- 各 bot の動く場所
  let seq = 0;
  async function paintWhere() {
    const mine = ++seq;
    const picked = bots.filter((b) => members.has(b.id) && !b.plain);
    await places.ensure(picked);   // モードの表が取れてから描く（範囲を限れないモードは cwd をそのまま使うので、取る前に描くと違う場所を見せる）
    if (mine !== seq) return;
    const rows = whereRows(places, picked, cwd);
    where.hidden = !rows.length;
    where.replaceChildren(...rows.map((r) => {
      const item = el('div', 'where-row');
      item.setAttribute('role', 'listitem');
      const code = el('code', null, r.cwd || t('channels:feed.settings.whereHome'));
      code.title = r.cwd;
      item.append(botIcon(r.bot, 'where-face', 16), el('b', null, r.bot.name), code);
      if (r.outside) item.append(el('span', 'why', t('channels:feed.settings.whereOutside', { name: r.bot.name })));
      return item;
    }));
  }

  // ---------------------------------------------------------------- 選ぶ面
  const msg = el('p', 'cerr');
  msg.setAttribute('role', 'alert');
  const box = el('div', 'cbrowse');
  box.hidden = true;
  const typed = el('input', 'cpath');
  typed.placeholder = t('composer.cwd.placeholder');
  typed.setAttribute('aria-label', t('composer.cwd.inputLabel'));
  typed.autocomplete = 'off';
  typed.spellcheck = false;
  const typedWrap = el('div', 'cpath-wrap');
  typedWrap.append(typed);
  const pane = el('div', 'cs-browse');
  pane.hidden = true;
  pane.append(typedWrap, box, msg);

  function choose(path) {
    cwd = String(path ?? '').trim();
    paintShown();
    closePop(true);
    paintWhere();
  }
  const check = async (v) => {
    const p = v.trim();
    if (!p) return;
    msg.textContent = '';
    try { const r = await host.cmd('listDirs', { path: p }); choose(r?.path || p); }
    catch (e) { msg.textContent = e?.code === 'ENOENT' ? t('composer.cwd.notFound') : e?.message ?? String(e); typed.setAttribute('aria-invalid', 'true'); }
  };
  typed.addEventListener('keydown', (e) => { if (isComposingKey(e) || e.key !== 'Enter') return; e.preventDefault(); e.stopPropagation(); check(typed.value); });
  typed.addEventListener('input', () => { typed.removeAttribute('aria-invalid'); msg.textContent = ''; });
  const browse = folderBrowser({ cmd: (c, a) => host.cmd(c, a), box, err: msg, onChoose: (p) => choose(p), closed: () => pop.hidden });

  function buildPop() {
    const nodes = [];
    const recent = (host.recentCwds?.() ?? []).slice(0, RECENT_MAX);
    if (recent.length) {
      nodes.push(el('div', 'caption', t('channels:feed.settings.cwdRecent')));
      for (const r of recent) {
        const b = el('button');
        b.type = 'button';
        b.title = r.value;
        b.append(el('code', null, r.value));
        if (r.value === cwd) b.setAttribute('aria-current', 'true');
        b.onclick = () => choose(r.value);
        nodes.push(b);
      }
    }
    const browseBtn = el('button', 'caction', t('channels:feed.settings.cwdBrowse'));
    browseBtn.type = 'button';
    browseBtn.onclick = async () => {
      msg.textContent = '';
      if (window.plyDesktop?.chooseFolder) {
        const picked = await window.plyDesktop.chooseFolder().catch(() => null);
        const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
        if (chosen) choose(chosen);
        return;
      }
      pane.hidden = false;
      typed.value = '';
      browse(cwd || '');
    };
    const none = el('button', null, t('channels:feed.settings.cwdNone'));
    none.type = 'button';
    none.onclick = () => choose('');
    nodes.push(browseBtn, pane, none);
    pop.replaceChildren(...nodes);
  }

  function openPop() {
    buildPop();
    pane.hidden = true;
    box.hidden = true;
    msg.textContent = '';
    pop.hidden = false;
    pick.setAttribute('aria-expanded', 'true');
    (pop.querySelector(':scope > button[aria-current]') ?? pop.querySelector(':scope > button'))?.focus();
  }
  function closePop(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true;
    pane.hidden = true;
    pick.setAttribute('aria-expanded', 'false');
    if (focus) pick.focus({ preventScroll: true });
  }
  pick.onclick = () => (pop.hidden ? openPop() : closePop(true));
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.target.closest?.('.cbrowse') || e.target === typed) return;   // 中を辿る一覧は、その中の操作に任せる
    const items = [...pop.querySelectorAll(':scope > button')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  paintShown();
  paintWhere();
  return {
    field,
    value: () => cwd,
    refreshWhere: () => { paintWhere(); },
    popOpen: () => !pop.hidden,
    closePop,
    // 押した場所がこの面（開く／閉じるボタン・一覧）の中か。一覧は押した拍に描き直されて押した要素が外れることがあるので、押した時点の経路で見る
    owns: (e) => e.composedPath().some((n) => n === pop || n === pick),
  };
}
