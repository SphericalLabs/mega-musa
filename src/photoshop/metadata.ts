/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import {
  isGenerationArchive,
  isGenerationGeometry,
  isReferenceAssetMetadata,
  isReferenceAssetPoolMetadata,
} from "../archive/schema";
import {
  type GenerationArchive,
  type ReferenceAssetMetadata,
  type ReferenceAssetPoolMetadata,
} from "../archive/types";

import { batchPlay } from "./runtime";

// Namespace generatorSettings so writes preserve other plugins' layer metadata.
export const ARCHIVE_SETTINGS_KEY = "io_sphericals_mega_musa";

export async function writeLayerMetadata(docId: number, layerId: number, value: unknown): Promise<void> {
  await batchPlay(
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

export async function readLayerMetadata(docId: number, layerId: number): Promise<unknown | null> {
  let result: any[];
  try {
    result = await batchPlay(
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
    // Photoshop may report missing metadata as a failed property lookup.
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

// Called in layer creation's modal scope; metadata failure can leave pixels placed.
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
