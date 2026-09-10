/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type HostModalLease } from "../host-modal";
import { SRGB_PROFILE } from "./document-state";
import { copyPixels } from "./pixel-data";
import { app, batchPlay, imaging, runModal } from "./runtime";

// Cover-fit through Photoshop's Image Size and read a centered crop. Propagate failures
// so the caller can use the JavaScript fallback.
export async function scaleViaPhotoshopInModal(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Promise<Uint8Array> {
  const scratch = await app.createDocument({
    width: srcW,
    height: srcH,
    resolution: 72,
    fill: "transparent",
    name: "mm-scale",
    profile: SRGB_PROFILE,
  });
  if (!scratch) throw new Error("Could not create scratch document for scaling.");
  try {
    const layerId = scratch.layers[0].id;
    const srcData = await imaging.createImageDataFromBuffer(rgba, {
      width: srcW,
      height: srcH,
      components: 4,
      componentSize: 8,
      colorSpace: "RGB",
      colorProfile: SRGB_PROFILE,
      chunky: true,
    });
    try {
      await imaging.putPixels({
        documentID: scratch.id,
        layerID: layerId,
        targetBounds: { left: 0, top: 0, right: srcW, bottom: srcH },
        imageData: srcData,
      });
    } finally {
      srcData.dispose();
    }

    const scale = Math.max(dstW / srcW, dstH / srcH);
    const targetW = Math.max(dstW, Math.ceil(srcW * scale));
    const targetH = Math.max(dstH, Math.ceil(srcH * scale));
    if (targetW !== srcW || targetH !== srcH) {
      const method = scale < 1 ? "bicubicSharper" : scale > 1 ? "bicubicSmoother" : "bicubic";
      await batchPlay(
        [
          {
            _obj: "imageSize",
            width: { _unit: "pixelsUnit", _value: targetW },
            height: { _unit: "pixelsUnit", _value: targetH },
            constrainProportions: true,
            interpolation: { _enum: "interpolationType", _value: method },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
    }

    const resizedW = Math.round(scratch.width);
    const resizedH = Math.round(scratch.height);
    if (resizedW < dstW || resizedH < dstH) {
      throw new Error("Photoshop's constrained resize did not cover the destination.");
    }
    const left = Math.floor((resizedW - dstW) / 2);
    const top = Math.floor((resizedH - dstH) / 2);

    const { data: raw, width: outputW, height: outputH, components: comps } = await copyPixels({
      documentID: scratch.id, sourceBounds: { left, top, right: left + dstW, bottom: top + dstH },
    });
    if (outputW !== dstW || outputH !== dstH) {
      throw new Error("Photoshop returned the wrong cover-fit dimensions.");
    }

    if (comps === 4) return new Uint8Array(raw);
    // Use opaque alpha when absent; selection coverage is applied during placement.
    const px = dstW * dstH;
    const rgbaOut = new Uint8Array(px * 4);
    for (let i = 0; i < px; i++) {
      rgbaOut[i * 4] = raw[i * comps];
      rgbaOut[i * 4 + 1] = raw[i * comps + 1];
      rgbaOut[i * 4 + 2] = raw[i * comps + 2];
      rgbaOut[i * 4 + 3] = 255;
    }
    return rgbaOut;
  } finally {
    try {
      await scratch.closeWithoutSaving();
    } catch {
      /* Scratch cleanup must not discard the scaled pixels. */
    }
  }
}

export async function scaleViaPhotoshop(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  lease?: HostModalLease
): Promise<Uint8Array> {
  // Scratch document creation and cleanup also require modal scope.
  return await runModal(
    "scale result",
    () => scaleViaPhotoshopInModal(rgba, srcW, srcH, dstW, dstH),
    lease
  );
}
