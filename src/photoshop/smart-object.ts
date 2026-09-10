/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type EmbeddedResultStorage } from "../archive/types";
import { encodeEmbeddedImage } from "../images/codec";
import { deleteMegaMusaTemporaryFile } from "../temp-files";
import { SRGB_PROFILE } from "./document-state";
import { boundVal, preciseBoundsFrom } from "./geometry";
import {
  deleteResultLayer,
  descendantLayers,
  newDocumentLayers,
  renameActiveLayer,
  selectLayerById,
  unlockResultLayer,
} from "./layers";
import { app, batchPlay, openDocumentById, storage } from "./runtime";
import { type Bounds } from "./types";

let smartObjectMarkerSequence = 0;

function nextSmartObjectMarker(): string {
  smartObjectMarkerSequence += 1;
  return `__mega_musa_result_${Date.now()}_${smartObjectMarkerSequence}`;
}

// Embed an image file to avoid an internal PSB. Size its outer transform in a scratch
// document before duplicating it into the target.
export async function createFileSmartObject(
  targetDocument: any,
  rgba: Uint8Array,
  width: number,
  height: number,
  targetBounds: Bounds,
  layerName: string,
  reduceDocumentSize: boolean
): Promise<{ layer: any; storage: EmbeddedResultStorage }> {
  const targetWidth = targetBounds.right - targetBounds.left;
  const targetHeight = targetBounds.bottom - targetBounds.top;
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new Error("The Smart Object destination is empty.");
  }
  const existingTargetLayerIds = new Set(
    descendantLayers(targetDocument).map((layer) => Number(layer.id)).filter(Number.isFinite)
  );
  const sourceMarker = nextSmartObjectMarker();
  const encoded = encodeEmbeddedImage(rgba, width, height, reduceDocumentSize);
  let scratch: any | null = null;
  let placedLayer: any | null = null;
  let sourceFile: any | null = null;
  try {
    const tempFolder = await storage.localFileSystem.getTemporaryFolder();
    sourceFile = await tempFolder.createFile(`${sourceMarker}.${encoded.extension}`, { overwrite: true });
    const fileBytes =
      encoded.bytes.byteOffset === 0 && encoded.bytes.byteLength === encoded.bytes.buffer.byteLength
        ? encoded.bytes.buffer
        : encoded.bytes.slice().buffer;
    await sourceFile.write(fileBytes, { format: storage.formats.binary });
    const token = storage.localFileSystem.createSessionToken(sourceFile);

    scratch = await app.createDocument({
      width,
      height,
      resolution: 72,
      fill: "transparent",
      name: "mm-result-source",
      profile: SRGB_PROFILE,
    });
    if (!scratch) throw new Error("Photoshop could not create the Smart Object source document.");

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
    const embeddedSource = scratch.activeLayers?.[0];
    if (!embeddedSource) throw new Error("Photoshop did not create the embedded Smart Object.");
    await renameActiveLayer(sourceMarker);

    // Image Size sets the outer transform while preserving the embedded source pixels.
    if (width !== targetWidth || height !== targetHeight) {
      await batchPlay(
        [
          {
            _obj: "imageSize",
            width: { _unit: "pixelsUnit", _value: targetWidth },
            height: { _unit: "pixelsUnit", _value: targetHeight },
            constrainProportions: false,
            interpolation: { _enum: "interpolationType", _value: "bicubic" },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        { propagateErrorToDefaultHandler: false }
      );
    }

    const sizedSource = scratch.activeLayers?.[0] || embeddedSource;
    await scratch.duplicateLayers([sizedSource], targetDocument);

    app.activeDocument = targetDocument;
    const createdLayers = newDocumentLayers(targetDocument, existingTargetLayerIds);
    placedLayer = createdLayers.find((layer) => layer.name === sourceMarker) || null;
    if (!placedLayer && createdLayers.length === 1) placedLayer = createdLayers[0];
    if (!placedLayer) {
      throw new Error("Photoshop copied the Smart Object but did not expose its destination layer.");
    }

    unlockResultLayer(placedLayer);
    await selectLayerById(placedLayer.id);
    await renameActiveLayer(layerName);
    return {
      layer: placedLayer,
      storage: {
        mode: encoded.storageMode,
        mimeType: encoded.mimeType,
        byteLength: encoded.bytes.length,
        lossy: encoded.lossy,
      },
    };
  } catch (error) {
    if (openDocumentById(targetDocument.id)) {
      app.activeDocument = targetDocument;
      const incompleteLayers = newDocumentLayers(targetDocument, existingTargetLayerIds);
      if (
        placedLayer &&
        !incompleteLayers.some((layer) => Number(layer.id) === Number(placedLayer.id)) &&
        !existingTargetLayerIds.has(Number(placedLayer.id))
      ) {
        incompleteLayers.push(placedLayer);
      }
      for (const incompleteLayer of incompleteLayers) {
        try {
          await deleteResultLayer(incompleteLayer.id);
        } catch (cleanupError: any) {
          console.log(
            "[Mega Musa] could not remove an incomplete Smart Object:",
            cleanupError?.message || cleanupError
          );
          try {
            incompleteLayer.visible = false;
          } catch {
            /* the visible raster fallback remains the best available recovery */
          }
        }
      }
    }
    throw error;
  } finally {
    if (scratch && openDocumentById(scratch.id)) {
      try {
        await scratch.closeWithoutSaving();
      } catch {
        /* only the plugin-created scratch document is eligible for closing */
      }
    }
    if (sourceFile) await deleteMegaMusaTemporaryFile(sourceFile);
    if (openDocumentById(targetDocument.id)) app.activeDocument = targetDocument;
  }
}

export async function smartObjectBounds(layer: any): Promise<Bounds | null> {
  // Transformed source corners include transparent margins that pixel bounds can omit.
  try {
    const result = await batchPlay(
      [
        {
          _obj: "get",
          _target: [{ _ref: "layer", _id: layer.id }],
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
    const transform = result?.[0]?.smartObjectMore?.transform;
    if (Array.isArray(transform) && transform.length >= 8) {
      const xs = [
        boundVal(transform[0]),
        boundVal(transform[2]),
        boundVal(transform[4]),
        boundVal(transform[6]),
      ];
      const ys = [
        boundVal(transform[1]),
        boundVal(transform[3]),
        boundVal(transform[5]),
        boundVal(transform[7]),
      ];
      if ([...xs, ...ys].every(Number.isFinite)) {
        const transformed = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };
        if (transformed.right > transformed.left && transformed.bottom > transformed.top) return transformed;
      }
    }
  } catch {
    /* boundsNoEffects is the compatible fallback on older hosts */
  }
  return preciseBoundsFrom(layer.boundsNoEffects) || preciseBoundsFrom(layer.bounds);
}

export async function moveActiveLayer(offsetX: number, offsetY: number): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "move",
        _target: [{ _enum: "ordinal", _ref: "layer" }],
        to: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: offsetX },
          vertical: { _unit: "pixelsUnit", _value: offsetY },
        },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { propagateErrorToDefaultHandler: false }
  );
}

// The scratch document already sized the Smart Object. Only translate here; Photoshop
// can reject Transform during placement.
export async function positionSmartObjectAtBounds(layer: any, target: Bounds): Promise<void> {
  const targetW = target.right - target.left;
  const targetH = target.bottom - target.top;
  const tolerance = 1;
  const current = await smartObjectBounds(layer);
  if (!current) throw new Error("Photoshop did not report the Smart Object bounds.");
  const currentW = current.right - current.left;
  const currentH = current.bottom - current.top;
  if (Math.abs(currentW - targetW) > tolerance || Math.abs(currentH - targetH) > tolerance) {
    throw new Error(
      "Photoshop did not preserve the pre-sized Smart Object dimensions: " +
      `target ${targetW}x${targetH}; actual ${currentW}x${currentH}.`
    );
  }

  await selectLayerById(layer.id);
  const dx = target.left - current.left;
  const dy = target.top - current.top;
  if (Math.abs(dx) > tolerance || Math.abs(dy) > tolerance) await moveActiveLayer(dx, dy);

  const positioned = await smartObjectBounds(layer);
  if (!positioned) throw new Error("Photoshop did not report the positioned Smart Object bounds.");
  const errors = [
    positioned.left - target.left,
    positioned.top - target.top,
    positioned.right - target.right,
    positioned.bottom - target.bottom,
  ];
  if (errors.some((error) => Math.abs(error) > tolerance)) {
    throw new Error(
      "The Smart Object did not match the raster placement bounds: " +
      `target ${target.left},${target.top},${target.right},${target.bottom}; ` +
      `actual ${positioned.left},${positioned.top},${positioned.right},${positioned.bottom}.`
    );
  }
}
