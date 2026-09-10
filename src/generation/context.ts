/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type Budget } from "../budget";
import { type DocumentState } from "../photoshop/document-state";
import { type ReferenceImageProcessor } from "../references/processor";
import { type GenerationQueue } from "./queue";
import { type GenerationJob } from "./types";

export interface GenerationContext {
  queue: GenerationQueue;
  processor: Pick<ReferenceImageProcessor, "resize">;
  setStatus(message: string, kind?: "info" | "error" | "ok"): void;
  setNote(message: string): void;
  renderBudget(budget: Budget): void;
  confirmDocumentWarnings(state: DocumentState, coversEntireTarget: boolean): Promise<boolean>;
  onRecallRefresh(): void;
  onQueueRefresh(): void;
}

export function setGenerationNote(context: GenerationContext, job: GenerationJob, message: string): void {
  if (job.id === context.queue.latestId) context.setNote(message);
}
