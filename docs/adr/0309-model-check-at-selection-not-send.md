# 0309 モデルの一覧の確かめは選ぶときに一本化し、送信直前には見ない

## 状態

承認（2026-11-10）。実機の調査と試験付きで差分を作業ツリーに残す形で入れる。同日、予約の無いふつうの送信にも同じ決め方を広げた（下の「送信の経路のモデル決め」）。

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

さらに、予約の無い送信では `resolveModel` が保存済みのモデルを一覧で確かめ、無ければ黙って `''`（既定）に戻していた。実機の記録にその形跡がある: `claude-fable-5-2` を保存した委譲の子の会話が、そのモデルがどの一覧にも載る前の数日間、すべてのターンを既定の `claude-opus-5-5` で走らせていた。保存したモデルが本当に無くなった・一覧が揺れたときに、利用者に見せず別のモデルで走るのは黙った差し替えになる。

## 決定

- **送信直前（`prepareTurn` の予約の確かめ）から、モデルが一覧にあるかの確かめを外す。** 残すのはターゲットの有無・モードの有無・endpoint/account の確かめ・エフォートの確かめと、モデルの形（文字列・長さ・制御文字。`isModelId` か `''`）だけ。予約のモデルは `resolveModel`（合わなければ既定へ戻す）を通さず、そのまま `runTurn` へ渡す。使えなければ CLI/API が断り、その理由は従来どおり turnResult の error として会話に出る
- **モデルの確かめは「選ぶとき」に一本化する**（設定・委譲・ルーティング・正準名への照合・予約を立てる `setTurnSettings`）。共通の `validModel` は: 今の一覧 → `{ refresh: true }` で一度だけ取り直した一覧 → それでも無ければ、一覧をまだ持てない backend の逃げ道として `backend.validModel` を呼ぶ。逃げ道は antigravity と同じ形で claude にも残す（**一覧を 1 度も取れていない間だけ**、形の良い id を通す。一覧の確認・取り直しは共通側が先にやるので、backend 側は最後の判断だけを答える）
- **`models(cwd, { refresh: true })` は取り直すが、間引きは通常どおり守る**: Claude は TTL を無視して probe を起こし結果を待つ（進行中の probe とは 1 本を分け合う）が、**失敗の再試行待ち（CATALOG_RETRY）は守り**、**その条件の一覧を取ってから同じ間隔（60 秒）の内は手元の一覧を返す**。縮んだ一覧を取ってから数分後の「一覧に無い」の確かめ直しはこれでも効き、「一覧に無い」が並ぶ経路で CLI を続けて起こさない。Antigravity は `authGuess === 'in'` のときだけ `agy models` を起こして待つ（`agy models` を起こしてよい条件は変えない。未確認・未ログインでは受動のまま）。読まない backend（`refresh` を見ない実装）は従来どおり同じ一覧の再判定になる
- **`canonicalModel`（正式な ID → 一覧の id の読み替え）は、取り直しを伴う確かめの前に手元の一覧と `matchModel` だけで当てる。** 両方外れた名前だけ `validModel`（取り直しあり）に回す。読み替えの結果（一覧にある→その名前・matchModel が当たる→その id・外れる→渡された名前のまま）は変えない
- **予約の無い送信（`prepareTurn` → `sendModel`）も、一覧では裁かない。** 渡された値 → 会話の保存値 → そのエージェントの設定の既定の順に取り、形（`isModelId` か `''`）だけ確かめてそのまま `runTurn` へ渡す。使えなければ CLI/API が断り、その理由が会話に出る（予約と同じ）
- **別エージェントのモデルを見分ける仕組みは足さない。** エージェントを替えるとき（`switchBackend`）は会話の保存値を `''` にし、既存の会話で別の backend を指定した送信は `pickBackend` が断るので、送信の時点で別エージェントの名前は残らない。切り替えを記録していない古い記録に残っていても、CLI/API が理由付きで断るので、利用者が選び直せばよい
- **変えない所**: `resolveModel` の「合わなければ既定へ」（選ぶときの経路——委譲・ルーティング・設定の候補の確かめ——は従来どおり `resolveModel`・`validModel` を通す。変わるのは送信の経路だけ）・互換の接続先の形だけの確かめ・Antigravity の `requireModelCatalog`（段を別の強さで黙って走らせない送信の関所）・Devin/Grok のアダプタ内のモデル確認（backend 側の関所として残る）

## 理由

- 一覧は backend の観測であって、CLI が実際に使えるかどうかの正本ではない。古い一覧を理由に送信を止めると、使えるモデルのターンを誤って断る。全部の backend が知らないモデルを理由付きで断ると確かめられたので、最終判断は CLI/API に委ねてよい
- 選ぶときの確かめが一度だけ取り直すのは、一覧の置き場が古い間に「一覧に無い」と誤って断らないため。backend ごとの独自実装を共通経路に揃えると、取り直しが全 backend で同じに効く
- 「一覧を 1 度も取れていない間は形の良い id を通す」は claude・antigravity とも残す: 一覧が取れない間に保存済みの明示モデルや固定の一覧に無い新しいモデルを「一覧に無い」で断ると、黙って既定のモデルへ戻して送ってしまう（ADR 0304・0308 の意図）。共通経路の最後の判断として置くことで、一覧の確認・取り直しを先に受けられる形に揃えた
- 取り直しに失敗の再試行待ちと直近の取得の間隔を残すのは、「一覧に無い」の確かめが並ぶ経路で CLI を連発しないため。正式な ID の読み替えを先に済ませるのは、当たる読み替えのたびに待たないため
- ふつうの送信も一覧で裁かないのは、保存したモデルが消えた・一覧が揺れたときに、黙って既定のモデルで走らせる方が CLI に断らせるより害が大きいから（使ったつもりのモデルで走らない、という事実を利用者が知れない）。backend の拒否は理由付きで会話に出るので、利用者はモデルを選び直せばよい
- 別エージェントのモデルを見分ける欄や履歴の推し量りを足さないのは、起きるのが古い記録だけで、そこも CLI/API の拒否で利用者が気づけるから。確かめる所を減らす、というこの ADR の方針に合わせた

## 影響

- 予約したモデルは、一覧が縮んでもそのまま backend へ渡る。backend が断ったときはその理由が会話に出る
- ふつうの送信でも、保存したモデル・渡されたモデル・既定のモデルは一覧で裁かれずそのまま backend へ渡る。保存したモデルが本当に無くなっていた会話（・ルーチンの bot・委譲の子）は、これ以降は既定で走らず backend の拒否（理由付き）になる
- 切り替えを記録していない古い会話に別エージェントのモデルが残っていれば、そのまま渡って CLI/API の拒否（理由付き）になる
- Claude・Antigravity でも、選ぶときに「一覧に無い」は一度だけ取り直して確かめる（直前の失敗・直近の取得から 60 秒の内は手元の一覧で答える）
- claude の `validModel` は「最後の判断」だけの形で残る: 一覧を 1 度も取れていない間は形の良い id を通し、一覧が取れたあとは共通側の結果どおり
- 対象: `core/server.mjs`（`validModel`・`prepareTurn`・`canonicalModel`・`sendModel`）・`core/backends/claude.mjs`（`models` の `refresh`・`validModel` の最後の判断への縮小）・`core/backends/antigravity.mjs`（`models` の `refresh`）・`core/backends/fake.mjs`（試験用の一覧の差し替え・呼び出しの記録）
- 試験: `tests/unit/server-reserved-model.mjs`（新規。一覧の縮小・backend の拒否・選ぶときの取り直し）・`tests/unit/server-send-model.mjs`（新規。ふつうの送信は保存モデルを一覧で裁かずそのまま渡す・断られたら理由が出て選び直せば通る）・`tests/unit/claude-model-refresh.mjs`（新規。`{ refresh }` の取り直しの間隔・失敗時・最後の判断）・`server-delegation-model-name.mjs`（正式な ID の読み替えで取り直しが走らない）・`claude-model-match.mjs`・`claude-catalog-stale.mjs`（`validModel` 呼び出しの更新）
