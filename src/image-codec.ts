import { encode, decode } from "fast-png";
import { decode as jpegDecode } from "jpeg-js";

// --- base64 <-> bytes (UXP provides global btoa/atob) -----------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // stay within String.fromCharCode.apply arg limits
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += (String.fromCharCode as any).apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- PNG encode / decode ----------------------------------------------------

export function encodePng(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  return encode({ width, height, data, channels, depth: 8 }) as Uint8Array;
}

export interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const img = decode(bytes);
  const data = img.data instanceof Uint8Array ? img.data : Uint8Array.from(img.data as ArrayLike<number>);
  return { data, width: img.width, height: img.height, channels: img.channels };
}

export function decodeJpeg(bytes: Uint8Array): DecodedImage {
  const img = jpegDecode(bytes, { useTArray: true, formatAsRGBA: true });
  const data = img.data instanceof Uint8Array ? img.data : Uint8Array.from(img.data as ArrayLike<number>);
  return { data, width: img.width, height: img.height, channels: 4 };
}

// Decode a model image response (PNG or JPEG) to pixels.
export function decodeImage(mimeType: string, bytes: Uint8Array): DecodedImage {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return decodeJpeg(bytes);
  if (mimeType === "image/png") return decodePng(bytes);
  throw new Error(`Unsupported image type from model: ${mimeType} (supported: PNG, JPEG).`);
}

// --- pixel helpers ----------------------------------------------------------

// Normalize any channel count to packed RGBA.
export function toRGBA(src: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  if (channels === 4) return src;
  const count = width * height;
  const out = new Uint8Array(count * 4);
  for (let i = 0, p = 0, q = 0; i < count; i++) {
    if (channels === 1) {
      out[q++] = src[p]; out[q++] = src[p]; out[q++] = src[p]; out[q++] = 255;
    } else {
      out[q++] = src[p]; out[q++] = src[p + 1]; out[q++] = src[p + 2]; out[q++] = 255;
    }
    p += channels;
  }
  return out;
}

// Multiply a packed-RGBA image's alpha by a per-pixel coverage mask (0..255),
// so the image becomes transparent where the mask is 0 (clips to a selection).
export function applyAlphaMask(rgba: Uint8Array, mask: Uint8Array): void {
  const count = Math.min(Math.floor(rgba.length / 4), mask.length);
  for (let i = 0; i < count; i++) {
    rgba[i * 4 + 3] = Math.round((rgba[i * 4 + 3] * mask[i]) / 255);
  }
}

// Cover-fit (like CSS object-fit: cover): scale the source to fully cover
// dw×dh, then center-crop the overflow. Preserves aspect — no distortion.
export function coverResampleRGBA(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const scale = Math.max(dw / sw, dh / sh); // max => fully covers, overflow trimmed
  const winW = dw / scale; // visible source window (<= sw)
  const winH = dh / scale; // visible source window (<= sh)
  const sx0 = (sw - winW) / 2; // center anchor
  const sy0 = (sh - winH) / 2;
  const stepX = winW / dw;
  const stepY = winH / dh;
  for (let y = 0; y < dh; y++) {
    let sy = sy0 + (y + 0.5) * stepY - 0.5;
    sy = Math.min(sh - 1, Math.max(0, sy));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      let sx = sx0 + (x + 0.5) * stepX - 0.5;
      sx = Math.min(sw - 1, Math.max(0, sx));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return out;
}

// Bilinear resample of a single-channel (grayscale) image.
export function resampleGray(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
      const bot = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
      out[y * dw + x] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
  return out;
}

// Bilinear resample of packed RGBA from (sw,sh) to (dw,dh).
export function resampleRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return out;
}
