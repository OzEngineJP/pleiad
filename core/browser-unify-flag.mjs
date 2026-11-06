// ブラウザーの一本化（ADR 0291〜0294、temporary/browser-unify-plan.md）の旗。
// AGENT_HOST_BROWSER_UNIFY=on のときだけ新しい形（ファイルのページと隔離の port・/_pleiad/・右の欄の Chrome のウィンドウ）を使う。
// 既定は off で、off のあいだ利用者に見える動きは今のまま。旗を外すのは C1。
export const BROWSER_UNIFY_ENV = 'AGENT_HOST_BROWSER_UNIFY';

/** 旗が on か。値は on だけを受ける（大小文字と前後の空白は見ない） */
export function browserUnifyOn(env = process.env) {
  return String(env?.[BROWSER_UNIFY_ENV] ?? '').trim().toLowerCase() === 'on';
}
