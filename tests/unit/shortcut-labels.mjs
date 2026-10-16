// 近道の表記（web/keyboard.mjs の shortcutLabel・shortcutAria と、web/i18n.mjs の data-shortcut）。
// macOS は ⌘ / ⇧ の記号（⌘⇧B と同じ形。Enter は ↩）、ほかは Ctrl+ / Shift+。キーの扱いは変えず、表記だけを OS に合わせる
import assert from 'node:assert/strict';
import { shortcutLabel, shortcutAria, parseShortcut } from '../../web/keyboard.mjs';

export const name = 'shortcut-labels';
export const title = '近道の表記: macOS は ⌘、ほかは Ctrl';

export default async function (t) {
  assert.equal(shortcutLabel('Enter', {}, true), '⌘↩');
  assert.equal(shortcutLabel('Enter', {}, false), 'Ctrl+Enter');
  assert.equal(shortcutLabel('Enter', { shift: true }, true), '⌘⇧↩');
  assert.equal(shortcutLabel('Enter', { shift: true }, false), 'Ctrl+Shift+Enter');
  assert.equal(shortcutLabel('B', {}, true), '⌘B');
  assert.equal(shortcutAria('F', {}, true), 'Meta+F');
  assert.equal(shortcutAria('Enter', { shift: true }, false), 'Control+Shift+Enter');
  assert.deepEqual(parseShortcut('shift+Enter'), { key: 'Enter', shift: true });
  assert.deepEqual(parseShortcut('B'), { key: 'B', shift: false });
  t.ok('macOS は ⌘・⇧、ほかは Ctrl+・Shift+。aria-keyshortcuts は Meta / Control', true);

  // 訳文に Ctrl のキーを直書きしない（{{key}} にして OS の表記で埋める）。Ctrl+C / ⌘C のように両方を書いたものは除く
  const fs = await import('node:fs');
  for (const lang of ['ja', 'en']) for (const ns of ['ui', 'channels']) {
    const text = fs.readFileSync(new URL(`../../web/locales/${lang}/${ns}.json`, import.meta.url), 'utf8');
    const left = text.split('\n').filter((line) => /Ctrl\+/.test(line) && !/⌘/.test(line));
    assert.deepEqual(left, [], `${lang}/${ns}.json に Ctrl の直書きが残っていない`);
  }
  t.ok('訳文の Ctrl の近道は {{key}} で OS の表記にする', true);
}
