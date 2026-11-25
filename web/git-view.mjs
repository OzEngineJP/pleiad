// git の動きの小さな部品（docs/design-system.md「git の動き」）。右パネルの git のタブ（web/git-panel.mjs）が共有する文の組み立てだけ。DOM には触れない。
// 返答の下の要約行（present kind: 'git'）と委譲カードの「変更」の行は、ADR 0352 でやめた（ADR 0085 の決定 2・3・6 の置き換え）。
import { t } from './i18n.mjs';

/** 「+6 −2」。削除が 0 なら +6 だけ（新規ファイルだけのときに −0 を出さない） */
export const changeText = (add, del) => `+${add}${del ? ` −${del}` : ''}`;

/** ブランチの名前。分離した HEAD は HEAD <hash>、最初のコミット前は「（コミットなし）」 */
export const branchLabel = (git) => git?.branch ?? (git?.head ? t('git.detached', { hash: git.head }) : t('git.noBranch'));

/** 「2 ファイル +6 −2」 */
export const filesText = (total) => `${t('git.files', { count: total.files })} ${changeText(total.add, total.del)}`;
