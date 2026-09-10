/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export function uint32Bytes(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0));
  const checksumInput = new Uint8Array(typeBytes.length + data.length);
  checksumInput.set(typeBytes);
  checksumInput.set(data, typeBytes.length);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(uint32Bytes(data.length), 0);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  chunk.set(uint32Bytes(crc32(checksumInput)), 8 + data.length);
  return chunk;
}

export function pngHasChunk(bytes: Uint8Array, wanted: string): boolean {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length =
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    if (offset + 12 + length > bytes.length) return false;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === wanted) return true;
    offset += 12 + length;
  }
  return false;
}

// Tag sRGB pixels without replacing an existing profile. Intent 0 is perceptual; this
// does not convert pixel colors.
export function tagPngAsSrgb(bytes: Uint8Array): Uint8Array {
  if (pngHasChunk(bytes, "sRGB") || pngHasChunk(bytes, "iCCP")) return bytes;
  const ihdrEnd = 8 + 12 + 13;
  if (bytes.length < ihdrEnd || !pngHasChunk(bytes, "IHDR")) {
    throw new Error("Could not tag an invalid PNG as sRGB.");
  }
  const srgb = pngChunk("sRGB", Uint8Array.of(0));
  const tagged = new Uint8Array(bytes.length + srgb.length);
  tagged.set(bytes.subarray(0, ihdrEnd));
  tagged.set(srgb, ihdrEnd);
  tagged.set(bytes.subarray(ihdrEnd), ihdrEnd + srgb.length);
  return tagged;
}

// Exif ColorSpace 1 declares the JPEG pixels as sRGB; this does not convert them.
export function tagJpegAsSrgb(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Could not tag an invalid JPEG as sRGB.");
  }
  const exif = Uint8Array.of(
    0xff, 0xe1, 0x00, 0x34,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x69, 0x87, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x01, 0xa0, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  );
  const tagged = new Uint8Array(bytes.length + exif.length);
  tagged.set(bytes.subarray(0, 2));
  tagged.set(exif, 2);
  tagged.set(bytes.subarray(2), 2 + exif.length);
  return tagged;
}
