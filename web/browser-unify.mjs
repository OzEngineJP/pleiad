// 右の欄の組み立て（ADR 0291〜0294）。旗が on（hostCapabilities.browserUnify がある）ときだけ web/client.mjs が読む。
// S0 では部品を作るだけで、何も描かない。組み立ては B1 が置く。
import { createTabStrip } from './tab-strip.mjs';
import { createAddressBar } from './address-bar.mjs';
import { createPageFrame } from './page-frame.mjs';
import { createPhoneInput } from './phone-input.mjs';

/**
 * @param {object} [deps] web/client.mjs から渡すもの（cmd・state など。足すのは B1）
 * @returns {{ capsChanged(caps: object | null): void }}
 */
export function createBrowserUnify(deps = {}) {
  const parts = {
    tabs: createTabStrip(deps),
    address: createAddressBar(deps),
    frame: createPageFrame(deps),
    phone: createPhoneInput(deps),
  };
  void parts;
  return { capsChanged() {} };
}
