/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import { MAX_BRACKET_GENERATION_JOBS, MAX_MANUAL_GENERATION_JOBS } from "../generation-limits";
import { runHostModalTask } from "../host-modal";
import { DEFAULT_MODEL, modelSpec } from "../models/catalog";
import { modelProviderLabel } from "../models/provider";
import { freezeModelSettings, normalizeModelSettings, validateModelInput } from "../models/settings";
import { type ModelSettings } from "../models/types";
import { providerCredentials, missingCredential } from "../panel/provider-settings";
import { $, isChecked } from "../panel/controls";
import { showDocumentBlocker } from "../panel/document-warnings";
import { setNote, setStatus } from "../panel/status";
import { documentBlocker, type DocumentState, getDocumentState } from "../photoshop/document-state";
import { getActiveDoc } from "../photoshop/runtime";
import { expandPromptTemplate } from "../prompt-expansion";
import { type RefImage } from "../references";
import { ReferenceCollection } from "../references/collection";
import { prepareReferenceArchiveImages } from "../references/preparation";
import { ReferenceImageProcessor } from "../references/processor";
import { GenerationQueue } from "./queue";
import { captureGenerationCanvas } from "./snapshot";
import { type GenerationCanvasInput, type GenerationJob } from "./types";
import { type GenerationWorkflow } from "./workflow";
export function createGenerationController({ queue, references, processor, workflow, descriptionBusy, captureSettings }: {
  queue: GenerationQueue;
  references: ReferenceCollection;
  processor: ReferenceImageProcessor;
  workflow: GenerationWorkflow;
  descriptionBusy: () => boolean;
  captureSettings?: () => ModelSettings;
}) {
  function updateGenerateControl(): void {
    const generate = $("generate");
    if (!generate) return;
    const queueFull = queue.full;
    generate.disabled = descriptionBusy() || queueFull;
    generate.title = queueFull
      ? `The manual generation queue is limited to ${MAX_MANUAL_GENERATION_JOBS} active jobs.`
      : "";
  }

  function onGenerateClick(): void {
    void onGenerate();
  }

  async function onGenerate(): Promise<void> {
    if (descriptionBusy()) return;
    if (queue.full) {
      updateGenerateControl();
      setStatus(
        `Generation queue is full. Wait for an active job to finish or cancel one (${MAX_MANUAL_GENERATION_JOBS} maximum).`
      );
      return;
    }
    setStatus("Starting…"); // immediate feedback that the click was received

    const promptTemplate = ($("prompt").value || "").trim();
    const model = $("model").value || DEFAULT_MODEL;
    let settings: ModelSettings;
    let credentials: Readonly<Record<string, string>>;
    let provider: string;
    try {
      const spec = modelSpec(model);
      provider = modelProviderLabel(model);
      credentials = providerCredentials(spec.provider);
      const missing = missingCredential(spec.provider, credentials);
      if (missing) throw new Error(`Enter your ${missing} and press Save.`);
      settings = freezeModelSettings(captureSettings ? captureSettings() : normalizeModelSettings(spec, {
        resolution: $("resolution")?.value, quality: $("quality")?.value, ratio: $("selRatio")?.value,
      }).settings);
      validateModelInput(spec, settings, isChecked($("includeSelection")), references.length);
    } catch (error) { setStatus(errorMessage(error), "error"); return; }
    const { quality, resolution } = settings;
    const apiKey = credentials.apiKey || "";
    if (!promptTemplate) {
      setStatus("Enter a prompt describing the edit.", "error");
      return;
    }
    let expandedPrompts: string[];
    try {
      expandedPrompts = expandPromptTemplate(promptTemplate, MAX_BRACKET_GENERATION_JOBS);
    } catch (err: any) {
      setStatus("Prompt expansion error: " + errorMessage(err), "error");
      return;
    }

    let doc: any;
    let documentState: DocumentState;
    try {
      doc = getActiveDoc();
      documentState = getDocumentState(doc);
      const blocker = documentBlocker(documentState);
      if (blocker) {
        await runHostModalTask(() => showDocumentBlocker(blocker));
        setStatus("Generation blocked before anything was sent — nothing was charged.");
        return;
      }
    } catch (err: any) {
      setStatus("Error: " + errorMessage(err), "error");
      return;
    }

    // Disabling canvas input still preserves the selection or target as placement bounds.
    const includeSelection = isChecked($("includeSelection"));
    const placeAsSmartObject = isChecked($("placeAsSmartObject"));
    const reduceDocumentSize = isChecked($("reduceDocumentSize"));
    const generationRefs = references.snapshot();
    let archiveReferencePreparation: Promise<RefImage[]> | null = null;
    const archiveReferences = () => {
      if (!archiveReferencePreparation) {
        archiveReferencePreparation = prepareReferenceArchiveImages(processor, generationRefs, reduceDocumentSize).catch(
          (error: any) => {
            console.log("[Mega Musa] kept original references because compact storage failed:", error?.message || error);
            return generationRefs;
          }
        );
      }
      return archiveReferencePreparation;
    };
    const activeLayers: any[] = Array.from(doc.activeLayers || []);
    const anchorId = Number(activeLayers[0]?.id);
    const anchorLayerId = Number.isFinite(anchorId) ? anchorId : null;
    const jobIds = queue.reserve(expandedPrompts.length);
    updateGenerateControl();
    let canvas: GenerationCanvasInput;
    try {
      setStatus("Freezing Photoshop selection and canvas pixels…");
      canvas = await captureGenerationCanvas(Number(doc.id), anchorLayerId, model, resolution, includeSelection);
    } catch (err: any) {
      queue.abandon(jobIds);
      setStatus("Error: " + errorMessage(err), "error");
      return;
    }
    const jobs: GenerationJob[] = expandedPrompts.map((prompt, index) => ({
      ...canvas,
      id: jobIds[index],
      prompt,
      model,
      provider,
      quality,
      apiKey,
      credentials,
      settings,
      resolution,
      includeSelection,
      placeAsSmartObject,
      reduceDocumentSize,
      references: generationRefs,
      archiveReferences,
      state: "preparing",
      status: "Freezing Photoshop input…",
      cancelRequested: false,
      cancelInFlight: null,
      cancelSlotWait: null,
      slotAcquired: false,
      requestSent: false,
      sentCharge: null,
      pendingPlacement: null,
    }));
    queue.add(jobs);
    setNote("");

    setStatus(
      jobs.length === 1
        ? `Generation ${jobs[0].id} added to the queue.`
        : `${jobs.length} expanded generations added to the queue.`
    );
    for (const job of jobs) void workflow.runGenerationJob(job);
  }
  return { onGenerateClick, onGenerate, updateGenerateControl };
}
