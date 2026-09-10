/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

export function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

// Fall back to local SHA-256 when UXP has no usable SubtleCrypto.
export function sha256Fallback(bytes: Uint8Array): string {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  const processBlock = (block: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      words[i] =
        ((block[p] || 0) << 24) |
        ((block[p + 1] || 0) << 16) |
        ((block[p + 2] || 0) << 8) |
        (block[p + 3] || 0);
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  };

  let offset = 0;
  while (offset + 64 <= bytes.length) {
    processBlock(bytes, offset);
    offset += 64;
  }
  const remainder = bytes.subarray(offset);
  const tail = new Uint8Array(remainder.length < 56 ? 64 : 128);
  tail.set(remainder);
  tail[remainder.length] = 0x80;
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000);
  const bitLengthLow = (bytes.length * 8) >>> 0;
  const end = tail.length;
  tail[end - 8] = bitLengthHigh >>> 24;
  tail[end - 7] = bitLengthHigh >>> 16;
  tail[end - 6] = bitLengthHigh >>> 8;
  tail[end - 5] = bitLengthHigh;
  tail[end - 4] = bitLengthLow >>> 24;
  tail[end - 3] = bitLengthLow >>> 16;
  tail[end - 2] = bitLengthLow >>> 8;
  tail[end - 1] = bitLengthLow;
  for (let p = 0; p < tail.length; p += 64) processBlock(tail, p);
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
}

export async function hashReferenceBytes(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (typeof subtle?.digest === "function") {
    try {
      const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
      return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    } catch {
      /* use the UXP-compatible fallback */
    }
  }
  return sha256Fallback(bytes);
}
