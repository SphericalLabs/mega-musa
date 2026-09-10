/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { boundsFrom } from "./geometry";
import { descendantLayers } from "./layers";
import { batchPlay } from "./runtime";
import { type ActiveArtboard, type Bounds } from "./types";

export async function exactArtboardBounds(docId: number, artboard: any): Promise<Bounds | null> {
  try {
    const result = await batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _ref: "layer", _id: artboard.id },
            { _ref: "document", _id: docId },
          ],
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
    const exact = boundsFrom(result?.[0]?.artboard?.artboardRect);
    if (exact) return exact;
  } catch (e: any) {
    console.log("[Mega Musa] could not read exact artboard bounds:", e?.message || e);
  }

  // Fall back to DOM bounds when older descriptors omit artboardRect.
  return boundsFrom(artboard.boundsNoEffects) || boundsFrom(artboard.bounds);
}

// Use the selected layer's artboard or the sole artboard. Reject ambiguous targets to
// avoid generating across the whole spread.
export async function getActiveArtboard(doc: any, anchorLayerId?: number | null): Promise<ActiveArtboard | null> {
  const artboards: any[] = Array.from(doc.artboards || []);
  if (!artboards.length) return null;

  const byId = new Map<number, any>(artboards.map((artboard) => [artboard.id, artboard]));
  let active: any | null = null;
  const frozenAnchor = Number.isFinite(anchorLayerId)
    ? descendantLayers(doc).find((layer) => Number(layer?.id) === Number(anchorLayerId))
    : null;
  const activeLayers: any[] = frozenAnchor ? [frozenAnchor] : Array.from(doc.activeLayers || []);
  for (const selected of activeLayers) {
    let layer: any | null = selected;
    while (layer) {
      const artboard = byId.get(layer.id);
      if (artboard) {
        active = artboard;
        break;
      }
      layer = layer.parent;
    }
    if (active) break;
  }

  if (!active && artboards.length === 1) active = artboards[0];
  if (!active) {
    throw new Error("Select an artboard, or a layer inside one, then try again.");
  }

  const bounds = await exactArtboardBounds(doc.id, active);
  if (!bounds) throw new Error(`Could not read the bounds of artboard “${active.name || "Artboard"}”.`);
  return { id: active.id, name: active.name || "Artboard", bounds };
}
