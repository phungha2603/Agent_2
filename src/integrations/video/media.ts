import { deflateSync } from "node:zlib";

/**
 * WAV helpers for the voice track. The TTS returns LINEAR16 as a
 * complete WAV file; every line of a scene is one such file, and a scene's
 * audio is those lines joined with a short pause. Reading durations from the
 * header means no ffmpeg/ffprobe is needed.
 */
export interface Pcm {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

export function parseWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let fmt: Omit<Pcm, "data"> | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      // Some encoders write 0 or 0xFFFFFFFF for a streamed data size.
      const end = size === 0 || size === 0xffffffff ? buf.length : Math.min(buf.length, body + size);
      return { ...fmt, data: buf.subarray(body, end) };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export function wavDurationSec(p: Pcm): number {
  return p.data.length / (p.sampleRate * p.channels * (p.bitsPerSample / 8));
}

export function encodeWav(p: Pcm): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = p.channels * (p.bitsPerSample / 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + p.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(p.channels, 22);
  header.writeUInt32LE(p.sampleRate, 24);
  header.writeUInt32LE(p.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(p.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(p.data.length, 40);
  return Buffer.concat([header, p.data]);
}

export function silence(seconds: number, like: Omit<Pcm, "data">): Pcm {
  const bytes = Math.round(seconds * like.sampleRate) * like.channels * (like.bitsPerSample / 8);
  return { ...like, data: Buffer.alloc(bytes) };
}

/** Joins clips (same format) with `gapSec` of silence between them; returns where each clip starts. */
export function concatPcm(clips: Pcm[], gapSec: number): { pcm: Pcm; starts: number[] } {
  if (!clips.length) throw new Error("no audio to join");
  const fmt = { sampleRate: clips[0].sampleRate, channels: clips[0].channels, bitsPerSample: clips[0].bitsPerSample };
  for (const c of clips) {
    if (c.sampleRate !== fmt.sampleRate || c.channels !== fmt.channels || c.bitsPerSample !== fmt.bitsPerSample) {
      throw new Error("audio clips of one scene have different formats");
    }
  }
  const gap = silence(gapSec, fmt).data;
  const parts: Buffer[] = [];
  const starts: number[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    if (i > 0) {
      parts.push(gap);
      t += gapSec;
    }
    starts.push(t);
    parts.push(c.data);
    t += wavDurationSec(c);
  });
  return { pcm: { ...fmt, data: Buffer.concat(parts) }, starts };
}

/** A solid-colour PNG: the mock image provider's output, so a render works without any image API. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/**
 * Splits one spoken line into on-screen caption chunks of at most
 * `maxWords` words, timed in proportion to their length within the line's
 * real audio duration. Each line has its own TTS clip, so the line
 * boundaries are exact; only the split inside a line is estimated.
 */
export function captionChunks(text: string, start: number, duration: number, maxWords = 7): { start: number; end: number; text: string }[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const groups: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    // Break after punctuation, or when the chunk is full.
    if (cur.length >= maxWords || /[.,!?;:…]$/.test(w)) {
      groups.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) groups.push(cur.join(" "));
  const total = groups.reduce((n, g) => n + g.length, 0);
  let t = start;
  return groups.map((g) => {
    const d = (g.length / total) * duration;
    const out = { start: round(t), end: round(t + d), text: g };
    t += d;
    return out;
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
