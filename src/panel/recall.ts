/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type GenerationArchive } from "../archive/types";
import { errorMessage } from "../errors";
import { GenerationQueue } from "../generation/queue";
import { bytesToBase64 } from "../images/base64";
import { encodePng } from "../images/codec";
import { toRGBA } from "../images/pixels";
import { resolutionLabel } from "../models/labels";
import { imageQualityLabel } from "../models/quality";
import { readLayerGenerationArchive } from "../photoshop/metadata";
import { readLayerThumbnail } from "../photoshop/pixels";
import { getActiveDoc } from "../photoshop/runtime";
import { restoreArchivedSelection } from "../photoshop/selection";
import { ReferenceCollection } from "../references/collection";
import { restoreReferenceAssets } from "../references/restore";
import { saveSetting } from "../storage";
import { $, hasOption, setCheckedSafe, setPickerSafe } from "./controls";
import { type PromptController } from "./prompt";
import { type SettingsController } from "./settings";
import { setStatus } from "./status";
export function createRecallController({ queue, references, settings, prompt, onReferencesChanged, onSelectionChange }: {
  queue: GenerationQueue;
  references: ReferenceCollection;
  settings: SettingsController;
  prompt: Pick<PromptController, "replace" | "locked">;
  onReferencesChanged: () => void;
  onSelectionChange: () => void;
}) {
  let selectedRecall: {
    generation: GenerationArchive;
    layerName: string;
    docId: number;
    layerId: number;
  } | null = null;

  let recallRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  let recallRefreshSequence = 0;

  let recallRefreshDeferred = false;

  let restoringRecallSelection = false;

  const RECALL_THUMBNAIL_MAX_EDGE = 96;

  const MAX_RECALL_LAYER_NAME_DISPLAY = 50;

  function recallLayerNameDisplay(layerName: string): string {
    if (layerName.length <= MAX_RECALL_LAYER_NAME_DISPLAY) return layerName;
    return `${layerName.slice(0, MAX_RECALL_LAYER_NAME_DISPLAY - 1).trimEnd()}…`;
  }

  function hideGenerationRecall(): void {
    selectedRecall = null;
    const section = $("recallSection");
    if (section) section.style.display = "none";
    clearGenerationRecallThumbnail();
  }

  function clearGenerationRecallThumbnail(): void {
    const frame = $("recallThumbnailFrame");
    const image = $("recallThumbnail");
    if (frame) frame.style.display = "none";
    if (image) {
      image.removeAttribute("src");
      image.removeAttribute("title");
    }
  }

  async function renderGenerationRecallThumbnail(docId: number, layer: any, sequence: number): Promise<void> {
    try {
      const thumbnail = await readLayerThumbnail(docId, layer, RECALL_THUMBNAIL_MAX_EDGE);
      if (sequence !== recallRefreshSequence || selectedRecall?.layerId !== layer.id) return;

      const rgba = toRGBA(thumbnail.data, thumbnail.width, thumbnail.height, thumbnail.components);
      const png = encodePng(rgba, thumbnail.width, thumbnail.height, 4);
      const image = $("recallThumbnail");
      const frame = $("recallThumbnailFrame");
      if (!image || !frame) return;
      image.src = `data:image/png;base64,${bytesToBase64(png)}`;
      image.title = layer.name || "Generated layer";
      frame.style.display = "block";
    } catch (err: any) {
      // Recall remains useful when a host cannot preview a particular layer kind.
      console.log("[Mega Musa] could not preview the recalled layer:", err?.message || err);
    }
  }

  function recallDateLabel(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    try {
      return date.toLocaleString();
    } catch {
      return value;
    }
  }

  function renderGenerationRecall(
    generation: GenerationArchive,
    layerName: string,
    docId: number,
    layerId: number
  ): void {
    selectedRecall = { generation, layerName, docId, layerId };
    const section = $("recallSection");
    if (section) section.style.display = "block";
    clearGenerationRecallThumbnail();
    $("recallLayerName").textContent = recallLayerNameDisplay(layerName);

    const details = [generation.provider, generation.modelLabel || generation.model, generation.ratio];
    if (generation.resolution) {
      details.push(generation.resolution === "auto" ? "Default resolution" : resolutionLabel(generation.resolution));
    }
    // Hide placeholder quality unless the provider reported a resolved value.
    if (generation.quality && (generation.quality !== "auto" || generation.resolvedQuality)) {
      const requestedQuality = imageQualityLabel(generation.quality);
      const resolvedQuality = generation.resolvedQuality
        ? imageQualityLabel(generation.resolvedQuality)
        : "";
      details.push(
        generation.quality === "auto" && resolvedQuality && resolvedQuality !== requestedQuality
          ? `${requestedQuality} quality (resolved ${resolvedQuality})`
          : `${requestedQuality} quality`
      );
    }
    $("recallDetails").textContent = details.join(" · ");

    const sourceParts = [generation.includeSelection ? "Canvas input included" : "Canvas input excluded"];
    if (generation.referenceNames.length) {
      sourceParts.push(`References: ${generation.referenceNames.join(", ")}`);
    } else {
      sourceParts.push("No reference images");
    }
    sourceParts.push(`placed at ${generation.outputWidth}×${generation.outputHeight}`);
    if (generation.resultStorage) {
      sourceParts.push(
        generation.resultStorage.mode === "jpeg-90"
          ? "Smart Object stored as JPEG 90"
          : generation.resultStorage.mode === "png-srgb"
            ? "Smart Object stored as lossless sRGB PNG"
            : "stored as a raster layer"
      );
    }
    sourceParts.push(`Generated ${recallDateLabel(generation.createdAt)}`);
    $("recallSource").textContent = sourceParts.join(" · ");
    $("restoreRecallSelection").disabled = restoringRecallSelection || !generation.geometry;
    $("recallSelectionNote").textContent = !generation.geometry
      ? "No rectangle was saved with this generation. Prompt and settings are still available."
      : generation.geometry.selectionBounds
        ? "Restores original coordinates only, without selection shape or feathering. Moved content is not tracked."
        : "No selection was drawn; restores the original generation frame. Moved content is not tracked.";
  }

  async function refreshGenerationRecall(): Promise<void> {
    const sequence = ++recallRefreshSequence;
    let doc: any;
    try {
      doc = getActiveDoc();
    } catch {
      if (sequence === recallRefreshSequence) hideGenerationRecall();
      return;
    }

    const activeLayers: any[] = Array.from(doc.activeLayers || []);
    if (activeLayers.length !== 1) {
      if (sequence === recallRefreshSequence) hideGenerationRecall();
      return;
    }
    const layer = activeLayers[0];
    const docId = doc.id;
    const layerId = layer.id;
    const generation = await readLayerGenerationArchive(docId, layerId);
    if (sequence !== recallRefreshSequence) return;

    // Selection can change during the metadata read; discard stale results.
    try {
      const currentDoc = getActiveDoc();
      const currentLayers: any[] = Array.from(currentDoc.activeLayers || []);
      if (currentDoc.id !== docId || currentLayers.length !== 1 || currentLayers[0].id !== layerId) {
        scheduleGenerationRecallRefresh();
        return;
      }
    } catch {
      hideGenerationRecall();
      return;
    }

    if (generation) {
      renderGenerationRecall(generation, layer.name || "Generated layer", docId, layerId);
      void renderGenerationRecallThumbnail(docId, layer, sequence);
    } else {
      hideGenerationRecall();
    }
  }

  function scheduleGenerationRecallRefresh(): void {
    if (queue.hasActive) {
      recallRefreshDeferred = true;
      if (recallRefreshTimer !== null) {
        clearTimeout(recallRefreshTimer);
        recallRefreshTimer = null;
      }
      return;
    }
    recallRefreshDeferred = false;
    if (recallRefreshTimer !== null) clearTimeout(recallRefreshTimer);
    recallRefreshTimer = setTimeout(() => {
      recallRefreshTimer = null;
      void refreshGenerationRecall();
    }, 60);
  }

  function flushDeferredGenerationRecallRefresh(): void {
    if (!recallRefreshDeferred || queue.hasActive) return;
    scheduleGenerationRecallRefresh();
  }

  async function onCopyRecallPrompt(): Promise<void> {
    if (!selectedRecall) return;
    try {
      const clipboard: any = (navigator as any).clipboard;
      if (typeof clipboard?.writeText === "function") {
        await clipboard.writeText(selectedRecall.generation.prompt);
      } else if (typeof clipboard?.setContent === "function") {
        await clipboard.setContent({ "text/plain": selectedRecall.generation.prompt });
      } else {
        throw new Error("Clipboard access is unavailable in this Photoshop version.");
      }
      setStatus("Generation prompt copied to the clipboard.", "ok");
    } catch (err: any) {
      const message = errorMessage(err);
      setStatus(
        /manifest version|clipboard access not supported/i.test(message)
          ? "Photoshop is still using Mega Musa’s old manifest. Remove the plugin from UXP Developer Tool, add dist/manifest.json again, then reload it."
          : "Could not copy the generation prompt: " + message,
        "error"
      );
    }
  }

  async function onRestoreRecallSelection(): Promise<void> {
    if (!selectedRecall || restoringRecallSelection) return;
    const selected = selectedRecall;
    restoringRecallSelection = true;
    $("restoreRecallSelection").disabled = true;
    setStatus("Checking the original rectangle…");
    try {
      await restoreArchivedSelection(selected.docId, selected.layerId, selected.generation.geometry);
      onSelectionChange();
      setStatus("Original rectangle restored at its saved coordinates. Check the selection before generating.", "ok");
    } catch (err: any) {
      setStatus("Original rectangle wasn't restored. " + errorMessage(err), "error");
    } finally {
      restoringRecallSelection = false;
      $("restoreRecallSelection").disabled = !selectedRecall?.generation.geometry;
    }
  }

  async function onLoadRecallSettings(): Promise<void> {
    if (!selectedRecall || prompt.locked) return;
    const selected = selectedRecall;
    const generation = selected.generation;
    if (!prompt.replace(generation.prompt, "Recall")) return;
    setCheckedSafe($("includeSelection"), generation.includeSelection);
    saveSetting("includeSelection", generation.includeSelection ? "1" : "0");
    onSelectionChange();

    const messages: string[] = [];
    if (hasOption($("model"), generation.model)) {
      setPickerSafe($("model"), generation.model);
      saveSetting("model", generation.model);
      const capabilityNote = settings.applyModelCapabilities(
        generation.model,
        generation.ratio,
        generation.resolution,
        generation.quality,
        generation.settings
      );
      if (capabilityNote) messages.push(capabilityNote);
    } else {
      messages.push(`${generation.modelLabel || generation.model} is not available in this version, so the current model was kept.`);
    }
    if (generation.references === undefined) {
      if (generation.referenceNames.length) {
        messages.push("This Stage 1 record stores reference names only, so its images could not be loaded.");
      }
      setStatus(["Generation prompt and available settings loaded.", ...messages].join(" "), "ok");
      return;
    }

    if (!generation.references.length && !generation.referenceNames.length) {
      references.clear();
      onReferencesChanged();
      messages.push("The reference list was cleared because this generation used no references.");
      setStatus(["Generation prompt and available settings loaded.", ...messages].join(" "), "ok");
      return;
    }

    setStatus("Generation prompt and settings loaded. Restoring embedded references…");
    try {
      const restored = await restoreReferenceAssets(
        selected.docId,
        generation.references,
        selected.layerId
      );
      references.replace(restored.images);
      onReferencesChanged();

      const neverEmbedded = Math.max(0, generation.referenceNames.length - generation.references.length);
      const unavailable = neverEmbedded + restored.missing.length + restored.failures.length;
      messages.push(
        `${references.length} embedded reference image${references.length === 1 ? "" : "s"} restored.`
      );
      if (unavailable) {
        messages.push(
          `${unavailable} reference image${unavailable === 1 ? " is" : "s are"} missing or unreadable; the prompt and settings were still loaded.`
        );
      }
      setStatus(
        ["Generation prompt and available settings loaded.", ...messages].join(" "),
        unavailable ? "error" : "ok"
      );
    } catch (err: any) {
      setStatus(
        [
          "Generation prompt and available settings loaded.",
          ...messages,
          "Embedded references could not be restored: " + errorMessage(err),
        ].join(" "),
        "error"
      );
    }
  }
  return { scheduleGenerationRecallRefresh, flushDeferredGenerationRecallRefresh, onCopyRecallPrompt, onRestoreRecallSelection, onLoadRecallSettings, dispose() { if (recallRefreshTimer !== null) clearTimeout(recallRefreshTimer); recallRefreshSequence += 1; } };
}
