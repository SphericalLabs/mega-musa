/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

import { base64ToBytes, bytesToBase64 } from "./image-codec";
import {
  ArchivedReference,
  ReferenceAssetMetadata,
  readLayerReferenceAssetMetadata,
  readLayerReferenceAssetPoolMetadata,
  writeLayerReferenceAssetMetadata,
  writeLayerReferenceAssetPoolMetadata,
} from "./archive";
import { RefImage, referenceImageFromBase64 } from "./references";

const { app, action, core, constants } = require("photoshop");
const { storage } = require("uxp");

export const REFERENCE_ASSET_GROUP_NAME = "Mega Musa Reference Archive";
let restoreExportSequence = 0;

export interface ArchivedReferenceResult {
  references: ArchivedReference[];
  failures: string[];
}

export interface RestoredReferenceResult {
  images: RefImage[];
  missing: string[];
  failures: string[];
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

// Web Crypto is the fast path. The compact fallback keeps content-addressed
// deduplication working in older UXP builds that expose no SubtleCrypto.
function sha256Fallback(bytes: Uint8Array): string {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  const processBlock = (block: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      words[i] =
        ((block[p] || 0) << 24) |
        ((block[p + 1] || 0) << 16) |
        ((block[p + 2] || 0) << 8) |
        (block[p + 3] || 0);
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  };

  let offset = 0;
  while (offset + 64 <= bytes.length) {
    processBlock(bytes, offset);
    offset += 64;
  }
  const remainder = bytes.subarray(offset);
  const tail = new Uint8Array(remainder.length < 56 ? 64 : 128);
  tail.set(remainder);
  tail[remainder.length] = 0x80;
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000);
  const bitLengthLow = (bytes.length * 8) >>> 0;
  const end = tail.length;
  tail[end - 8] = bitLengthHigh >>> 24;
  tail[end - 7] = bitLengthHigh >>> 16;
  tail[end - 6] = bitLengthHigh >>> 8;
  tail[end - 5] = bitLengthHigh;
  tail[end - 4] = bitLengthLow >>> 24;
  tail[end - 3] = bitLengthLow >>> 16;
  tail[end - 2] = bitLengthLow >>> 8;
  tail[end - 1] = bitLengthLow;
  for (let p = 0; p < tail.length; p += 64) processBlock(tail, p);
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
}

export async function hashReferenceBytes(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (typeof subtle?.digest === "function") {
    try {
      const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
      return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    } catch {
      /* use the UXP-compatible fallback */
    }
  }
  return sha256Fallback(bytes);
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function assetLayerName(hash: string, name: string): string {
  const cleanName = name.replace(/[\r\n]+/g, " ").trim() || "reference image";
  return `[Mega Musa Reference ${hash.slice(0, 12)}] ${cleanName}`.slice(0, 255);
}

function layersOf(owner: any): any[] {
  try {
    return Array.from(owner?.layers || []);
  } catch {
    return [];
  }
}

function descendantLayers(owner: any): any[] {
  const result: any[] = [];
  for (const layer of layersOf(owner)) {
    result.push(layer);
    result.push(...descendantLayers(layer));
  }
  return result;
}

function layerById(doc: any, layerId: number): any | null {
  return descendantLayers(doc).find((layer) => Number(layer?.id) === layerId) || null;
}

function isGroupLayer(layer: any): boolean {
  try {
    if (String(layer?.kind || "").toLowerCase().includes("group")) return true;
    return layer?.layers != null;
  } catch {
    return false;
  }
}

async function findAssetPool(doc: any): Promise<any | null> {
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

async function getOrCreateAssetPool(doc: any): Promise<any> {
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
    // Do not leave a visible plugin group selected if Photoshop accepts the
    // layer creation but rejects its metadata.
    setPoolEditable(group, false);
    throw error;
  }
  return group;
}

function setPoolEditable(group: any, editable: boolean): void {
  if (editable) {
    try {
      group.allLocked = false;
    } catch (error: any) {
      console.log("[Mega Musa] could not unlock the asset group:", error?.message || error);
    }
  }

  // The group and every archived reference keep their own eye disabled. Hiding
  // only the parent protects the composite but leaves newly placed children
  // visibly enabled when the archive group is expanded.
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

async function selectLayer(layerId: number): Promise<void> {
  const result = await action.batchPlay(
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
  const error = result?.[0]?._obj === "error" ? result[0] : null;
  if (error) throw new Error(error.message || "Photoshop could not select the archived reference.");
}

function pointerFor(metadata: ReferenceAssetMetadata, layerId: number, name: string): ArchivedReference {
  return {
    id: metadata.id,
    hash: metadata.hash,
    layerId,
    name,
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
  };
}

async function assetLayersByHash(docId: number, group: any): Promise<Map<string, { layer: any; metadata: ReferenceAssetMetadata }>> {
  const assets = new Map<string, { layer: any; metadata: ReferenceAssetMetadata }>();
  for (const layer of descendantLayers(group)) {
    const metadata = await readLayerReferenceAssetMetadata(docId, layer.id);
    if (metadata && !assets.has(metadata.hash)) assets.set(metadata.hash, { layer, metadata });
  }
  return assets;
}

// Called from placeResult's existing executeAsModal scope. Each unique original
// file becomes one embedded Smart Object; repeated use only adds another pointer.
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
    const existing = await assetLayersByHash(docId, group);
    const tempFolder = await storage.localFileSystem.getTemporaryFolder();
    for (const reference of references) {
      let placedLayer: any | null = null;
      try {
        const bytes = base64ToBytes(reference.base64);
        const hash = await hashReferenceBytes(bytes);
        const match = existing.get(hash);
        if (match) {
          match.layer.visible = false;
          archived.push(pointerFor(match.metadata, match.layer.id, reference.name));
          continue;
        }

        const metadata: ReferenceAssetMetadata = {
          kind: "referenceAsset",
          v: 1,
          id: hash,
          hash,
          name: reference.name,
          mimeType: reference.mimeType,
          byteLength: bytes.length,
          createdAt: new Date().toISOString(),
        };
        const file = await tempFolder.createFile(`mega-musa-${hash}.${imageExtension(reference.mimeType)}`, {
          overwrite: true,
        });
        const fileBytes =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
        await file.write(fileBytes, { format: storage.formats.binary });
        const token = storage.localFileSystem.createSessionToken(file);

        await selectLayer(group.id);
        const placeResult = await action.batchPlay(
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
        const placeError = placeResult?.[0]?._obj === "error" ? placeResult[0] : null;
        if (placeError) throw new Error(placeError.message || "Photoshop could not embed the reference image.");
        placedLayer = doc.activeLayers?.[0] || null;
        if (!placedLayer || placedLayer.id === group.id) {
          throw new Error("Photoshop did not return the embedded reference layer.");
        }
        placedLayer.visible = false;
        placedLayer.name = assetLayerName(hash, reference.name);
        if (placedLayer.parent?.id !== group.id) {
          placedLayer.move(group, constants.ElementPlacement.PLACEINSIDE);
        }
        await writeLayerReferenceAssetMetadata(docId, placedLayer.id, metadata);
        existing.set(hash, { layer: placedLayer, metadata });
        archived.push(pointerFor(metadata, placedLayer.id, reference.name));
      } catch (error: any) {
        failures.push(reference.name);
        console.log(`[Mega Musa] could not archive reference “${reference.name}”:`, error?.message || error);
        // If placement succeeded but metadata did not, keep the orphan harmless
        // inside the hidden pool. It is intentionally not treated as reusable.
        try {
          if (placedLayer) placedLayer.visible = false;
          if (placedLayer && placedLayer.parent?.id !== group.id) {
            placedLayer.move(group, constants.ElementPlacement.PLACEINSIDE);
          }
        } catch {
          /* the final group hide still protects the document composite */
        }
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

async function exportEmbeddedReference(layerId: number, hash: string, mimeType: string): Promise<string> {
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  // Export Contents opens Photoshop's Save/overwrite UI when its destination
  // already exists. A unique temp target keeps Load Settings noninteractive.
  const unique = `${Date.now().toString(36)}-${restoreExportSequence++}`;
  const file = await tempFolder.createFile(
    `mega-musa-restore-${hash}-${unique}.${imageExtension(mimeType)}`
  );
  const token = storage.localFileSystem.createSessionToken(file);
  await selectLayer(layerId);
  const result = await action.batchPlay(
    [
      {
        _obj: "placedLayerExportContents",
        null: { _path: token, _kind: "local" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
  const error = result?.[0]?._obj === "error" ? result[0] : null;
  if (error) throw new Error(error.message || "Photoshop could not export the embedded reference.");
  const buffer = await file.read({ format: storage.formats.binary });
  return bytesToBase64(new Uint8Array(buffer));
}

function openDocumentById(docId: number): any | null {
  return Array.from(app.documents || []).find((doc: any) => doc.id === docId) || null;
}

// Load Settings calls this explicitly. The prompt and ordinary controls are
// restored before this starts, so missing or modified asset layers only affect
// the references and are returned as a report instead of blocking the load.
export async function restoreReferenceAssets(
  docId: number,
  references: ArchivedReference[],
  selectedLayerId: number
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

  return await core.executeAsModal(
    async () => {
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
          ? await assetLayersByHash(docId, pool)
          : new Map<string, { layer: any; metadata: ReferenceAssetMetadata }>();
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
            if (!metadata || metadata.hash !== reference.hash) {
              const fallback = pooledAssets.get(reference.hash);
              layer = fallback?.layer || null;
              metadata = fallback?.metadata || null;
            }
            if (!layer || !metadata) {
              missing.push(name);
              continue;
            }

            let base64 = exported.get(reference.hash);
            if (!base64) {
              base64 = await exportEmbeddedReference(layer.id, reference.hash, metadata.mimeType);
              exported.set(reference.hash, base64);
            }
            const image = referenceImageFromBase64(name, base64);
            if (!image) throw new Error("the embedded Smart Object did not contain a supported image");
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
    },
    { commandName: "Mega Musa: restore references" }
  );
}
