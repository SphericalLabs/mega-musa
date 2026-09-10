/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { app, batchPlay, constants } from "./runtime";

// Check document roots, since a group's first child is not the document front.
// Unreadable stacks return false so the caller still attempts the move.
export function isFrontOfDocument(layerId: number): boolean {
  try {
    const rootLayers: any[] = Array.from(app.activeDocument?.layers || []);
    return rootLayers.length > 0 && Number(rootLayers[0]?.id) === Number(layerId);
  } catch (e: any) {
    console.log("[Mega Musa] could not read the layer stack:", e?.message || e);
    return false;
  }
}

export async function selectLayerById(layerId: number): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "select",
        _target: [{ _ref: "layer", _id: layerId }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
  if (!app.activeDocument?.activeLayers?.some((layer: any) => Number(layer.id) === Number(layerId))) {
    throw new Error("Photoshop did not activate the requested layer.");
  }
}

export async function renameActiveLayer(name: string): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        to: { _obj: "layer", name },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

// Clear independent locks, including state inherited during placement.
export function unlockResultLayer(layer: any): void {
  for (const property of [
    "allLocked",
    "pixelsLocked",
    "positionLocked",
    "transparentPixelsLocked",
  ]) {
    try {
      layer[property] = false;
    } catch (e: any) {
      console.log(`[Mega Musa] could not clear result layer ${property}:`, e?.message || e);
    }
  }
}

// Moving before the first root layer also extracts results from groups and artboards.
export async function bringResultToDocumentFront(layer: any): Promise<void> {
  unlockResultLayer(layer);
  const layerId = Number(layer?.id);
  if (isFrontOfDocument(layerId)) return;
  try {
    const frontLayer = Array.from(app.activeDocument?.layers || [])[0] as any;
    if (!frontLayer) throw new Error("Photoshop did not expose the document layer stack.");
    layer.move(frontLayer, constants.ElementPlacement.PLACEBEFORE);
    if (!isFrontOfDocument(layerId)) {
      throw new Error("Photoshop did not move the result to the document root.");
    }
  } catch (e: any) {
    // Stack position is secondary to preserving an already returned paid image.
    console.log("[Mega Musa] could not move the result to the top of the document:", e?.message || e);
  }
}

export async function deleteResultLayer(layerId: number): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "delete",
        _target: [{ _ref: "layer", _id: layerId }],
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

export function isLayerContainer(value: any): boolean {
  try {
    return !!value && value.layers != null && String(value.typename || "").toLowerCase() !== "document";
  } catch {
    return false;
  }
}

export function layersOf(owner: any): any[] {
  try {
    return Array.from(owner?.layers || []);
  } catch {
    return [];
  }
}

export function descendantLayers(owner: any): any[] {
  const result: any[] = [];
  for (const layer of layersOf(owner)) {
    result.push(layer);
    if (isLayerContainer(layer)) result.push(...descendantLayers(layer));
  }
  return result;
}

export function newDocumentLayers(document: any, existingLayerIds: Set<number>): any[] {
  return descendantLayers(document).filter((layer) => {
    const id = Number(layer?.id);
    return Number.isFinite(id) && !existingLayerIds.has(id);
  });
}
