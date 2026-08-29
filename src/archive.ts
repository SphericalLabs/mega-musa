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

import type { ActiveArtboard, Bounds } from "./photoshop-bridge";

const { action } = require("photoshop");

// generatorSettings shares one Photoshop property between plugins. A dedicated
// key keeps Mega Musa's record isolated instead of replacing another plugin's
// layer metadata.
export const ARCHIVE_SETTINGS_KEY = "io_sphericals_mega_musa";

export interface ArchivedReference {
  id: string;
  hash: string;
  layerId: number;
  name: string;
  mimeType: string;
  byteLength: number;
}

export interface ReferenceAssetMetadata {
  kind: "referenceAsset";
  v: 1;
  id: string;
  hash: string;
  name: string;
  mimeType: string;
  byteLength: number;
  createdAt: string;
}

export interface ReferenceAssetPoolMetadata {
  kind: "referenceAssetPool";
  v: 1;
  name: string;
}

export interface ArchivedGenerationGeometry {
  // Preserve the original selection separately from the aspect-fitted crop.
  // Without a drawn selection, recall uses the generation frame instead.
  selectionBounds: Bounds | null;
  generationBounds: Bounds;
  documentWidth: number;
  documentHeight: number;
  artboard: { id: number; bounds: Bounds } | null;
}

export interface GenerationArchive {
  v: 1;
  prompt: string;
  provider: string;
  model: string;
  modelLabel: string;
  resolution: string;
  ratio: string;
  quality: string;
  resolvedQuality?: string;
  includeSelection: boolean;
  placeAsSmartObject?: boolean;
  referenceNames: string[];
  requestedSize: string;
  outputWidth: number;
  outputHeight: number;
  createdAt: string;
  // Stage 2 can add reusable in-file asset pointers without changing the Stage
  // 1 fields or invalidating records already stored in PSD/PSB files.
  references?: ArchivedReference[];
  geometry?: ArchivedGenerationGeometry;
}

function isBounds(value: any): value is Bounds {
  return (
    value != null &&
    [value.left, value.top, value.right, value.bottom].every(Number.isFinite) &&
    value.right > value.left &&
    value.bottom > value.top
  );
}

function isGenerationGeometry(value: any): value is ArchivedGenerationGeometry {
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

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

// Checks geometry only: unchanged dimensions cannot prove the content is still
// in its original position. Never scale, offset or clip the saved rectangle.
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

function isArchivedReference(value: any): value is ArchivedReference {
  return (
    typeof value?.id === "string" &&
    typeof value.hash === "string" &&
    Number.isFinite(value.layerId) &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    Number.isFinite(value.byteLength)
  );
}

function isGenerationArchive(value: any): value is GenerationArchive {
  return (
    value?.v === 1 &&
    typeof value.prompt === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.modelLabel === "string" &&
    typeof value.resolution === "string" &&
    typeof value.ratio === "string" &&
    typeof value.quality === "string" &&
    typeof value.includeSelection === "boolean" &&
    (value.placeAsSmartObject === undefined || typeof value.placeAsSmartObject === "boolean") &&
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

function isReferenceAssetMetadata(value: any): value is ReferenceAssetMetadata {
  return (
    value?.kind === "referenceAsset" &&
    value.v === 1 &&
    typeof value.id === "string" &&
    typeof value.hash === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    Number.isFinite(value.byteLength) &&
    typeof value.createdAt === "string"
  );
}

function isReferenceAssetPoolMetadata(value: any): value is ReferenceAssetPoolMetadata {
  return value?.kind === "referenceAssetPool" && value.v === 1 && typeof value.name === "string";
}

async function writeLayerMetadata(docId: number, layerId: number, value: unknown): Promise<void> {
  await action.batchPlay(
    [
      {
        _obj: "set",
        _target: [
          { _property: "generatorSettings" },
          { _ref: "layer", _id: layerId },
          { _ref: "document", _id: docId },
        ],
        to: { _obj: "null", json: JSON.stringify(value) },
        property: ARCHIVE_SETTINGS_KEY,
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

async function readLayerMetadata(docId: number, layerId: number): Promise<unknown | null> {
  let result: any[];
  try {
    result = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "generatorSettings" },
            { _ref: "layer", _id: layerId },
            { _ref: "document", _id: docId },
          ],
          property: ARCHIVE_SETTINGS_KEY,
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
  } catch {
    // Most layers have no Mega Musa metadata. Photoshop may report that absence
    // as a failed property lookup rather than an empty descriptor.
    return null;
  }

  const descriptor = result?.[0];
  const settings = descriptor?.generatorSettings;
  const raw =
    settings?.json ??
    settings?.[ARCHIVE_SETTINGS_KEY]?.json ??
    descriptor?.[ARCHIVE_SETTINGS_KEY]?.json ??
    descriptor?.json;
  if (typeof raw !== "string" || !raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    console.log("[Mega Musa] ignored invalid metadata on a layer.");
    return null;
  }
}

// This runs inside the same executeAsModal operation that creates the layer, so
// the pixels and their provenance are committed together to the exact layer ID.
export async function writeLayerGenerationArchive(
  docId: number,
  layerId: number,
  archive: GenerationArchive
): Promise<void> {
  await writeLayerMetadata(docId, layerId, archive);
}

export async function readLayerGenerationArchive(
  docId: number,
  layerId: number
): Promise<GenerationArchive | null> {
  const archive = await readLayerMetadata(docId, layerId);
  if (isGenerationArchive(archive)) {
    // Optional rectangle data must not make the prompt/settings unreadable.
    if (archive.geometry !== undefined && !isGenerationGeometry(archive.geometry)) {
      console.log("[Mega Musa] ignored invalid rectangle geometry in the generation archive.");
      return { ...archive, geometry: undefined };
    }
    return archive;
  }
  if (archive === null || isReferenceAssetMetadata(archive) || isReferenceAssetPoolMetadata(archive)) return null;
  console.log("[Mega Musa] ignored invalid generation archive metadata on the selected layer.");
  return null;
}

export async function writeLayerReferenceAssetMetadata(
  docId: number,
  layerId: number,
  metadata: ReferenceAssetMetadata
): Promise<void> {
  await writeLayerMetadata(docId, layerId, metadata);
}

export async function readLayerReferenceAssetMetadata(
  docId: number,
  layerId: number
): Promise<ReferenceAssetMetadata | null> {
  const metadata = await readLayerMetadata(docId, layerId);
  return isReferenceAssetMetadata(metadata) ? metadata : null;
}

export async function writeLayerReferenceAssetPoolMetadata(
  docId: number,
  layerId: number,
  metadata: ReferenceAssetPoolMetadata
): Promise<void> {
  await writeLayerMetadata(docId, layerId, metadata);
}

export async function readLayerReferenceAssetPoolMetadata(
  docId: number,
  layerId: number
): Promise<ReferenceAssetPoolMetadata | null> {
  const metadata = await readLayerMetadata(docId, layerId);
  return isReferenceAssetPoolMetadata(metadata) ? metadata : null;
}
