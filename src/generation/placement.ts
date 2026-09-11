/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import { PAID_PLACEMENT_MODAL_TIMEOUT_SECONDS } from "../host-modal";
import { placeResult } from "../photoshop/placement";
import { type GenerationJob } from "./types";

import { type GenerationContext, setGenerationNote } from "./context";

export function createPlacementWorkflow(context: GenerationContext, place: typeof placeResult = placeResult) {
  const { queue, setStatus, onRecallRefresh, onQueueRefresh } = context;
  function preserveFailedPlacement(job: GenerationJob, error: any): boolean {
    if (!job.pendingPlacement) return false;
    const message = `Paid result preserved. ${errorMessage(error)} Use Retry Placement to place it without generating again.`;
    queue.update(job, "placement-failed", message);
    setStatus(`Placement paused — ${message}`, "error");
    return true;
  }

  async function completeGenerationPlacement(job: GenerationJob): Promise<void> {
    const pending = job.pendingPlacement;
    if (!pending) throw new Error("The generated image is no longer available for placement.");

    queue.update(job, "placing", "Waiting to place the paid result. Close any open Photoshop tool menu or dialog…");
    const placement = await place({
      docId: job.docId,
      bounds: pending.region,
      rgba: pending.rgba,
      width: pending.width,
      height: pending.height,
      layerName: pending.layerName,
      selection: pending.selectionSnapshot,
      placeAsSmartObject: job.placeAsSmartObject,
      reduceDocumentSize: job.reduceDocumentSize,
      archive: pending.archive,
      references: await job.archiveReferences(),
      anchorLayerId: job.anchorLayerId,
    }, { timeoutSeconds: PAID_PLACEMENT_MODAL_TIMEOUT_SECONDS });
    // Placement succeeded. A later panel-refresh error must not offer to place it twice.
    job.pendingPlacement = null;
    onRecallRefresh();

    if (placement.smartObject) {
      const storage = placement.resultStorage?.mode === "jpeg-90" ? "JPEG 90" : "lossless sRGB PNG";
      pending.notes.push(
        `The full-resolution ${pending.returnedSize} result is embedded as ${storage}, scaled proportionally and clipped to the original rectangle.`
      );
      setGenerationNote(context, job,
        [pending.notes.join(" "), pending.usageDetails.join("; ")].filter(Boolean).join(" ")
      );
    }

    const maskSuffix = placement.clip === "mask" ? " with an editable linked mask" : "";
    const doneMessage = pending.isRegion
      ? placement.clip === "mask"
        ? placement.smartObject
          ? "Done — result embedded as a Smart Object with an editable linked mask."
          : "Done — complete scaled image added as a pixel layer with an editable linked mask."
        : `Done — result ${placement.smartObject ? "embedded as a Smart Object" : "added as a pixel layer"}; the image fits the opaque selection without a mask.`
      : pending.activeArtboard
        ? placement.smartObject
          ? `Done — result framed to active artboard “${pending.activeArtboard.name}” and embedded at the top of the document as a Smart Object.`
          : `Done — result framed to active artboard “${pending.activeArtboard.name}” and added as a pixel layer${maskSuffix}.`
        : placement.smartObject
          ? "Done — full-image result embedded as a Smart Object."
          : `Done — full-image result added as a pixel layer${maskSuffix}.`;
    const archiveMessages: string[] = [];
    if (job.placeAsSmartObject && !placement.smartObject) {
      archiveMessages.push("Smart Object placement failed; the paid result was preserved as a raster layer.");
    }
    if (!placement.archiveSaved) archiveMessages.push("Prompt archive could not be saved; see the console.");
    if (placement.referenceArchiveFailures) {
      archiveMessages.push(
        `${placement.referenceArchiveFailures} reference image${placement.referenceArchiveFailures === 1 ? " was" : "s were"} not embedded; see the console.`
      );
    }
    const archivedMessage = archiveMessages.length ? ` ${archiveMessages.join(" ")}` : "";
    const completedMessage = pending.usageDetails.length
      ? `${doneMessage} (${pending.usageDetails.join(", ")}).${archivedMessage}`
      : `${doneMessage}${archivedMessage}`;
    setStatus(completedMessage, "ok");
    queue.remove(job);
  }

  async function retryGenerationPlacement(job: GenerationJob): Promise<void> {
    if (job.state !== "placement-failed" || !job.pendingPlacement) return;
    try {
      await completeGenerationPlacement(job);
    } catch (error: any) {
      const message = errorMessage(error);
      if (!preserveFailedPlacement(job, error)) {
        job.pendingPlacement = null;
        queue.update(job, "failed", "Error: " + message);
        setStatus("Error: " + message, "error");
      }
    } finally {
      onQueueRefresh();
    }
  }

  return { completeGenerationPlacement, retryGenerationPlacement, preserveFailedPlacement };
}
