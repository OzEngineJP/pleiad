# 0289 脇を閉じると 52px のレールに畳み、P の印・下端のアカウントと設定を固定にする

- 状態: 承認（AsIs / ToBe のモック `temporary/mockups/sidebar-toggle-position.html` を利用者が承認）。[ADR 0288](0288-sidebar-bot-strip-and-create-entries.md) の決定 5（脇の開閉ボタンを頭の左端に置く）を置き換える

## 状況

脇の開閉は、開くボタンと閉じるボタンが別の場所にあり、閉じるたびに 47px 跳んだ（デスクトップ版。macOS では横 68px・縦 47px）。閉じると脇が丸ごと消え、検索・設定・ルーティンへは開き直さないと届かず、デスクトップ版の窓の帯（40px）は紙の色の空き地になった。macOS では閉じるボタンが信号を避けて 25px に潰れていた。引き出し（700px 以下）でも、開くハンバーガー（44px）と閉じるボタン（36px・引き出しの左上）で位置と大きさが違った。

## 決定

1. **P の印を脇の左上に固定する**（`#sideMark`）。開いても閉じても同じ位置（web・Windows は見出しの行、macOS は信号の下で検索の行の左）。文字のロゴ「Pleiad」はどこにも出さない。
   - 開いている間は名前「Pleiad」の絵（`role="img"`・`tabindex="-1"`・`pointer-events:none`）で押せない。
   - 閉じている間は「サイドバーを開く（Ctrl+B）」のボタンになる。ポインタを載せる・Tab の焦点・押している間は、P の印が開くの印（脇の絵）に替わる。閉じている間の未確認・承認待ちの印は、今の開くボタンと同じものを P に付ける（web/open-sidebar-mark.mjs）。
2. **閉じると脇は 52px のレール（`--rail-w`）に畳む。** 消えない。上から P → 検索 → ルーティン（時計）、下端に設定 → Pleiad Plus の丸と並ぶ。ボタンは 36px。
   - 検索は脇を開いて検索欄に焦点（Ctrl+Shift+F と同じ動き）。時計は脇を開き、ルーティンの見出しを開いて焦点を当てる。
   - Ctrl+B／⌘B はそのまま効く。
3. **閉じるボタンは通知の右**（脇の右上の端）。`#closeSidebar` を `#notifBell` の次に置く。
4. **脇の下端に固定の一行を置く**（`.side-foot`、52px）。左は Pleiad Plus の丸とメール（`#sidePlus`）、右端に設定（`#settings`、30px）。状況の一行（ログインが要る・接続が切れた・取り消し・操作キー）はその上にそのまま出る。
   - Plus の出し方は 3 つ。ログイン中は頭文字の丸とメール。ログアウト中は人の形の丸と「Pleiad Plus にログイン」。使えない（`status.available === false`）ときは左を出さず設定だけ。どれも押すと設定 › Pleiad Plus を開く。
   - Plus の丸は開いているときも閉じているときも左下の同じ位置（開いている間は `#sidePlus` の左の絵、閉じている間は押せるボタン `#sideAvatar`）。
   - ログインが要る間は、下端とレールの両方の設定に印を付ける（#authNeed の行と同じ知らせ）。
5. **引き出し（700px 以下）**: 開くのはハンバーガー（44px・左上）、閉じるのは引き出しの右上の ✕（44px・右端から 4px）。下端にアカウントと設定の一行（60px）。開くと焦点は ✕ へ移る。
6. **動き**: 会話の紙が `--dur`（240ms）・`--ease-out` で 292 ⇔ 52px に滑る。脇の中身とレールは `--dur-fast`（120ms）で入れ替わる。動きを減らす設定では 0ms。
7. **焦点**: 閉じると P（「サイドバーを開く」）へ、開くと閉じるボタンへ移す。`#openSidebar` は狭い画面だけのハンバーガーにする（チャンネルの `#chOpenSidebar`・スレッドの `#chThreadOpenSidebar` も同じ）。

## 理由

- P の印は開閉で動かない唯一の目印なので、開く操作を P に集約すると、場所を覚え直さずに済む。開いている間は押せないので、P の下の見出しや窓の帯はそのまま押せる（pointer-events を切る）。
- レールにすると、閉じていても検索・ルーティン・設定・Plus に届き、帯も空き地にならない。幅 52px は 36px のボタンと 8px の余白に収まる最小の幅。
- Plus の丸と名はアカウントの状態（ログイン中・要ログイン・使えない）を常に見せる場所として下端に固定し、設定はその右端（いままでどおり右）に置く。
- 引き出しの ✕ を右上の端に置くと、「片付けるものは端」という並びと、会話の頭の右端にある閉じる系のボタンと揃う。

## 影響

- 保存形式・操作の一覧・会話とスレッドの正本は変えない。脇の開閉の覚え（`agent-host-sidebar`）はそのまま。
- `web/index.html`: `.brand`（P と文字のロゴ）を `#sideMark`（P の印と開くの印の 2 枚）に替える。`#closeSidebar` を `#notifBell` の次へ、`#settings` を新しい `.side-foot`（`#sidePlus`・`#sidePlusAv`・`#sidePlusName`・`#settings`）へ。レール `#sideRail`（`#railSearch`・`#railRoutines`・`#railSettings`）と `#sideAvatar` を足す。`#closeSidebar` に ✕ の絵（`.ic-x`）を足す。`#openSidebar`・`#chOpenSidebar`・`#chThreadOpenSidebar` はハンバーガーの絵にそろえる。
- `web/style.css`: `--rail-w:52px`。閉じた列は `--side-col:var(--rail-w)` で脇は visibility で隠し、P・レール・Plus の丸は子の visible で残す。帯を紙にする規則と mac の `padding-left:80px` はやめる（P は信号の下、検索の行の左を 50px 開ける）。引き出しの ✕ を右上に。
- `web/client.mjs`: `paintSideChrome()`（P・レール・Plus の押し方と名前を、開閉・狭い画面・設定の出入りで塗り直す）、`paintSideFoot()`（Plus の 3 つの状態）、`syncAuthDot()`（ログインが要る間の点）を足す。`setSidebar` の焦点は P ⇔ 閉じるボタン。
- `web/side.mjs`: `focusKey(key)` を足す（レールのルーティンで木の項目を指す）。
- `web/channels/sidebar.mjs`・`web/channels/index.mjs`: `openRoutines()` を足す（ルーティンの見出しを外から開く）。
- i18n: `app.searchTitle`（「会話を検索（{{key}}）」）を足す。ほかは今の文言を流用する（開く・閉じる・設定・ルーティン・`settings.remote.groups.plusLogin`）。
- 画面の今の形は design-system.md「脇」に書く。
