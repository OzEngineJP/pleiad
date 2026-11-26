// メインの頭の行（Chats・チャンネル・DM・スレッド・bot のページ）の絵が 1 つであること（承認済み 2026-11-26。
// docs/design-system.md「メインの頭」）。index.html の静的な頭（会話の #openSidebar・#titleWand・#sessionMore、
// Channels の #chOpenSidebar）は web/icons.mjs と同じパスを書き、JS で組む頭（スレッド・流れ・bot のページ）は icons.mjs から取る。
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MENU_PATH, WAND_PATH, MORE_PATH, menuIcon, searchIcon, wandIcon, moreIcon } from '../../web/icons.mjs';

export const name = 'main-head-icons';
export const title = 'メインの頭の ≡・⋮・虫眼鏡・✦ は web/icons.mjs の 1 つの絵';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** index.html の id のボタンの中の最初の path の d */
const pathOf = (html, id) => new RegExp(`id="${id}"[^>]*>\\s*<svg[^>]*>\\s*<path d="([^"]+)"`).exec(html)?.[1] ?? null;

export default function (t) {
  const html = read('web/index.html');
  for (const id of ['openSidebar', 'chOpenSidebar']) t.ok(`#${id} の ≡ は MENU_PATH`, pathOf(html, id) === MENU_PATH, pathOf(html, id));
  t.ok('#titleWand の ✦ は WAND_PATH', pathOf(html, 'titleWand') === WAND_PATH, pathOf(html, 'titleWand'));
  t.ok('#sessionMore の ⋮ は MORE_PATH', pathOf(html, 'sessionMore') === MORE_PATH, pathOf(html, 'sessionMore'));
  for (const id of ['openSidebar', 'chOpenSidebar']) {
    t.ok(`#${id} は共通の ≡（.side-opener）`, new RegExp(`class="[^"]*\\bside-opener\\b[^"]*" id="${id}"`).test(html));
  }
  t.ok('絵は読み上げない', [menuIcon, searchIcon, wandIcon, moreIcon].every((s) => s.includes('aria-hidden="true"')));

  // JS で組む頭は icons.mjs から取る（パスを手で書き写さない）
  const thread = read('web/channels/thread-head.mjs');
  t.ok('スレッドの頭は menuIcon・searchIcon・wandIcon を使う', ['menuIcon', 'searchIcon', 'wandIcon'].every((n) => thread.includes(n)));
  t.ok('スレッドの頭に ≡ のパスを書き写していない', !thread.includes(MENU_PATH));
  t.ok('流れの頭の ⋮ は moreIcon', read('web/channels/feed.mjs').includes('moreIcon'));
  t.ok('bot のページの ⋮ は moreIcon', read('web/channels/bot-page.mjs').includes('moreIcon'));
}
