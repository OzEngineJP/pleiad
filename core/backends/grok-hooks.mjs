// Pleiad がそろえる Hooks を Grok へ渡す、ターンごとのプラグインの置き場（<dataDir>/grok-hooks/<pid>-<乱数>/hooks/hooks.json）。
//
// 中身は core/hooks-unify.mjs が組む（runtime.pluginHooks。Claude Code の形）。ここはターンの始めに書き、
// session/new・session/load の _meta.pluginDirs で渡し、ターンの終わりに消す。Grok はセッション限定のプラグインを保存しない
// （~/.grok/docs/user-guide/09-plugins.md）ので、次のターンは新しい置き場を渡す。
// 置き場の数は、同時に走る Grok のターンの数まで。強制終了で消し損ねたものは、持ち主の pid が居なければ次の起動の最初の書き込みで消す
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const swept = new Set();

/** pluginHooks をターンごとの置き場に書く。{ dir, cleanup }。cleanup は何度呼んでもよい */
export async function writeTurnPlugin(base, pluginHooks) {
  if (!swept.has(base)) { swept.add(base); sweep(base); }
  const dir = path.join(base, `${process.pid}-${randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(path.join(dir, 'hooks'), { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(pluginHooks, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) { remove(dir); throw error; }
  return { dir, cleanup: () => remove(dir) };
}

/** 持ち主の Pleiad（名前の頭の pid）が居ない置き場を消す。強制終了ではターンの終わりの cleanup が走らないため */
export function sweep(base) {
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  for (const name of names) {
    const owner = Number(/^(\d+)-/.exec(name)?.[1]);
    if (owner === process.pid) continue;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); continue; } catch (e) { if (e.code === 'EPERM') continue; }
    }
    remove(path.join(base, name));
  }
}

function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
