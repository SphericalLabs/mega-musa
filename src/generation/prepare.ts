/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type HostModalReservation, acquireHostModalTask } from "../host-modal";
import { encodePng } from "../images/codec";
import { modelSpec } from "../models/catalog";
import { outputFrame } from "../models/geometry";
import { resolutionLabel } from "../models/labels";
import { fitRegionToRatio, intersectBounds } from "../photoshop/geometry";
import { readRegion } from "../photoshop/pixels";
import { captureSelection, setRectSelection } from "../photoshop/selection";
import { type Bounds, type SelectionSnapshot } from "../photoshop/types";
import { type RefImage as RequestReference } from "../providers/types";
import { cancelledError, throwIfCancelled } from "./cancellation";
import { pixelSize, placementCoversEntireTarget } from "./presentation";
import { type GenerationJob } from "./types";

import { type GenerationContext, setGenerationNote } from "./context";

const REQUEST_MIN_MAX_EDGE = 2048;
export async function prepareGeneration(job: GenerationJob, context: GenerationContext) {
  const { queue, processor } = context;
  const {
    model,
    resolution,
    includeSelection,
    references: generationRefs,
    docId,
    docWidth: docW,
    docHeight: docH,
    activeArtboard,
    rawSelection,
  } = job;
  const spec = modelSpec(model);

  let hostReservation: HostModalReservation | null = null;
  try {
    throwIfCancelled(job);
    const documentBounds: Bounds = { left: 0, top: 0, right: docW, bottom: docH };
    const targetBounds = activeArtboard?.bounds || documentBounds;
    const targetW = targetBounds.right - targetBounds.left;
    const targetH = targetBounds.bottom - targetBounds.top;

    const hasSelection =
      !!rawSelection && rawSelection.right - rawSelection.left > 1 && rawSelection.bottom - rawSelection.top > 1;
    const sel = hasSelection ? intersectBounds(rawSelection as Bounds, targetBounds) : null;
    if (hasSelection && activeArtboard && !sel) {
      throw new Error(`The selection does not overlap the active artboard “${activeArtboard.name}”.`);
    }
    const isRegion = !!sel;

    // Start from the selection or active target; aspect fitting may expand or shrink it
    // within the target bounds.
    const baseRegion: Bounds = isRegion ? (sel as Bounds) : targetBounds;
    const baseW = baseRegion.right - baseRegion.left;
    const baseH = baseRegion.bottom - baseRegion.top;

    // Fit the crop while preserving the existing selection shape for placement.
    const frame = outputFrame(spec, resolution, baseW, baseH);
    const ratioLabel = frame.label;
    const region = fitRegionToRatio(baseRegion, frame.ratio, targetBounds);
    const cropW = region.right - region.left;
    const cropH = region.bottom - region.top;

    queue.update(job, "preparing", "Waiting to freeze Photoshop input…");
    hostReservation = await acquireHostModalTask();
    throwIfCancelled(job);
    const snapshotLease = hostReservation.lease;
    if (isRegion) queue.update(job, "preparing", "Capturing selection…");
    let selectionSnapshot: SelectionSnapshot | null = isRegion
      ? await captureSelection(docId, region, snapshotLease)
      : null;
    throwIfCancelled(job);
    const coversEntireTarget = placementCoversEntireTarget(region, targetBounds, selectionSnapshot);

    const openaiDimensions = frame.openaiSize?.split("x").map(Number) || [];
    const exactOutputSize =
      openaiDimensions.length === 2 && openaiDimensions.every(Number.isFinite)
        ? pixelSize(openaiDimensions[0], openaiDimensions[1])
        : "";
    const [pickerRatioW, pickerRatioH] = ratioLabel.split(":").map(Number);
    const pickerIsApproximate =
      !!exactOutputSize &&
      openaiDimensions[0] * pickerRatioH !== openaiDimensions[1] * pickerRatioW;
    const tierLongEdge: Record<string, number> = {
      "512px": 512,
      "1K": 1024,
      "2K": 2048,
      "4K": 4096,
    };
    const outputLongEdge = openaiDimensions.length === 2
      ? Math.max(openaiDimensions[0], openaiDimensions[1])
      : tierLongEdge[resolution] || 1024;
    const requestMaxEdge = Math.max(REQUEST_MIN_MAX_EDGE, outputLongEdge);

    const notes: string[] = [];
    if (
      isRegion &&
      activeArtboard &&
      rawSelection &&
      (sel!.left !== rawSelection.left ||
        sel!.top !== rawSelection.top ||
        sel!.right !== rawSelection.right ||
        sel!.bottom !== rawSelection.bottom)
    ) {
      notes.push(`Only the part of the selection inside active artboard “${activeArtboard.name}” is used.`);
    }
    if (!isRegion) {
      // Check cancellation before creating a visible selection for the fitted target.
      throwIfCancelled(job);
      await setRectSelection(region, docId, snapshotLease);
      const cropped = cropW !== targetW || cropH !== targetH;
      const what = includeSelection ? "what was sent" : "where the result lands";
      const targetName = activeArtboard ? `active artboard “${activeArtboard.name}”` : "the full image";
      if (cropped) {
        const trimmed =
          cropW !== targetW ? `${targetW - cropW}px off the width` : `${targetH - cropH}px off the height`;
        notes.push(
          `No selection — selected ${targetName} and fit it to ${ratioLabel}: ` +
          `${cropW}×${cropH} of ${targetW}×${targetH} (${trimmed}). The selection shows ${what}.`
        );
      } else {
        notes.push(
          `No selection — selected ${targetName} (${targetW}×${targetH}), already ${ratioLabel}, so nothing was cropped.`
        );
      }
    }
    const outputFrameNote = exactOutputSize
      ? `${exactOutputSize}${pickerIsApproximate ? `; picker shows nearest ratio ${ratioLabel}` : ""}`
      : `${ratioLabel} at ${resolution === "auto" ? "default resolution" : resolutionLabel(resolution)}`;
    if (isRegion) {
      notes.push(`Region edit — output request: ${outputFrameNote}; result stays clipped to your selection.`);
    } else if (exactOutputSize) {
      notes.push(`Output request: ${outputFrameNote}.`);
    }
    if (!includeSelection) {
      notes.push(
        generationRefs.length
          ? `“Include Photoshop selection” is off — generating from the prompt and ${generationRefs.length} reference image${generationRefs.length === 1 ? "" : "s"} only.`
          : "“Include Photoshop selection” is off and there are no references — plain text-to-image from the prompt."
      );
    }
    setGenerationNote(context, job, notes.join(" "));

    let basePng: Uint8Array | undefined;
    if (includeSelection) {
      queue.update(
        job,
        "preparing",
        isRegion
          ? "Reading selected region…"
          : activeArtboard
            ? `Reading active artboard “${activeArtboard.name}”…`
            : "Reading full image…"
      );
      // Apply selection coverage during placement, leaving request pixels unmasked.
      const read = await readRegion(docId, region, false, requestMaxEdge, snapshotLease);
      if (Math.max(read.image.width, read.image.height) > requestMaxEdge) {
        throw new Error("Photoshop returned a canvas input larger than the request limit.");
      }
      basePng = encodePng(read.image.data, read.image.width, read.image.height, read.image.components);
      console.log("[Mega Musa]", read.debug);
      throwIfCancelled(job);
    }

    if (!(await context.confirmDocumentWarnings(job.documentState, coversEntireTarget))) {
      job.cancelRequested = true;
      throw cancelledError();
    }
    hostReservation.release();
    hostReservation = null;
    throwIfCancelled(job);

    const requestReferences: RequestReference[] = [];
    for (let index = 0; index < generationRefs.length; index += 1) {
      throwIfCancelled(job);
      queue.update(
        job,
        "preparing",
        `Preparing reference image ${index + 1}/${generationRefs.length}…`
      );
      requestReferences.push(await processor.resize(generationRefs[index], { maxEdge: requestMaxEdge }));
    }

    return { frame, region, cropW, cropH, isRegion, selectionSnapshot, notes, exactOutputSize, outputFrameNote, openaiDimensions, requestReferences, basePng };
  } finally { hostReservation?.release(); }
}
export type PreparedGeneration = Awaited<ReturnType<typeof prepareGeneration>>;
