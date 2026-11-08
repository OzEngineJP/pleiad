import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'visualize-card-mouse';
export const title = '可視化カードの実マウス操作と操作列の表示';

export default async function(t) {
  if (process.env.VISUALIZE_CARD_MOUSE_TEST !== '1') {
    t.note('VISUALIZE_CARD_MOUSE_TEST=1 enables the isolated browser checks.');
    return;
  }
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../browser/visualize-card-mouse.mjs');
  const result = spawnSync(process.execPath, [script], { encoding:'utf8', timeout:120000, windowsHide:true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  t.ok('別 origin の本物のブラウザーでマウス操作を確認', result.status === 0, output);
};
