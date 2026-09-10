/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import { HostModalTimeoutError, PAID_PLACEMENT_MODAL_TIMEOUT_SECONDS } from "../host-modal";
import { placeResult } from "../photoshop/placement";
import { type GenerationJob } from "./types";

import { type GenerationContext, setGenerationNote } from "./context";

export function createPlacementWorkflow(context: GenerationContext, place: typeof placeResult = placeResult) {
  const { queue, setStatus, onRecallRefresh, onQueueRefresh } = context;
  function preserveTimedOutPlacement(job: GenerationJob, error: any): boolean {
    if (!(error instanceof HostModalTimeoutError) || !job.pendingPlacement) return false;
    const message = `Paid result preserved. ${error.message}`;
    queue.update(job, "placement-failed", message);
    setStatus(`Placement paused — ${message}`, "error");
    return true;
  }

  async function completeGenerationPlacement(job: GenerationJob): Promise<void> {
    const pending = job.pendingPlacement;
    if (!pending) throw new Error("The generated image is no longer available for placement.");

    queue.update(job, "placing", "Waiting to place the paid result in Photoshop…");
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
    onRecallRefresh();

    if (placement.smartObject) {
      const storage = placement.resultStorage?.mode === "jpeg-90" ? "JPEG 90" : "lossless sRGB PNG";
      pending.notes.push(
        `The full-resolution ${pending.returnedSize} result is embedded as ${storage} and sized nondestructively to the raster placement bounds.`
      );
      setGenerationNote(context, job,
        [pending.notes.join(" "), pending.usageDetails.join("; ")].filter(Boolean).join(" ")
      );
    }

    const doneMessage = pending.isRegion
      ? placement.clip === "alpha"
        ? "Done — raster fallback clipped to the selection captured at the start with baked transparency."
        : placement.clip === "mask"
          ? placement.smartObject
            ? "Done — result embedded as a Smart Object with an editable linked mask."
            : "Done — raster fallback clipped to your selection with an editable mask."
          : placement.smartObject
            ? "Done — result embedded as a Smart Object; the fully opaque selection needed no mask."
            : "Done — result added as a raster layer; the fully opaque selection needed no mask."
      : pending.activeArtboard
        ? placement.smartObject
          ? `Done — result framed to active artboard “${pending.activeArtboard.name}” and embedded at the top of the document as a Smart Object.`
          : `Done — result framed to active artboard “${pending.activeArtboard.name}” and added at the top of the document as a raster layer.`
        : placement.smartObject
          ? "Done — full-image result embedded as a Smart Object."
          : "Done — full-image result added as a raster layer.";
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
      if (!preserveTimedOutPlacement(job, error)) {
        job.pendingPlacement = null;
        queue.update(job, "failed", "Error: " + message);
        setStatus("Error: " + message, "error");
      }
    } finally {
      onQueueRefresh();
    }
  }

  return { completeGenerationPlacement, retryGenerationPlacement, preserveTimedOutPlacement };
}
