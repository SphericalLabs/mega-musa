/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ArchivedReference, type AssetStorageMode, type ReferenceAssetMetadata } from "../archive/types";
import { base64ToBytes } from "../images/base64";
import { writeLayerReferenceAssetMetadata } from "../photoshop/metadata";
import { app, batchPlay, constants, storage } from "../photoshop/runtime";
import { type RefImage } from "../references";
import { deleteMegaMusaTemporaryFile } from "../temp-files";
import {
  addIndexedAsset,
  assetLayerName,
  getOrCreateAssetPool,
  imageExtension,
  indexAssetLayers,
  pointerFor,
  selectLayer,
  setPoolEditable,
  storageKey,
} from "./asset-pool";
import { hashReferenceBytes } from "./hash";

export interface ArchivedReferenceResult {
  references: ArchivedReference[];
  failures: string[];
}

// Requires the target document and an active modal scope. Reuse existing assets; callers
// prepare compressed bytes only for new assets.
export async function archiveReferenceAssetsInActiveDocument(
  docId: number,
  references: RefImage[],
  resultLayerId: number
): Promise<ArchivedReferenceResult> {
  if (!references.length) return { references: [], failures: [] };
  const doc = app.activeDocument;
  if (!doc || doc.id !== docId) {
    return { references: [], failures: references.map((reference) => reference.name) };
  }

  let group: any;
  try {
    group = await getOrCreateAssetPool(doc);
  } catch (error: any) {
    console.log("[Mega Musa] could not create the reference asset pool:", error?.message || error);
    try {
      await selectLayer(resultLayerId);
    } catch {
      /* the generated result remains in the document even if reselect fails */
    }
    return { references: [], failures: references.map((reference) => reference.name) };
  }

  const archived: ArchivedReference[] = [];
  const failures: string[] = [];
  setPoolEditable(group, true);
  try {
    const existing = await indexAssetLayers(docId, group);
    const tempFolder = await storage.localFileSystem.getTemporaryFolder();
    for (const reference of references) {
      let placedLayer: any | null = null;
      let file: any | null = null;
      try {
        const sourceBytes = base64ToBytes(reference.base64);
        const hash = reference.archivedHash || await hashReferenceBytes(sourceBytes);
        const prepared = reference.archiveAsset;
        const storageMode: AssetStorageMode =
          prepared?.storageMode || reference.archivedStorageMode || "original";
        const bytes = prepared ? base64ToBytes(prepared.base64) : sourceBytes;
        const mimeType = prepared?.mimeType || reference.mimeType;
        // Reuse an original asset before considering a compressed duplicate.
        const match =
          existing.originalByHash.get(hash) ||
          existing.byStorage.get(storageKey(hash, storageMode));
        if (match) {
          match.layer.visible = false;
          archived.push(pointerFor(match.metadata, match.layer.id, reference.name));
          continue;
        }

        const id = storageMode === "original" ? hash : `${hash}:${storageMode}`;
        const metadata: ReferenceAssetMetadata = {
          kind: "referenceAsset",
          v: 1,
          id,
          hash,
          name: reference.name,
          mimeType,
          byteLength: bytes.length,
          createdAt: new Date().toISOString(),
          storageMode,
          sourceMimeType: reference.mimeType,
          sourceByteLength: sourceBytes.length,
          lossy: prepared?.lossy || false,
        };
        file = await tempFolder.createFile(
          `mega-musa-${hash}-${storageMode}.${imageExtension(mimeType)}`,
          { overwrite: true }
        );
        const fileBytes =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
        await file.write(fileBytes, { format: storage.formats.binary });
        const token = storage.localFileSystem.createSessionToken(file);

        await selectLayer(group.id);
        await batchPlay(
          [
            {
              _obj: "placeEvent",
              null: { _path: token, _kind: "local" },
              linked: false,
              freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          {}
        );
        placedLayer = doc.activeLayers?.[0] || null;
        if (!placedLayer || placedLayer.id === group.id) {
          throw new Error("Photoshop did not return the embedded reference layer.");
        }
        placedLayer.visible = false;
        placedLayer.name = assetLayerName(hash, reference.name, storageMode);
        if (placedLayer.parent?.id !== group.id) {
          placedLayer.move(group, constants.ElementPlacement.PLACEINSIDE);
        }
        await writeLayerReferenceAssetMetadata(docId, placedLayer.id, metadata);
        addIndexedAsset(existing, { layer: placedLayer, metadata });
        archived.push(pointerFor(metadata, placedLayer.id, reference.name));
      } catch (error: any) {
        failures.push(reference.name);
        console.log(`[Mega Musa] could not archive reference “${reference.name}”:`, error?.message || error);
        // Hide incomplete assets; without metadata they cannot be reused.
        try {
          if (placedLayer) placedLayer.visible = false;
          if (placedLayer && placedLayer.parent?.id !== group.id) {
            placedLayer.move(group, constants.ElementPlacement.PLACEINSIDE);
          }
        } catch {
          /* the final group hide still protects the document composite */
        }
      } finally {
        if (file) await deleteMegaMusaTemporaryFile(file);
      }
    }
  } finally {
    setPoolEditable(group, false);
    try {
      await selectLayer(resultLayerId);
    } catch (error: any) {
      console.log("[Mega Musa] could not reselect the generated layer:", error?.message || error);
    }
  }
  return { references: archived, failures };
}
