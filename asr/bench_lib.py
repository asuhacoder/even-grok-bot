#!/usr/bin/env python3
"""Benchmark helpers for the local ASR server.

  wrap <in.pcm> <out.wav> [pad_ms]   prepend a 44-byte RIFF header to 16 kHz mono s16le PCM
  text                               read an /inference JSON response on stdin, print its text field
  cer <ref> <hyp>                    print the character error rate between reference and hypothesis
"""
import json
import struct
import sys
import unicodedata

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2


def wrap(pcm_path, wav_path, pad_ms):
    pcm = open(pcm_path, "rb").read()
    pcm += b"\x00\x00" * (SAMPLE_RATE * pad_ms // 1000)
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * BYTES_PER_SAMPLE,
                          BYTES_PER_SAMPLE, 8 * BYTES_PER_SAMPLE)
    header += b"data" + struct.pack("<I", len(pcm))
    with open(wav_path, "wb") as out:
        out.write(header + pcm)


def normalize(text):
    text = unicodedata.normalize("NFKC", text)
    return "".join(ch for ch in text
                   if not ch.isspace() and unicodedata.category(ch)[0] not in "PS")


def edit_distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def main(argv):
    command = argv[1]
    if command == "wrap":
        pad_ms = int(argv[4]) if len(argv) > 4 else 0
        wrap(argv[2], argv[3], pad_ms)
    elif command == "text":
        print(json.load(sys.stdin).get("text", "").strip())
    elif command == "cer":
        ref, hyp = normalize(argv[2]), normalize(argv[3])
        rate = edit_distance(ref, hyp) / len(ref) if ref else 0.0
        print(f"{rate:.3f}")
    else:
        sys.exit(f"unknown command: {command}")
        return
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
