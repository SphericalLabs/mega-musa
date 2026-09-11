/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { getRecallSelectionBounds } from "../archive/schema";
import { type ArchivedGenerationGeometry } from "../archive/types";
import { type HostModalLease } from "../host-modal";
import { resampleGray } from "../images/resample";
import { getActiveArtboard } from "./artboards";
import { boundsFrom, selectionNeedsMask } from "./geometry";
import { app, batchPlay, getActiveDoc, imaging, runModal, withActiveDocument } from "./runtime";
import { type Bounds, type SelectionSnapshot } from "./types";

// Called only inside a modal operation with the intended document active.
export async function replaceRectSelection(b: Bounds): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: {
          _obj: "rectangle",
          top: { _unit: "pixelsUnit", _value: b.top },
          left: { _unit: "pixelsUnit", _value: b.left },
          bottom: { _unit: "pixelsUnit", _value: b.bottom },
          right: { _unit: "pixelsUnit", _value: b.right },
        },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

// These helpers run inside the caller's modal operation.
export async function clearSelection(): Promise<void> {
  await batchPlay([{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _enum: "ordinal", _value: "none" },
    _options: { dialogOptions: "dontDisplay" },
  }], {});
}

export async function replaceSelectionSnapshot(docId: number, snapshot: SelectionSnapshot | null): Promise<void> {
  if (!snapshot) return clearSelection();
  if (!selectionNeedsMask(snapshot)) return replaceRectSelection(snapshot.bounds);
  const width = snapshot.bounds.right - snapshot.bounds.left;
  const height = snapshot.bounds.bottom - snapshot.bounds.top;
  if (width < 1 || height < 1 || snapshot.data.length !== width * height) {
    throw new Error("The captured selection does not match its bounds.");
  }
  const imageData = await imaging.createImageDataFromBuffer(snapshot.data, {
    width, height, components: 1, componentSize: 8,
    colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2", chunky: true,
  });
  try {
    await imaging.putSelection({ documentID: docId, imageData, targetBounds: snapshot.bounds, replace: true });
  } finally {
    imageData.dispose();
  }
}

// Keep the selection that exists when placement starts, including edits made while
// generation was running. The job's captured selection is used only for clipping.
export async function readCurrentSelectionSnapshot(docId: number): Promise<SelectionSnapshot | null> {
  const bounds = await getSelectionBounds(docId);
  return bounds ? { bounds, data: await readSelectionMask(docId, bounds) } : null;
}

export async function withSelectionPreserved<T>(
  docId: number, run: () => Promise<T>, captured?: SelectionSnapshot | null
): Promise<T> {
  const snapshot = captured === undefined ? await readCurrentSelectionSnapshot(docId) : captured;
  let failed = false;
  try {
    await clearSelection();
    return await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await replaceSelectionSnapshot(docId, snapshot);
    } catch (error) {
      if (!failed) throw error;
      console.log("[Mega Musa] could not restore the selection after failed placement:", error);
    }
  }
}

export async function setRectSelection(
  b: Bounds,
  docId?: number,
  lease?: HostModalLease
): Promise<void> {
  await runModal(
    "snap selection",
    async () => withActiveDocument(docId ?? app.activeDocument?.id, () => replaceRectSelection(b)),
    lease
  );
}

export async function restoreArchivedSelection(
  docId: number,
  layerId: number,
  geometry: ArchivedGenerationGeometry | undefined
): Promise<void> {
  await runModal("restore original rectangle", async () => {
    // Recheck the recall target after waiting; the selection may have changed.
    const doc = getActiveDoc();
    const layers: any[] = Array.from(doc.activeLayers || []);
    if (doc.id !== docId || layers.length !== 1 || layers[0].id !== layerId) {
      throw new Error("Select the archived result layer again, then retry. The current selection is unchanged.");
    }
    if (doc.quickMaskMode) {
      throw new Error("Exit Quick Mask mode before restoring the rectangle. The current selection is unchanged.");
    }
    const artboard = await getActiveArtboard(doc, layerId);
    const bounds = getRecallSelectionBounds(geometry, Number(doc.width), Number(doc.height), artboard);
    await replaceRectSelection(bounds);
  });
}

export async function getSelectionBounds(docId?: number): Promise<Bounds | null> {
  // Avoid an unresolved Photoshop target when no document is open.
  if (!Number.isFinite(docId) && !app.activeDocument) return null;

  const documentTarget = Number.isFinite(docId)
    ? { _ref: "document", _id: docId }
    : { _ref: "document", _enum: "ordinal", _value: "targetEnum" };
  const result = await batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          documentTarget,
        ],
        // dontDisplay can still show the native "Get is not available" error dialog.
        _options: { dialogOptions: "silent" },
      },
    ],
    {}
  );
  const sel = result?.[0]?.selection;
  if (!sel) return null;
  const v = (u: any) => (typeof u === "number" ? u : u?._value ?? 0);
  return {
    left: Math.round(v(sel.left)),
    top: Math.round(v(sel.top)),
    right: Math.round(v(sel.right)),
    bottom: Math.round(v(sel.bottom)),
  };
}

// Photoshop may return only nonempty selection bounds. Align coverage within the full
// region and leave the rest unselected.
export async function readSelectionMask(docId: number, bounds: Bounds): Promise<Uint8Array> {
  const selection = await imaging.getSelection({
    documentID: docId,
    sourceBounds: bounds,
    componentSize: 8,
  });
  const imageData = selection.imageData;
  try {
    const sourceW = imageData.width;
    const sourceH = imageData.height;
    const components = imageData.components || 1;
    if (sourceW < 1 || sourceH < 1) throw new Error("Photoshop returned an empty selection snapshot.");

    const raw = await imageData.getData({ chunky: true });
    let gray: Uint8Array;
    if (components === 1) {
      gray = new Uint8Array(raw);
    } else {
      gray = new Uint8Array(sourceW * sourceH);
      for (let i = 0; i < gray.length; i++) gray[i] = raw[i * components];
    }

    const sourceBounds = boundsFrom(selection.sourceBounds) || bounds;
    const regionW = sourceBounds.right - sourceBounds.left;
    const regionH = sourceBounds.bottom - sourceBounds.top;
    const regionMask =
      sourceW === regionW && sourceH === regionH
        ? gray
        : resampleGray(gray, sourceW, sourceH, regionW, regionH);
    if (
      sourceBounds.left === bounds.left &&
      sourceBounds.top === bounds.top &&
      regionW === bounds.right - bounds.left &&
      regionH === bounds.bottom - bounds.top
    ) {
      return regionMask;
    }

    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const mask = new Uint8Array(width * height);
    const offsetX = sourceBounds.left - bounds.left;
    const offsetY = sourceBounds.top - bounds.top;
    for (let y = 0; y < regionH; y++) {
      const targetY = y + offsetY;
      if (targetY < 0 || targetY >= height) continue;
      for (let x = 0; x < regionW; x++) {
        const targetX = x + offsetX;
        if (targetX < 0 || targetX >= width) continue;
        mask[targetY * width + targetX] = regionMask[y * regionW + x];
      }
    }
    return mask;
  } finally {
    imageData.dispose();
  }
}

// Capture selection coverage before sending; failure must stop the paid request.
export async function captureSelection(
  docId: number,
  bounds: Bounds,
  lease?: HostModalLease
): Promise<SelectionSnapshot> {
  return await runModal(
    "capture selection",
    async () => {
      const data = await readSelectionMask(docId, bounds);
      if (!data.some((coverage) => coverage > 0)) {
        throw new Error("Photoshop returned an empty selection snapshot.");
      }
      return { bounds, data };
    },
    lease
  );
}
