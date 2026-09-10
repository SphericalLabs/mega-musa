/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { getActiveArtboard } from "./photoshop/artboards";
export { readClipboardImage } from "./photoshop/clipboard";
export { fitRegionToRatio, intersectBounds, selectionNeedsMask } from "./photoshop/geometry";
export { bringResultToDocumentFront } from "./photoshop/layers";
export { readLayerThumbnail, readRegion } from "./photoshop/pixels";
export { placeResult } from "./photoshop/placement";
export { getActiveDoc } from "./photoshop/runtime";
export { scaleViaPhotoshop } from "./photoshop/scaling";
export {
  captureSelection,
  getSelectionBounds,
  restoreArchivedSelection,
  setRectSelection,
} from "./photoshop/selection";
export type {
  ActiveArtboard,
  Bounds,
  ImageBuffer,
  PastedImage,
  PlacementClip,
  PlacementResult,
  RegionRead,
  SelectionSnapshot,
} from "./photoshop/types";
