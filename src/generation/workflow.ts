/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { addToBudget } from "../budget";
import { formatMoney } from "../currency";
import { errorMessage } from "../errors";
import { modelSpec } from "../models/catalog";
import { actualUsageUSD, estimatedTotalUSD } from "../models/pricing";
import { isOpenAIModel } from "../models/provider";
import { imageQualityLabel } from "../models/quality";
import { placeResult } from "../photoshop/placement";
import { awaitCancellable, isCancelledError, newAbortController, throwIfCancelled } from "./cancellation";
import { type GenerationJob } from "./types";

import { generateImage } from "../providers/images";
import { type GenerateResult } from "../providers/types";
import { type GenerationContext, setGenerationNote } from "./context";
import { createPlacementWorkflow } from "./placement";
import { prepareGeneration } from "./prepare";
import { prepareGenerationResult } from "./result";

export interface GenerationServices {
  prepare?: typeof prepareGeneration;
  generate?: typeof generateImage;
  place?: typeof placeResult;
}
export function createGenerationWorkflow(context: GenerationContext, services: GenerationServices = {}) {
  const { queue, setStatus, renderBudget, onQueueRefresh } = context;
  const prepare = services.prepare || prepareGeneration;
  const generate = services.generate || generateImage;
  const placement = createPlacementWorkflow(context, services.place || placeResult);
  async function runGenerationJob(job: GenerationJob): Promise<void> {
    const {
      prompt,
      model,
      quality,
      apiKey,
      resolution,
      includeSelection,
      references: generationRefs,
    } = job;
    const spec = modelSpec(model);
    try {
      const input = await prepare(job, context);
      const { frame, notes, requestReferences, basePng } = input;
      const sizeLabel = frame.geminiAspect ?? frame.openaiSize ?? "auto";
      const modeLabel = includeSelection
        ? "editing the canvas"
        : generationRefs.length
          ? "from references"
          : "text-to-image";
      const qualitySuffix = isOpenAIModel(model) ? `, ${imageQualityLabel(quality)} quality` : "";
      throwIfCancelled(job);
      await queue.waitForSlot(job);
      const baseReq = {
        apiKey,
        model,
        prompt,
        baseImagePng: basePng,
        references: requestReferences,
      };
      let result: GenerateResult;
      try {
        throwIfCancelled(job);
        queue.update(
          job,
          "generating",
          `Generating ${sizeLabel} @ ${resolution === "auto" ? "default" : resolution}${qualitySuffix} with ${model} — ${modeLabel}…`
        );
        const controller = newAbortController();
        job.sentCharge = estimatedTotalUSD(spec, resolution, frame.openaiSize, quality);
        job.requestSent = true;
        const request = generate({ ...baseReq, frame, resolution, quality, signal: controller.signal });
        // Prepare the shared reference archive while the provider request is in flight.
        void job.archiveReferences();
        result = await awaitCancellable(job, request, controller);
      } finally {
        queue.releaseSlot(job);
      }
      // Disable cancellation during placement to preserve the returned image.
      job.cancelInFlight = null;
      queue.update(job, "placing", "Preparing returned image…");

      // Record cost before decoding or placement; prefer usage data when available.
      const actualCost = result.usage ? actualUsageUSD(spec, result.usage) : null;
      const budgetCharge = actualCost ?? job.sentCharge;
      renderBudget(addToBudget(budgetCharge));
      const resolvedQuality = isOpenAIModel(model) ? result.usage?.quality || quality : undefined;
      const usageDetails: string[] = [];
      if (resolvedQuality) usageDetails.push(`${imageQualityLabel(resolvedQuality)} quality`);
      if (actualCost !== null) usageDetails.push(`actual ca. ${formatMoney(actualCost)}`);
      else if (isOpenAIModel(model) && job.sentCharge !== null) {
        usageDetails.push(`estimate ca. ${formatMoney(job.sentCharge)}`);
      }
      if (usageDetails.length) {
        setGenerationNote(context, job, [notes.join(" "), usageDetails.join("; ")].filter(Boolean).join(" "));
      }

      job.pendingPlacement = prepareGenerationResult(job, input, result, usageDetails, context);
      await placement.completeGenerationPlacement(job);
    } catch (err: any) {
      if (isCancelledError(err)) {
        // Canceling the wait cannot confirm provider cancellation. Budget sent requests at
        // the frozen estimate because final usage is unavailable.
        if (job.requestSent) {
          renderBudget(addToBudget(job.sentCharge, true));
          setStatus(
            job.sentCharge === null
              ? "Canceled — the request was already sent, so it counts as billed. This tier has no published price, so no amount was added."
              : `Canceled — the request was already sent, so it counts as billed: ca. ${formatMoney(job.sentCharge)} added to the budget.`
          );
        } else {
          setStatus("Canceled before anything was sent — nothing was charged.");
        }
        queue.remove(job);
      } else {
        const message = (job.pendingPlacement ? "Image generated, but Photoshop placement failed. " : "") + errorMessage(err);
        if (!placement.preserveTimedOutPlacement(job, err)) {
          job.pendingPlacement = null;
          queue.update(job, "failed", "Error: " + message);
          setStatus("Error: " + message, "error");
        }
      }
    } finally {
      queue.releaseSlot(job);
      queue.pump();
      job.cancelInFlight = null;
      job.cancelSlotWait = null;
      onQueueRefresh();
    }
  }
  return { runGenerationJob, retryGenerationPlacement: placement.retryGenerationPlacement };
}
export type GenerationWorkflow = ReturnType<typeof createGenerationWorkflow>;
