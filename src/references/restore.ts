/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ArchivedReference } from "../archive/types";
import { type HostModalLease, executeHostModal, runHostModalTask } from "../host-modal";
import { bytesToBase64 } from "../images/base64";
import { readLayerReferenceAssetMetadata } from "../photoshop/metadata";
import { app, batchPlay, core, openDocumentById, storage } from "../photoshop/runtime";
import { type RefImage, referenceImageFromBase64 } from "../references";
import { deleteMegaMusaTemporaryFile } from "../temp-files";
import {
  emptyAssetIndex,
  findAssetPool,
  imageExtension,
  indexAssetLayers,
  layerById,
  selectLayer,
  setPoolEditable,
  storageKey,
  storedMode,
} from "./asset-pool";

let restoreExportSequence = 0;

export interface RestoredReferenceResult {
  images: RefImage[];
  missing: string[];
  failures: string[];
}

async function exportEmbeddedReference(layerId: number, hash: string, mimeType: string): Promise<string> {
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  // Use a fresh temp path so Export Contents does not prompt to overwrite a file.
  const unique = `${Date.now().toString(36)}-${restoreExportSequence++}`;
  const file = await tempFolder.createFile(
    `mega-musa-restore-${hash}-${unique}.${imageExtension(mimeType)}`
  );
  try {
    const token = storage.localFileSystem.createSessionToken(file);
    await selectLayer(layerId);
    await batchPlay(
      [
        {
          _obj: "placedLayerExportContents",
          null: { _path: token, _kind: "local" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
    const buffer = await file.read({ format: storage.formats.binary });
    return bytesToBase64(new Uint8Array(buffer));
  } finally {
    await deleteMegaMusaTemporaryFile(file);
  }
}

// Restore references after prompt/settings recall. Report missing or unreadable assets
// without blocking the other restored settings.
export async function restoreReferenceAssets(
  docId: number,
  references: ArchivedReference[],
  selectedLayerId: number,
  lease?: HostModalLease
): Promise<RestoredReferenceResult> {
  const previousDocument = app.activeDocument;
  const targetDocument = openDocumentById(docId);
  if (!targetDocument) {
    return {
      images: [],
      missing: references.map((reference) => reference.name || "reference image"),
      failures: [],
    };
  }

  return await runHostModalTask(
    () => executeHostModal(core, async () => {
      const switched = previousDocument?.id !== docId;
      if (switched) app.activeDocument = targetDocument;
      const images: RefImage[] = [];
      const missing: string[] = [];
      const failures: string[] = [];
      let pool: any | null = null;
      try {
        pool = await findAssetPool(targetDocument);
        if (pool) setPoolEditable(pool, true);
        const pooledAssets = pool
          ? await indexAssetLayers(docId, pool)
          : emptyAssetIndex();
        const exported = new Map<string, string>();

        for (const reference of references) {
          const name = reference?.name || "reference image";
          if (!reference || typeof reference.hash !== "string" || !Number.isFinite(reference.layerId)) {
            missing.push(name);
            continue;
          }
          try {
            let layer = layerById(targetDocument, reference.layerId);
            let metadata = layer ? await readLayerReferenceAssetMetadata(docId, layer.id) : null;
            if (!metadata || metadata.hash !== reference.hash || metadata.id !== reference.id) {
              const fallback =
                pooledAssets.byId.get(reference.id) ||
                pooledAssets.byStorage.get(storageKey(reference.hash, reference.storageMode || "original")) ||
                pooledAssets.originalByHash.get(reference.hash) ||
                pooledAssets.anyByHash.get(reference.hash);
              layer = fallback?.layer || null;
              metadata = fallback?.metadata || null;
            }
            if (!layer || !metadata) {
              missing.push(name);
              continue;
            }

            let base64 = exported.get(metadata.id);
            if (!base64) {
              base64 = await exportEmbeddedReference(layer.id, reference.hash, metadata.mimeType);
              exported.set(metadata.id, base64);
            }
            const image = referenceImageFromBase64(name, base64);
            if (!image) throw new Error("the embedded Smart Object did not contain a supported image");
            image.archivedHash = metadata.hash;
            image.archivedStorageMode = storedMode(metadata);
            images.push(image);
          } catch (error: any) {
            failures.push(name);
            console.log(`[Mega Musa] could not restore reference “${name}”:`, error?.message || error);
          }
        }
      } finally {
        if (pool) setPoolEditable(pool, false);
        try {
          await selectLayer(selectedLayerId);
        } catch {
          /* the source layer may have been deleted while the panel was open */
        }
        if (switched && previousDocument && openDocumentById(previousDocument.id)) {
          try {
            app.activeDocument = previousDocument;
          } catch {
            /* leave the archive document active if Photoshop refuses the switch */
          }
        }
      }
      return { images, missing, failures };
    }, "restore references"),
    lease
  );
}
