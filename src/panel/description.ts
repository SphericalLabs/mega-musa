/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { addDescriptionToBudget } from "../budget";
import { ProviderFailure } from "../providers/failure";
import { validCost } from "../models/pricing";
import { providerCredentials, missingCredential } from "./provider-settings";
import { formatMoney } from "../currency";
import { formatDescriptions } from "../description-format";
import { errorMessage } from "../errors";
import {
  awaitCancellable,
  type CancellableJob,
  isCancelledError,
  newAbortController,
  throwIfCancelled,
} from "../generation/cancellation";
import { GenerationQueue } from "../generation/queue";
import { bytesToBase64 } from "../images/base64";
import { encodePng } from "../images/codec";
import { descriptionModelSpec } from "../models/description-catalog";
import { descriptionUsageUSD, estimatedDescriptionUSD } from "../models/description-pricing";
import { getActiveArtboard } from "../photoshop/artboards";
import { intersectBounds } from "../photoshop/geometry";
import { readRegionInModal } from "../photoshop/pixels";
import { app, getActiveDoc, runModal } from "../photoshop/runtime";
import { getSelectionBounds, replaceRectSelection } from "../photoshop/selection";
import { type Bounds } from "../photoshop/types";
import { type DescriptionModelSpec, type DescriptionUsage } from "../providers/description-types";
import { describeImages } from "../providers/descriptions";
import { type RefImage as RequestReference } from "../providers/types";
import { ReferenceCollection } from "../references/collection";
import { ReferenceImageProcessor } from "../references/processor";
import { $, isChecked } from "./controls";
import { showModalNotice } from "./notices";
import { type PromptController } from "./prompt";
import { descriptionApiKey } from "./settings";
import { renderBudget, setStatus } from "./status";

export interface DescriptionDependencies {
  references: ReferenceCollection;
  processor: Pick<ReferenceImageProcessor, "resize">;
  queue: Pick<GenerationQueue, "hasActive">;
  prompt: Pick<PromptController, "replace" | "setLocked">;
  onBusyChange?: () => void;
}

export function createDescriptionController({ references, processor, queue, prompt, onBusyChange = () => { } }: DescriptionDependencies) {
  let describing = false;

  let descriptionJob: CancellableJob | null = null;

  const DESCRIPTION_INPUT_MAX_EDGE = 2048;

  interface PreparedDescriptionInput {
    source: string;
    image: RequestReference;
  }

  function updateDescriptionControls(): void {
    const busy = queue.hasActive || describing;
    const describeButton = $("describe");
    if (describeButton) {
      describeButton.disabled = !describing && queue.hasActive;
      describeButton.textContent = describing ? "Cancel" : "Describe";
      describeButton.setAttribute("variant", describing ? "warning" : "primary");
    }
    const describeModel = $("describeModel");
    if (describeModel) describeModel.disabled = busy;
  }

  function setDescriptionBusy(on: boolean): void {
    describing = on;
    prompt.setLocked(on);
    onBusyChange();
    updateDescriptionControls();
  }

  function selectedDescriptionModel(): DescriptionModelSpec | null {
    return descriptionModelSpec($("describeModel")?.value || "");
  }

  async function prepareDescriptionInputs(job: CancellableJob): Promise<PreparedDescriptionInput[]> {
    const inputs: PreparedDescriptionInput[] = [];
    const includeSelection = isChecked($("includeSelection"));
    const descriptionRefs = references.snapshot();

    if (includeSelection && app.activeDocument) {
      // Read the selection, pixels and optional full-frame selection in one modal
      // scope so the document cannot change between these operations.
      await runModal("read description input", async () => {
        throwIfCancelled(job);
        const doc = getActiveDoc();
        let rawSelection: Bounds | null = null;
        try {
          rawSelection = await getSelectionBounds(doc.id);
        } catch {
          throwIfCancelled(job);
          throw new Error("Couldn't read the Photoshop selection. Finish the active tool or dialog, then retry.");
        }
        throwIfCancelled(job);
        if (rawSelection && (rawSelection.right - rawSelection.left <= 1 || rawSelection.bottom - rawSelection.top <= 1)) return;
        setStatus(rawSelection ? "Reading Photoshop selection for description…" : "Reading the full Photoshop frame for description…");
        const documentBounds: Bounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const activeArtboard = await getActiveArtboard(doc);
        throwIfCancelled(job);
        const targetBounds = activeArtboard?.bounds || documentBounds;
        const region = rawSelection ? intersectBounds(rawSelection, targetBounds) : targetBounds;
        if (!region) {
          throw new Error(
            activeArtboard
              ? `The selection does not overlap the active artboard “${activeArtboard.name}”.`
              : "The selection does not overlap the Photoshop document."
          );
        }

        const read = await readRegionInModal(doc.id, region, false, DESCRIPTION_INPUT_MAX_EDGE);
        throwIfCancelled(job);
        if (!rawSelection) await replaceRectSelection(region);
        throwIfCancelled(job);
        const png = encodePng(read.image.data, read.image.width, read.image.height, read.image.components);
        inputs.push({
          source: "Photoshop selection",
          image: { mimeType: "image/png", base64: bytesToBase64(png) },
        });
        console.log("[Mega Musa] description", read.debug);
      });
    }

    for (let index = 0; index < descriptionRefs.length; index += 1) {
      const reference = descriptionRefs[index];
      setStatus(`Preparing reference image ${index + 1}/${descriptionRefs.length} for description…`);
      const image = await processor.resize(reference, { maxEdge: DESCRIPTION_INPUT_MAX_EDGE });
      throwIfCancelled(job);
      inputs.push({
        source: `Reference ${index + 1}: ${reference.name}`,
        image,
      });
    }
    return inputs;
  }

  function descriptionUsageText(totalTokens?: number, reasoningTokens?: number): string {
    if (totalTokens === undefined) return "";
    const reasoning = reasoningTokens ? `, including ${Math.round(reasoningTokens)} reasoning tokens` : "";
    return ` (${Math.round(totalTokens)} tokens${reasoning})`;
  }

  async function onDescribe(): Promise<void> {
    if (descriptionJob) {
      descriptionJob.cancelRequested = true;
      const stopRequest = descriptionJob.cancelInFlight;
      descriptionJob.cancelInFlight = null;
      if (stopRequest) stopRequest();
      return;
    }
    if (queue.hasActive || describing) return;
    const model = selectedDescriptionModel();

    const job: CancellableJob = { cancelRequested: false, cancelInFlight: null };
    const controller = newAbortController();
    let requestSent = false;
    let inputImageCount = 0;
    let estimatedCharge: number | null = null;
    let chargeRecorded = false;
    let budgetCharge: number | null = null;
    let usedEstimate = false;
    const recordDescriptionCharge = (usage?: DescriptionUsage, reportedCost?: number) => {
      // A late response after Cancel must not add the same request a second time.
      if (!model || chargeRecorded) return;
      chargeRecorded = true;
      const usageCharge = validCost(reportedCost) ?? (usage ? descriptionUsageUSD(model, usage) : null);
      usedEstimate = usageCharge === null;
      budgetCharge = usageCharge ?? estimatedCharge;
      renderBudget(addDescriptionToBudget(budgetCharge, inputImageCount, job.cancelRequested, usedEstimate));
    };
    const descriptionChargeText = () => !chargeRecorded ? "" : budgetCharge === null ? " Price unknown; no amount added to the budget." :
      ` ${usedEstimate ? "Estimate" : "Usage cost"}: ca. ${formatMoney(budgetCharge)} added to the budget.`;
    descriptionJob = job;
    setDescriptionBusy(true);
    setStatus("Preparing inputs for description…");
    try {
      const inputs = await awaitCancellable(job, prepareDescriptionInputs(job), controller);
      throwIfCancelled(job);
      if (!inputs.length) {
        const message = "Describe requires a Photoshop document or at least one reference image.";
        setStatus(message, "error");
        await showModalNotice({
          kind: "blocker",
          title: "An image is required",
          message,
          instruction: "Add a reference image or open a document and enable Include Photoshop selection.",
          primaryLabel: "Close",
        });
        return;
      }
      if (!model) throw new Error("Choose a description model.");
      const apiKey = descriptionApiKey(model);
      const credentials = providerCredentials(model.provider);
      const missing = missingCredential(model.provider, credentials);
      if (missing) throw new Error(`Enter your ${missing} and press Save.`);

      setStatus(`Describing ${inputs.length} visual input${inputs.length === 1 ? "" : "s"} with ${model.label}… (10–90s)`);
      inputImageCount = inputs.length;
      estimatedCharge = estimatedDescriptionUSD(model, inputImageCount);
      const request = describeImages({
        apiKey,
        credentials,
        onDispatch: () => { throwIfCancelled(job); requestSent = true; },
        model,
        images: inputs.map((input) => input.image),
        signal: controller.signal,
        onUsage: recordDescriptionCharge,
      });
      const result = await awaitCancellable(job, request, controller);
      throwIfCancelled(job);
      recordDescriptionCharge(result.usage);
      if (!prompt.replace(formatDescriptions(inputs, result.descriptions), "Describe")) {
        throw new Error("The description could not be applied to the prompt.");
      }
      updateDescriptionControls();
      setStatus(
        `Prompt filled from ${inputs.length} visual input${inputs.length === 1 ? "" : "s"} with ${model.label}${descriptionUsageText(
          result.usage?.totalTokens,
          result.usage?.reasoningTokens
        )}.${descriptionChargeText()}`,
        "ok"
      );
    } catch (error: any) {
      const failure = error instanceof ProviderFailure ? error : null;
      if (isCancelledError(error) || failure?.outcome.canceled) {
        job.cancelRequested = true;
        if (requestSent || failure?.outcome.costUSD !== undefined) recordDescriptionCharge(undefined, failure?.outcome.costUSD);
        setStatus(
          "Description canceled. Prompt unchanged." + descriptionChargeText() +
          (requestSent ? " Final provider billing may differ." : "")
        );
      } else {
        if (failure?.outcome.costUSD !== undefined) recordDescriptionCharge(undefined, failure.outcome.costUSD);
        setStatus("Description error: " + errorMessage(error) + descriptionChargeText(), "error");
      }
    } finally {
      job.cancelInFlight = null;
      descriptionJob = null;
      setDescriptionBusy(false);
    }
  }

  return { onDescribe, updateDescriptionControls, get busy() { return describing; } };
}
