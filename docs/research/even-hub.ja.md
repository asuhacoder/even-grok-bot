# Even Hub 開発者プラットフォーム 技術ブリーフ（Even Realities G2）

調査日 2026-10-20。前提とする要件は「タップ=確定、ダブルタップ=戻る、長押し=メニュー、スワイプ=移動」の G2 アプリ。

英語版は `even-hub.md`。内容は同一で、こちらが日本語版。

このプロジェクトは Even Hub で一般公開しない。各利用者が自分のビルドを自分の開発者アカウントへ Beta ビルドとして入れる。以下の審査・提出の記述は、Beta ビルドも同じプラットフォームの制約に従うために残しており、審査に提出するためではない。

## 出典と調査方法

権威順の一次情報。

1. `@evenrealities/even_hub_sdk@0.0.16`（2026-09-24 公開）。型定義は `npm pack` 後の `package/dist/index.d.ts`（1535 行）を読んだ。公式ドキュメント自身が「`.d.ts` が正典」と明記している（https://hub.evenrealities.com/docs/build/device-apis）。
2. `@evenrealities/evenhub-cli@0.1.14` の `package/main.js`。`app.json` の実バリデータである zod スキーマが同梱されている。
3. `@evenrealities/evenhub-simulator@0.9.5` と `@evenrealities/pretext@0.1.4` の `package/README.md`。
4. https://hub.evenrealities.com/docs/ 配下の各ページ。VitePress v2 の prerender 済み HTML なので、`curl` だけで本文が取れる。当初の想定「JS レンダリング」は誤りで、ブラウザは不要だった。

**ローカル検証済み** と記した箇所は、SDK バンドルを `node -e "require('./dist/index.cjs')"` で実際に実行して確認した。それ以外はドキュメントまたは型定義の記述。確定できなかった項目は UNCONFIRMED と記す。

**注意すべきバージョン乖離。** ドキュメントの changelog（https://hub.evenrealities.com/docs/reference/changelog、最終更新 2026-08-29）は SDK 0.0.14 を最新とし、レビュー基準の `min_sdk_version` 下限も 0.0.14 と書く。npm には 0.0.16 があり、その `package.json` は `"minAppVersion": "2.2.10"` を宣言している。以下の型は 0.0.16 のもの。

## 1. アプリのアーキテクチャ

**コードが動く場所。** プラグインは通常の Web アプリ（HTML/CSS/JS または TypeScript）で、Even Realities スマホアプリがホストする WebView 上で動く。Android は Chromium、iOS は WKWebView。スマホアプリ本体は Flutter で、BLE 5.2 経由ですべてをグラスへ中継する。ネイティブのスクロール処理を除き、グラス側ではアプリロジックが動かない（https://hub.evenrealities.com/docs/get-started/architecture）。

経路は「JS が `bridge.callEvenApp(method, params)` を呼ぶ → WebView ブリッジ → Even Realities アプリ → Bluetooth → グラス」。イベントは `window._listenEvenAppMessage(...)` で戻ってくる（同ページ）。

**フレームワーク。** 非依存。公式テンプレートはバンドルサイズ優先で Vite + TypeScript のバニラ TS。React、Vue、Svelte も利用可能と明記されている（https://hub.evenrealities.com/docs/reference/faq）。ESM 前提。SDK README が挙げる実行要件は `window.flutter_inappwebview.callHandler`。

**ブリッジ初期化。** この 1 呼び出しがすべての前提になる。

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
const bridge = await waitForEvenAppBridge()
```

`waitForEvenAppBridge(): Promise<EvenAppBridge>` はホスト側ブリッジが生きてから resolve する。resolve 前に SDK メソッドを呼ぶと**無言で no-op** になる（https://hub.evenrealities.com/docs/get-started/quickstart/first-app）。`EvenAppBridge` はシングルトンで、`EvenAppBridge.getInstance()`。

**ブリッジの全メソッド。** `dist/index.d.ts` から取得し、プロトタイプを reflect して**ローカル検証済み**。

`callEvenApp`、`getUserInfo`、`getDeviceInfo`、`setLocalStorage`、`getLocalStorage`、`getAppLocation`、`startAppLocationUpdates`、`stopAppLocationUpdates`、`pickImageFromAlbum`、`captureImageFromCamera`、`createStartUpPageContainer`、`rebuildPageContainer`、`updateImageRawData`、`textContainerUpgrade`、`audioControl`、`imuControl`、`shutDownPageContainer`、`onLaunchSource`、`onDeviceStatusChanged`、`onEvenHubEvent`、`onAppLocationChanged`。

OS 入力の購読口は 1 つだけ。`onEvenHubEvent(cb: (event: EvenHubEvent) => void): () => void`。

**起動順序。** `waitForEvenAppBridge()`、次に `createStartUpPageContainer(...)` を 1 回だけ、その後にその他すべて。`audioControl(true, AudioInputSource.Glasses)` はスタートアップページが存在している必要がある。

プロジェクト構成（https://hub.evenrealities.com/docs/get-started/quickstart/first-app）。`src/main.ts` がエントリ、`index.html` と `vite.config.ts` は配布時のまま触らない、Even 固有ファイルは `app.json` のみ、`public/icon.png` が 24x24 のグレースケールアイコン。

## 2. 表示

**キャンバス。** 片眼あたり 576 x 288 px。原点は左上、X は右、Y は下。4 ビットグレースケール 16 階調で、緑として描画される。白は明るい緑、黒は消灯（透明）（https://hub.evenrealities.com/docs/build/display）。

**モデル。** DOM なし、CSS なし、flexbox なし。絶対ピクセル座標の矩形コンテナを宣言し、ファームウェアが合成する。任意ピクセル描画は不可（https://hub.evenrealities.com/docs/reference/faq）。

**コンテナ上限。** 同ページと `.d.ts` の `CreateStartUpPageContainer` より。

| フィールド | 上限 | 強制する側 |
| --- | --- | --- |
| `containerTotalNum` | 1 から 12 | ファームウェア |
| `textObject` | 最大 8 | ファームウェア |
| `imageObject` | 最大 4 | ファームウェア |
| `listObject` | 12 の残り枠 | ファームウェア |

**ローカル検証済み** の重要な差異。`validateEvenHubPageContainer` にテキストコンテナ 13 個を渡すと `{ valid: true }` を返す。SDK が検証するのは z-order、メニュー、輝度の 3 つだけ。12 / 8 / 4 の上限はファームウェア側で拒否されるため、SDK 検証を通っても実機で失敗しうる。

**共通プロパティ**（https://hub.evenrealities.com/docs/build/display）。

| プロパティ | 範囲 | 補足 |
| --- | --- | --- |
| `xPosition`、`yPosition` | 0 から 576 / 0 から 288 | 左上原点 |
| `width`、`height` | 0 から 576 / 0 から 288 | |
| `containerID` | number | ページ内で一意 |
| `containerName` | 最大 16 文字 | ページ内で一意 |
| `isEventCapture` | 0 または 1 | 1 のコンテナはページに 1 つだけ |
| `zOrderIndex` | ページ内で一意 | ページ単位で全指定か全省略。SDK 0.0.12+ |
| `borderWidth` | 0 から 5 | テキストとリストのみ |
| `borderColor` | 0 から 15 | テキストとリストのみ |
| `borderRadius` | 0 から 10 | protobuf の綴りミスを引き継いでいる |
| `paddingLength` | 0 から 32 | テキストとリストのみ |

背景や塗りつぶしのプロパティは存在しない。枠線だけが装飾手段。

**テキストコンテナ。** `TextContainerProperty`。プレーンテキスト、左揃え、上揃え。整列指定なし、フォントサイズ指定なし、太字・斜体なし。共通プロパティ以外のフィールドは `content?: string` と `textColor?: number`。

**文字数上限**（https://hub.evenrealities.com/docs/build/display）。

| 呼び出し | 最大文字数 |
| --- | --- |
| `createStartUpPageContainer` | 1,000 |
| `rebuildPageContainer` | 1,000 |
| `textContainerUpgrade` | 2,000 |

**挙動。** コンテナ幅で折り返す。`\n` は改行。全画面テキストコンテナで概ね 400 から 500 文字。中央寄せは空白パディングで作る。

**スクロール。** 内容があふれ、かつそのコンテナが `isEventCapture: 1` の場合、ファームウェアがスクロールする。プログラムからスクロール位置を指定する手段はない（https://hub.evenrealities.com/docs/build/device-apis の「What the SDK doesn't expose」）。

**更新。** インプレース更新は `textContainerUpgrade`。実機でちらつかない。

```ts
declare class TextContainerUpgrade {
  containerID?: number
  containerName?: string
  contentOffset?: number
  contentLength?: number
  content?: string
  textColor?: number
}
```

`containerID` と `containerName` の両方が作成時の値と一致しないと無言で no-op。`contentOffset` と `contentLength` は部分文字列更新用。`rebuildPageContainer` は全再描画で、実機ではちらつく。

**テキスト輝度。** `textColor` は 0 から 4 の 5 段階（SDK 0.0.14+）。名前と違い色ではなく輝度。作成・再構築時に省略すると端末既定の 4。アップグレード時に省略すると現在値を維持。0 は「未設定」ではなく最暗なので、`textColor: 0` は実質見えない可能性がある。0 から 4 の外は SDK が `INVALID_TEXT_BRIGHTNESS` で拒否する。同じコンテナ上で `textColor` が 0 から 4、`borderColor` が 0 から 15 という別スケールである点に注意。

**リストコンテナ。** `ListContainerProperty` が `itemContainer: ListItemContainerProperty` を持ち、その中に `itemCount`、`itemWidth`、`isItemSelectBorderEn`、`itemName: string[]` が入る。スクロールとハイライトはファームウェア処理。上限は 1 リスト 20 項目、1 項目 64 文字。項目単位のスタイル、行高、区切り線はなし。インプレース更新も不可で、リスト変更はページ再構築になる。

**イメージコンテナ。** `ImageContainerProperty`、1 コンテナ最大 288 x 144 px、4 ビットグレースケール。`imageData` は `number[]`、`Uint8Array`、`ArrayBuffer`、base64 を受け付ける。`createStartUpPageContainer` でピクセルを渡すことはできない。プレースホルダを作り、`updateImageRawData` で送る。同時送信は不可。転送時に LZ4 圧縮される（SDK 0.0.12+、コード変更不要）。送信は 100 ms 間隔に律速され、その窓に入った呼び出しは破棄されず次に繰り越される。

**フォント。** ファームウェアに焼き込まれた LVGL フォント 1 種のみ。フォント選択不可、サイズ指定不可、等幅でもない。フォント集合にない文字は無言で落ちる。絵文字は使えず、FAQ は Unicode の幾何学文字・罫線文字を代替として挙げる。

**行メトリクス。** 公式公開パッケージ `@evenrealities/pretext@0.1.4`（`dist/font_measure.d.ts`、SDK と同じ Even Realities メンテナが `@evenrealities` スコープで公開）より。行高は固定 27 px。字幅はファームウェアの LVGL C フォントファイルから抽出。グリフのフォールバック連鎖は型定義のコメントに `evenroster -> evenroster_crylgrek -> cn -> evenemoji` と記載。

**日本語・CJK。** 部分的にのみ確認済みで、このブリーフで最も根拠が弱い項目。

- フォールバック連鎖に `cn` フォントが入っており、`@evenrealities/pretext` は「Wide character support, Latin, Cyrillic, Greek, CJK (Chinese, Japanese, Korean), Bopomofo」をうたう（`package/README.md`）。
- `supported_languages` は必須フィールドで `ja` と `zh` を受け付ける（https://hub.evenrealities.com/docs/ship/packaging）。
- コンテキストメニューのページは CJK を明示的に扱う。「CJK is 3 bytes per glyph, so a Chinese label is capped near 10」（https://hub.evenrealities.com/docs/build/contextual-menu）。
- シミュレータの changelog は 0.2.0 で「lighter CJK font」、0.7.0 で「Unknown-glyph handling matches firmware」と記す。

テキストコンテナの節で日本語対応を明言したページは存在しない。JIS 第 1 水準の漢字がすべて出るかは **UNCONFIRMED**、ファームウェアとシミュレータでグリフ集合が一致するかも **UNCONFIRMED**。日本語コピーを前提に設計する前に、かなと実語彙を実機で確認すること。

## 3. 入力イベント

この節が仕様の可否を決める。制約一覧として読んでほしい。

**2 つの入力源、1 つのジェスチャ集合。** Even G2 の左右テンプルタッチパッドと、オプションの R1 リング。どちらも「押下、二度押し、上スワイプ、下スワイプ、長押しと離し」を出し、source で区別できる（https://hub.evenrealities.com/docs/build/device-apis）。

**イベント型。** `dist/index.d.ts` の `OsEventTypeList`。

| イベント | 値 | アプリへの届き方 |
| --- | --- | --- |
| `CLICK_EVENT` | 0 | `textEvent` または `listEvent` |
| `SCROLL_TOP_EVENT` | 1 | `textEvent` または `listEvent` |
| `SCROLL_BOTTOM_EVENT` | 2 | `textEvent` または `listEvent` |
| `DOUBLE_CLICK_EVENT` | 3 | `textEvent` または `listEvent` |
| `FOREGROUND_ENTER_EVENT` | 4 | `sysEvent` |
| `FOREGROUND_EXIT_EVENT` | 5 | `sysEvent` |
| `ABNORMAL_EXIT_EVENT` | 6 | `sysEvent` |
| `SYSTEM_EXIT_EVENT` | 7 | `sysEvent` |
| `IMU_DATA_REPORT` | 8 | `sysEvent` |
| `LONG_PRESS_EVENT` | 9 | `sysEvent` |
| `LONG_PRESS_RELEASE_EVENT` | 10 | `sysEvent` |

**ルーティング。** ページ内で `isEventCapture: 1` を設定するコンテナは 1 つだけ。クリック、ダブルクリック、スクロール上下はそのコンテナに届き、テキストコンテナなら `event.textEvent`、リストコンテナなら `event.listEvent` になる。この表を迂回して常に届く経路が 2 つある。長押しの `event.sysEvent` と、コンテキストメニュー選択の `event.menuItemClickEvent`。

**入力源の識別。** `sysEvent.eventSource` の `EventSourceType`。`0` はヌルダミー、`1` が `TOUCH_EVENT_FROM_GLASSES_R`、`2` が `TOUCH_EVENT_FROM_RING`、`3` が `TOUCH_EVENT_FROM_GLASSES_L`。

**ドキュメント内の矛盾。** https://hub.evenrealities.com/docs/build/device-apis は「Both events always arrive on `event.sysEvent` ... and `eventSource` is absent on them」と書く。一方 `.d.ts` は「CLICK / DOUBLE_CLICK / LONG_PRESS / LONG_PRESS_RELEASE はいずれもこのフィールドで右テンプル・リング・左テンプルを識別し、長押しのパース時に eventType だけを残してはならない」と逆のことを書く。`EventSource: 2` を持つ長押しペイロードが `{"eventType":9,"eventSource":2}` として往復することを**ローカル検証済み**。SDK は source を保持する。ファームウェアが長押しで source を埋めるかは UNCONFIRMED。

**予約済み・OS が取得するジェスチャ。** 機構が 3 つあり、挙動がそれぞれ違う。

1. **タップ後の長押しは OS のもの。** 「The OS claims tap then long press for its own menu. A tap followed by a sustained press raises the contextual menu, so whether a press reaches your app depends on which layer owns it」（https://hub.evenrealities.com/docs/build/device-apis）。FAQ も同旨。「The OS claims tap then long press for its own menu, so a press only reaches you when your layer owns it.」
2. **ダブルタップはシステムジェスチャで、契約が必須。** シミュレータは `double_click` を「System double-tap, normally back, dismiss, or the exit dialog on a root page」と説明する（https://hub.evenrealities.com/docs/test/simulator）。ルートページでは要件が厳格で、「Root-page double-tap calls `bridge.shutDownPageContainer(1)` ... Apps that exit silently or do nothing on double-tap are rejected」（https://hub.evenrealities.com/docs/ship/app-submission）。
3. **スワイプはネイティブスクロールであり、自由なジェスチャではない。** `SCROLL_TOP_EVENT` と `SCROLL_BOTTOM_EVENT` の説明は「Swipe up / scroll reaches top boundary」「Swipe down / scroll reaches bottom boundary」。イベント取得コンテナのスクロールはファームウェアが所有する。ドラッグベクトルもスワイプごとのデルタもなく、左右スワイプは存在しない。

**要件と実装可能範囲の対応。**

| 要件 | プラットフォームの実態 | 判定 |
| --- | --- | --- |
| タップ = 確定 | `CLICK_EVENT`（0）がイベント取得コンテナに届く | 可 |
| ダブルタップ = 戻る | `DOUBLE_CLICK_EVENT`（3）は届くが、OS もシステムの戻る・閉じるとして扱う。ルートページでは終了ダイアログを出さないとレビューで落ちる | 内部ページのみ可。ルートページでは必須の終了契約と衝突 |
| 長押し = メニュー | `LONG_PRESS_EVENT`（9）と `LONG_PRESS_RELEASE_EVENT`（10）は存在するが、タップ後長押しは OS メニューが取得するため raw の押下は確実には回ってこない。正規の手段は `menuObject` と `menuItemClickEvent` | `menuObject` を使う。raw 長押しの上に作らない |
| スワイプ = 移動 | `SCROLL_TOP` と `SCROLL_BOTTOM` のみで、いずれもイベント取得コンテナのネイティブスクロールの境界イベント。方向スワイプなし、デルタなし、左右なし | カーソル移動・選択移動の手段としては不可 |

設計上の帰結。「スワイプで選択を移動」にプラットフォーム側のプリミティブはない。スクロールの境界通知が 2 つ得られるだけ。リストコンテナの上下 `SCROLL_*` でナビゲーションを組み、ハイライトはファームウェアに任せるか、スワイプを捨ててクリック巡回にするかの二択になる。

**クリック処理の実装上の注意 2 点。**

- ドキュメントは「SDK normalizes 0 to undefined in some cases」として `case undefined` を書くよう求める（https://hub.evenrealities.com/docs/build/device-apis）。0.0.16 で `OsEventTypeList.fromJson(0)` が `0` を返し、テキストコンテナのクリックが `{"containerID":1,"eventType":0}` にパースされることを**ローカル検証済み**。助言は古いが無害。旧 SDK 互換のため `case undefined` は残してよい。
- `onEvenHubEvent` は購読口が 1 つ。画面ごとに追加しない。戻り値の関数で解除する。

## 4. マイクと音声

開始と停止は `audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>`。`AudioInputSource` は `Glasses = "glasses"` と `Phone = "phone"` で、省略時はグラス。

```ts
await bridge.audioControl(true, AudioInputSource.Glasses) // G2 の 4 マイクアレイ
await bridge.audioControl(false)                          // 停止
```

**フォーマットは両ソース共通。** PCM 16 kHz、符号付き 16 ビットリトルエンディアン、モノラル（https://hub.evenrealities.com/docs/build/device-apis）。チャンク分割はシミュレータのページにあり、「100 ms of data per event (3,200 bytes / 1,600 samples)」（https://hub.evenrealities.com/docs/test/simulator）。

**受け取り方。** チャンクは他のイベントと同じ購読口に来る。

```ts
declare class AudioEvent {
  audioPcm: Uint8Array
  source: AudioInputSource
  direction: number | null
  speakerRole: AudioSpeakerRole   // 'self' | 'other' | 'unknown'
}
```

`bridge.onEvenHubEvent(e => { const a = e.audioEvent; /* a.audioPcm */ })`

**制約。**

- グラス側キャプチャは `createStartUpPageContainer` 実行済みが前提。スマホマイクは不要。
- マニフェスト権限はグラスが `g2-microphone`、スマホが `phone-microphone`。未使用の権限はレビューで指摘される。
- 4 マイクアレイの個別マイク取得と DOA 角度通知は「on the roadmap」で未提供。渡ってくるのはミックス済みモノラル 1 本。
- `direction` は生の符号付き int16 方向タグで、SDK は単位も範囲も変換しない。スマホマイクでは `null`。
- `speakerRole` は「the App audio algorithm result, not a firmware identity assertion」と明記されている。
- グラスに音声出力はない。スピーカー非搭載。
- WebView がサスペンドされるとキャプチャは止まる。フォアグラウンド復帰時に同じ `AudioInputSource` で再有効化する。

ストリーミング文字起こし API は存在しない。`asr` テンプレートは「audio capture wired, transcription scaffolding, mic UI states」を同梱する（https://hub.evenrealities.com/docs/get-started/quickstart/templates）ので、ASR は自前、通常はサーバ側で組むことになる。

## 5. ネットワーク

**WebView から `fetch`、`XMLHttpRequest`、WebSocket が使える。** 独立したゲートが 2 つある（https://hub.evenrealities.com/docs/build/networking）。

**ゲート 1、Even 側ホワイトリスト。** 宛先ドメインが `app.json` の `network` 権限 `whitelist` に載っている必要がある。リクエストが WebView を出る前に Even Realities アプリが強制する。記載外はトラフィックを一切発生させずにブロックされる。

**ゲート 2、ブラウザの CORS。** WebView エンジンが標準 CORS を強制する。リモートサーバが `Access-Control-Allow-Origin` 等を返さないとレスポンスは捨てられる。ドキュメントは強く念押しする。「The whitelist is not a CORS bypass」「APIs that work on localhost but fail inside the WebView are almost always CORS misconfigurations on the remote side」。

**マニフェストの形。** `@evenrealities/evenhub-cli@0.1.14` の `package/main.js` 内 zod スキーマで確認。

```ts
{ name: "network", desc: string /* 1..300 文字 */, whitelist: string[] /* 既定 [] */ }
```

スキーマは whitelist の文字列フォーマットを検証しない。形式の規則は文章でのみ規定されている。

**形式の規則**（https://hub.evenrealities.com/docs/build/networking）。

- 「One whitelist entry per origin. Use the full origin (`https://api.example.com`). Bare hostnames and wildcards aren't supported.」
- 「HTTPS in production. Plain `http://` is only useful for local dev against a LAN dev server.」
- レビュー基準はさらに「Backend service domains, if any, are documented and traceable to the developer」を求め、プライバシーポリシーが全権限を網羅していることも確認する。

**Tailscale の可否を直接答える。**

- 素の `100.x.y.z` は `http://` としてのみ通り、しかもローカル開発の扱い。本番レビューは HTTPS を前提とし、IP 直指定の HTTPS はスマホが信頼する証明書を要する。ホワイトリスト項目に非標準ポートを書けるかは、CLI が文字列を検証しないため **UNCONFIRMED**。
- `https://machine.tailXXXX.ts.net` は正式な HTTPS オリジンで実証明書を持つため、こちらの形が妥当。ただし非公開ホスト名がレビューを通るかは **UNCONFIRMED**。文書化されたレビュー条件は「documented and traceable to the developer」であり、ドキュメント化された Tailscale ホストは理屈上これを満たす。
- WebSocket は許可され、同じホワイトリスト規制下にある。エントリを `https://` オリジンで書くのか `wss://` スキームで書くのかは、ドキュメントが「same whitelist rules」としか書かないため **UNCONFIRMED**。

**設計に効く上限。** 「Can I make network calls while backgrounded? No. WebView is suspended on background; in-flight requests stall.」また WebSocket は Android でサスペンド時に「typically drop」。BLE スループットは約 10 から 30 KB/s で、これは画像とアニメーションの上限でありネットワークの上限ではない。

## 6. バックグラウンドとライフサイクル

**OS による差**（https://hub.evenrealities.com/docs/build/background-lifecycle）。

| プラットフォーム | エンジン | バックグラウンド・ロック時 |
| --- | --- | --- |
| iOS | WKWebView | 動作継続。メモリ上の JS 状態は保持。特別な対応は不要 |
| Android | Chromium WebView | メモリ逼迫時にサスペンドされうる。プロセス回収でメモリ上状態は消える |

ドキュメントの指示は明快で「Treat Android suspend as the app starts cold」。`localStorage` へ早めに永続化し、再起動時に再構築する。

**何が残るか。**

| リソース | バックグラウンド・ロック後の生存 |
| --- | --- |
| `localStorage` | 常に残る。ディスク永続。アンインストールで消える |
| メモリ上の JS 状態 | iOS は残る。Android は残らない場合がある |
| 開いている WebSocket | iOS は概ね維持。Android は概ね切断 |
| `audioControl(true, ...)` のキャプチャ | サスペンドで停止。フォアグラウンドで再有効化が必要 |
| `startAppLocationUpdates` のストリーム | サスペンドで停止。フォアグラウンドで再設定が必要 |

**配布モードで答えが変わる点が落とし穴。** https://hub.evenrealities.com/docs/test/local-testing と https://hub.evenrealities.com/docs/test/beta-testing より。

| モード | ロック・バックグラウンド時の挙動 |
| --- | --- |
| 開発用 QR サイドロード | アプリがバックグラウンドになった瞬間に死ぬ。開発用 WebSocket が切れ、QR 再スキャンまで白画面。ロック挙動の検証は不可能 |
| プライベートビルド（ポータルの `.ehpk`） | 短時間は生存。5 分ロックテストは通らない |
| ベータビルド | レビュー同等。5 分ロックテストを通る |

つまりポケットにスマホを入れたまま動く必要のある G2 アプリは、ベータビルドでしか検証できない。レビューはまさにこの検査を実行する。「Phone locked + Even App backgrounded → glasses-launched app renders within reasonable time」に加え「After 2 minutes idle the app is still alive and responsive」（https://hub.evenrealities.com/docs/ship/app-submission）。

**通知とグラス画面の起動。** 「Can I receive push notifications? No. Plugins are foreground-only on the glasses. The phone app receives notifications and may surface them in its own UI」（https://hub.evenrealities.com/docs/reference/faq）。

したがってバックグラウンド中のアプリに対して、グラス画面を起こす手段もコンテンツを押し込む手段もない。サーバ起点で休止中のアプリを更新する設計は範囲外。例外的にコンテキストメニューは「without waking your WebView」で描画されるが、このオーバーレイは OS 所有で、アプリが実行時に書き込むことはできない。

**終了契約。** `shutDownPageContainer(exitMode?: number)`。モード 1 はシステムの終了確認ダイアログを出し、ルートページでは必須。モード 0 は即時終了で、ユーザーが既に確定した内部ページでのみ許される。終了後はスマホ側 WebView も閉じる必要があり、残存する WebView はレビューで拒否される。

**フォアグラウンドイベントは終了ではない。** `FOREGROUND_EXIT_EVENT` はコンテキストメニューのオーバーレイが閉じたときに発火する。ページはマウントされたまま。ドキュメントはこのハンドラを冪等にするよう警告している。

## 7. コンテキストメニュー

**何か。** タップ後の長押しで立ち上がる、OS 描画のオーバーレイ。フレームは OS が所有し、アプリの項目は常にシステム枠に囲まれる（https://hub.evenrealities.com/docs/build/contextual-menu）。

| 枠 | 所有者 |
| --- | --- |
| Display off | システム。SDK からは到達不可 |
| Brightness | システム。OS が完結処理し、アプリに通知されない |
| アプリのアクション項目 | アプリ。最大 10 |
| Close [アプリ名] | システム。SDK からは到達不可 |

**アプリが定義できるか。** できる。SDK 0.0.14+ かつ Even App 2.2.9+。`createStartUpPageContainer` または `rebuildPageContainer` に `menuObject` を付ける。

```ts
declare class MenuItemProperty {
  itemName?: string  // 最大 32 UTF-8 バイト。文字数ではない
  itemID?: number    // 非ゼロ uint32。トップレベルメニュー内で一意
}
declare class MenuContainerProperty {
  menuItems?: MenuItemProperty[]  // ファームウェアは最大 10 件
}
```

**挙動上の制約。**

- 撃ちっぱなし。項目を選ぶと `menuItemClickEvent` が 1 回届いてメニューが閉じる。トグル状態なし、再描画なし、アプリからの応答経路もなし。
- `menuObject` は再構築時に丸ごと置換される。省略するとアプリ項目が消え既定に戻る。メニューを維持したい再構築では毎回付け直す。
- 項目選択は `FOREGROUND_ENTER_EVENT`、`menuItemClickEvent`、`FOREGROUND_EXIT_EVENT` の順で通知される。
- `menuItemClickEvent` は `isEventCapture` のルーティングを通らない。
- クライアント側バリデーションは**ローカル検証済み**で到達を確認。11 件で `TOO_MANY_MENU_ITEMS`、ASCII 33 バイトで `INVALID_MENU_ITEM_NAME`、`itemID: 0` で `INVALID_MENU_ITEM_ID`、重複で `DUPLICATE_MENU_ITEM_ID`。
- 2.2.9 未満のアプリでは宣言が無言の no-op になる。SDK 0.0.14 以降でパックすると CLI が 2.2.9 の下限を刻むため、該当ユーザーは起動時点でブロックされる。
- 同ページの設計注意。「Don't add your own exit item, the root-page double-tap contract in App Submission is unchanged and still required.」

メニュー UI の正規の置き場所はここ。OS が既にタップ後長押しをメニューに割り当てている以上、「長押し=メニュー」を独自実装するのはプラットフォームと競合する。`menuObject` を宣言すれば、ユーザーに見える結果は同じで、対応済みの経路になる。

## 8. ツール

**CLI。** `npm install -g @evenrealities/evenhub-cli`。バイナリは `evenhub`、別名 `eh`（https://hub.evenrealities.com/docs/reference/cli）。バージョン 0.1.14。

| コマンド | 用途 |
| --- | --- |
| `evenhub init` | `app.json` の雛形を生成。`-d/--directory`、`-o/--output` |
| `evenhub qr` | 開発用サイドロードの QR を表示。`-u/--url`、`-i/--ip`、`-p/--port`、`--path`、`--https`/`--http`、`-e/--external`、`-s/--scale`、`--clear` |
| `evenhub pack <json> <project>` | `.ehpk` を生成。`-o/--output`、`--no-ignore`、`-c/--check`、`--sdk-ver <version>`、`--enforce-manual-version` |
| `evenhub login` | アカウント認証情報を保存 |
| `evenhub --completion-bash\|zsh\|fish` | シェル補完 |

0.1.14 以降、pack 失敗時は非ゼロ終了するため、`.ehpk` が無いまま CI が通ることはない。`pack` は SDK の npm `minAppVersion` メタデータから `min_app_version` を導出し、`.ehpk` にのみ刻む。ソースの `app.json` は書き換えない。

**マニフェスト `app.json`。** `main.js` 内の zod スキーマで確認し、https://hub.evenrealities.com/docs/ship/packaging と突き合わせた。

| フィールド | 必須 | 規則 |
| --- | --- | --- |
| `package_id` | 必須 | `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`。2 セグメント以上、ハイフン不可 |
| `edition` | 必須 | 厳密に `"202601"` |
| `name` | 必須 | 20 文字以内。「Even」を含められない |
| `version` | 必須 | `x.y.z`。`v` 接頭辞なし、プレリリース接尾辞なし |
| `min_app_version` | 任意 | CLI が導出して刻む。自分の値と SDK 下限の高い方 |
| `min_sdk_version` | 必須 | 文字列。レビュー基準の下限は 0.0.14 |
| `entrypoint` | 必須 | ビルドフォルダ内に実在すること。例 `index.html` |
| `permissions` | 必須 | オブジェクトの配列。`[]` 可 |
| `supported_languages` | 必須 | `en, de, fr, es, it, zh, ja, ko` の部分集合 |

権限名は CLI スキーマにある 6 種で、`network`、`location`、`g2-microphone`、`phone-microphone`、`album`、`camera`。`whitelist` を取るのは `network` のみ。

**シミュレータ。** `npm install -g @evenrealities/evenhub-simulator`、npm 上の最新は 0.9.5。`evenhub-simulator http://localhost:5173`。オプションは `-g/--glow`、`--automation-port <port>`、`--aid`、`--print-config-path` など。

CI で効くのは自動化プレーン（https://hub.evenrealities.com/docs/test/simulator）。

| エンドポイント | 用途 |
| --- | --- |
| `GET /api/ping` | ヘルスチェック |
| `GET /api/screenshot/glasses` | LVGL フレームバッファの 576x288 RGBA PNG |
| `GET /api/screenshot/webview` | ホスト WebView の PNG |
| `GET /api/console[?since_id=N]` | console、未捕捉例外、失敗した fetch |
| `DELETE /api/console` | バッファ消去 |
| `POST /api/input` | `{"action": "up"\|"down"\|"click"\|"double_click"\|"long_press"\|"long_press_release"\|"context_menu"}` |

ドキュメントが明記する注意点。エミュレータではない。フォントとグレースケールは実機と画素一致しない。SDK の LZ4 画像経路を展開しないため、圧縮転送は実機で検証する必要がある。特定ファームウェアでシステムメニュー枠がどう出るかは判定できない。起動後おおむね 4 秒待ってから入力を送り、`/api/console` で ready 行をポーリングする。

**テンプレート。** `github.com/even-realities/evenhub-templates` を `npx degit even-realities/evenhub-templates/<name>` で取得。`minimal`、`text-heavy`（ページネーションとフォント計測ヘルパ）、`asr`（音声取得と文字起こしの足場）、`image` の 4 種。インプレース更新機構はなく、上流と diff して必要な分を持ってくる。

**テストのはしご。** レイアウトとロジックはシミュレータ。実 BLE のタイミング、HMR、実入力は QR サイドロード。実パッケージ経路と実権限プロンプトはプライベートビルド。ロック生存とレビュー同等性はベータビルド。提出前チェックは `evenhub pack app.json dist -o myapp.ehpk -c`。

**その他の制約。** `.ehpk` の実用上限は約 10 MB。有料配信なし。地域別配信なし。リリース済みバージョンは不変で fix-forward のみ。システムブラウザへのディープリンクなし。ハプティクスなし。クリップボードなし。ファイルシステムなし。

## 未確定事項（UNCONFIRMED）

1. テキストコンテナ用フォントの日本語グリフ範囲。根拠は間接的（`@evenrealities/pretext` の `cn` フォールバック、`supported_languages` の `ja`、メニュー文書の CJK バイト計算）。実機で日本語コーパスを流した確認は未了。
2. 長押しイベントでファームウェアが `eventSource` を埋めるか。`.d.ts` は保持を要求し、ドキュメントは不在と書き、パーサは存在すれば保持する。
3. ホワイトリスト項目に非標準ポートを書けるか、`*.ts.net` ホスト名がレビューを通るか。CLI は文字列を検証しない。
4. WebSocket のホワイトリスト項目を `https://` と `wss://` のどちらで書くか。
5. 特定ファームウェアでアプリ項目の周囲に出るシステムメニュー枠の構成。
6. ダブルタップとタップ後長押し以外に、OS がアプリ到達前に取得するジェスチャがあるか。
7. `docs/reference/changelog` は npm より SDK 2 パッチ分古く、0.0.15 と 0.0.16 のリリースノートはドキュメントから読めなかった。0.0.16 の `minAppVersion` が 2.2.10 であることは `package.json` で確認したが、変更内容は未確認。

## 仕様への提言

1. raw の長押しをやめ、`menuObject` に置き換える。プラットフォームはタップ後長押しを自前のオーバーレイに割り当てており、独自長押しメニューは OS と競合する。`menuObject` なら選択イベント付きの実メニューが競合なしで手に入る。
2. ダブルタップは内部ページの「戻る」としてのみ使い、ルートページでは `shutDownPageContainer(1)` に繋ぐ。ルートページの終了ダイアログはレビューの必須関門で、ルートページに独自の終了 UI を置くことは明示的な落選理由。
3. スワイプを移動ジェスチャとして捨てる。プラットフォームが提供するのはイベント取得コンテナのスクロール境界 2 種だけ。リストコンテナでナビゲーションを組み、ハイライト移動はファームウェアに任せるか、クリック巡回にする。
4. 購読口 1 つ、イベント取得コンテナはページに 1 つ、という前提で設計する。これは回避すべき制約ではなくルーティングモデルそのもの。
5. プッシュも画面起動もない前提で組む。サーバ起点の更新はフォアグラウンド時のみ。ロックを跨いで残すべき状態は `localStorage` へ。
