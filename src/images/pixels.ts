/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export function rgbaIsOpaque(data: Uint8Array): boolean {
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) return false;
  }
  return true;
}

export function toRGBA(src: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  if (channels === 4) return src;
  const count = width * height;
  const out = new Uint8Array(count * 4);
  for (let i = 0, p = 0, q = 0; i < count; i++) {
    if (channels === 1 || channels === 2) {
      out[q++] = src[p]; out[q++] = src[p]; out[q++] = src[p];
      out[q++] = channels === 2 ? src[p + 1] : 255;
    } else {
      out[q++] = src[p]; out[q++] = src[p + 1]; out[q++] = src[p + 2]; out[q++] = 255;
    }
    p += channels;
  }
  return out;
}

// Multiply alpha by selection coverage (0..255), preserving existing transparency.
export function applyAlphaMask(rgba: Uint8Array, mask: Uint8Array): void {
  const count = Math.min(Math.floor(rgba.length / 4), mask.length);
  for (let i = 0; i < count; i++) {
    rgba[i * 4 + 3] = Math.round((rgba[i * 4 + 3] * mask[i]) / 255);
  }
}
