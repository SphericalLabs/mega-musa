/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { selectionNeedsMask } from "./geometry";
import { selectLayerById } from "./layers";
import { batchPlay } from "./runtime";
import { clearSelection, replaceRectSelection, replaceSelectionSnapshot } from "./selection";
import { type Bounds, type PlacementClip, type SelectionSnapshot } from "./types";

// Both layer types use the complete image frame, including off-canvas pixels.
// A white canvas-sized mask can still hide overflow, so never judge its necessity
// from the visible canvas or a thumbnail alone.
export async function applyPlacementMask(
  docId: number,
  layerId: number,
  imageBounds: Bounds,
  destination: Bounds,
  selection: SelectionSnapshot | null
): Promise<PlacementClip> {
  if (selection && selectionNeedsMask(selection)) {
    await makeLayerMaskFromSnapshot(docId, layerId, selection);
    return "mask";
  }
  if (imageBounds.left !== destination.left || imageBounds.top !== destination.top ||
    imageBounds.right !== destination.right || imageBounds.bottom !== destination.bottom) {
    await makeLayerMaskFromBounds(layerId, destination);
    return "mask";
  }
  return "none";
}

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

export async function makeLayerMaskFromBounds(layerId: number, bounds: Bounds): Promise<void> {
  try {
    await selectLayerById(layerId);
    await replaceRectSelection(bounds);
    await makeSelectionMask();
  } finally {
    await clearSelection();
  }
}

// The placement scope owns preservation of the user's live selection. Use captured
// coverage directly, including feathering, without temporary pixel layers.
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

  try {
    await selectLayerById(resultLayerId);
    await replaceSelectionSnapshot(docId, snapshot);
    await makeSelectionMask();
  } finally {
    await clearSelection();
  }
}
