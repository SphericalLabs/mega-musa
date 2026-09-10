/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type EmbeddedResultStorage } from "../archive/types";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ActiveArtboard {
  id: number;
  name: string;
  bounds: Bounds;
}

export interface ImageBuffer {
  data: Uint8Array;
  width: number;
  height: number;
  components: number;
}

export interface RegionRead {
  image: ImageBuffer;
  // Crop-sized coverage (0..255), present only when withMask is requested.
  mask?: Uint8Array;
  debug: string;
}

export interface SelectionSnapshot {
  bounds: Bounds;
  // Region-sized selection coverage, 0..255, including feathering.
  data: Uint8Array;
}

export type PlacementClip = "none" | "mask" | "alpha";

export interface PlacementResult {
  clip: PlacementClip;
  layerId: number;
  smartObject: boolean;
  archiveSaved: boolean;
  referenceArchiveFailures: number;
  resultStorage: EmbeddedResultStorage;
}

export interface PastedImage extends ImageBuffer {
  // Clipboard dimensions before any paste downscaling.
  originalWidth: number;
  originalHeight: number;
}
