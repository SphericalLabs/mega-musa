/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { SRGB_PROFILE } from "./document-state";
import { deleteResultLayer, selectLayerById } from "./layers";
import { app, batchPlay, imaging } from "./runtime";
import { type SelectionSnapshot } from "./types";

export async function makeSelectionMask(): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "make",
        new: { _class: "channel" },
        at: { _ref: "channel", _enum: "channel", _value: "mask" },
        using: { _enum: "userMaskEnabled", _value: "revealSelection" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
  // Keep the default linked mask so later transforms move the result and mask together.
}

export async function loadLayerTransparencyAsSelection(layerId: number): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: {
          _ref: [
            { _ref: "channel", _enum: "channel", _value: "transparencyEnum" },
            { _ref: "layer", _id: layerId },
          ],
        },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { propagateErrorToDefaultHandler: false }
  );
}

// Placement can change the live selection. Rebuild captured coverage through a temporary
// layer's transparency before creating the result mask.
export async function makeLayerMaskFromSnapshot(
  docId: number,
  resultLayerId: number,
  snapshot: SelectionSnapshot
): Promise<void> {
  const width = snapshot.bounds.right - snapshot.bounds.left;
  const height = snapshot.bounds.bottom - snapshot.bounds.top;
  if (snapshot.data.length !== width * height) {
    throw new Error("The captured selection does not match its placement bounds.");
  }

  let maskSource: any | null = null;
  try {
    await batchPlay(
      [{ _obj: "make", _target: [{ _ref: "layer" }], _options: { dialogOptions: "dontDisplay" } }],
      { propagateErrorToDefaultHandler: false }
    );
    maskSource = app.activeDocument?.activeLayers?.[0] || null;
    if (!maskSource) throw new Error("Photoshop did not expose the temporary selection layer.");

    const rgba = new Uint8Array(snapshot.data.length * 4);
    for (let i = 0; i < snapshot.data.length; i++) {
      const offset = i * 4;
      rgba[offset] = 255;
      rgba[offset + 1] = 255;
      rgba[offset + 2] = 255;
      rgba[offset + 3] = snapshot.data[i];
    }
    const imageData = await imaging.createImageDataFromBuffer(rgba, {
      width,
      height,
      components: 4,
      componentSize: 8,
      colorSpace: "RGB",
      colorProfile: SRGB_PROFILE,
      chunky: true,
    });
    try {
      await imaging.putPixels({
        documentID: docId,
        layerID: maskSource.id,
        targetBounds: snapshot.bounds,
        imageData,
      });
    } finally {
      imageData.dispose();
    }

    await loadLayerTransparencyAsSelection(maskSource.id);
    await deleteResultLayer(maskSource.id);
    maskSource = null;
    await selectLayerById(resultLayerId);
    await makeSelectionMask();
    await restoreSelectionFromMask();
  } finally {
    if (maskSource) {
      try {
        await deleteResultLayer(maskSource.id);
      } catch {
        try {
          maskSource.visible = false;
        } catch {
          /* never leave the temporary white mask source visible */
        }
      }
    }
  }
}

export async function restoreSelectionFromMask(): Promise<void> {
  try {
    await batchPlay(
      [
        {
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: { _ref: "channel", _enum: "channel", _value: "mask" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
  } catch (e: any) {
    // The result and its mask are already safe; only the marching ants are lost.
    console.log("[Mega Musa] could not restore the selection after masking:", e?.message || e);
  }
}
