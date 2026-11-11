#!/bin/bash
# The benchmark corpus, in one place so bench.sh and verify.sh share one ground truth.
# Sourced, not executed.
ASR_DIR="${ASR_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
FIXTURES="$ASR_DIR/fixtures"
FFMPEG="${FFMPEG:-$(command -v ffmpeg || echo "$HOME/.local/bin/ffmpeg")}"

SENTENCES=(
  "開発PMに、今日のプルリクエストのレビュー状況を教えてと伝えて"
  "サンプルのデモ環境でログインできないので、原因を調べてSlackに共有して"
  "明日の15時から定例ミーティングを設定して、参加者に招待を送って"
  "音量を10パーセント上げて"
  "今日の天気を教えて"
)

audio_ms() {
  python3 - "$1" <<'PY'
import sys, wave
with wave.open(sys.argv[1]) as w:
    print(round(w.getnframes() * 1000 / w.getframerate()))
PY
}

# Produces per utterance: uN.wav (16 kHz mono s16le), uN.pcm (headerless), 
# uN.pcm.wav (PCM + 44-byte header, no padding), uN.pcm100.wav (PCM on 100 ms
# boundaries plus one flushed silent chunk, the shape the relay produces), uN.txt (ground truth).
make_fixtures() {
  mkdir -p "$FIXTURES"
  local index=0
  for sentence in "${SENTENCES[@]}"; do
    index=$((index + 1))
    local base="$FIXTURES/u$index"
    if [[ -e "$base.wav" ]]; then
      continue
    fi
    say -v Kyoko -o "$base.aiff" "$sentence"
    "$FFMPEG" -y -loglevel error -i "$base.aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$base.wav"
    "$FFMPEG" -y -loglevel error -i "$base.wav" -f s16le -acodec pcm_s16le "$base.pcm"
    python3 "$ASR_DIR/bench_lib.py" wrap "$base.pcm" "$base.pcm.wav" 0
    local pad_ms=$(( (100000 - $(audio_ms "$base.wav") % 100) % 100 + 100 ))
    python3 "$ASR_DIR/bench_lib.py" wrap "$base.pcm" "$base.pcm100.wav" "$pad_ms"
    printf '%s\n' "$sentence" > "$base.txt"
  done
}
