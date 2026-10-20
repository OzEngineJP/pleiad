# 0237 Android 版のランチャーの入口を、殻とは別の透過のトランポリンにする

- 状態: 提案

## 状況

Android 版の殻（`MainActivity`。Capacitor、ホスト一覧とペアリング）は `singleTask` で、ランチャーの intent-filter を持っていた。タスクが残っているあいだにアイコンから開き直すと、OS はタスクの上の画面（ホストの窓 `HostActivity`）を終了させてから、殻の `onNewIntent` に `ACTION_MAIN` を届ける。直前の修正（27dd7935）で `onNewIntent` でも再開の判定（`ResumePolicy`）を走らせて窓を開き直すようにしたが、それでもアイコンを押すたびに `HostActivity` が壊れて作り直され、WebView の読み込み直し・スクロール位置のリセット・接続のやり直しが毎回起きる。最近使ったアプリから戻ったときは窓はそのまま残るので、アイコンからの復帰もそれに揃えたい。

案は 3 つあった。

- A: `MainActivity` を `singleTop`（または `standard`）に替え、上に重なった新しいインスタンスを `isTaskRoot` で見てすぐ閉じる。リンク（`pleiad://pair`・`pleiad://open`）の intent も singleTask でなくなるので、起動中は新しいインスタンスが上に積まれる経路になり、殻の複数インスタンス・リンクの転送の扱いを別途設計する必要がある。
- B: LAUNCHER の入口を殻から分け、透過のトランポリン（`LauncherActivity`）にする。殻は `singleTask` のままなので、リンクの intent は従来どおり既存のインスタンスの `onNewIntent` へ届く。
- C: `HostActivity` を別のタスク（taskAffinity）にする。アイコンのタップは殻のタスクを前へ出すので一覧が見えてしまい、最近使ったアプリにも 2 枚並ぶ。

## 決定

**B。** `LauncherActivity`（透過・起動の窓なしのテーマ、`standard`）を LAUNCHER の入口にして、タスクには残らない。タスクがすでにあるタップ（入口がタスクの根ではない `isTaskRoot == false`）は、そのまま閉じる──上に置かれた入口が退くだけで、タスクの上の画面（生きているホストの窓、または一覧）がそのまま前へ出る。新しいタスクのタップ（入口が根）だけ、起動の intent を `MainActivity` へ渡してから閉じる（分岐は `remote-core` の `ResumePolicy.launcherRoute`。`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY` も渡す）。

殻（`MainActivity`）は `singleTask` のままで、`pleiad://pair`・`pleiad://open` の intent-filter も殻に残す。リンクの届け方・上の画面を終了させる挙動は従来のまま変えない。殻へ `ACTION_MAIN` が届く経路（明示のコンポーネント起動）でも、従来どおり `onNewIntent` の判定で最後のホストを開き直す。

## 理由

- 目的は「生きているホストの窓を作り直さず前へ出す」ことで、最近使ったアプリからの復帰と同じにすること。B はランチャーの経路だけに手を入れ、リンクの経路（通知・ペアリング。ADR 0086）には一切触れない。
- A でも同じ見た目は作れるが、リンクの intent が新しい殻のインスタンスを毎回上に積む形になり、複数インスタンスの殻（Capacitor のブリッジ・静的の link 受け渡し）と、リンクを目的の窓へ転送する設計が増える。効く挙動の変化も大きい（起動中の pair・open でホストの窓が残るようになる）ので、この修正の範囲では採らない。
- C はアイコンのタップが一覧を前へ出すので目的に合わず、タスクを 2 つに分ける複雑さも増える。
- `isTaskRoot` の偽の場合に閉じるだけなので、OS が「新しいインスタンスを積む」か「タスクを前へ出すだけ」かのどちらの実装でも正しく動く。

## 影響

- アイコンからの復帰で `HostActivity` は作り直されない。WebView の状態・プロキシ・接続がそのまま残る。
- 冷起動では従来どおり `ResumePolicy` が最後のホストの窓を開く（殻の起動が 1 段増えるだけ）。
- アプリのランチャーの顔は `LauncherActivity` になる（label・icon はアプリのもの）。`MainActivity` への `ACTION_MAIN` の直接起動（開発・試験での `am start -n`）も変わらず動く。
- iOS には関係しない。
