/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { runHostModalTask } from "../host-modal";
import { resolutionLabel } from "../models/labels";
import { type Bounds } from "../photoshop/types";
import { type RefImage as RequestReference } from "../providers/types";
import { cancelledError, throwIfCancelled } from "./cancellation";
import { pixelSize, placementCoversEntireTarget } from "./presentation";
import { type GenerationJob } from "./types";

import { type GenerationContext, setGenerationNote } from "./context";

export async function prepareGeneration(job: GenerationJob, context: GenerationContext) {
  const { queue, processor } = context;
  const {
    resolution,
    includeSelection,
    references: generationRefs,
    docWidth: docW,
    docHeight: docH,
    activeArtboard,
    rawSelection,
    frame, region, selectionSnapshot, basePng, requestMaxEdge,
  } = job;
  throwIfCancelled(job);
  const documentBounds: Bounds = { left: 0, top: 0, right: docW, bottom: docH };
  const targetBounds = activeArtboard?.bounds || documentBounds;
  const targetW = targetBounds.right - targetBounds.left;
  const targetH = targetBounds.bottom - targetBounds.top;

  const isRegion = !!rawSelection;
  const ratioLabel = frame.label;
  const cropW = region.right - region.left;
  const cropH = region.bottom - region.top;
  const coversEntireTarget = placementCoversEntireTarget(region, targetBounds, selectionSnapshot);

  const outputDimensions = frame.width && frame.height ? [frame.width, frame.height] : [];
  const exactOutputSize =
    outputDimensions.length === 2 && outputDimensions.every(Number.isFinite)
      ? pixelSize(outputDimensions[0], outputDimensions[1])
      : "";
  const [pickerRatioW, pickerRatioH] = ratioLabel.split(":").map(Number);
  const pickerIsApproximate =
    !!exactOutputSize &&
    outputDimensions[0] * pickerRatioH !== outputDimensions[1] * pickerRatioW;

  const notes: string[] = [];
  if (
    isRegion &&
    activeArtboard &&
    rawSelection &&
    (region.left !== rawSelection.left ||
      region.top !== rawSelection.top ||
      region.right !== rawSelection.right ||
      region.bottom !== rawSelection.bottom)
  ) {
    notes.push(`Only the part of the selection inside active artboard “${activeArtboard.name}” is used.`);
  }
  if (!isRegion) {
    const targetName = activeArtboard ? `active artboard “${activeArtboard.name}”` : "the full image";
    notes.push(`No selection — using all of ${targetName} (${targetW}×${targetH}). The selection shows where the result lands.`);
  }
  const outputFrameNote = exactOutputSize
    ? `${exactOutputSize}${pickerIsApproximate ? `; picker shows nearest ratio ${ratioLabel}` : ""}`
    : `${ratioLabel} at ${resolution === "auto" ? "default resolution" : resolutionLabel(resolution)}`;
  if (isRegion) {
    notes.push(`Region edit — output request: ${outputFrameNote}; result stays clipped to your selection.`);
  } else if (exactOutputSize) {
    notes.push(`Output request: ${outputFrameNote}.`);
  }
  notes.push("The result fills the original rectangle without stretching; excess image edges are cropped.");
  if (!includeSelection) {
    notes.push(
      generationRefs.length
        ? `“Include Photoshop selection” is off — generating from the prompt and ${generationRefs.length} reference image${generationRefs.length === 1 ? "" : "s"} only.`
        : "“Include Photoshop selection” is off and there are no references — plain text-to-image from the prompt."
    );
  }
  setGenerationNote(context, job, notes.join(" "));

  if (!(await runHostModalTask(() => context.confirmDocumentWarnings(job.documentState, coversEntireTarget)))) {
    job.cancelRequested = true;
    throw cancelledError();
  }
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

  return { frame, region, cropW, cropH, isRegion, selectionSnapshot, notes, exactOutputSize, outputFrameNote, outputDimensions, requestReferences, basePng };
}
export type PreparedGeneration = Awaited<ReturnType<typeof prepareGeneration>>;
