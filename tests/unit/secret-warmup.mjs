// main がサーバーを起こす前に safeStorage の鍵を一度取り出す（desktop/secret-bridge.cjs の warmSecretStorage・desktop/main.cjs の boot）。
// macOS のキーチェーンの確認で main が止まっても、サーバーの起動の待ち（60 秒）が走っていないようにする。Electron は起動しない
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { warmSecretStorage } = require('../../desktop/secret-bridge.cjs');

export const name = 'secret-warmup';
export const title = 'キーチェーンの確認をサーバーの起動の待ちより前に済ませる（safeStorage の鍵の取り出し）';

export default async function (t) {
  const calls = [];
  const ok = warmSecretStorage({ isEncryptionAvailable: () => true, encryptString: s => { calls.push('enc'); return Buffer.from(s); }, decryptString: b => { calls.push('dec'); return b.toString(); } });
  t.ok('鍵を一度取り出す（暗号化と復号を 1 回ずつ）', ok === true && calls.join(',') === 'enc,dec');
  const logs = [];
  const denied = warmSecretStorage({ isEncryptionAvailable: () => true, encryptString: () => { throw new Error('denied'); } }, { log: line => logs.push(line) });
  t.ok('拒否されても投げず、記録だけ残す', denied === false && logs.length === 1 && /denied/.test(logs[0]));
  t.ok('使えない起動では取り出さない', warmSecretStorage({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('x'); } }) === false);
  t.ok('safeStorage が無くても投げない', warmSecretStorage(undefined) === false);

  // boot() の中で、サーバーを起こす（chooseLinkedServer・utilityProcess.fork）・起動の待ちを始めるより前に呼ぶ
  const src = await fs.readFile(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  const boot = src.slice(src.indexOf('async function boot()'));
  const at = boot.indexOf('warmSecretStorage(safeStorage');
  const before = ['chooseLinkedServer(', 'utilityProcess.fork(', "t('server.startTimeout')"].map(s => boot.indexOf(s));
  t.ok('boot() でサーバーを起こす・起動の待ちを始める前に鍵を取り出す', at > 0 && before.every(i => i > at), JSON.stringify({ at, before }));
}
