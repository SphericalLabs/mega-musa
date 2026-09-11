/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { encodePng } from "../images/codec";
import { modelSpec } from "../models/catalog";
import { outputFrame } from "../models/geometry";
import { getActiveArtboard } from "../photoshop/artboards";
import { documentBlocker, getDocumentState } from "../photoshop/document-state";
import { expandRegionToRatio, intersectBounds } from "../photoshop/geometry";
import { readRegionInModal } from "../photoshop/pixels";
import { app, runModal, withActiveDocument } from "../photoshop/runtime";
import { getSelectionBounds, readSelectionMask, replaceRectSelection } from "../photoshop/selection";
import { type GenerationCanvasInput } from "./types";

export async function captureGenerationCanvas(
  docId: number,
  anchorLayerId: number | null,
  model: string,
  resolution: string,
  includeSelection: boolean
): Promise<GenerationCanvasInput> {
  return runModal("freeze generation input", () => withActiveDocument(docId, async () => {
    const doc = app.activeDocument;
    const documentState = getDocumentState(doc);
    const blocker = documentBlocker(documentState);
    if (blocker) throw new Error(`${blocker.message} ${blocker.instruction}`);
    const docWidth = Number(doc.width);
    const docHeight = Number(doc.height);
    const activeArtboard = await getActiveArtboard(doc, anchorLayerId);
    const target = activeArtboard?.bounds || { left: 0, top: 0, right: docWidth, bottom: docHeight };
    const rawSelection = await getSelectionBounds(docId);
    const region = rawSelection ? intersectBounds(rawSelection, target) : { ...target };
    if (!region) throw new Error("The selection does not overlap the target canvas or active artboard.");

    const selectionSnapshot = rawSelection ? { bounds: { ...region }, data: await readSelectionMask(docId, region) } : null;
    if (selectionSnapshot && !selectionSnapshot.data.some(coverage => coverage > 0)) {
      throw new Error("Photoshop returned an empty selection snapshot.");
    }
    const spec = modelSpec(model);
    const frame = outputFrame(spec, resolution, region.right - region.left, region.bottom - region.top);
    const inputBounds = expandRegionToRatio(region, frame.ratio);
    const tierLongEdge: Record<string, number> = { "512px": 512, "1K": 1024, "2K": 2048, "4K": 4096 };
    const outputLongEdge = frame.width && frame.height
      ? Math.max(frame.width, frame.height)
      : tierLongEdge[resolution] || 1024;
    const requestMaxEdge = Math.min(spec.inputs.maxEdge, Math.max(2048, outputLongEdge));
    let basePng: Uint8Array | undefined;
    if (includeSelection) {
      // Read surrounding context where available and preserve empty margins. Never
      // shrink the destination to satisfy a provider's aspect-ratio restrictions.
      const read = await readRegionInModal(docId, inputBounds, false, requestMaxEdge, target);
      basePng = encodePng(read.image.data, read.image.width, read.image.height, read.image.components);
      console.log("[Mega Musa]", read.debug);
    }
    if (!rawSelection) await replaceRectSelection(region);
    return {
      docId, docWidth, docHeight, anchorLayerId, activeArtboard, rawSelection, documentState,
      region, inputBounds, frame, selectionSnapshot, basePng, requestMaxEdge,
    };
  }));
}
