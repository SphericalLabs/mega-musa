/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type GenerationArchive } from "../archive/types";
import { decodeImage } from "../images/codec";
import { toRGBA } from "../images/pixels";
import { modelSpec } from "../models/catalog";
import { resolutionLabel } from "../models/labels";
import { modelNameWithoutYear, pixelSize, ratioDiffers, resultLayerName } from "./presentation";
import { type GenerationJob } from "./types";

import { type GenerateResult } from "../providers/types";
import { type GenerationContext, setGenerationNote } from "./context";
import { type PreparedGeneration } from "./prepare";
import { type PendingGenerationPlacement } from "./types";

export function prepareGenerationResult(job: GenerationJob, input: PreparedGeneration, result: GenerateResult, usageDetails: string[], context: GenerationContext): PendingGenerationPlacement {
  const {
    prompt,
    model,
    provider,
    quality,
    resolution,
    includeSelection,
    placeAsSmartObject,
    reduceDocumentSize,
    references: generationRefs,
    docWidth: docW,
    docHeight: docH,
    activeArtboard,
    rawSelection,
  } = job;
  const spec = modelSpec(model);

  const { queue } = context;
  const { frame, region, cropW, cropH, isRegion, selectionSnapshot, notes, exactOutputSize, outputFrameNote, outputDimensions } = input;
  const ratioLabel = frame.label;
  const resolvedQuality = spec.qualities.length > 1 ? result.usage?.quality || quality : undefined;
  const decoded = decodeImage(result.mimeType, result.bytes);
  const returnedSize = pixelSize(decoded.width, decoded.height);
  const returnedRatioDiffers = ratioDiffers(decoded.width, decoded.height, frame.ratio);
  const returnedSizeDiffers =
    !!exactOutputSize &&
    (decoded.width !== outputDimensions[0] || decoded.height !== outputDimensions[1]);
  if (returnedRatioDiffers) {
    notes.push(
      exactOutputSize
        ? `Provider returned ${returnedSize} instead of ${exactOutputSize}. It fills the original rectangle proportionally, with excess edges hidden by an editable mask.`
        : `Provider returned ${returnedSize} instead of the requested ${ratioLabel} frame. It fills the original rectangle proportionally, with excess edges hidden by an editable mask.`
    );
  } else if (returnedSizeDiffers) {
    notes.push(`Provider returned ${returnedSize} instead of ${exactOutputSize}. It is sized to fit without stretching.`);
  }
  if (returnedRatioDiffers || returnedSizeDiffers) {
    setGenerationNote(context, job, [notes.join(" "), usageDetails.join("; ")].filter(Boolean).join(" "));
  }
  const rgba = toRGBA(decoded.data, decoded.width, decoded.height, decoded.channels);

  queue.update(job, "placing", "Placing result at the top of the document…");
  // Auto and fixed-size outputs need an inferred tier for the archive and layer label.
  const layerDetails: string[] = [modelNameWithoutYear(spec.label)];
  const outputK = Math.sqrt(decoded.width * decoded.height) / 1024;
  const inferredTier = outputK < Math.SQRT2 ? "1K" : outputK < 2 * Math.SQRT2 ? "2K" : "4K";
  const resolutionDetail = spec.imageSizes.length && resolution !== "auto"
    ? resolutionLabel(resolution)
    : inferredTier;
  layerDetails.push(resolutionDetail);
  const archive: GenerationArchive = {
    v: 1,
    providerId: spec.provider,
    settings: job.settings,
    prompt,
    provider,
    model,
    modelLabel: spec.label,
    resolution,
    ratio: ratioLabel,
    quality,
    resolvedQuality,
    includeSelection,
    placeAsSmartObject,
    reduceDocumentSize,
    referenceNames: generationRefs.map((reference) => reference.name),
    requestedSize: exactOutputSize || outputFrameNote,
    outputWidth: cropW,
    outputHeight: cropH,
    createdAt: new Date().toISOString(),
    geometry: {
      selectionBounds: isRegion ? { ...rawSelection! } : null,
      generationBounds: { ...region },
      documentWidth: docW,
      documentHeight: docH,
      artboard: activeArtboard
        ? { id: activeArtboard.id, bounds: { ...activeArtboard.bounds } }
        : null,
    },
  };
  return {
    region,
    rgba,
    width: decoded.width,
    height: decoded.height,
    layerName: resultLayerName(prompt, layerDetails),
    selectionSnapshot,
    archive,
    returnedSize,
    notes,
    usageDetails,
    isRegion,
    activeArtboard,
  };

}
