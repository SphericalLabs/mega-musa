/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export function coverDimensions(sw: number, sh: number, dw: number, dh: number): { width: number; height: number } {
  const scale = Math.max(dw / sw, dh / sh);
  return { width: Math.max(dw, Math.round(sw * scale)), height: Math.max(dh, Math.round(sh * scale)) };
}

// Use the same integer resize and centered crop as Photoshop Image Size.
export function coverResampleRGBA(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const resized = coverDimensions(sw, sh, dw, dh);
  const stepX = sw / resized.width;
  const stepY = sh / resized.height;
  const sx0 = Math.floor((resized.width - dw) / 2) * stepX;
  const sy0 = Math.floor((resized.height - dh) / 2) * stepY;
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

// Bilinear interpolation of single-channel coverage values.
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

// Bilinear interpolation of packed RGBA channels.
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
