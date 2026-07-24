import { mkdir, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../config";

const EXT_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

// Strict alphabet check: Buffer.from(..., "base64") silently ignores invalid
// characters, so malformed payloads would otherwise decode to garbage bytes.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageBudget {
  spent: number;
}

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
}

function getArtifactsDir(): string {
  return join(getConfigDir(), "artifacts");
}

function timestampPrefix(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

export function guessExtFromMagic(bytes: Uint8Array): string {
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  if (sig.startsWith("\x89PNG")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  return "png";
}

export async function materializeInlineImage(
  mimeType: string,
  base64Data: string,
  budget?: ImageBudget,
): Promise<string> {
  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const normalized = base64Data.replace(/\s+/g, "");
  if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("inline image data is not valid base64");
  }
  // Validate decoded size from the base64 length *before* allocating a Buffer, so a
  // malicious or broken upstream cannot force a large allocation / OOM.
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedBytes = (normalized.length / 4) * 3 - padding;
  if (decodedBytes === 0) throw new Error("inline image data is empty after base64 decode");
  if (decodedBytes > MAX_DECODED_BYTES_PER_IMAGE) throw new Error(`inline image exceeds ${MAX_DECODED_BYTES_PER_IMAGE} byte per-image cap`);
  if (budget && budget.spent + decodedBytes > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`inline image response exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response cap`);
  }

  const buf = Buffer.from(normalized, "base64");
  if (budget) budget.spent += buf.length;

  // Sniff actual format from decoded bytes rather than trusting the declared mimeType.
  const ext = guessExtFromMagic(buf);
  const filePath = join(dir, `img-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`);
  await writeFile(filePath, buf, { mode: 0o600 });
  return filePath;
}

export async function downloadImageToArtifact(
  url: string,
  budget?: ImageBudget,
  signal?: AbortSignal,
): Promise<string> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!m) throw new Error("data URL is not a valid base64 image");
    return materializeInlineImage(m[1], m[2], budget);
  }

  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error("image download failed: " + resp.status);

  // Stream the body with a hard byte cap so a missing/lying Content-Length or a
  // compromised CDN URL cannot exhaust memory before the size check runs.
  if (!resp.body) throw new Error("image download returned no body");
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error(`image download exceeds ${MAX_DOWNLOAD_BYTES} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }

  if (budget && budget.spent + bytes.length > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`image download exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response budget`);
  }

  const ext = guessExtFromMagic(bytes);
  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (budget) budget.spent += bytes.length;

  const filePath = join(dir, `dl-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return filePath;
}

const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB

export interface VideoBudget {
  spent: number;
}

export function createVideoBudget(): VideoBudget {
  return { spent: 0 };
}

export function guessVideoExtFromMagic(bytes: Uint8Array): string {
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  // MP4/QuickTime/MOV: bytes 4-7 == "ftyp" (ISO BMFF)
  if (sig.slice(4, 8) === "ftyp") return "mp4";
  // WebM/Matroska: \x1a\x45\xdf\xa3
  if (sig.startsWith("\x1a\x45\xdf\xa3")) return "webm";
  return "mp4";
}

/**
 * Download a video from a URL to an artifact file with a 200 MiB hard cap, streaming the body
 * to avoid buffering the entire file. Format is sniffed from magic bytes.
 */
export async function downloadVideoToArtifact(
  url: string,
  budget?: VideoBudget,
  signal?: AbortSignal,
): Promise<string> {
  // For data: URLs, handle inline (unlikely for video but keep parity)
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    const meta = url.slice(0, commaIdx);
    const data = url.slice(commaIdx + 1);
    const isBase64 = meta.includes(";base64");
    if (!isBase64) throw new Error("non-base64 data URI for video is not supported");
    const buf = Buffer.from(data, "base64");
    if (budget) budget.spent += buf.byteLength;
    if (buf.byteLength > MAX_VIDEO_DOWNLOAD_BYTES) throw new Error("video data URI exceeds size cap");
    const ext = guessVideoExtFromMagic(buf);
    const dir = getArtifactsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `vid-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`;
    const dest = join(dir, name);
    await writeFile(dest, buf, { mode: 0o600 });
    return dest;
  }

  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error("video download failed: HTTP " + resp.status);

  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("video download returned no body");

  // Peek the first chunk for magic-byte sniffing before opening the file.
  const first = await reader.read();
  if (first.done || !first.value) {
    throw new Error("video download returned empty body");
  }
  const ext = guessVideoExtFromMagic(first.value);
  const name = `vid-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`;
  const dest = join(dir, name);
  const fh = await open(dest, "w", 0o600);
  let totalBytes = first.value.byteLength;
  if (budget) budget.spent += totalBytes;
  if (totalBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
    reader.releaseLock();
    await fh.close();
    await unlink(dest).catch(() => {});
    throw new Error("video download exceeds size cap");
  }
  let success = false;
  try {
    await fh.writeFile(first.value);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (budget) budget.spent += value.byteLength;
      if (totalBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
        throw new Error("video download exceeds size cap");
      }
      await fh.writeFile(value);
    }
    success = true;
  } finally {
    reader.releaseLock();
    await fh.close();
    if (!success) await unlink(dest).catch(() => {});
  }
  return dest;
}
