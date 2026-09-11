/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ModelSettings } from "../models/types";
import { type Bounds } from "../photoshop/types";

export type AssetStorageMode = "original" | "png-srgb" | "jpeg-90";

export interface EmbeddedResultStorage {
  mode: "raster" | "png-srgb" | "jpeg-90";
  mimeType?: "image/png" | "image/jpeg";
  byteLength?: number;
  lossy: boolean;
}

export interface ArchivedReference {
  id: string;
  hash: string;
  layerId: number;
  name: string;
  mimeType: string;
  byteLength: number;
  storageMode?: AssetStorageMode;
  sourceMimeType?: string;
  sourceByteLength?: number;
  lossy?: boolean;
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
  storageMode?: AssetStorageMode;
  sourceMimeType?: string;
  sourceByteLength?: number;
  lossy?: boolean;
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
  providerId?: string;
  settings?: ModelSettings;
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
  reduceDocumentSize?: boolean;
  resultStorage?: EmbeddedResultStorage;
  referenceNames: string[];
  requestedSize: string;
  outputWidth: number;
  outputHeight: number;
  createdAt: string;
  // Optional asset pointers keep older prompt-only archives readable.
  references?: ArchivedReference[];
  geometry?: ArchivedGenerationGeometry;
}
