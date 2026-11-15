// 指示・Skills の名前 × エージェントの表（ADR 0337）を、main の実装で採った記録と突き合わせる試験の C/D（旧い保存の組み合わせ default: 旧「エージェントに任せる」のまま）。
// 中身と確かめることの説明は tests/lib/context-doc-equivalence.mjs
import { runEquivalence } from '../lib/context-doc-equivalence.mjs';

export const name = 'context-doc-main-touch-default';
export const title = '指示・Skills の表: 押せるマスは効いて押し戻せる（旧「エージェントに任せる」のまま）';

export default t => runEquivalence(t, { touch: ['default'] });
