// エージェント × 機能の対応表（docs/backend-matrix.md）を、能力の印（core/backends/contract.mjs）から作る。
// 表は手で書かない。印・エージェントを足したら `node tests/lib/backend-matrix.mjs --write` で書き直す（npm test の backend-contract が、
// 文書が今の印と一致するかを見る）。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CAPABILITY_KEYS } from '../../core/backends/contract.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MATRIX_FILE = path.join(ROOT, 'docs', 'backend-matrix.md');

/** 印ごとの説明（表の 1 列目）。印を足したらここにも足す（無いと backend-contract が落とす） */
export const ABOUT = {
  title: 'タイトルをエージェントの側に持つ（無ければ Pleiad の控え）',
  tag: '状態タグをエージェントの側に持つ（無ければ Pleiad の控え）',
  fork: 'エージェントの側で分岐する（無ければ Pleiad が写して分ける）',
  forkMessage: '発言の途中で分岐できる',
  rewind: '同じ会話の巻き戻し（resumeAt: 次のターンで切る / thread: すぐ切る / —: Pleiad が写す）',
  subagents: 'サブエージェントの一覧と中身',
  liveModel: '走っている最中にモデルを替える',
  liveMode: '走っている最中に承認モードを替える',
  hostTools: 'AI から set_status / set_title / fork を呼ぶ',
  approvals: '対話の承認（none: 承認モードが確認なしだけ）',
  alwaysAllow: '承認に「常に許可」を返す',
  mcpApproval: 'MCP のツールの承認（host: エージェントが聞かないので Pleiad が聞く）',
  login: 'Pleiad の画面からログインする',
  accounts: '会話ごとにアカウントを選ぶ（token: Pleiad がトークンを持つ / agent: エージェントがアカウントごとの置き場でログインする）',
  compatEndpoints: '互換の接続先を会話ごとに選ぶ',
  compact: '手動・自動の圧縮',
  autoCompactWindow: '委譲の子の自動圧縮の閾値を受け取る',
  promptSuggestions: '次の発言の候補（native: ターンの中で届く / —: suggestNext がある場合だけターンの後に作る）',
  plyInstructions: 'Pleiad の指示（ユーザーが足した分・既定の項目）を受け取る',
  plyAgents: '委譲の橋（ply_agents。agentRuntime の url・headers・instructions）を受け取る',
  plyContext: 'Pleiad のコンテキスト（ply_context）の受け取り方（turn / conversation）',
  computerUse: 'コンピューターの操作（ply_computer）。画像の渡し方',
  plyShell: 'Pleiad のシェルのツール（ply_shell）を受け取る',
  nativeShellOff: 'エージェントのシェルのツールを会話ごとに切れる（ply_shell だけにする）',
  shell: '入力欄の `!`（host: Pleiad が走らせる / native: エージェントが走らせる）',
  effortInModelId: '強さをモデルの id で選ぶ',
  instructionsAtStart: '指示は会話の始めにしか効かない（人格を直したら次のターンで渡し直す）',
  failureDiagnostics: '失敗の理由を会話の控えに残す',
  promptDelivery: '発言が相手に渡った合図を返答の中身と別に出せる（— なら合図が無くても届いていることがある）',
  handover: '更新で走っているターンを止めない（無停止の更新。新しいサーバーが付け直す）',
  browser: 'エージェントのブラウザー（Chrome の窓。AGENT_BROWSER_* の環境変数と ply_browser）を受け取る',
  plyControl: '操作の一覧（ply_control）と会話に束縛した CLI（PLEIAD_CONTROL_*）を受け取る',
  secrets: '秘密情報と変数（環境変数と一覧の文）を受け取る',
  visualize: '可視化の指示を受け取る',
  hooks: 'Pleiad がそろえる Hooks（hooksRuntime）を受け取る',
};

const cell = (v) => {
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

export function renderMatrix(natives) {
  const ids = MATRIX_AGENTS.filter((id) => natives[id]);
  const head = `| 機能 | ${ids.map((id) => natives[id].label ?? id).join(' | ')} |`;
  const rule = `|---|${ids.map(() => '---').join('|')}|`;
  const rows = CAPABILITY_KEYS.map((key) => `| ${ABOUT[key] ?? key}（\`${key}\`） | ${ids.map((id) => cell(natives[id].capabilities?.[key])).join(' | ')} |`);
  const supplementary = [
    ['AIからの題名・状態変更・分岐（hostTools または ply_control）', b => Boolean(b.capabilities?.hostTools || b.capabilities?.plyControl)],
    ['次の発言候補の生成（ネイティブまたは suggestNext）', b => b.capabilities?.promptSuggestions === 'native' || typeof b.suggestNext === 'function'],
    ['会話タイトル候補の生成（suggestTitle）', b => typeof b.suggestTitle === 'function'],
    ['プロバイダーの使用枠の取得口（usage。取得できる値はCLI・契約による）', b => typeof b.usage === 'function'],
  ];
  return [
    '# エージェント × 機能の対応表',
    '',
    '<!-- 自動で作る表。手で直さない。`node tests/lib/backend-matrix.mjs --write` で書き直す（tests/lib/backend-matrix.mjs） -->',
    '',
    '各エージェントのバックエンド（`core/backends/<id>.mjs`）が書いた能力の印（`core/backends/contract.mjs`）の一覧。',
    '— は「対応しない」とバックエンドが明示したもの（書き忘れではない。書き忘れは `npm test` の backend-contract が落とす）。',
    '印の意味と、エージェントを足す手順は [multi-backend.md](multi-backend.md)「エージェントを足す」。',
    '',
    head,
    rule,
    ...rows,
    '',
    'Devin の plyContext は配達経路を表す。Pleiad担当分のネイティブ読込を止める所有者分離は未実装（[残件](https://github.com/OzEngineJP/pleiad/issues/108)）。',
    '',
    '## 共通処理・補助メソッドによる機能',
    '',
    '能力の印だけでは判定できない機能。タイトルの編集・分岐・巻き戻しは、ネイティブ実装が無くても Pleiad の共通処理が補う。',
    '可視化の印は指示の配達を表し、HTML参照の描画・保存は全エージェントに共通。通常のシェルと ply_shell も別の機能。',
    '',
    head,
    rule,
    ...supplementary.map(([label, supported]) => `| ${label} | ${ids.map(id => cell(supported(natives[id]))).join(' | ')} |`),
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // バックエンドを読み込むと core の置き場の道具も読み込まれる。利用者の本物のデータ置き場（~/.agent-host）を開かないよう、一時の置き場へ向ける
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  process.env.AGENT_HOST_DATA = mkdtempSync(path.join(os.tmpdir(), 'pleiad-backend-matrix-'));
  const text = renderMatrix(await loadNatives(MATRIX_AGENTS));
  if (process.argv.includes('--write')) { writeFileSync(MATRIX_FILE, text); console.log('書き直した:', path.relative(ROOT, MATRIX_FILE)); }
  else {
    let now = '';
    try { now = readFileSync(MATRIX_FILE, 'utf8').replace(/\r\n/g, '\n'); } catch {}
    console.log(now === text ? '最新' : '古い（--write で書き直す）');
    process.exit(now === text ? 0 : 1);
  }
  process.exit(0);
}
