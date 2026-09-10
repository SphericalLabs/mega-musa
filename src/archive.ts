/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { getRecallSelectionBounds } from "./archive/schema";
export type {
  ArchivedGenerationGeometry,
  ArchivedReference,
  AssetStorageMode,
  EmbeddedResultStorage,
  GenerationArchive,
  ReferenceAssetMetadata,
  ReferenceAssetPoolMetadata,
} from "./archive/types";
export {
  ARCHIVE_SETTINGS_KEY,
  readLayerGenerationArchive,
  readLayerReferenceAssetMetadata,
  readLayerReferenceAssetPoolMetadata,
  writeLayerGenerationArchive,
  writeLayerReferenceAssetMetadata,
  writeLayerReferenceAssetPoolMetadata,
} from "./photoshop/metadata";
