# 0309 モデルの一覧の確かめは選ぶときに一本化し、送信直前には見ない

## 状態

承認（2026-11-10）。実機の調査と試験付きで差分を作業ツリーに残す形で入れる。

## 状況

次のターンの設定の予約（`nextSettings`）は、予約した backend・モデル・モードが送信の直前（`prepareTurn`）にも有効かを `validModel` で確かめていた。モデルの一覧は各 backend が TTL つきで覚えるので、予約してから送信までに一覧が縮んだ（取り直しで減った・別の条件の一覧に入れ替わった）と、選んだはずのモデルでターンが「予約が無効」で始まらなかった。一覧が古いだけでも起きうる。

各 backend が知らないモデル名を渡されたときの振る舞いを、この PC の CLI（claude 2.1.303・codex-cli 0.160.0・agy 1.5.3・opencode v2.0.32・devin 3000.11.92・grok 1.0.62）で確かめた。いずれも黙って別のモデルで走らず、理由を付けて断る:

- Claude（`--model`・SDK）: `is_error` の result（`api_error_status: 404`、"There's an issue with the selected model …"）。アダプタは turnResult の error として会話に出す
- Codex（thread/start・resume の `model`）: `400 model_not_found`（"… is not supported"）
- Antigravity（`--model`）: "model … is not recognized as a known model or custom model in settings"（exit 1）
- OpenCode（`-m provider/model`）: "Model unavailable: …"（exit 1）
- Grok（`-m`）: "unknown model id"（exit 1）。アダプタ側の `verifySelection`（`currentModelId` の一致）でも止まる
- Devin: 直接の実行は初回設定の対話で未確認。アダプタが `resolveDevinModel` でカタログ（`devin models list`、無ければ 1 回取り直し）に無いモデルを `DEVIN_MODEL_UNAVAILABLE` で先に断るので、会話には理由が出る

加えて、モデルの確かめは backend ごとにばらついていた: Claude は独自の `validModel`（一度も一覧が取れていなければ形の良い id を通す）を持ち、共通の「一覧に無ければ一度だけ取り直す」経路を通らなかった。`models(cwd, { refresh: true })` は server 側が呼んでいても、Claude は引数を受け付けず、Antigravity は受け付けても取り直さなかった。

取り直しが「呼ぶたびに CLI を起こして待つ」形だと、確かめが並ぶ経路（AI が委譲に書く正式な ID の読み替え・候補ごとの確かめ・予約の無い送信の `resolveModel`・未ログインで失敗し続ける間）で、毎回 10〜30 秒待つことになる。取り直しには間引きが要る。

## 決定

- **送信直前（`prepareTurn` の予約の確かめ）から、モデルが一覧にあるかの確かめを外す。** 残すのはターゲットの有無・モードの有無・endpoint/account の確かめ・エフォートの確かめと、モデルの形（文字列・長さ・制御文字。`isModelId` か `''`）だけ。予約のモデルは `resolveModel`（合わなければ既定へ戻す）を通さず、そのまま `runTurn` へ渡す。使えなければ CLI/API が断り、その理由は従来どおり turnResult の error として会話に出る
- **モデルの確かめは「選ぶとき」に一本化する**（設定・委譲・ルーティング・正準名への照合・予約を立てる `setTurnSettings`）。共通の `validModel` は: 今の一覧 → `{ refresh: true }` で一度だけ取り直した一覧 → それでも無ければ、一覧をまだ持てない backend の逃げ道として `backend.validModel` を呼ぶ。逃げ道は antigravity と同じ形で claude にも残す（**一覧を 1 度も取れていない間だけ**、形の良い id を通す。一覧の確認・取り直しは共通側が先にやるので、backend 側は最後の判断だけを答える）
- **`models(cwd, { refresh: true })` は取り直すが、間引きは通常どおり守る**: Claude は TTL を無視して probe を起こし結果を待つ（進行中の probe とは 1 本を分け合う）が、**失敗の再試行待ち（CATALOG_RETRY）は守り**、**その条件の一覧を取ってから同じ間隔（60 秒）の内は手元の一覧を返す**。縮んだ一覧を取ってから数分後の「一覧に無い」の確かめ直しはこれでも効き、「一覧に無い」が並ぶ経路で CLI を続けて起こさない。Antigravity は `authGuess === 'in'` のときだけ `agy models` を起こして待つ（`agy models` を起こしてよい条件は変えない。未確認・未ログインでは受動のまま）。読まない backend（`refresh` を見ない実装）は従来どおり同じ一覧の再判定になる
- **`canonicalModel`（正式な ID → 一覧の id の読み替え）は、取り直しを伴う確かめの前に手元の一覧と `matchModel` だけで当てる。** 両方外れた名前だけ `validModel`（取り直しあり）に回す。読み替えの結果（一覧にある→その名前・matchModel が当たる→その id・外れる→渡された名前のまま）は変えない
- **変えない所**: `resolveModel` の「合わなければ既定へ」・互換の接続先の形だけの確かめ・Antigravity の `requireModelCatalog`（段を別の強さで黙って走らせない送信の関所）・Devin/Grok のアダプタ内のモデル確認（backend 側の関所として残る）

## 理由

- 一覧は backend の観測であって、CLI が実際に使えるかどうかの正本ではない。古い一覧を理由に送信を止めると、使えるモデルのターンを誤って断る。全部の backend が知らないモデルを理由付きで断ると確かめられたので、最終判断は CLI/API に委ねてよい
- 選ぶときの確かめが一度だけ取り直すのは、一覧の置き場が古い間に「一覧に無い」と誤って断らないため。backend ごとの独自実装を共通経路に揃えると、取り直しが全 backend で同じに効く
- 「一覧を 1 度も取れていない間は形の良い id を通す」は claude・antigravity とも残す: 一覧が取れない間に保存済みの明示モデルや固定の一覧に無い新しいモデルを「一覧に無い」で断ると、黙って既定のモデルへ戻して送ってしまう（ADR 0304・0308 の意図）。共通経路の最後の判断として置くことで、一覧の確認・取り直しを先に受けられる形に揃えた
- 取り直しに失敗の再試行待ちと直近の取得の間隔を残すのは、「一覧に無い」の確かめが並ぶ経路で CLI を連発しないため。正式な ID の読み替えを先に済ませるのは、当たる読み替えのたびに待たないため

## 影響

- 予約したモデルは、一覧が縮んでもそのまま backend へ渡る。backend が断ったときはその理由が会話に出る
- Claude・Antigravity でも、選ぶときに「一覧に無い」は一度だけ取り直して確かめる（直前の失敗・直近の取得から 60 秒の内は手元の一覧で答える）
- claude の `validModel` は「最後の判断」だけの形で残る: 一覧を 1 度も取れていない間は形の良い id を通し、一覧が取れたあとは共通側の結果どおり
- 対象: `core/server.mjs`（`validModel`・`prepareTurn`・`canonicalModel`）・`core/backends/claude.mjs`（`models` の `refresh`・`validModel` の最後の判断への縮小）・`core/backends/antigravity.mjs`（`models` の `refresh`）・`core/backends/fake.mjs`（試験用の一覧の差し替え・呼び出しの記録）
- 試験: `tests/unit/server-reserved-model.mjs`（新規。一覧の縮小・backend の拒否・選ぶときの取り直し）・`tests/unit/claude-model-refresh.mjs`（新規。`{ refresh }` の取り直しの間隔・失敗時・最後の判断）・`server-delegation-model-name.mjs`（正式な ID の読み替えで取り直しが走らない）・`claude-model-match.mjs`・`claude-catalog-stale.mjs`（`validModel` 呼び出しの更新）
