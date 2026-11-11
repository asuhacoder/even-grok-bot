# Grok Bot × Even G2 実装計画（Phase A/B フレーミング）

## 完了の定義（検証可能な述語）

要件書「思考実験」の 9 フローを、実際の Grok Bot デスクトップアプリ（Mac mini）と G2（実機。未入手の部分は evenhub-simulator の automation API）で通し、各フローの期待画面遷移と Grok Bot 側の結果（送信された文、承認の選択、停止）が一致すること。加えて、Mac mini 再起動後に人手なしで復帰し、Grok Bot アプリ停止・通信断が G2 に表示されること。

## 調査で確定した事実

- Grok Bot は Electron 42 アプリ（com.anysphere.sand 0.71.2）。既定では AX ツリーが空。AXManualAccessibility を立ててもウィンドウが別 Space にあると AX から見えない。根拠は [decisions.tsv](decisions.tsv)。
- Electron fuse は `--remote-debugging-port` を塞いでいない。CDP で DOM を読めれば、マウス・フォーカス・クリップボードを使わずに読み取りと操作ができる。共用 Mac の衝突要件に最も強い。未検証（Grok Bot の再起動が必要）。
- Even Hub の制約は [even-hub.md](research/even-hub.md) を参照。要件と衝突する点は次のとおり。
  - 長押しは OS が先取りする。`menuObject`（最大 10 項目、各 32 バイト）で OS メニューとして出すのが正規の道。見た目の操作は「長押し＝メニュー」のまま。
  - 上下スワイプは自由なジェスチャではない。リスト選択の移動とテキストのスクロールはファームウェアが行い、アプリには端に達したときの `SCROLL_TOP/BOTTOM` だけが届く。一覧・選択肢はリストコンテナ、本文はテキストコンテナで表現すれば要件の操作感は保てる。
  - ルート画面のダブルタップは、Even Hub の審査基準上 `shutDownPageContainer(1)`（OS の終了確認ダイアログ）を呼ぶ必要がある。要件「待機でダブルタップ＝何もしない」と衝突する。
  - プッシュも画面の起こしもない。通知は G2 アプリが前面で動いている間だけ届く。これは要件の「常時起動・通常は無表示」と同じ前提。
  - 電話ロック中の常駐はベータ配布でのみ成立し、QR 開発版では検証できない。
  - 日本語グリフは間接証拠のみ（cn フォント経由）。実機で要確認。
  - マイクは 16kHz s16le mono の PCM が 100ms ごとに届く。Whisper にそのまま渡せる。

## 構成

- `relay/`（Mac mini、Node + TS）
  - `grok/` CDP アダプタ。Bot 一覧、会話、承認・質問カード、作業中状態の読み取りと、送信・選択・停止・Bot 切替の操作。DOM セレクタは 1 ファイルに集約し、アプリ更新時の修正点を 1 か所にする。
  - `state/` 全 Bot の正規化モデル（Bot, Message, PendingAction）。差分から通知イベントを作る。
  - `api/` Tailscale 内限定の HTTPS（`tailscale serve`）＋ WebSocket。トークン認証。
  - `asr/` whisper.cpp（ローカル、ja）。音声は外部に出さない。
  - launchd で自動起動。Grok Bot を CDP 付きで起動・監視する。
- `g2/`（Even Hub アプリ、Vite + TS）
  - 画面状態機械（reducer）。要件の画面×操作表をそのまま表データとして持つ。
  - 描画層。576×288、日本語の折り返しとページ分割。

## フェーズ（未知の大きい順）

1. スパイク A：CDP 接続と DOM 読み取り（Bot 一覧、会話、承認カード、作業中表示）と、送信・Bot 切替の操作。別 Bot を読むための画面切替が人の作業とどう衝突するかも観測する。
2. スパイク B：G2 での日本語表示（simulator → 実機）と、PCM → whisper.cpp の日本語精度・遅延。
3. relay の状態モデルと通知生成。録画した DOM スナップショットに対するテストで検証。
4. G2 の状態機械。要件の表から生成したテストで全セルを検証。
5. 結合。simulator の automation API で 9 フローを自動実行するスクリプトを作る。
6. 運用。launchd、再起動復帰、障害表示、各利用者の Even Hub アカウントでの Beta 配布。

厳密度は高め。承認操作は取り消せないため、承認・停止はテスト用 Bot でだけ実行し、実 Bot への承認系操作は事前確認なしに行わない。
