// G2 microphone PCM (16 kHz, s16le, mono) -> local whisper.cpp server -> text.

export const SAMPLE_RATE = 16000;
/** 90 s of audio; longer recordings are cut, not rejected. */
const MAX_BYTES = SAMPLE_RATE * 2 * 90;

export function wav(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export class Recording {
  private chunks: Uint8Array[] = [];
  private size = 0;

  push(chunk: Uint8Array): void {
    if (this.size >= MAX_BYTES) return;
    const take = chunk.subarray(0, MAX_BYTES - this.size);
    this.chunks.push(take);
    this.size += take.length;
  }

  pcm(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  get seconds(): number {
    return this.size / (SAMPLE_RATE * 2);
  }
}

/** Whisper hallucinates stock phrases on silence; treat those as nothing heard. */
const SILENCE = /^(ご視聴ありがとうございました|ありがとうございました|字幕.*|\[.*\]|（.*）|\(.*\))[。．.!！]*$/;

export async function transcribe(baseUrl: string, pcm: Uint8Array): Promise<string> {
  if (pcm.length < SAMPLE_RATE * 2 * 0.3) return '';
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'g2.wav');
  form.append('response_format', 'json');
  form.append('language', 'ja');
  form.append('temperature', '0');
  const res = await fetch(`${baseUrl}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`音声認識エラー ${res.status}`);
  const text = String(((await res.json()) as { text?: string }).text ?? '').replace(/\s+/g, ' ').trim();
  return SILENCE.test(text) ? '' : text;
}

export async function asrUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}
