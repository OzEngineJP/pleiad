# 0325 外部 MCP を、名前 × エージェントの一覧にする（担当の 2 択をやめる）

- 状態: 承認（2026-11-14）
- 承認の内容: プロダクトオーナーが、モックの形（temporary/mockups/context-owner-both-v2.html の 01〜07、行ごとに並べる読み）を承認した。タブで分ける読み（08）は作らない。
- 置き換えるもの: [ADR 0031](0031-confirm-before-unifying-mcp.md)（外部 MCP の担当を「Pleiad がそろえる」へ切り替える前の確認）。指示・Skills の担当の 2 択と、会話の右パネルの「この場所だけ変える」の MCP の 2 択は、この ADR では変えない。

## 状況

設定 › プラグインの外部 MCP は、担当を「エージェントに任せる」か「Pleiad がそろえる」の 2 択で決めていた。
- 「そろえる」は全部か全く無しで、「Codex の slack だけ Claude にも渡す」「Claude の github だけ止める」ができなかった。
- プラグインの MCP と claude.ai のコネクターは、どちらの担当でも一覧に出なかった。
- 「そろえる」へ切り替えるときだけ確認の面が出た（ADR 0031）。広がる範囲が一度に決まるためで、名前ごとに決めれば不要になる。

## 決定

- 担当の 2 択をやめ、名前 × エージェント（Claude・Codex・Antigravity・OpenCode・Devin・Grok）の 1 つの一覧にする。行は種類の記号・名前・出どころのロゴ・全体のスイッチ・6 つのエージェントのアイコン。組は「Pleiad に登録」（末尾に「MCP を追加」）と「エージェントの設定」。
- 名前に無いエージェントのアイコンを入れると、その名前だけを広げる。広げる前に名前ごとに 1 回、その場で聞く（「Codex の設定の slack を、Claude にもつなぎます」）。外すときは聞かない。
- プラグインの MCP（`plugin:<プラグイン>:<名前>`）と claude.ai のコネクター（`claude.ai <名前>`）を同じ一覧に出す。コネクターは Claude の列だけ押せる。
- エージェント自身の MCP を名前ごとに止められるのは Claude・Codex・OpenCode。Devin・Grok・Antigravity は鍵を付けて押せない。止め方は「起動のときに Pleiad が止める」だけで、エージェントの設定ファイルは書き換えない。
- 保存は `context-scans.json` の外部 MCP の `agents`（`off`・`spread`、名前 → エージェントの配列）。これがあると中継は常に開き、名前ごとの止めと広げが効く。

## 移行

- `agents` が無い人（今の人全員）の今の接続は変えない。最初にアイコンを触った時点で、そのときの実効の状態を `agents` に書き写す（`mcpAgentsFromLegacy`）。
  - 「Pleiad がそろえる」の人: 広げられていた名前は全エージェントでオン。外してあった Claude のコネクターはオフのまま。
  - 「任せる」の人: Pleiad の登録が残っていても、その名前はオフ。
- 更新の前後で各エージェントから見える MCP が同じことは `tests/unit/context-mcp-matrix.mjs` で確かめる。

## 理由

- 名前ごとに決められれば、全部か全く無しかを選ばなくてよい。広がる範囲は 1 つの名前に限られ、確認も名前ごとで足りる。
- 一覧にあるものだけを操作できる形にすると、プラグインとコネクターも同じ操作で止められる。
- 止める手段のないエージェントは、押せるように見せず、鍵と理由を出す。

## 影響

- `core/context-settings.mjs`・`core/context-runtime.mjs`・`core/context-mcp-matrix.mjs`・`core/context-claude-extras.mjs`・`core/ops/context.mjs`（`context.mcpMatrix`・`context.setMcpAgent`）・`core/backends/*`（起動のときの止め方）・`web/mcp-matrix.mjs`・`web/context.mjs`。
- コネクターの最後に読めた一覧を `<data>/claude-connectors.json` に小さな JSON で残す（`tests/data-writes-allowlist.mjs`）。
- Grok は指示・Skills を「Pleiad がそろえる」にすると `ply_context` を受け取れない（`PLY_CONTEXT_CONFLICTS`）。その間、中継に頼る Grok の列は鍵と同じ見た目で押せない。
- 会話の右パネルの「この場所だけ変える」の MCP の 2 択は残る（場所ごとの一覧は別の仕事）。
