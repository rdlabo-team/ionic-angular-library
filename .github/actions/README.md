# Live Update 用 Composite Actions

Capacitor + [Capawesome Live Update](https://capawesome.io/plugins/live-update/) を使うフリート各アプリ（winecode / tipsys / foodlabel / receptray など）で共有する GitHub Actions です。各アプリの `.github/workflows/live-update.yml` から SHA 固定で参照します。

- **`validate-live-update`** — タグが現在のネイティブアプリと互換かを検証し、配信先チャンネル等を出力する
- **`publish-live-update`** — Web バンドルを作成・署名し、本番チャンネルへアップロードする

配信は「タグ push（`vX.Y.Z` / `vX.Y.Z-N`）」で発火します。

---

## チャンネルの考え方（重要）

Live Update は **ネイティブビルド番号ごとに 1 本のチャンネル** を使います。チャンネル名は必ず次の形です。

```
production-<ネイティブビルド番号>
```

ネイティブビルド番号は Android の `versionCode` と iOS の `CURRENT_PROJECT_VERSION`（この 2 つは常に一致している必要がある）です。

**なぜビルド番号ごとに分けるのか** — Live Update は「同じネイティブバイナリの上で JS/HTML/CSS だけを差し替える」仕組みです。ネイティブが変わった端末に古い前提の Web バンドルが降ってくると壊れるため、ネイティブビルド番号でチャンネルを分離し、**互換な端末にしか配信されないよう**にしています（アップロード時に `--android-min/max` `--ios-min/max` をビルド番号に固定）。

### 同じチャンネルのままになる場合（＝Live Update で配信できる）

ネイティブビルド番号を **変えていない** リリース。典型的には Web（Angular / Ionic）側だけの変更です。

- バグ修正・文言修正・UI 調整・ロジック変更など **JS/HTML/CSS のみ**
- 依存の変更でも **ネイティブに影響しないもの**（Capacitor プラグイン以外の npm パッケージ）

この場合、既に配信済みの端末はストア更新なしで即座に新しい Web バンドルを受け取ります。

例）`9.0.0`（build `9000000`）をストア公開済み → `9.0.1` を Web 変更のみでタグ付け
→ どちらも `production-9000000` に配信。既存ユーザーはそのまま最新化される。

### チャンネルが変わる場合（＝ストアリリースが必要）

ネイティブビルド番号を **上げた** リリース。次のいずれかを含むと、Live Update ではなくストア配布が必要になり、チャンネルも新しくなります。

- `app/android/**` または `app/ios/**` の変更
- `app/capacitor.config.ts`（または `capacitor.config.json`）の変更
- `@capacitor/*` または `@capawesome/capacitor-live-update` の **バージョン変更**

例）`9.0.0`（build `9000000`）→ ネイティブを更新して `9.1.0`（build `9100000`）をストア公開
→ 新チャンネル `production-9100000`。以降の `9.1.x` の Web 変更はこの新チャンネルへ。
古い `9.0.x` 端末は `production-9000000` のまま影響を受けない。

> `validate-live-update` は、前回タグからネイティブ/設定/プラグイン依存が変わっているのにビルド番号を上げていない（＝チャンネルが同じまま）ケースを **CI で失敗させます**。これにより「ストア更新が必要な変更を誤って Live Update で流す」事故を防ぎます。

### ビルド番号のルール

ビルド番号は `major`・`minor` を先頭にエンコードします。

```
floor(ビルド番号 / 10000) === major * 100 + minor
```

| バージョン | ビルド番号  | 先頭（major*100+minor） | チャンネル             |
| ---------- | ----------- | ----------------------- | ---------------------- |
| `9.0.x`    | `9000000`   | `900`                   | `production-9000000`   |
| `9.1.x`    | `9100000`   | `901`                   | `production-9100000`   |
| `10.2.x`   | `10020000`  | `1002`                  | `production-10020000`  |

同じ `major.minor` の中で patch を上げるだけなら、ビルド番号（＝チャンネル）は据え置きにでき、Live Update で配信できます。

---

## タグの規約

- `vX.Y.Z` — 通常リリース
- `vX.Y.Z-N` — プレリリース（`N` が新しいほど後）

タグの `X.Y` はネイティブの `major.minor` と一致し、`Z`（patch）はネイティブの patch 以上である必要があります。

---

## `validate-live-update`

タグと現在のネイティブアプリの互換性を検証します。

**Inputs**

| 名前       | 必須 | 既定  | 説明                                   |
| ---------- | ---- | ----- | -------------------------------------- |
| `app-path` | no   | `app` | リポジトリルートから見たアプリのパス   |
| `tag`      | yes  | —     | `vX.Y.Z` / `vX.Y.Z-N` 形式のリリースタグ |

**Outputs**

| 名前                 | 説明                                             |
| -------------------- | ------------------------------------------------ |
| `version`            | `v` を除いたバージョン（例: `9.0.1`）            |
| `build_number`       | Android/iOS 共通のネイティブビルド番号           |
| `production_channel` | 配信先チャンネル（`production-<build_number>`）   |

**検証内容**

1. 完全な Git 履歴が必要（`actions/checkout` の `fetch-depth: 0`）
2. Android と iOS の marketing version / build 番号が一致していること
3. タグがネイティブ `major.minor` と一致し、patch がネイティブ以上であること
4. ビルド番号が `major.minor` を正しくエンコードしていること
5. 直前の互換タグと比べて、ネイティブ/設定/プラグイン依存に変更がないこと（あればストアリリースが必要として失敗）

## `publish-live-update`

Web バンドルを作成・署名して本番チャンネルへアップロードします。`validate-live-update` の出力を入力に渡す前提です。

**Inputs**

| 名前                 | 必須 | 既定           | 説明                                             |
| -------------------- | ---- | -------------- | ------------------------------------------------ |
| `app-path`           | no   | `app`          | アプリのパス                                     |
| `app-id`             | yes  | —              | Capawesome Cloud のアプリ ID                     |
| `channel`            | yes  | —              | 配信先チャンネル（通常 `production-<build>`）     |
| `build-number`       | yes  | —              | min/max に固定するネイティブビルド番号           |
| `version`            | yes  | —              | リリースバージョン（`v` は付いていてもよい）     |
| `git-ref`            | no   | `github.sha`   | バンドルに記録する Git ref                       |
| `cli-version`        | no   | `4.15.0`       | `@capawesome/cli` のバージョン                   |
| `input-path`         | no   | `www/browser`  | バンドル対象の Web ビルド出力                    |
| `bundle-path`        | no   | `bundle.zip`   | 生成するバンドルの出力先                         |
| `rollout-percentage` | no   | `100`          | ロールアウト割合                                 |
| `token`              | yes  | —              | Capawesome Cloud API トークン（secret）          |
| `private-key`        | yes  | —              | バンドル署名用の RSA 秘密鍵 PEM（secret）        |

`token` / `private-key` は secret を input 経由で渡します。秘密鍵は実行ディレクトリに一時ファイルとして書き出し、処理後（失敗時も含め）必ず削除します。

---

## アプリ側の使い方（例）

```yaml
- id: validate
  uses: rdlabo-team/ionic-angular-library/.github/actions/validate-live-update@<SHA>
  with:
    app-path: app
    tag: ${{ github.ref_name }}
- name: Publish production update
  uses: rdlabo-team/ionic-angular-library/.github/actions/publish-live-update@<SHA>
  with:
    app-path: app
    app-id: ${{ env.CAPAWESOME_APP_ID }}
    channel: ${{ steps.validate.outputs.production_channel }}
    build-number: ${{ steps.validate.outputs.build_number }}
    version: ${{ steps.validate.outputs.version }}
    token: ${{ secrets.CAPAWESOME_TOKEN }}
    private-key: ${{ secrets.CAPAWESOME_LIVE_UPDATE_PRIVATE_KEY }}
```

`<SHA>` はこのリポジトリのコミット SHA で固定してください。

## 開発（テスト）

各アクションのロジックは純関数に分離し、Vitest で検証しています。

```bash
npm run test:actions
```
