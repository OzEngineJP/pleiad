// エージェントごとの記述（データだけ）。SDK にもネットワークにも依存せず、バックエンドを読み込まずに引ける。
//
// エージェントの一覧・CLI の探し方・画面のロゴ・短い名前・圧縮の既定など、core と画面のあちこちが id ごとに持っていた表は、
// ここから作る（docs/multi-backend.md「エージェントを足す」）。エージェントを足すときは、ここに 1 つ足し、
// core/backends/<id>.mjs を書く。記述のキー（DESCRIPTOR_KEYS）は全部書く（使わないものは null）。tests/unit/backend-contract.mjs が落とす。
import path from 'node:path';

/**
 * module      core/backends/ からの場所（core/backends/index.mjs が動的 import する）
 * shortLabel  入力欄のエージェントの区切りの短い名前（製品名なので訳さない）。null なら正式名（backend.label）
 * brand       ロゴ（web/brand/ のファイル）。mark: true は SVG の #mark を currentColor で描く（色は web/style.css の .row-be-<id>。
 *             画面は文書内の <symbol> として読み込む。web/brand-marks.mjs）、false は画像のまま。null はロゴなし（◇）
 * cli         実行ファイル。exe は既定の名前、binEnv は差し替えの環境変数、npmPackage は npm の包み（.cmd を node で起こす形に解く）、
 *             installUrl は「インストール」の案内、searchDirs は PATH のほかに見る置き場（起動済みの Pleiad が PATH の変更を拾えないため）。
 *             null は CLI を使わない（fake）
 * idleCompaction  会話を離れた後の自動の圧縮（ADR 0068）の既定 { enabled, delayMinutes }。null は Pleiad が圧縮しない
 *             （エージェントが自分で決める）。文字列なら、その id の設定の行を借りる（fake は claude の行で試験する）
 * hooksAs     Pleiad がそろえる Hooks を、このエージェントへ、どのエージェントの形を真似て渡すか（core/hooks-config.mjs の UNIFY_TARGETS）。
 *             ネイティブの Hooks を持つエージェント（core/hooks-config.mjs の HOOK_AGENTS）と、渡さないエージェントは null
 * hooksVia    hooksAs のエージェントへの渡し方。'callback' は Pleiad の中で走らせてエージェントのプラグインの口から呼ぶ（OpenCode）、
 *             'plugin' はエージェントが自分で走らせる hooks のファイルを、その会話だけのプラグインとして渡す（Grok）。hooksAs が null なら null
 * contextSources  エージェントが自分で読む指示・Skills・MCP の読み込み元（core/context-settings.mjs の SOURCES）。
 *             エージェント任せの会話の「指示の量」の見積もりと、エージェントの設定に登録された MCP の一覧に使う。null は読み方を知らない
 * shellDefault  エージェントのシェルのツールの既定（設定 shellTool。ADR 0227 §3）。'native' はエージェントのもの、'ply' は Pleiad の ply_shell だけ
 *             （能力の印 nativeShellOff が無いエージェントは 'native' のまま）
 * shellTools  シェルのコマンドを走らせるネイティブのツールの名前（tool.start の name。大文字と小文字を区別する）。長いコマンドの知らせ・
 *             声の待ちの案内が、この一覧で見分ける（core/shell-tools.mjs）。バックエンドの toolHints の shape: 'shell' と同じ名前を書く
 *             （tests/unit/backend-contract.mjs が突き合わせる）。名前で見分けられないエージェントは []（tool.start に shell: true を付ける）
 */
export const AGENTS = {
  claude: {
    module: './claude.mjs',
    shortLabel: 'Claude',
    brand: { logo: 'claude.svg', mark: false },
    cli: { exe: 'claude', binEnv: 'AGENT_HOST_CLAUDE_BIN', npmPackage: '@anthropic-ai/claude-code', installUrl: 'https://code.claude.com/docs/en/setup', searchDirs: null },
    idleCompaction: { enabled: true, delayMinutes: 50 },
    contextSources: ['claude'],
    hooksAs: null,
    hooksVia: null,
    shellTools: ['Bash', 'PowerShell'],
    shellDefault: 'native',
  },
  codex: {
    module: './codex.mjs',
    shortLabel: 'Codex',
    brand: { logo: 'openai.svg', mark: true },
    cli: { exe: 'codex', binEnv: 'AGENT_HOST_CODEX_BIN', npmPackage: '@openai/codex', installUrl: 'https://developers.openai.com/codex/cli/', searchDirs: null },
    idleCompaction: { enabled: false, delayMinutes: 25 },
    contextSources: ['codex'],
    hooksAs: null,
    hooksVia: null,
    shellTools: ['commandExecution'],
    shellDefault: 'native',
  },
  antigravity: {
    module: './antigravity.mjs',
    shortLabel: 'Antigravity',
    brand: { logo: 'antigravity.svg', mark: true },
    cli: {
      exe: 'agy', binEnv: 'AGENT_HOST_AGY_BIN', npmPackage: null, installUrl: 'https://antigravity.google/docs/cli/install/',
      // Windows の配置先（install.ps1 が `%LOCALAPPDATA%\agy\bin` へ置き、そのあと `agy install` が PATH を書く）。
      // PATH だけを見ていると、入れた直後に「再確認」を押しても未インストールのまま。Unix 版は `$HOME/.local/bin` なので既定の置き場で足りる
      searchDirs: (env) => (env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'agy', 'bin')] : []),
    },
    idleCompaction: null,
    // AGENTS.md（作業場所。common）と、~/.gemini・.agents 系（antigravity）
    contextSources: ['common', 'antigravity'],
    hooksAs: null,
    hooksVia: null,
    shellTools: ['run_command'],
    shellDefault: 'native',
  },
  opencode: {
    module: './opencode.mjs',
    shortLabel: 'OpenCode',
    brand: { logo: 'opencode.svg', mark: true },
    cli: {
      exe: 'opencode', binEnv: 'AGENT_HOST_OPENCODE_BIN', npmPackage: '@opencode/cli', installUrl: 'https://opencode.ai/docs/',
      // 公式のインストーラー（install スクリプト）は `~/.opencode/bin` に置く。npm で入れたものは PATH（npm の置き場）で見つかる
      searchDirs: (env) => [path.join(env.USERPROFILE || env.HOME || '', '.opencode', 'bin')].filter((d) => d.length > '.opencode/bin'.length),
    },
    // 会話を離れた後の自動の圧縮（summarize）。既定は切る（OpenCode 自身も文脈があふれる前に圧縮する）
    idleCompaction: { enabled: false, delayMinutes: 25 },
    // AGENTS.md（作業場所。common）と、設定の置き場の AGENTS.md・skills・opencode.json の mcp
    contextSources: ['common', 'opencode'],
    // OpenCode のフックは JS のプラグインで、コマンドの Hooks の形が無い。Pleiad のプラグインと中継の口で、Claude Code の Hooks と同じ形で渡す（opencode-hooks.mjs）
    hooksAs: 'claude',
    hooksVia: 'callback',
    // bash が裏で起こしたサーバーを待って戻らなくなる（v1.19.3。2026-10-18）ので、既定で ply_shell だけにする
    shellTools: ['bash', 'shell'],
    shellDefault: 'ply',
  },
  devin: {
    module: './devin.mjs',
    shortLabel: 'Devin',
    brand: { logo: 'devin.svg', mark: true },
    cli: {
      exe: 'devin', binEnv: 'AGENT_HOST_DEVIN_BIN', npmPackage: null, installUrl: 'https://docs.devin.ai/cli',
      // The official Windows installer adds this directory to PATH after installation.
      searchDirs: (env) => (env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'devin', 'cli', 'bin')] : []),
    },
    // 会話を離れた後の自動の圧縮（/compact を prompt として送る）。既定は切る（Devin 自身も文脈があふれる前に圧縮する）
    idleCompaction: { enabled: false, delayMinutes: 25 },
    // AGENTS.md（common）・Claude 互換のインポート（claude）・.devin 系（devin）・OpenCode の MCP のインポート（opencode）
    contextSources: ['common', 'claude', 'devin', 'opencode'],
    hooksAs: 'claude',
    hooksVia: 'config',
    // ACP のツールの名前は自由な題なので、名前では見分けない（kind: 'execute' の呼び出しに shell: true を付ける。devin-normalize.mjs）
    shellTools: [],
    shellDefault: 'native',
  },
  grok: {
    module: './grok.mjs',
    shortLabel: 'Grok',
    brand: { logo: 'grok.svg', mark: true },
    cli: {
      exe: 'grok', binEnv: 'AGENT_HOST_GROK_BIN', npmPackage: '@xai-official/grok', installUrl: 'https://x.ai/cli',
      // 公式のインストーラー（install.ps1 / install.sh）は `~/.grok/bin` に置く。npm で入れたものは PATH で見つかる
      searchDirs: (env) => [path.join(env.USERPROFILE || env.HOME || '', '.grok', 'bin')].filter((d) => d.length > '.grok/bin'.length),
    },
    // 手動・アイドル時の圧縮は ACP に /compact を送り、閾値前の自動圧縮は Grok 自身が行う
    idleCompaction: { enabled: false, delayMinutes: 25 },
    // AGENTS.md（作業場所。common）と ~/.grok（AGENTS.md・rules・skills・config.toml の MCP。grok）と Claude 互換（既定で有効）
    contextSources: ['common', 'grok', 'claude'],
    // Grok の Hooks の形は Claude Code と同じ。セッション限定のプラグイン（_meta.pluginDirs）の hooks/hooks.json で渡す
    hooksAs: 'claude',
    hooksVia: 'plugin',
    // ACP のツールの名前は自由な題なので、名前では見分けない（kind: 'execute' の呼び出しに shell: true を付ける。grok-normalize.mjs）
    shellTools: [],
    shellDefault: 'native',
  },
  fake: {
    module: './fake.mjs',
    shortLabel: null,
    brand: null,
    cli: null,
    idleCompaction: 'claude',
    contextSources: null,
    hooksAs: null,
    hooksVia: null,
    shellTools: ['fake_shell'],
    shellDefault: 'native',
  },
};

export const DESCRIPTOR_KEYS = Object.freeze(['module', 'shortLabel', 'brand', 'cli', 'idleCompaction', 'contextSources', 'hooksAs', 'hooksVia', 'shellTools', 'shellDefault']);

/** 既定で有効にするエージェント（AGENT_HOST_BACKENDS が無いとき）。試験用の fake は入れない */
export const DEFAULT_AGENT_IDS = Object.freeze(Object.keys(AGENTS).filter((id) => id !== 'fake'));

/** id の記述。知らない id なら null */
export const agentOf = (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : null);

/** 会話を離れた後の自動の圧縮の設定の行を持つエージェント（行を借りるものは除く）と、その既定 */
export function idleCompactionDefaults() {
  return Object.fromEntries(Object.entries(AGENTS).filter(([, a]) => a.idleCompaction && typeof a.idleCompaction === 'object').map(([id, a]) => [id, { ...a.idleCompaction }]));
}

/** id の会話が使う自動の圧縮の設定の行の id（借りる先があればそれ）。行が無ければ null */
export function idleCompactionKey(id) {
  const rule = agentOf(id)?.idleCompaction;
  if (typeof rule === 'string') return rule;
  return rule ? id : null;
}

/** 画面に渡す記述（describeBackends に載せる分） */
export function agentPresentation(id) {
  const a = agentOf(id);
  return { shortLabel: a?.shortLabel ?? null, brand: a?.brand ? { ...a.brand } : null, idleCompaction: idleCompactionKey(id) };
}
