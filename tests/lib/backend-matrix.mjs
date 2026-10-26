// エージェント × 機能の対応表を、能力の印（core/backends/capability-marks.mjs。状態は agent-marks.mjs）から作って端末に出す。
//
//   node tests/lib/backend-matrix.mjs
//
// 文書の写し（docs/backend-matrix.md）は持たない（ADR 0273）。正本はコードだけにする。
// 表は手で書かない。印・エージェントを足したら、このコマンドで一覧を確かめる。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPABILITY_KEYS, isCapabilityState } from '../../core/backends/contract.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';

/** 印ごとの説明（表の 1 列目）。印を足したらここにも足す（無いと backend-contract が落とす） */
export const ABOUT = {
  title: 'タイトルをエージェントの側に持つ（補: Pleiad の控え）',
  tag: '状態タグをエージェントの側に持つ（補: Pleiad の控え）',
  fork: 'エージェントの側で分岐する（補: Pleiad が写して分ける）',
  forkMessage: '発言の途中で分岐できる（補: Pleiad が写す）',
  rewind: '同じ会話の巻き戻し（resumeAt: 次のターンで切る / thread: すぐ切る / 補: Pleiad が写す）',
  subagents: 'サブエージェントの一覧と中身',
  liveModel: '走っている最中にモデルを替える',
  liveMode: '走っている最中に承認モードを替える',
  hostTools: 'AI から set_status / set_title / fork を呼ぶ（補: ply_control で同じことができる）',
  approvals: '対話の承認（none: 承認モードが確認なしだけ）',
  alwaysAllow: '承認に「常に許可」を返す',
  mcpApproval: 'MCP のツールの承認（host: エージェントが聞かないので Pleiad が聞く）',
  login: 'Pleiad の画面からログインする',
  accounts: '会話ごとにアカウントを選ぶ（token: Pleiad がトークンを持つ / agent: エージェントがアカウントごとの置き場でログインする）',
  compatEndpoints: '互換の接続先を会話ごとに選ぶ',
  compact: '手動・自動の圧縮（true: compact() で圧縮する / prompt: /compact を発言として送る）',
  autoCompactWindow: '委譲の子の自動圧縮の閾値を受け取る',
  promptSuggestions: '次の発言の候補（native: ターンの中で届く / 補: ターンの後に suggestNext で作る）',
  plyInstructions: 'Pleiad の指示（ユーザーが足した分・既定の項目）を受け取る',
  plyAgents: '委譲の橋（ply_agents。agentRuntime の url・headers・instructions）を受け取る',
  plyContext: 'Pleiad のコンテキスト（ply_context）の受け取り方（turn / conversation）',
  computerUse: 'コンピューターの操作（ply_computer）。画像の渡し方',
  plyShell: 'Pleiad のシェルのツール（ply_shell）を受け取る',
  nativeShellOff: 'エージェントのシェルのツールを会話ごとに切れる（ply_shell だけにする）',
  shell: '入力欄の `!`（host: Pleiad が走らせる / native: エージェントが走らせる）',
  steer: '走っている作業へ追加指示を途中で渡す（— なら次のターンで渡す）',
  handover: '更新で走っているターンを止めない（無停止の更新。新しいサーバーが付け直す）',
  browser: 'エージェントのブラウザー（Chrome の窓。AGENT_BROWSER_* の環境変数と ply_browser）を受け取る',
  plyControl: '操作の一覧（ply_control）と会話に束縛した CLI（PLEIAD_CONTROL_*）を受け取る',
  secrets: '秘密情報と変数（環境変数と一覧の文）を受け取る',
  visualize: '可視化の指示を受け取る',
  hooks: 'Pleiad がそろえる Hooks（hooksRuntime）を受け取る',
};

const cell = (v) => {
  if (isCapabilityState(v)) {
    if (v.state === 'covered') return '補';
    if (v.state === 'impossible') return '無理';
    if (v.state === 'todo') return `未実装 ${v.issue}`;
    return `?${v.state}`;
  }
  if (v === true) return '✓';
  if (v === false || v == null) return '—';
  if (typeof v === 'object') return v.waitSliceMs ? `${v.images}（${Math.round(v.waitSliceMs / 1000)} 秒ごと）` : v.images;
  return String(v);
};

/** 表に出すエージェント（試験用の fake は出さない） */
export const MATRIX_AGENTS = Object.keys(AGENTS).filter((id) => id !== 'fake');

/** 各エージェントのラップ前のバックエンド（能力の印を読むだけ。ターンは始めない） */
export async function loadNatives(ids = Object.keys(AGENTS)) {
  const natives = {};
  for (const id of ids) natives[id] = (await import(new URL(`../../core/backends/${AGENTS[id].module.replace(/^\.\//, '')}`, import.meta.url))).backend;
  return natives;
}

/** 補助表で「利用者に届く」と見るか。covered は Pleiad の共通処理が補うので届く扱い */
const works = (v) => (isCapabilityState(v) ? v.state === 'covered' : Boolean(v));

export function renderMatrix(natives) {
  const ids = MATRIX_AGENTS.filter((id) => natives[id]);
  const head = `| 機能 | ${ids.map((id) => natives[id].label ?? id).join(' | ')} |`;
  const rule = `|---|${ids.map(() => '---').join('|')}|`;
  const rows = CAPABILITY_KEYS.map((key) => `| ${ABOUT[key] ?? key}（\`${key}\`） | ${ids.map((id) => cell(natives[id].capabilities?.[key])).join(' | ')} |`);
  const supplementary = [
    ['AIからの題名・状態変更・分岐（hostTools または ply_control）', (b) => works(b.capabilities?.hostTools) || works(b.capabilities?.plyControl)],
    ['次の発言候補の生成（ネイティブまたは suggestNext）', (b) => b.capabilities?.promptSuggestions === 'native' || typeof b.suggestNext === 'function'],
    ['会話タイトル候補の生成（suggestTitle）', (b) => typeof b.suggestTitle === 'function'],
    ['プロバイダーの使用枠の取得口（usage。取得できる値はCLI・契約による）', (b) => typeof b.usage === 'function'],
    // 画面へは describeBackends がメソッドの有無から作る印（capabilities.stopBackground・backgroundDetails）で渡る
    ['裏のコマンドを作業ダイアログから止める（stopBackground）', (b) => typeof b.stopBackground === 'function'],
    ['裏のコマンドの出力を作業ダイアログで読む（getBackgroundTask → backgroundDetails）', (b) => typeof b.getBackgroundTask === 'function'],
  ];
  const states = [];
  for (const id of ids) for (const key of CAPABILITY_KEYS) {
    const value = natives[id].capabilities?.[key];
    if (isCapabilityState(value)) states.push([id, key, value]);
  }
  const section = (title, columns, filter, rowOf) => [
    `## ${title}`,
    '',
    columns ? `| エージェント | 機能 | ${columns} |` : '| エージェント | 機能 |',
    columns ? '|---|---|---|' : '|---|---|',
    ...states.filter(([, , v]) => filter(v)).map(([id, key, v]) => rowOf(id, key, v)),
    '',
  ];
  return [
    '# エージェント × 機能の対応表',
    '',
    '<!-- 端末に出す一覧（node tests/lib/backend-matrix.mjs）。文書の写しは持たない（ADR 0273） -->',
    '',
    '✓ = 対応（値はそのまま） / 補 = Pleiad の共通処理が補う / 無理 = 不可能（理由は下） / 未実装 = Issue（下）',
    '',
    head,
    rule,
    ...rows,
    '',
    '## 共通処理・補助メソッドによる機能',
    '',
    '能力の印だけでは判定できない機能。タイトルの編集・分岐・巻き戻しは、ネイティブ実装が無くても Pleiad の共通処理が補う。',
    '可視化の印は指示の配達を表し、HTML参照の描画・保存は全エージェントに共通。通常のシェルと ply_shell も別の機能。',
    '',
    head,
    rule,
    ...supplementary.map(([label, supported]) => `| ${label} | ${ids.map((id) => cell(supported(natives[id]))).join(' | ')} |`),
    '',
    ...section('不可能（理由）', '理由', (v) => v.state === 'impossible', (id, key, v) => `| ${natives[id].label ?? id} | ${key} | ${v.reason} |`),
    ...section('未実装（Issue）', 'Issue', (v) => v.state === 'todo', (id, key, v) => `| ${natives[id].label ?? id} | ${key} | ${v.issue} |`),
    ...section('Pleiad が補う', '', (v) => v.state === 'covered', (id, key) => `| ${natives[id].label ?? id} | ${key} |`),
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // バックエンドを読み込むと core の置き場の道具も読み込まれる。利用者の本物のデータ置き場（~/.agent-host）を開かないよう、一時の置き場へ向ける
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  process.env.AGENT_HOST_DATA = mkdtempSync(path.join(os.tmpdir(), 'pleiad-backend-matrix-'));
  console.log(renderMatrix(await loadNatives(MATRIX_AGENTS)));
}
