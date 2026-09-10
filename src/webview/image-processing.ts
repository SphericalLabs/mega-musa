/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

import { type ResizeOptions } from "./protocol";

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The reference image could not be decoded."));
    image.src = dataUrl;
  });
}

export async function resizeImage(options: ResizeOptions & { base64: string; mimeType: string }) {

  const image = await loadImage(`data:${options.mimeType};base64,${options.base64}`);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("The reference image has no readable dimensions.");

  let resultBase64 = options.base64;
  let resultWidth = width;
  let resultHeight = height;
  if (
    Math.max(width, height) > options.maxEdge ||
    options.forcePng ||
    options.normalizeSrgb ||
    options.compactStorage
  ) {
    const scale = Math.min(1, options.maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    resultWidth = targetWidth;
    resultHeight = targetHeight;
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    // Request sRGB when supported; older WebViews may reject the options object.
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d", { colorSpace: "srgb" });
    } catch {
    }
    if (!context) context = canvas.getContext("2d");
    if (!context) throw new Error("The image processor could not create a canvas.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    let outputType = options.forcePng ? "image/png" : options.mimeType;
    let outputQuality = 0.95;
    if (options.compactStorage) {
      const pixels = context.getImageData(0, 0, targetWidth, targetHeight).data;
      let opaque = true;
      for (let pixel = 3; pixel < pixels.length; pixel += 4) {
        if (pixels[pixel] !== 255) {
          opaque = false;
          break;
        }
      }
      outputType = opaque ? "image/jpeg" : "image/png";
      outputQuality = 0.9;
    }
    // Compact archives use PNG for transparency and JPEG 90 for opaque pixels.
    const dataUrl = canvas.toDataURL(outputType, outputQuality);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("The resized image could not be encoded.");
    resultBase64 = dataUrl.slice(comma + 1);
  }

  return { base64: resultBase64, width: resultWidth, height: resultHeight, sourceWidth: width, sourceHeight: height };
}
