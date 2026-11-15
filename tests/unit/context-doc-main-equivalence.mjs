// 指示・Skills の名前 × エージェントの表（ADR 0337）を、main の実装で採った記録と突き合わせる試験の A と B（触っていない人の計画・表の初期のマス）。
// 中身と確かめることの説明は tests/lib/context-doc-equivalence.mjs
import { runEquivalence } from '../lib/context-doc-equivalence.mjs';

export const name = 'context-doc-main-equivalence';
export const title = '指示・Skills の表: 旧い保存の全部の組み合わせで、触っていない人の計画と表の初期のマスが main と同じ';

export default t => runEquivalence(t, { plans: true });
