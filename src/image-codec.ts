/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { base64ToBytes, bytesToBase64 } from "./images/base64";
export { decodeImage, decodeJpeg, decodePng, encodeEmbeddedImage, encodeJpeg, encodePng } from "./images/codec";
export type { DecodedImage, EncodedEmbeddedImage } from "./images/codec";
export { tagJpegAsSrgb, tagPngAsSrgb } from "./images/color-tags";
export { applyAlphaMask, rgbaIsOpaque, toRGBA } from "./images/pixels";
export { coverResampleRGBA, resampleGray, resampleRGBA } from "./images/resample";
