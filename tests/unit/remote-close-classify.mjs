// classifyClose の振る舞いの試験（docs/remote.md §7.4、issue B6）。
// own は今と同じ結果、plus は閉じ方の表のとおり。
import { classifyClose } from '../../core/remote/device-link.mjs';

export const name = 'remote-close-classify';
export const title = 'リモート接続の切断分類: own と plus の振る舞い';

export default function (t) {
  // ---- own の場合（従来通り）
  t.ok('own: 4401 は revoked', classifyClose({ closeCode: 4401 }) === 'revoked');
  t.ok('own: goaway revoked は revoked', classifyClose({ goaway: 'revoked', closeCode: 1000 }) === 'revoked');
  t.ok('own: 4404 は host-offline', classifyClose({ closeCode: 4404 }) === 'host-offline');
  t.ok('own: 4408 は host-offline', classifyClose({ closeCode: 4408 }) === 'host-offline');
  t.ok('own: shutdown は host-offline', classifyClose({ goaway: 'shutdown', closeCode: 1001 }) === 'host-offline');
  t.ok('own: 1013 は offline', classifyClose({ closeCode: 1013 }) === 'offline');
  t.ok('own: 1006 は offline', classifyClose({ closeCode: 1006 }) === 'offline');
  t.ok('own: 4429 は offline', classifyClose({ closeCode: 4429 }) === 'offline');

  // ---- plus の場合
  // 4404 -> host-offline
  t.ok('plus: 4404 は host-offline', classifyClose({ closeCode: 4404, via: 'plus' }) === 'host-offline');
  t.ok('plus: 4408 は host-offline', classifyClose({ closeCode: 4408, via: 'plus' }) === 'host-offline');

  // 4401 reason revoked / device token -> readmit
  t.ok('plus: 4401 revoked は readmit', classifyClose({ closeCode: 4401, reason: 'revoked', via: 'plus' }) === 'readmit');
  t.ok('plus: 4401 device token は readmit', classifyClose({ closeCode: 4401, reason: 'device token', via: 'plus' }) === 'readmit');
  t.ok('plus: goaway revoked は readmit', classifyClose({ goaway: 'revoked', via: 'plus' }) === 'readmit');

  // 4401 reason account -> blocked
  t.ok('plus: 4401 account は blocked', classifyClose({ closeCode: 4401, reason: 'account', via: 'plus' }) === 'blocked');

  // 4401 reason host -> removed（ホストの PC が Plus のアカウントから外された。受け入れ直さない）
  t.ok('plus: 4401 host は removed', classifyClose({ closeCode: 4401, reason: 'host', via: 'plus' }) === 'removed');

  // 4401 reason token -> offline
  t.ok('plus: 4401 token は offline', classifyClose({ closeCode: 4401, reason: 'token', via: 'plus' }) === 'offline');

  // 4401 reason plus off -> host-offline
  t.ok('plus: 4401 plus off は host-offline', classifyClose({ closeCode: 4401, reason: 'plus off', via: 'plus' }) === 'host-offline');

  // 4401 reason plus unavailable -> paused
  t.ok('plus: 4401 plus unavailable は paused', classifyClose({ closeCode: 4401, reason: 'plus unavailable', via: 'plus' }) === 'paused');

  // 4429 reason account limit -> limit
  t.ok('plus: 4429 account limit は limit', classifyClose({ closeCode: 4429, reason: 'account limit', via: 'plus' }) === 'limit');

  // 4429 reason admit rate -> offline
  t.ok('plus: 4429 admit rate は offline', classifyClose({ closeCode: 4429, reason: 'admit rate', via: 'plus' }) === 'offline');

  // 1013 -> offline
  t.ok('plus: 1013 は offline', classifyClose({ closeCode: 1013, via: 'plus' }) === 'offline');

  // goaway shutdown -> host-offline
  t.ok('plus: goaway shutdown は host-offline', classifyClose({ goaway: 'shutdown', via: 'plus' }) === 'host-offline');

  // その他 -> offline
  t.ok('plus: 1006 は offline', classifyClose({ closeCode: 1006, via: 'plus' }) === 'offline');
}
