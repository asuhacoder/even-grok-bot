# Grok Bot × Even G2

Grok Bot の全 Bot を、Even G2 と R1 リングだけで読み・答え・承認・音声指示できるようにする。

**Even Hub では一般公開していない。** 公式のストア掲載も、共有の中継もない。使う人がそれぞれ自分で G2 アプリをビルドし、自分の Even Hub 開発者アカウントへ Beta（非公開テスト）ビルドとしてアップロードし、自分の Mac で動かす自分の中継へ向ける。手順は「[自分の Mac で立ち上げる](#自分の-mac-で立ち上げる)」と「[自分の Even Hub アカウントへ Beta として入れる](#自分の-even-hub-アカウントへ-beta-として入れる)」にある。

## 構成

| 部品 | 場所 | 役割 |
| --- | --- | --- |
| 中継 | `relay/` | Mac 上の Grok Bot デスクトップアプリを CDP（127.0.0.1:9447）で読み書きする。G2 には認証付き WebSocket を出す |
| 音声認識 | `asr/` | whisper.cpp（large-v3-turbo q5_0、ja）。127.0.0.1:8178。音声は Mac の外に出ない |
| G2 アプリ | `g2/` | Even Hub アプリ。画面遷移は `g2/src/machine.ts` の状態機械、表示は `view.ts`、SDK 呼び出しは `glasses.ts` |
| 契約 | `shared/protocol.ts` | 中継と G2 の間のメッセージ |
| 運用 | `ops/` | launchd 登録と、G2 への読み込み用 QR |

中継は loopback でしか待ち受けない。外への公開は、自分の Tailscale で `ops/install.sh` が張る経路だけである。リポジトリに自分のホスト名や tailnet の住所は入っていない。

## 自分の Mac で立ち上げる

必要なもの：

- macOS（launchd、`open`、`ioreg` を使う。Apple Silicon で動作を確認している）
- Grok Bot デスクトップアプリ。`~/Applications` か `/Applications` に置く。別の場所なら `GROK_APP` にパスを入れる
- Node.js 24 以上と pnpm（`package.json` の `packageManager` に書いた版で動く）
- python3、git
- Tailscale。Mac と電話を同じ tailnet に入れる。`tailscale` コマンドが `PATH` に無いときは `TAILSCALE_BIN` にパスを入れる
- Even Realities G2 と Even Realities アプリ（電話）
- 音声認識を使うなら whisper.cpp のビルドに cmake（`uvx` 経由でもよい）

音声認識のサーバは先にビルドしておく。手順は [asr/README.md](asr/README.md) の「構築手順」にある。`vendor/` に whisper.cpp とモデルが入る。

```bash
pnpm install && (cd g2 && pnpm install)
./ops/install.sh
./ops/qr.sh
```

`install.sh` は再実行してよい。launchd の plist へ、このマシンの Node とリポジトリのパスを書き、中継と音声認識を登録する。続けて Tailscale の HTTPS パス `/evengrok` と、生 TCP の転送を張る。

既定のポートは次のとおり。変えるときは、Tailscale の転送先と中継の待ち受けが同じポートを指すようにする。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `RELAY_PORT` | `8791` | 中継の HTTPS 側。Tailscale の HTTPS がここへ転送する |
| `RELAY_RAW_PORT` | `8793` | 生 TCP の転送先 |
| `TAILSCALE_TCP_PORT` | `8792` | 電話から届く生 TCP の待ち受け |
| `RELAY_RAW_PROXY_PROTOCOL` | `2` | `1`、`2`、または `off`。`install.sh` が既定で `2` を書く。未設定の手起動はヘッダを要求しない |
| `TAILSCALE_BIN` | `tailscale` | `whois` に使う実行ファイル |
| `TAILSCALE_SOCKET` | `$HOME/.tailscale/tailscaled.sock` があればそれ、無ければ空 | 空なら `tailscale` の既定ソケット。ユーザー空間の tailscaled を使うときだけ要る |
| `ASR_PORT` | `8178` | 音声認識 |
| `RELAY_OWNER_LOGIN` | 空 | 空ならすべての経路でトークンが要る |
| `GROK_APP` | `~/Applications/Grok Bot.app`、無ければ `/Applications/Grok Bot.app` | 中継が起動する Grok Bot |
| `GROK_CDP_PORT` | `9447` | Grok Bot の DevTools ポート（127.0.0.1） |
| `RELAY_STATE_DIR` | `relay/state` | トークンと保存した画面 HTML の置き場所 |

自分の Tailscale ログインを入れてから登録し直すと、HTTPS と生 TCP の両方でそのログインはトークンなしになる。

```bash
RELAY_OWNER_LOGIN='you@example.com' ./ops/install.sh
```

生 TCP は `tailscale serve --tcp=8792 --proxy-protocol=2 tcp://127.0.0.1:8793` で公開する。`install.sh` と `qr.sh` は、既にある tcp 転送を外してからこの形で張り直す。version 1 にするときは、登録の前に `RELAY_RAW_PROXY_PROTOCOL=1` を置く。`off` にすると、ヘッダのない今までの転送に戻る。

```bash
tailscale serve --tcp=8792 off
tailscale serve --bg --tcp=8792 --proxy-protocol=2 tcp://127.0.0.1:8793
```

中継は生 TCP の `Tailscale-User-Login` を読まない。読むのは PROXY ヘッダの送信元アドレスで、`tailscale whois --json` の `UserProfile.LoginName` と比べる。一致すればトークンは要らない。一致しないとき、whois が失敗したとき、プロトコルを `off` にしたときは、トークンが要る。プロトコルが `1` か `2` のとき、ヘッダが無い接続は拒否する。

PROXY ヘッダを信じてよいのは、この待ち受けが 127.0.0.1 だけで、接続してくるのが tailscaled だけだからである。同じ Mac の別プロセスはヘッダを偽造できる。

初回起動で `relay/state/token` ができる。このファイルはコミットしない。`qr.sh` は tailnet の IPv4 をその場で読み、開発用 QR を出す。QR の URL にトークンが入るので、自分の画面だけで表示する。標準出力に出る WebSocket URL にトークンは含まれない。Even Realities アプリで QR を読むと、アプリは中継から読み込まれ、トークンが端末に保存される。

Grok Bot が動いていなければ、中継が `--remote-debugging-port=9447` 付きで起動する。人が手でポートなしの Grok Bot を起動していた場合は、Mac が 2 分間操作されなかったときに限り、起動し直す（最大 10 分に 1 回）。

ログは `~/Library/Logs/even-grok/` にある。

配布版を電話に入れるときは、パッケージを作る前に `g2/app.json` の `package_id` を自分の ID へ変える。`network.whitelist` へ、自分の中継のオリジンを 1 件ずつ足す。この 2 つの変更はコミットしない。空の whitelist のままでは、Even アプリが通信を WebView の外へ出さない。

ワイルドカード、`*.ts.net`、IP の範囲、スキームだけの指定は使えない。whitelist はオリジンの完全な文字列だけを取る。WebSocket を `https` のオリジンで書くか `wss` で書くかは文書が決めていないので、使うスキームを両方入れる。生 TCP を使うなら `http://<tailnet-ipv4>:<port>` と `ws://<tailnet-ipv4>:<port>` の両方が要る。診断の POST は `http` 側へ行く。

```bash
pnpm --dir g2 run pack
```

`VITE_RELAY_URLS` や `VITE_RELAY_TOKEN` が付いていると、pack は失敗する。接続先とトークンはパッケージに入らない。

電話のページで中継 URL とトークンを保存する。開発用 QR で中継からページを開いたときは、ページと同じオリジンへも接続する。URL を複数書くときはカンマで区切る。アプリは wss を先に試し、開かなければ次へ進む。MagicDNS 名への wss は、実機の WebView から中継のログに届いていない。届いた実績があるのは tailnet IPv4 への ws である。その URL を候補に足す。

診断は、採用した各候補の `/diag` へ POST する。生 TCP のポートも同じ `/diag` を受け、本文をログへ出す。トークンが無いか違うとき、中継ログは `client denied (token)` になる。hello が制限時間までに来ないと `client denied (auth timeout)` になる。成功時は `client connected (token)`、`client connected (tailnet identity)`、または `client connected (tailnet identity via proxy)` になる。最後の1つは、生 TCP の PROXY ヘッダから whois で所有者と分かったときである。ログにトークンの値は出ない。

## 操作と、Even Hub の制約への対応

| 要件 | 実装 |
| --- | --- |
| タップ＝決定 | そのまま |
| ダブルタップ＝戻る | そのまま。待機画面だけは OS の終了確認を出す（審査の必須要件。取り消せば終了しない） |
| 長押し＝メニュー | アプリは長押しを受け取れないため、OS のメニュー（`menuObject`）に画面ごとの項目を出す。見た目の操作は同じ |
| 上下スワイプ＝移動 | 一覧と選択肢はファームウェアが強調表示を動かす。会話と承認内容は 1 画面ずつページ送りする |
| 通知 | G2 アプリが前面で動いている間だけ届く。Even Hub にはプッシュも画面の起動手段もない |

文字は実機フォントの字幅（`@evenrealities/pretext`）で折り返し、1 ページ＝1 画面にしている。Even Hub の上限は実測した。テキストは 999 バイト、一覧の 1 行は 63 バイト、一覧は 20 行まで（`g2/sim/exp.ts`）。実際の会話 27.9 万文字のうち、G2 のフォントにない文字は記号 7 種だけで、それらは置き換える。

## Mac を人が使っているとき

- マウス、キーボード、クリップボードは使わない。すべて Grok Bot の画面内部から操作する。
- 通知の監視はサイドバーを読むだけで、表示中の Bot は切り替えない。
- G2 で別の Bot を開く・送る・答える・過去を読むときと、G2 で開いている Bot に新着があったとき（最短 4 秒おき）に、デスクトップの表示 Bot が約 0.1 秒切り替わる。切り替えは 1 本の列で順番に処理し、同時には起きない。
- 切り替えの間に人が別の Bot を選んだら、元には戻さず、人の選択を優先する。
- 送信ボタンを押す直前に、表示中の Bot が宛先と同じかを同じ処理の中で確かめる。違えば送らない。
- その Bot の入力欄に Mac 側で書きかけの文があるときは、上書きせず送信を断る。送信に失敗したときは、中継が入れた文だけを消す。
- G2 で Bot を開くと、Grok Bot 側でも既読になる（アプリの仕様）。G2 の「最初の未読」は、G2 で実際に表示したページを基準にする。

## 障害時の表示

G2 の待機画面に理由を 1 行出す。中継との接続断、Grok Bot の停止や未サインイン、音声認識の停止を区別する。メニューの「接続状態を表示」で内訳を見られる。

## 自分の Even Hub アカウントへ Beta として入れる

このアプリは Even Hub で一般公開せず、審査にも出さない。各自が自分の開発者アカウントで、自分だけ（または自分が招いたテスター）が使う Beta ビルドとして入れる。電話をロックしても動き続けるのは Beta ビルドだけで、QR の開発版はロックで止まる。

Web 配信と Even Hub へのアップロードは別工程である。通常の `build` は、中継が配る Web 用である。配布用は `pnpm --dir g2 run pack` を使う。接続先はパックせず、上の手順で whitelist と電話の設定に置く。

1. [Even Hub](https://hub.evenrealities.com/) に自分の開発者アカウントでログインし、自分のプロジェクトを作る（2 回目以降は既存のものを使う）。
2. 上の手順どおり、`g2/app.json` の `package_id` を自分の ID に、`network.whitelist` を自分の中継のオリジンにしてから `pnpm --dir g2 run pack` を実行する。この変更はコミットしない。
3. 生成したパッケージを自分のプロジェクトの「Upload a build」から登録し、「Add build」で確定する。
4. 対象ビルドを Beta へ昇格し、ポータルで対象バージョンが Published（Beta）になったことを確認する。
5. 電話の Even Realities アプリから Beta 版を入れ、電話のページで自分の中継 URL とトークンを保存する。

中継のヘルスチェックだけでは配布版の接続確認にならない。

## 検証

```bash
pnpm test                       # 状態機械（思考実験 9 本を含む）、通知差分、正規化、レイアウト
pnpm run typecheck
node g2/sim/drive.mjs <出力先> click down click shot:x   # シミュレータを自動操作して画面を保存
```

判断の記録は [docs/decisions.tsv](docs/decisions.tsv) にある。作者の環境で計測した記録なので、Bot 名や時刻は例として読む。

## 未検証・既知の制約

- 承認と選択肢回答のボタン操作は、承認待ちのカードが手元になく、実カードでは試していない。ボタンが見つからないときは押さずに失敗を返し、画面の HTML を `relay/state/fixtures/` に保存する。
- Grok Bot 0.71.2 には Bot 自身の作業を止めるボタンがない。「停止」は、画面に停止ボタン（会話内のクラウドエージェント、コンピューター操作）があるときだけ効き、ないときは G2 にそう表示する。
- 電話ロック中の常駐は、Even Hub のベータ配布でしか成立しない。QR の開発版はロックで止まる。
- MagicDNS 名への wss は、実機の WebView から中継へ届いた記録がない。配布版では tailnet IPv4 の ws を候補に足す。whitelist にその `ws` と `http` のオリジンが無いと、Even アプリはリクエストを外へ出さない。
- Grok Bot の更新で画面構成が変わると動かなくなる。読み書きの前提は `relay/src/grok/page.js` に集めてある。

## ライセンス

MIT。[LICENSE](LICENSE) を参照。依存ソフトウェアと、配布用パッケージに含まれるもののライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にある。Grok Bot、Even Realities、Tailscale とは関係のない個人のプロジェクトである。
