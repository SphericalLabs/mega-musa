/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ActiveArtboard, type Bounds } from "../photoshop/types";
import {
  type ArchivedGenerationGeometry,
  type ArchivedReference,
  type EmbeddedResultStorage,
  type GenerationArchive,
  type ReferenceAssetMetadata,
  type ReferenceAssetPoolMetadata,
} from "./types";

export function isBounds(value: any): value is Bounds {
  return (
    value != null &&
    [value.left, value.top, value.right, value.bottom].every(Number.isFinite) &&
    value.right > value.left &&
    value.bottom > value.top
  );
}

export function isGenerationGeometry(value: any): value is ArchivedGenerationGeometry {
  return (
    value != null &&
    (value.selectionBounds === null || isBounds(value.selectionBounds)) &&
    isBounds(value.generationBounds) &&
    Number.isFinite(value.documentWidth) &&
    value.documentWidth > 0 &&
    Number.isFinite(value.documentHeight) &&
    value.documentHeight > 0 &&
    (value.artboard === null ||
      (Number.isInteger(value.artboard?.id) && isBounds(value.artboard?.bounds)))
  );
}

export function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

// Unchanged canvas/artboard bounds cannot prove that the content has not moved.
export function getRecallSelectionBounds(
  geometry: ArchivedGenerationGeometry | undefined,
  documentWidth: number,
  documentHeight: number,
  artboard: ActiveArtboard | null
): Bounds {
  if (!isGenerationGeometry(geometry)) {
    throw new Error("This generation has no readable saved rectangle. Prompt and settings are still available.");
  }
  if (
    !Number.isFinite(documentWidth) || !Number.isFinite(documentHeight) ||
    documentWidth <= 0 || documentHeight <= 0
  ) {
    throw new Error("Could not read the current canvas dimensions. Try again with an open document.");
  }
  if (geometry.documentWidth !== documentWidth || geometry.documentHeight !== documentHeight) {
    throw new Error(
      `Canvas changed from ${geometry.documentWidth} × ${geometry.documentHeight} to ` +
      `${documentWidth} × ${documentHeight}. Draw a new selection.`
    );
  }
  if (
    geometry.artboard
      ? !artboard || geometry.artboard.id !== artboard.id || !sameBounds(geometry.artboard.bounds, artboard.bounds)
      : artboard !== null
  ) {
    throw new Error("The original artboard is missing, has changed or is no longer the target. Draw a new selection.");
  }
  const bounds = geometry.selectionBounds ?? geometry.generationBounds;
  const target = artboard?.bounds ?? { left: 0, top: 0, right: documentWidth, bottom: documentHeight };
  if (
    bounds.left < target.left || bounds.top < target.top ||
    bounds.right > target.right || bounds.bottom > target.bottom
  ) {
    throw new Error(
      `The saved rectangle does not fit entirely inside the ${artboard ? "artboard" : "canvas"}. Draw a new selection.`
    );
  }
  return bounds;
}

export function isArchivedReference(value: any): value is ArchivedReference {
  return (
    typeof value?.id === "string" &&
    typeof value.hash === "string" &&
    Number.isFinite(value.layerId) &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    Number.isFinite(value.byteLength) &&
    (value.storageMode === undefined || ["original", "png-srgb", "jpeg-90"].includes(value.storageMode)) &&
    (value.sourceMimeType === undefined || typeof value.sourceMimeType === "string") &&
    (value.sourceByteLength === undefined || Number.isFinite(value.sourceByteLength)) &&
    (value.lossy === undefined || typeof value.lossy === "boolean")
  );
}

export function isEmbeddedResultStorage(value: any): value is EmbeddedResultStorage {
  return (
    value != null &&
    ["raster", "png-srgb", "jpeg-90"].includes(value.mode) &&
    (value.mimeType === undefined || value.mimeType === "image/png" || value.mimeType === "image/jpeg") &&
    (value.byteLength === undefined || Number.isFinite(value.byteLength)) &&
    typeof value.lossy === "boolean"
  );
}

export function isArchivedModelSettings(value: any): boolean {
  return value != null && Number.isInteger(value.version) && value.version > 0 &&
    typeof value.resolution === "string" && typeof value.ratio === "string" && typeof value.quality === "string" &&
    value.options != null && typeof value.options === "object" && !Array.isArray(value.options) &&
    Object.entries(value.options).every(([key, item]) => !["__proto__", "constructor", "prototype"].includes(key) &&
      (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))));
}

export function isGenerationArchive(value: any): value is GenerationArchive {
  return (
    value?.v === 1 &&
    typeof value.prompt === "string" &&
    typeof value.provider === "string" &&
    (value.providerId === undefined || typeof value.providerId === "string") &&
    (value.settings === undefined || isArchivedModelSettings(value.settings)) &&
    typeof value.model === "string" &&
    typeof value.modelLabel === "string" &&
    typeof value.resolution === "string" &&
    typeof value.ratio === "string" &&
    typeof value.quality === "string" &&
    (value.resolvedQuality === undefined || typeof value.resolvedQuality === "string") &&
    typeof value.includeSelection === "boolean" &&
    (value.placeAsSmartObject === undefined || typeof value.placeAsSmartObject === "boolean") &&
    (value.reduceDocumentSize === undefined || typeof value.reduceDocumentSize === "boolean") &&
    (value.resultStorage === undefined || isEmbeddedResultStorage(value.resultStorage)) &&
    Array.isArray(value.referenceNames) &&
    value.referenceNames.every((name: unknown) => typeof name === "string") &&
    typeof value.requestedSize === "string" &&
    Number.isFinite(value.outputWidth) &&
    Number.isFinite(value.outputHeight) &&
    typeof value.createdAt === "string" &&
    (value.references === undefined ||
      (Array.isArray(value.references) && value.references.every(isArchivedReference)))
  );
}

export function isReferenceAssetMetadata(value: any): value is ReferenceAssetMetadata {
  return (
    value?.kind === "referenceAsset" &&
    value.v === 1 &&
    typeof value.id === "string" &&
    typeof value.hash === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    Number.isFinite(value.byteLength) &&
    typeof value.createdAt === "string" &&
    (value.storageMode === undefined || ["original", "png-srgb", "jpeg-90"].includes(value.storageMode)) &&
    (value.sourceMimeType === undefined || typeof value.sourceMimeType === "string") &&
    (value.sourceByteLength === undefined || Number.isFinite(value.sourceByteLength)) &&
    (value.lossy === undefined || typeof value.lossy === "boolean")
  );
}

export function isReferenceAssetPoolMetadata(value: any): value is ReferenceAssetPoolMetadata {
  return value?.kind === "referenceAssetPool" && value.v === 1 && typeof value.name === "string";
}
