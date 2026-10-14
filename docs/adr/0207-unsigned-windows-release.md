# ADR 0207: Windows の配布を無署名にし、更新は latest.yml の sha512 と方針で確かめる

- 状態: 提案
- 日付: 2026-10-14
- 関連: [ADR 0176](0176-update-signature-pinned-signers.md)（これを改める）、[desktop-releases.md](../desktop-releases.md)

## 状況

Windows の配布は自己署名（`CN=Ply Evaluation (hikaru)`、指紋 `BCEE9BE8…0910`、期限 2027-09-18）。どの PC にも信頼されない署名で、SmartScreen の警告も消えない。それでも、鍵の管理（GitHub Secrets の PFX・期限前の鍵の入れ替え）が要る。ADR 0176 のとおり、自動更新は指紋が固定の一覧にある署名だけを受け入れる。無署名の版をそのまま出すと、今の利用者の更新は `TRUST_E_NOSIGNATURE` で止まり、手動での入れ直しが要る。

electron-updater（6.8.9）は、署名とは別に、`latest.yml` の `sha512` でダウンロードした全体を確かめる（`DigestTransform` の `ERR_CHECKSUM_MISMATCH`。差分の取得・前回のダウンロードの再利用も同じ値で確かめる）。署名の確かめ（`verifySignature`）はその後に、インストールの前に呼ばれる。

## 決定

1. **Windows の配布を無署名にできるようにする。** `PLY_WINDOWS_SIGNING=none` のとき、electron-builder は署名しない（`signExecutable: false`・Windows だけ `forceCodeSigning: false`）。`app-update.yml` に `publisherName` を書かない（`verifyUpdateCodeSignature: false`）。署名の Secrets が環境にあれば止める。リリースの確かめは、配布物が `NotSigned` であること（署名が混じっていないこと）を見る。macOS の署名・公証は変えない。
2. **更新の確かめを方針で切り替える**（`desktop/update-signature.cjs`）。方針は `desktop/update-trust.json`（`desktop/update-signers.json` を改名）で、アプリに同梱する。
   - `unsigned`: `accept` なら無署名（`TRUST_E_NOSIGNATURE`）を受け入れる。`reject` なら受け入れない。
   - `publishers`: Windows が信頼する署名（`WinVerifyTrust` が `S_OK`）を受け入れる発行元名。インストール済みの `app-update.yml` の `publisherName` も加える。
   - `signers`: 指紋を固定した自己署名（ADR 0176 のまま）。
   - どれも受け入れない方針は読み込みで失敗にする。
3. **署名の有無に関わらず、`latest.yml` の `sha512` を確かめ直す。** ダウンロードしたファイルの SHA-512 が、同じ更新の情報の値と合わなければ受け入れない。`sha512` が無いときも受け入れない。electron-updater の確かめと重なるが、無署名の版では、これが中身の正しさの唯一の確かめになる。将来の electron-updater の変更でその確かめが外れても、ここで止まるようにする。
4. **改ざん（`TRUST_E_BAD_DIGEST`）・形の分からないファイル・その他の結果は、方針によらず受け入れない。**
5. **移るには署名した橋渡しの版が要る。** 今の利用者の更新の確かめは ADR 0176 のもの（無署名を受け入れない）。そのため、まず方針を `unsigned: accept` にした版を、今の鍵で署名して配る。その後に無署名の版を出す。この順を、無署名の公開の前に `scripts/release-unsigned-guard.mjs` が確かめる。Latest の版と、一番新しい版（先行版の利用者が取る）の `BUILD-INFO.json` に `updateAcceptsUnsigned: true` が無ければ止める。

## 理由

- 自己署名は、利用者から見た守りを足していない。信頼されないので SmartScreen の評価にも効かず、守っているのは「GitHub の書き込み権限を持つ者が、署名の鍵なしで更新を差し替えられない」の 1 点だけ。その鍵は、同じ GitHub の Secrets に置いてある。
- 無署名でも、配布物と `latest.yml` は同じ GitHub Release から HTTPS で取る。フィード（`app-update.yml` の owner/repo）はアプリに焼き込まれている。
- 方針をファイルにしたのは、認証局の署名（SignPath・Azure Artifact Signing など）へ戻すときに、コードを変えずに `publishers` を足して `unsigned` を外すだけで済むようにするため。
- 戻すときも順序が要る。発行元を `publishers` に足した版（無署名でよい）を先に配り、その後に署名した版を出す。リリースのビルドは、Azure の発行元が `publishers` に無ければ止まる。全員が移ったら `unsigned: reject` の版を出す。
- 橋渡しを確かめる仕掛けは、Release の `BUILD-INFO.json` を読むだけにした。アプリや更新の形式は変えない。

## 影響

- **失う守り（正直に書く）**: これまでは、GitHub のアカウント・トークン・Actions を乗っ取っても、署名の鍵（PFX とパスワード）が無ければ、利用者の PC で動く更新は出せなかった。無署名では、Release に書き込める者は誰でも、利用者に任意のコードを入れられる。`sha512` は `latest.yml` と同じ Release に載るので、同じ攻撃者が両方を差し替えられる。`sha512` が守るのは転送中の破損・途中の差し替え（中身の正しさ）であって、出した人が本物かどうかではない。なお、PFX が同じ GitHub の Secrets にある今の形でも、Actions を乗っ取れば署名させられるので、失う差は「Release に直接書き込める権限」と「署名させられる権限」の差に限られる。
- 安い代わりの守り（足していない。運用で入れられる）: GitHub の不変のリリース（immutable releases。公開後の配布物の差し替えを防ぐ）・アカウントの 2 段階認証・リリースのワークフローに承認つきの Environment。より強い守りは、`latest.yml` に Ed25519 の署名を付けて公開鍵をアプリに入れる形だが、新しい仕組みになるので、この ADR では決めない。
- 初回のインストールでは、SmartScreen が「不明な発行元」と出す（自己署名と同じ）。Windows の「スマート アプリ コントロール」が有効な PC では、無署名の実行ファイルが止められることがある。
- 橋渡しの版が届く前に止まっている PC（オフライン・更新を切った PC）は、無署名の版を受け取れず、手動での入れ直しが要る。
- 自己署名の指紋（`signers`）は方針に残す。橋渡しの版より前の版からの更新と、橋渡しの期間に出す署名の版のため。
- `Desktop signed release` のワークフローは `BUILD-INFO.json` を書かないので、それで出した版の後に無署名の版を出すと、確かめで止まる（その版には方針の値が記録されていない）。
