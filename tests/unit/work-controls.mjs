// 子の会話のモーダルの入力欄のチップ（web/composer/work-controls.mjs。ADR 0315 段 4・ADR 0317）。
// メインと同じ面にアカウント・互換の接続先を出し、選んだ値は子の次のターンの予約（reserve）へ流す。
//   - 値の読みは「重ねた選択 → 予約中の選択 → 次のターンの予約 → 子の行」の順
//   - 接続先を選ぶと、モデルとエフォートは接続先の既定へ戻る（メイン・server と同じ）。接続先があるあいだ、語彙・エフォートはアカウントを使わない
//   - アカウント・接続先の候補は、エージェントが対応していなければ出さない
import { createWorkControls } from '../../web/composer/work-controls.mjs';

export const name = 'work-controls';
export const title = '子の会話の入力欄のチップ: アカウント・互換の接続先を子の値で出し、次のターンの予約へ流す';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

export default async function (t) {
  const rows = new Map([['c1', { id: 'c1', backend: 'claude', model: 'opus', effort: 'high', mode: 'plan', cwd: '/w', compatEndpoint: 'ep1', claudeAccount: 'acc1' }],
    ['c3', { id: 'c3', backend: 'claude', model: 'opus', effort: 'high', mode: 'plan', cwd: '/repo.wt/x' }],
    ['c2', { id: 'c2', backend: 'codex', model: 'gpt', effort: 'low', mode: 'default', cwd: '/w' }]]);
  const writes = [], vocabAsked = [], choicesAsked = [], repaints = [], fails = [];
  const hold = { write: null };
  const efforts = { efforts: {}, ready: () => true, fresh: () => true, adopt: async () => true };
  const controls = createWorkControls({
    row: (id) => rows.get(id), item: (id) => (id === 'c3' ? { worktree: { origin: '/repo', branch: 'ply/x', path: '/repo.wt/x' } } : null), pending: () => null,
    backends: () => [{ id: 'claude' }, { id: 'codex' }], labelOf: (id) => id,
    vocab: (backend, account) => ({ models: { '': {}, opus: {} }, modes: { default: {}, plan: {} }, tag: `${backend}/${account}` }),
    loadVocab: async (...a) => { vocabAsked.push(a); },
    efforts,
    reserve: (patch, id) => { writes.push({ patch, id }); return hold.write ?? Promise.resolve(); },
    setMode: async () => {},
    recent: () => [],
    loadChoices: async (backend) => { choicesAsked.push(backend); },
    accounts: (backend, account, endpoint) => (backend === 'claude' ? [{ value: '', label: 'signed' }, { value: 'acc1', label: 'A1', endpoint }] : null),
    endpointView: (backend, selected) => (backend === 'claude' ? { selected, row: selected ? { id: selected } : null } : null),
    worktreeNote: (branch) => `wt:${branch}`,
    revalidate: () => {},
    repaint: (id) => repaints.push(id),
    fail: (e) => fails.push(e),
    empty: () => ({ efforts: {} }),
  });

  const d = controls.get('c1');
  t.ok('Claude の子には接続先の面が出て、行の接続先を選んでいる', d.endpoint?.selected === 'ep1' && d.endpoint.row?.id === 'ep1', JSON.stringify(d.endpoint));
  t.ok('アカウントの候補が出て、行のアカウントを選んでいる', d.accounts?.length === 2 && d.account === 'acc1');
  t.ok('そのエージェントの候補を取りに行く（1 回だけ）', choicesAsked.length === 1 && choicesAsked[0] === 'claude');
  controls.get('c1');
  t.ok('描き直しのたびには取りに行かない', choicesAsked.length === 1);
  t.ok('互換の接続先を選んでいる間、語彙はアカウントなしで引く', controls.get('c1').models && vocabAsked.length === 0);

  const cx = controls.get('c2');
  t.ok('対応していないエージェントの子にはアカウント・接続先の節を出さない', cx.accounts === null && cx.endpoint === null);

  // 委譲で worktree を割り当てられた子: 作業場所は元の場所 ⑂ worktree の読み取りだけ
  const wt = controls.get('c3');
  t.ok('worktree の子は作業場所のチップを押せず、元の場所と worktree の印を出す', wt.cwdDisabled === true && wt.worktree?.current?.origin === '/repo' && wt.worktree.canSplit === false);
  t.ok('押せない理由に worktree のブランチを添える', wt.lockedNote === 'wt:ply/x');
  t.ok('worktree でない子は従来どおり（作業場所を替えられ、印も注記も無い）', d.cwdDisabled === false && d.worktree === null && d.lockedNote === '');

  // 接続先を選ぶ: 予約へ流れ、モデルとエフォートは重ねて空に戻る
  controls.on.endpoint('c1', 'ep2');
  t.ok('接続先を予約へ流す', writes.at(-1)?.id === 'c1' && writes.at(-1).patch.endpoint === 'ep2' && Object.keys(writes.at(-1).patch).length === 1, JSON.stringify(writes.at(-1)));
  const sel = controls.selection('c1');
  t.ok('選んだ直後は接続先を重ねて見せ、モデル・エフォートは接続先の既定へ戻る', sel.endpoint === 'ep2' && sel.model === '' && sel.effort === '', JSON.stringify(sel));
  await settle();
  t.ok('保存できて行が予約を持つようになれば重ねを外す（行の値に戻る）', controls.selection('c1').endpoint === 'ep1');

  // 行が予約を持つ
  rows.get('c1').nextSettings = { backend: 'claude', endpoint: '', model: '' };
  t.ok('次のターンの予約が公式（空）なら、行の接続先より優先する', controls.selection('c1').endpoint === '');
  t.ok('公式なら接続先の面は「公式」を選んでいる', controls.get('c1').endpoint.selected === '' && controls.get('c1').endpoint.row === null);
  delete rows.get('c1').nextSettings;

  // アカウントを選ぶ
  controls.on.account('c1', '');
  t.ok('アカウントを予約へ流す', writes.at(-1)?.patch.account === '' && Object.keys(writes.at(-1).patch).length === 1);
  t.ok('選んだ直後はログイン中のアカウントを重ねて見せる', controls.selection('c1').account === '');

  // 書けなかったら戻して理由を言う
  hold.write = Promise.reject(new Error('保存できない'));
  hold.write.catch(() => {});
  await settle();
  controls.on.account('c1', '');
  t.ok('書いている間は選んだ値を見せる', controls.selection('c1').account === '');
  await settle();
  t.ok('書けなかったら重ねを外して行の値へ戻し、理由を言う', fails.includes('保存できない') && controls.selection('c1').account === 'acc1');
  t.ok('描き直しを呼んでいる', repaints.length > 0);
}
