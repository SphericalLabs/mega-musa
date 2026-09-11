/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ModelSettings } from "../models/types";
import { type GenerationArchive } from "../archive/types";
import { type DocumentState } from "../photoshop/document-state";
import { type ActiveArtboard, type Bounds, type SelectionSnapshot } from "../photoshop/types";
import { type ImageQuality } from "../providers/types";
import { type RefImage } from "../references";
import { type CancellableJob } from "./cancellation";

export type GenerationJobState =
  | "preparing"
  | "waiting"
  | "generating"
  | "placing"
  | "cancelling"
  | "placement-failed"
  | "failed";

export interface PendingGenerationPlacement {
  region: Bounds;
  rgba: Uint8Array;
  width: number;
  height: number;
  layerName: string;
  selectionSnapshot: SelectionSnapshot | null;
  archive: GenerationArchive;
  returnedSize: string;
  notes: string[];
  usageDetails: string[];
  isRegion: boolean;
  activeArtboard: ActiveArtboard | null;
}

// Captured at submission; subsequent panel changes cannot retarget a queued job.
export interface GenerationInput {
  readonly prompt: string;
  readonly model: string;
  readonly provider: string;
  readonly quality: ImageQuality;
  readonly apiKey: string;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly settings?: ModelSettings;
  readonly resolution: string;
  readonly includeSelection: boolean;
  readonly placeAsSmartObject: boolean;
  readonly reduceDocumentSize: boolean;
  readonly references: RefImage[];
  readonly archiveReferences: () => Promise<RefImage[]>;
  readonly docId: number;
  readonly docWidth: number;
  readonly docHeight: number;
  readonly anchorLayerId: number | null;
  readonly activeArtboard: ActiveArtboard | null;
  readonly rawSelection: Bounds | null;
  readonly documentState: DocumentState;
}

export interface GenerationJob extends GenerationInput, CancellableJob {
  readonly id: number;
  state: GenerationJobState;
  status: string;
  cancelSlotWait: (() => void) | null;
  slotAcquired: boolean;
  requestSent: boolean;
  sentCharge: number | null;
  pendingPlacement: PendingGenerationPlacement | null;
}
