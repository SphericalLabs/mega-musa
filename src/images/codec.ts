/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { decode, encode } from "fast-png";
import { decode as jpegDecode, encode as jpegEncode } from "jpeg-js";
import { tagJpegAsSrgb, tagPngAsSrgb } from "./color-tags";
import { rgbaIsOpaque } from "./pixels";

export function encodePng(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  return tagPngAsSrgb(encode({ width, height, data, channels, depth: 8 }) as Uint8Array);
}

export function encodeJpeg(data: Uint8Array, width: number, height: number, quality = 90): Uint8Array {
  // Bundled jpeg-js 0.4.4 takes its CommonJS Buffer.from path in UXP. Supply that
  // operation only during this synchronous encode.
  const globals: any = globalThis as any;
  const hadBuffer = Object.prototype.hasOwnProperty.call(globals, "Buffer");
  const previousBuffer = globals.Buffer;
  if (typeof previousBuffer === "undefined") {
    globals.Buffer = {
      from(value: ArrayLike<number>): Uint8Array {
        return value instanceof Uint8Array ? value : Uint8Array.from(value);
      },
    };
  }
  try {
    const encoded = jpegEncode({ data, width, height }, quality).data;
    const bytes = encoded instanceof Uint8Array ? encoded : Uint8Array.from(encoded as ArrayLike<number>);
    return tagJpegAsSrgb(bytes);
  } finally {
    if (hadBuffer) globals.Buffer = previousBuffer;
    else delete globals.Buffer;
  }
}

export interface EncodedEmbeddedImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
  storageMode: "png-srgb" | "jpeg-90";
  lossy: boolean;
}

export function encodeEmbeddedImage(
  rgba: Uint8Array,
  width: number,
  height: number,
  reduceDocumentSize: boolean
): EncodedEmbeddedImage {
  if (reduceDocumentSize && rgbaIsOpaque(rgba)) {
    return {
      bytes: encodeJpeg(rgba, width, height, 90),
      mimeType: "image/jpeg",
      extension: "jpg",
      storageMode: "jpeg-90",
      lossy: true,
    };
  }
  return {
    bytes: encodePng(rgba, width, height, 4),
    mimeType: "image/png",
    extension: "png",
    storageMode: "png-srgb",
    lossy: false,
  };
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

export function decodeImage(mimeType: string, bytes: Uint8Array): DecodedImage {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return decodeJpeg(bytes);
  if (mimeType === "image/png") return decodePng(bytes);
  throw new Error(`Unsupported image type from model: ${mimeType} (supported: PNG, JPEG).`);
}
