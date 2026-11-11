# ローカル日本語音声認識サーバ（whisper.cpp）

短い日本語音声コマンド（2〜30 秒、スマートグラスのマイク）を想定した、
127.0.0.1 だけで待ち受ける HTTP ASR サーバ。推論時に音声はマシン外へ出ない
（`asr/verify.sh` がサーバプロセスの保有ソケットを検査して証明する）。

| 項目 | 値 |
| --- | --- |
| 本体 | whisper.cpp v1.9.5（`vendor/whisper.cpp`、shallow clone） |
| 推論 | Metal（Metal + BLAS + CPU。flash attention 有効） |
| モデル | `ggml-large-v3-turbo-q5_0.bin`（574 MB、既定） |
| VAD | Silero v5.1.2（`--vad`、既定で有効） |
| 待ち受け | `http://127.0.0.1:8178/inference` |
| 言語 | `ja` 固定 |

## 構築手順

Homebrew も sudo も使わない。cmake は `uvx` 経由で取る（キャッシュは
リポジトリ内の `.cache/uv` に置き、リポジトリ外に残さない）。

```bash
# リポジトリのルートで実行する
export UV_CACHE_DIR=$PWD/.cache/uv

git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
cd vendor/whisper.cpp
uvx --from cmake cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
uvx --from cmake cmake --build build --config Release -j 15 --target whisper-server

sh models/download-ggml-model.sh large-v3-turbo-q5_0 ../models
sh models/download-ggml-model.sh large-v3-turbo-q8_0 ../models   # 比較用（任意）
sh models/download-vad-model.sh silero-v5.1.2 ../models
```

成果物は `vendor/whisper.cpp/build/bin/whisper-server` と
`vendor/models/*.bin`。`vendor/` は `.gitignore` 済みなので、clone し直したら
上の 4 コマンドを再実行する（所要 2 分程度）。

## 起動・停止

```bash
asr/start.sh          # 前面で起動。Ctrl-C で停止
asr/verify.sh         # 起動→文字起こし→外部ソケット無し→停止 を自動で検査
asr/bench.sh          # 計測（後述）。サーバの起動と停止も自分で行う
```

`start.sh` は環境変数で上書きできる。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `ASR_PORT` | `8178` | 待ち受けポート |
| `ASR_MODEL` | `ggml-large-v3-turbo-q5_0.bin` | `vendor/models/` 内のファイル名 |
| `ASR_THREADS` | `6` | CPU スレッド数（P コア 5 に合わせる） |
| `ASR_VAD` | `1` | `0` で VAD 無効 |
| `ASR_PROMPT` | `開発PM、サンプル、Slack` | デコーダの初期プロンプト。`""` で無効。既定値は例なので、自分の Bot 名やよく話す固有名詞に置き換える |
| `FFMPEG` | `PATH` 上の `ffmpeg` | `bench.sh` と `verify.sh` が音声を作るときに使う |

`asr/dev.evengrok.asr.plist` は launchd 用のテンプレートで、パスはプレースホルダである。`./ops/install.sh` がこのマシンのパスを埋めて登録する。テンプレートをそのまま `launchctl` に渡さない。

`KeepAlive` は `SuccessfulExit=false`（異常終了のみ再起動）。`start.sh` は
ポートが埋まっていれば終了コード 0 で抜けるので、二重起動で再起動ループにはならない。

## API

`POST /inference`、`multipart/form-data`。`file` は **16 kHz モノラル 16 bit PCM の WAV**。

```bash
curl -sS http://127.0.0.1:8178/inference \
  -F file=@asr/fixtures/u1.wav \
  -F language=ja \
  -F response_format=json \
  -F temperature=0.0 \
  -F temperature_inc=0.2
```

```json
{"text":"開発PMに、今日のプルリクエストのレビュー状況を教えてと伝えて、\n"}
```

`asr/fixtures/` は `.gitignore` 済みで、初回の `asr/bench.sh` か `asr/verify.sh` が
`say -v Kyoko` から生成する。手元に WAV が無いときはどちらかを一度走らせる。

| フィールド | 既定 | 備考 |
| --- | --- | --- |
| `file` | 必須 | WAV。16 kHz モノラル s16le |
| `language` | サーバ既定 `ja` | 省略可。付けたほうが確実 |
| `response_format` | `json` | `json` / `verbose_json` / `text`。`verbose_json` は単語単位の時刻も返す |
| `temperature` | `0.0` | 貪欲法。コマンド用途はこれで十分 |
| `temperature_inc` | サーバ既定 `0.2` | 失敗時の温度フォールバック幅 |
| `prompt` | サーバ既定（上表） | 固有名詞の補正に効く。リクエスト単位で上書き可 |
| `vad` | サーバ既定 `true` | 無音時の幻覚を抑える |

### リレーが PCM チャンクを送る場合

100 ms ごとの 16 kHz モノラル s16le（1 チャンク 3,200 バイト）を結合し、先頭に
44 バイトの RIFF ヘッダを付けるだけでそのまま `file` に渡せる。ヘッダだけの
変換は `asr/bench_lib.py wrap` がその実装例（`fixtures.sh` が `uN.pcm100.wav` を作る）。
末尾が 100 ms に満たない分は無音で埋めてよい。計測ではこの詰め物による遅延・精度の
劣化は見られなかった（3.20 節）。

## 実測値

環境: Apple M5 Pro / macOS 27.0 / 48 GB。`asr/bench.sh` で計測した。定型構成 = q5_0 + プロンプト + VAD 有効、
各発話 3 種の入力 × 3 回 = 9 サンプル。warm は中央値（最小–最大）。

リポジトリに残している結果ファイルは、プロンプト無しの q5_0 の 1 構成だけ
（`asr/bench-results/ggml-large-v3-turbo-q5_0.*`）。プロンプトを使った構成の結果ファイルは、
ファイル名のハッシュが計測時のプロンプトから作られていたため削除し、数値はこのページの表にだけ残している。
文の固有名詞は公開用に一般的な例へ置き換えてある。遅延、音声長、CER の数値は計測時のままなので、
公開した文から CER を計算し直しても一致しない。

| 発話 | 音声長 | cold | warm | CER |
| --- | --- | --- | --- | --- |
| u1 開発PMに… | 5.80 s | 347 ms | 329 ms (325–339) | 0.000 |
| u2 サンプルのデモ環境で… | 6.20 s | — | 347 ms (323–482) | 0.000 |
| u3 明日の15時から… | 6.18 s | — | 319 ms (302–503) | 0.000 |
| u4 音量を10パーセント上げて | 2.37 s | — | 267 ms (257–318) | 0.385 |
| u5 今日の天気を教えて | 1.90 s | — | 269 ms (262–300) | 0.000 |

- モデルのロード（プロセス起動→待ち受け開始）は約 1 秒。cold（起動後 1 回目）は
  Metal カーネル生成の分だけ warm より 10〜20 ms 遅い程度で、体感差はない。
- 遅延はほぼ音声長に比例し、2 秒で約 260 ms、6 秒で約 320 ms。30 秒でも 0.5 秒弱の見込み。
- 計測中は同じマシンで他プロセスがビルドしており、最大 500 ms の外れ値が出た。
  負荷が無いときの中央値は約 300 ms（u1〜u3）。

### 入力形式の差（u1）

| 入力 | 中央値 | 備考 |
| --- | --- | --- |
| `u1.wav`（ffmpeg 生成） | 330 ms | 基準 |
| `u1.pcm.wav`（生 PCM + 44 バイトヘッダ） | 329 ms | 差なし |
| `u1.pcm100.wav`（100 ms 境界 + 無音 1 チャンク） | 332 ms | 差なし |

### 構成ごとの比較（u1 / u2 / u3 の warm 中央値 ms、CER）

| 構成 | u1 | u2 | u3 | 判断 |
| --- | --- | --- | --- | --- |
| q5_0・プロンプト無し | 304 / 0.065 | 309 / 0.222 | 308 / 0.000 | 固有名詞が崩れる |
| **q5_0・プロンプト有り（既定）** | 329 / 0.000 | 347 / 0.000 | 319 / 0.000 | 採用 |
| q5_0・長いプロンプト | 335 / 0.000 | 433 / 0.000 | 368 / 0.000 | 精度同じで遅い |
| q8_0・プロンプト有り | 419 / 0.000 | 369 / 0.000 | 356 / 0.000 | 精度同じで遅い |
| q5_0・プロンプト有り・VAD 無効 | 305 / 0.000 | 319 / 0.000 | 318 / 0.000 | 20 ms 速いが無音で幻覚 |

### 無音 3 秒を投げた場合

| VAD | 出力 |
| --- | --- |
| 有効（既定） | 空文字 |
| 無効 | `ご視聴ありがとうございました` |

VAD は約 20 ms のコストでこの幻覚を防ぐので既定で有効にしている。
ボタンを押したが何も話さなかった場合に、偽のコマンドが下流へ流れるのを防ぐ。

## 正解と認識結果（q5_0 + プロンプト + VAD）

| # | 正解 | 出力 |
| --- | --- | --- |
| u1 | 開発PMに、今日のプルリクエストのレビュー状況を教えてと伝えて | 開発PMに、今日のプルリクエストのレビュー状況を教えてと伝えて、 |
| u2 | サンプルのデモ環境でログインできないので、原因を調べてSlackに共有して | サンプルのデモ環境でログインできないので、原因を調べてSlackに共有して、 |
| u3 | 明日の15時から定例ミーティングを設定して、参加者に招待を送って | 明日の15時から定例ミーティングを設定して、参加者に招待を送って、 |
| u4 | 音量を10パーセント上げて | 音量を10%上げて |
| u5 | 今日の天気を教えて | 今日の天気を教えて |

u4 の CER 0.385 は `10パーセント` → `10%` の表記差だけ。意味は一致している。

## 注意点

- **固有名詞はプロンプト依存。** プロンプト無しでは `開発` → `カイハツ`、
  `Slack` → `スラック` になる。既定プロンプトで両方直る。逆に、ドメイン語を
  含まない発話（u4・u5）に `開発` が混入する現象は起きていない。
- **数字・単位は正規化が必要。** `10パーセント` は `10%` で返る。下流で
  コマンド解釈するなら数値表現の正規化を入れる。
- **句読点は不安定。** 末尾に `、` が付いたり付かなかったりする。判定に使わない。
- **`GET /` は無い。** 死活監視は TCP の listen を見る（`lsof -nP -iTCP:8178`）。
- **launchd は `~` を展開しない。** plist 内のパスは絶対パス。ログのディレクトリは
  事前に作る必要がある。
- モデルの解凍・量子化は不要。`vendor/models/` に 2 ファイル（q5_0 と VAD）を
  置けば動く。q8_0 は比較用で、既定では使わない。
