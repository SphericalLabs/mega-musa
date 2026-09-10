/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type EmbeddedResultStorage, type GenerationArchive } from "../archive/types";
import { DEFAULT_HOST_MODAL_TIMEOUT_SECONDS, type HostModalLease } from "../host-modal";
import { type RefImage } from "../references";
import { archiveReferenceAssetsInActiveDocument } from "../references/archive";
import { selectionNeedsMask } from "./geometry";
import { withHistory } from "./history";
import { bringResultToDocumentFront, deleteResultLayer, descendantLayers, selectLayerById } from "./layers";
import { makeLayerMaskFromSnapshot } from "./masks";
import { writeLayerGenerationArchive } from "./metadata";
import { placeRasterFallback } from "./raster";
import { app, runModal, withActiveDocument } from "./runtime";
import { createFileSmartObject, positionSmartObjectAtBounds } from "./smart-object";
import { type Bounds, type PlacementClip, type PlacementResult, type SelectionSnapshot } from "./types";

// Try full-resolution Smart Object placement when requested; fall back to raster if it
// fails. Apply captured selection coverage where clipping is needed.
export interface PlacementRequest {
  docId: number;
  bounds: Bounds;
  rgba: Uint8Array;
  width: number;
  height: number;
  layerName: string;
  selection: SelectionSnapshot | null;
  placeAsSmartObject: boolean;
  reduceDocumentSize: boolean;
  archive: GenerationArchive;
  references: RefImage[];
  anchorLayerId?: number | null;
}

export interface PlacementContext {
  lease?: HostModalLease;
  timeoutSeconds?: number;
}

export async function placeResult(request: PlacementRequest, context: PlacementContext = {}): Promise<PlacementResult> {
  const { docId, bounds, rgba, width, height, layerName, selection, placeAsSmartObject,
    reduceDocumentSize, archive, references, anchorLayerId } = request;
  const { lease, timeoutSeconds = DEFAULT_HOST_MODAL_TIMEOUT_SECONDS } = context;
  const historyName = "Mega Musa: place result";
  // Opaque rectangular coverage needs no separate layer mask.
  const clippingSelection = selectionNeedsMask(selection) ? selection : null;
  return await runModal(
    "place result",
    async (executionContext) => withActiveDocument(docId, async () => {
      return withHistory(executionContext, docId, historyName, async () => {
        const document = app.activeDocument;
        const frozenAnchor = Number.isFinite(anchorLayerId)
          ? descendantLayers(document).find((layer) => Number(layer?.id) === Number(anchorLayerId))
          : null;
        const fallbackAnchor = Array.from(document.layers || [])[0] || null;
        const anchorLayer = frozenAnchor || fallbackAnchor;
        if (anchorLayer) await selectLayerById(anchorLayer.id);
        const resolvedAnchorLayerId = anchorLayer?.id;
        let resultLayer: any;
        let clip: PlacementClip = "none";
        let smartObject = placeAsSmartObject;
        let incompleteSmartObject: any | null = null;
        let resultStorage: EmbeddedResultStorage = { mode: "raster", lossy: false };

        if (placeAsSmartObject) {
          try {
            const created = await createFileSmartObject(
              document,
              rgba,
              width,
              height,
              bounds,
              layerName,
              reduceDocumentSize
            );
            incompleteSmartObject = created.layer;
            resultStorage = created.storage;
            await positionSmartObjectAtBounds(incompleteSmartObject, bounds);
            await bringResultToDocumentFront(incompleteSmartObject);

            if (clippingSelection) {
              await makeLayerMaskFromSnapshot(docId, incompleteSmartObject.id, clippingSelection);
              clip = "mask";
            }
            resultLayer = incompleteSmartObject;
          } catch (error: any) {
            smartObject = false;
            resultStorage = { mode: "raster", lossy: false };
            console.log("[Mega Musa] Smart Object placement failed; using raster fallback:", error?.message || error);
            if (incompleteSmartObject) {
              try {
                await deleteResultLayer(incompleteSmartObject.id);
              } catch (cleanupError: any) {
                console.log("[Mega Musa] could not remove the incomplete Smart Object:", cleanupError?.message || cleanupError);
                try {
                  incompleteSmartObject.visible = false;
                } catch {
                  /* the raster fallback remains the visible paid result */
                }
              }
            }
          }
        }

        if (!smartObject) {
          if (resolvedAnchorLayerId) await selectLayerById(resolvedAnchorLayerId);
          const fallback = await placeRasterFallback(
            docId,
            bounds,
            rgba,
            width,
            height,
            layerName,
            clippingSelection
          );
          resultLayer = fallback.layer;
          clip = fallback.clip;
        }

        const layerId = resultLayer.id;
        archive.resultStorage = resultStorage;

        let referenceArchiveFailures = 0;
        try {
          const assets = await archiveReferenceAssetsInActiveDocument(docId, references, layerId);
          archive.references = assets.references;
          referenceArchiveFailures = assets.failures.length;
        } catch (e: any) {
          // Preserve the generated result if reference archiving fails.
          archive.references = [];
          referenceArchiveFailures = references.length;
          console.log("[Mega Musa] could not archive reference assets:", e?.message || e);
        }

        let archiveSaved = true;
        try {
          await writeLayerGenerationArchive(docId, layerId, archive);
        } catch (e: any) {
          // Report metadata failure without discarding the placed pixels.
          archiveSaved = false;
          console.log("[Mega Musa] could not save the layer generation archive:", e?.message || e);
        }
        // Restore the result to the front after reference archiving changes the stack.
        await bringResultToDocumentFront(resultLayer);
        const placement = {
          clip,
          layerId,
          smartObject,
          archiveSaved,
          referenceArchiveFailures,
          resultStorage,
        };
        return placement;
      });
    }),
    lease,
    timeoutSeconds
  );
}
