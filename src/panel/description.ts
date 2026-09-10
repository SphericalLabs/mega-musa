/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { addDescriptionToBudget } from "../budget";
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
import { readRegion } from "../photoshop/pixels";
import { getActiveDoc } from "../photoshop/runtime";
import { getSelectionBounds } from "../photoshop/selection";
import { type Bounds } from "../photoshop/types";
import { type DescriptionModelSpec, type DescriptionUsage } from "../providers/description-types";
import { describeImages } from "../providers/descriptions";
import { type RefImage as RequestReference } from "../providers/types";
import { ReferenceCollection } from "../references/collection";
import { ReferenceImageProcessor } from "../references/processor";
import { $, isChecked } from "./controls";
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

  let descriptionInputRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  let descriptionInputRefreshSequence = 0;

  let hasDescriptionSelection = false;

  const DESCRIPTION_INPUT_MAX_EDGE = 2048;

  interface PreparedDescriptionInput {
    source: string;
    image: RequestReference;
  }

  function updateDescriptionControls(): void {
    const busy = queue.hasActive || describing;
    const describeButton = $("describe");
    if (describeButton) {
      const hasInput = references.length > 0 || (isChecked($("includeSelection")) && hasDescriptionSelection);
      describeButton.disabled = !describing && (busy || !hasInput);
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

  async function refreshDescriptionInputAvailability(sequence: number): Promise<void> {
    let hasSelection = false;
    try {
      const selection = await getSelectionBounds();
      hasSelection =
        !!selection && selection.right - selection.left > 1 && selection.bottom - selection.top > 1;
    } catch {
      /* No document or no readable selection means no Photoshop input. */
    }
    if (sequence !== descriptionInputRefreshSequence) return;
    hasDescriptionSelection = hasSelection;
    updateDescriptionControls();
  }

  function scheduleDescriptionInputRefresh(): void {
    if (descriptionInputRefreshTimer !== null) clearTimeout(descriptionInputRefreshTimer);
    const sequence = ++descriptionInputRefreshSequence;
    descriptionInputRefreshTimer = setTimeout(() => {
      descriptionInputRefreshTimer = null;
      void refreshDescriptionInputAvailability(sequence);
    }, 60);
  }

  function selectedDescriptionModel(): DescriptionModelSpec | null {
    return descriptionModelSpec($("describeModel")?.value || "");
  }

  async function prepareDescriptionInputs(job: CancellableJob): Promise<PreparedDescriptionInput[]> {
    const inputs: PreparedDescriptionInput[] = [];
    const includeSelection = isChecked($("includeSelection"));
    const descriptionRefs = references.snapshot();

    if (includeSelection) {
      let rawSelection: Bounds | null = null;
      try {
        rawSelection = await getSelectionBounds();
      } catch {
        /* References can still be described without an open Photoshop document. */
      }
      throwIfCancelled(job);
      const hasSelection =
        !!rawSelection && rawSelection.right - rawSelection.left > 1 && rawSelection.bottom - rawSelection.top > 1;
      if (hasSelection) {
        setStatus("Reading Photoshop selection for description…");
        const doc = getActiveDoc();
        const documentBounds: Bounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const activeArtboard = await getActiveArtboard(doc);
        throwIfCancelled(job);
        const targetBounds = activeArtboard?.bounds || documentBounds;
        const region = intersectBounds(rawSelection as Bounds, targetBounds);
        if (!region) {
          throw new Error(
            activeArtboard
              ? `The selection does not overlap the active artboard “${activeArtboard.name}”.`
              : "The selection does not overlap the Photoshop document."
          );
        }

        const read = await readRegion(doc.id, region, false, DESCRIPTION_INPUT_MAX_EDGE);
        throwIfCancelled(job);
        const png = encodePng(read.image.data, read.image.width, read.image.height, read.image.components);
        inputs.push({
          source: "Photoshop selection",
          image: { mimeType: "image/png", base64: bytesToBase64(png) },
        });
        console.log("[Mega Musa] description", read.debug);
      }
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
    if (!(references.length > 0 || (isChecked($("includeSelection")) && hasDescriptionSelection))) {
      setStatus("Add a reference image or draw and include a Photoshop selection.", "error");
      return;
    }
    const model = selectedDescriptionModel();
    if (!model) {
      setStatus("Choose a description model.", "error");
      return;
    }
    const apiKey = descriptionApiKey(model);
    if (!apiKey) {
      setStatus(`Enter your ${model.provider === "openai" ? "OpenAI" : "Gemini"} API key and press Save.`, "error");
      return;
    }

    const job: CancellableJob = { cancelRequested: false, cancelInFlight: null };
    const controller = newAbortController();
    let requestSent = false;
    let inputImageCount = 0;
    let estimatedCharge = 0;
    let budgetCharge: number | null = null;
    let usedEstimate = false;
    const recordDescriptionCharge = (usage?: DescriptionUsage) => {
      // A late response after Cancel must not add the same request a second time.
      if (budgetCharge !== null) return;
      const usageCharge = usage ? descriptionUsageUSD(model, usage) : null;
      usedEstimate = usageCharge === null;
      budgetCharge = usageCharge ?? estimatedCharge;
      renderBudget(addDescriptionToBudget(budgetCharge, inputImageCount, job.cancelRequested, usedEstimate));
    };
    const descriptionChargeText = () => budgetCharge === null ? "" :
      ` ${usedEstimate ? "Estimate" : "Usage cost"}: ca. ${formatMoney(budgetCharge)} added to the budget.`;
    descriptionJob = job;
    setDescriptionBusy(true);
    setStatus("Preparing inputs for description…");
    try {
      const inputs = await awaitCancellable(job, prepareDescriptionInputs(job), controller);
      throwIfCancelled(job);
      if (!inputs.length) {
        throw new Error("Add a reference image or draw and include a Photoshop selection.");
      }

      setStatus(`Describing ${inputs.length} visual input${inputs.length === 1 ? "" : "s"} with ${model.label}… (10–90s)`);
      inputImageCount = inputs.length;
      estimatedCharge = estimatedDescriptionUSD(model, inputImageCount);
      requestSent = true;
      const request = describeImages({
        apiKey,
        model,
        images: inputs.map((input) => input.image),
        signal: controller.signal,
        onUsage: recordDescriptionCharge,
      });
      const result = await awaitCancellable(job, request, controller);
      throwIfCancelled(job);
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
      if (isCancelledError(error)) {
        if (requestSent) recordDescriptionCharge();
        setStatus(
          "Description canceled. Prompt unchanged." + descriptionChargeText() +
          (requestSent ? " Final provider billing may differ." : "")
        );
      } else {
        setStatus("Description error: " + errorMessage(error) + descriptionChargeText(), "error");
      }
    } finally {
      job.cancelInFlight = null;
      descriptionJob = null;
      setDescriptionBusy(false);
    }
  }

  return { onDescribe, updateDescriptionControls, scheduleDescriptionInputRefresh, get busy() { return describing; }, dispose() { if (descriptionInputRefreshTimer !== null) clearTimeout(descriptionInputRefreshTimer); descriptionInputRefreshSequence += 1; } };
}
