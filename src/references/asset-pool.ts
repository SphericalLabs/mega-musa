/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ArchivedReference, type AssetStorageMode, type ReferenceAssetMetadata } from "../archive/types";
import {
  readLayerReferenceAssetMetadata,
  readLayerReferenceAssetPoolMetadata,
  writeLayerReferenceAssetPoolMetadata,
} from "../photoshop/metadata";

import { descendantLayers, layersOf } from "../photoshop/layers";
import { batchPlay } from "../photoshop/runtime";

export const REFERENCE_ASSET_GROUP_NAME = "Mega Musa Reference Archive";

export function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export function assetLayerName(hash: string, name: string, storageMode: AssetStorageMode): string {
  const cleanName = name.replace(/[\r\n]+/g, " ").trim() || "reference image";
  const mode = storageMode === "original" ? "" : ` ${storageMode}`;
  return `[Mega Musa Reference ${hash.slice(0, 12)}${mode}] ${cleanName}`.slice(0, 255);
}

export function layerById(doc: any, layerId: number): any | null {
  return descendantLayers(doc).find((layer) => Number(layer?.id) === layerId) || null;
}

export function isGroupLayer(layer: any): boolean {
  try {
    if (String(layer?.kind || "").toLowerCase().includes("group")) return true;
    return layer?.layers != null;
  } catch {
    return false;
  }
}

export async function findAssetPool(doc: any): Promise<any | null> {
  const groups = layersOf(doc).filter(isGroupLayer);
  groups.sort((a, b) =>
    a?.name === REFERENCE_ASSET_GROUP_NAME ? -1 : b?.name === REFERENCE_ASSET_GROUP_NAME ? 1 : 0
  );
  for (const layer of groups) {
    const metadata = await readLayerReferenceAssetPoolMetadata(doc.id, layer.id);
    if (metadata?.name === REFERENCE_ASSET_GROUP_NAME) return layer;
  }
  return null;
}

export async function getOrCreateAssetPool(doc: any): Promise<any> {
  const existing = await findAssetPool(doc);
  if (existing) return existing;
  const group = await doc.createLayerGroup({ name: REFERENCE_ASSET_GROUP_NAME });
  if (!group) throw new Error("Photoshop could not create the reference asset group.");
  try {
    await writeLayerReferenceAssetPoolMetadata(doc.id, group.id, {
      kind: "referenceAssetPool",
      v: 1,
      name: REFERENCE_ASSET_GROUP_NAME,
    });
  } catch (error) {
    // Hide and lock the new group if metadata creation fails.
    setPoolEditable(group, false);
    throw error;
  }
  return group;
}

export function setPoolEditable(group: any, editable: boolean): void {
  if (editable) {
    try {
      group.allLocked = false;
    } catch (error: any) {
      console.log("[Mega Musa] could not unlock the asset group:", error?.message || error);
    }
  }

  // Hide each child as well as the group so expanding the archive shows no enabled eyes.
  for (const layer of descendantLayers(group)) {
    try {
      layer.visible = false;
    } catch (error: any) {
      console.log("[Mega Musa] could not hide an archived reference:", error?.message || error);
    }
  }
  try {
    group.visible = false;
  } catch (error: any) {
    console.log("[Mega Musa] could not hide the asset group:", error?.message || error);
  }

  if (!editable) {
    try {
      group.allLocked = true;
    } catch (error: any) {
      console.log("[Mega Musa] could not lock the asset group:", error?.message || error);
    }
  }
}

export async function selectLayer(layerId: number): Promise<void> {
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
}

export function pointerFor(metadata: ReferenceAssetMetadata, layerId: number, name: string): ArchivedReference {
  return {
    id: metadata.id,
    hash: metadata.hash,
    layerId,
    name,
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
    storageMode: metadata.storageMode,
    sourceMimeType: metadata.sourceMimeType,
    sourceByteLength: metadata.sourceByteLength,
    lossy: metadata.lossy,
  };
}

export interface IndexedAsset {
  layer: any;
  metadata: ReferenceAssetMetadata;
}

export interface AssetIndex {
  byId: Map<string, IndexedAsset>;
  byStorage: Map<string, IndexedAsset>;
  originalByHash: Map<string, IndexedAsset>;
  anyByHash: Map<string, IndexedAsset>;
}

export function emptyAssetIndex(): AssetIndex {
  return {
    byId: new Map(),
    byStorage: new Map(),
    originalByHash: new Map(),
    anyByHash: new Map(),
  };
}

export function storedMode(metadata: ReferenceAssetMetadata): AssetStorageMode {
  return metadata.storageMode || "original";
}

export function storageKey(hash: string, storageMode: AssetStorageMode): string {
  return `${hash}:${storageMode}`;
}

export function addIndexedAsset(index: AssetIndex, asset: IndexedAsset): void {
  const { metadata } = asset;
  if (!index.byId.has(metadata.id)) index.byId.set(metadata.id, asset);
  if (!index.byStorage.has(storageKey(metadata.hash, storedMode(metadata)))) {
    index.byStorage.set(storageKey(metadata.hash, storedMode(metadata)), asset);
  }
  if (!index.anyByHash.has(metadata.hash)) index.anyByHash.set(metadata.hash, asset);
  if (storedMode(metadata) === "original" && !index.originalByHash.has(metadata.hash)) {
    index.originalByHash.set(metadata.hash, asset);
  }
}

export async function indexAssetLayers(docId: number, group: any): Promise<AssetIndex> {
  const assets = emptyAssetIndex();
  for (const layer of descendantLayers(group)) {
    const metadata = await readLayerReferenceAssetMetadata(docId, layer.id);
    if (metadata) addIndexedAsset(assets, { layer, metadata });
  }
  return assets;
}
