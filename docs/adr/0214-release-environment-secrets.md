# 0214 署名・ストアの Secrets は Environment「release」にだけ置く

- 状態: 承認（2026-10-16）

## 状況

リポジトリを組織（OzEngineJP）へ移すと、組織の基本の権限（Write）で、組織のメンバーがこのリポジトリに書き込めるようになる。
Repository Secrets は、書き込める人が push したどのブランチのワークフローからも読める。Windows の署名の PFX、Android の署名鍵、Play のサービスアカウントの鍵が、ブランチにワークフローを置くだけで読み出せる。

## 決定

- 署名・ストアの Secrets（`WIN_CSC_*`・`PLY_ANDROID_*`・Play・iOS・TestFlight の鍵）は Repository Secrets に置かず、Environment `release` にだけ置く。
- `release` の配備の条件は、ブランチ `main` とタグ `v*` だけ。ほかのブランチ・PR のワークフローからは使えない。`desktop-release` の Environment も同じ条件にする。
- Secrets を使うジョブ（`evaluation-release.yml` の release・`android-release.yml`・`android-play.yml`・`ios-app.yml` の credentials と testflight）に `environment: release` を書く。
- Repository Variables（指紋・発行元など、秘密でないもの）はリポジトリに置いたまま。

## 理由

- GitHub は Repository Secrets をブランチで絞れない。Environment の配備の条件なら、`main` に入った（＝レビューを経た）ワークフローと、ルールセットで作れる人が限られたリリースのタグからしか読めない。
- 組織の基本の権限は組織のほかのリポジトリにも効くので、このリポジトリのためだけに下げない。

## 影響

- メンバーは今までどおりブランチ・PR を作れるが、署名の鍵には届かない。`main` に直接 push できる人は、`main` のワークフローで鍵を使える（`main` の守りはルールセットの削除・強制 push の禁止だけ）。
- Secrets を足す・替えるときは `gh secret set <名前> --env release`（`scripts/setup-evaluation-secrets.ps1` も Environment へ書く）。
- `release` の Environment を使うジョブは、`main` 以外から手動で動かすと配備の条件で止まる。
