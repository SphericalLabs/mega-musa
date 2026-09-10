/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { resetBudget } from "../budget";
import { errorMessage } from "../errors";
import { createGenerationController } from "../generation/controller";
import { GenerationQueue } from "../generation/queue";
import { createGenerationWorkflow } from "../generation/workflow";
import { ReferenceCollection } from "../references/collection";
import { ReferenceImageProcessor } from "../references/processor";
import { saveApiKey, saveOpenAIApiKey } from "../storage";
import { clearMegaMusaTemporaryFiles } from "../temp-files";
import { $ } from "./controls";
import { createDescriptionController } from "./description";
import { confirmDocumentWarnings } from "./document-warnings";
import { createDropController } from "./drop";
import { renderGenerationQueue } from "./queue-view";
import { createRecallController } from "./recall";
import { createReferencePanel } from "./references";
import { setupCollapsibleSections, setupPromptResize } from "./sections";
import { createSelectionControls } from "./selection";
import { createSettingsController } from "./settings";
import { renderBudget, setNote, setStatus } from "./status";

const { entrypoints } = require("uxp");
const { action } = require("photoshop");

// The composition root is the only place that connects independent feature controllers.
export function createPanel() {
  const queue = new GenerationQueue();
  const references = new ReferenceCollection();
  const processor = new ReferenceImageProcessor((message) => {
    const webview = $("dropWebview");
    if (!webview || typeof webview.postMessage !== "function") throw new Error("The image processor is unavailable.");
    webview.postMessage(message);
  });
  const settings = createSettingsController(refreshSelection);
  const description = createDescriptionController({
    references, processor, queue,
    onBusyChange: () => {
      generation.updateGenerateControl();
      refreshActivity();
    }
  });
  const recall = createRecallController({
    queue, references, settings,
    onReferencesChanged: () => referencePanel.renderThumbs(), onSelectionChange: refreshSelection
  });
  const workflow = createGenerationWorkflow({
    queue, processor, setStatus, setNote, renderBudget, confirmDocumentWarnings,
    onRecallRefresh: () => recall.scheduleGenerationRecallRefresh(), onQueueRefresh: refreshQueue
  });
  const generation = createGenerationController({
    queue, references, processor, workflow,
    descriptionBusy: () => description.busy
  });
  const referencePanel = createReferencePanel({
    references, processor, onChange: () => {
      drop.syncDropCapacity();
      description.updateDescriptionControls();
    }
  });
  const drop = createDropController({
    references, processor,
    onReferencesChanged: () => referencePanel.renderThumbs()
  });
  const selection = createSelectionControls(settings.refreshResolutionLabels);
  const unsubscribeQueue = queue.subscribe(refreshQueue);

  function refreshSelection(): void {
    description.updateDescriptionControls();
    description.scheduleDescriptionInputRefresh();
  }

  function refreshActivity(): void {
    $("generationActivity").style.display = queue.hasActive || description.busy ? "block" : "none";
  }

  function refreshQueue(): void {
    renderGenerationQueue(queue, workflow.retryGenerationPlacement);
    refreshActivity();
    generation.updateGenerateControl();
    description.updateDescriptionControls();
    recall.flushDeferredGenerationRecallRefresh();
  }

  const onPhotoshopChange = () => {
    recall.scheduleGenerationRecallRefresh();
    description.scheduleDescriptionInputRefresh();
  };

  async function init(): Promise<void> {
    try {
      entrypoints.setup({ panels: { nbpEditorPanel: { show: onPhotoshopChange } } });
      await clearMegaMusaTemporaryFiles();
      setupCollapsibleSections();
      setupPromptResize();
      for (const key of [
        { label: "Gemini", field: "geminiApiKey", button: "saveGeminiKey", save: saveApiKey },
        { label: "OpenAI", field: "openaiApiKey", button: "saveOpenAIKey", save: saveOpenAIApiKey },
      ]) {
        $(key.button).addEventListener("click", async () => {
          const apiKey = ($(key.field).value || "").trim();
          try {
            await key.save(apiKey);
            settings.refreshDescriptionModelSelection();
            setStatus(apiKey ? `${key.label} API key saved securely.` : `${key.label} API key cleared.`, "ok");
          } catch (error) {
            setStatus(`Could not save ${key.label} API key: ` + errorMessage(error), "error");
          }
        });
      }
      const actions: Record<string, () => void | Promise<void>> = {
        addRefs: referencePanel.onAddRefs,
        pasteRef: referencePanel.onPasteRef,
        clearRefs: () => { references.clear(); referencePanel.renderThumbs(); },
        generate: generation.onGenerateClick,
        cancelAllGenerations: () => queue.cancelAll(),
        describe: description.onDescribe,
        undoDescription: description.onUndoDescription,
        copyRecallPrompt: recall.onCopyRecallPrompt,
        loadRecallSettings: recall.onLoadRecallSettings,
        restoreRecallSelection: recall.onRestoreRecallSelection,
        fitSelection: selection.onFitSelection,
        fitNearest: selection.onFitNearest,
        resetBudget: () => { renderBudget(resetBudget()); setStatus("Budget counter reset — counting from today.", "ok"); },
      };
      for (const [id, handler] of Object.entries(actions)) $(id).addEventListener("click", handler);
      drop.setupDropWebview();
      try {
        await action.addNotificationListener(["select", "set", "make", "delete", "open", "close"], onPhotoshopChange);
      } catch (error) {
        console.log("[Mega Musa] could not watch Photoshop input:", errorMessage(error));
      }
      onPhotoshopChange();
      $("prompt").addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== "Return") return;
        if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        void generation.onGenerate();
      });
      document.addEventListener("keydown", (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey) || !["v", "V"].includes(event.key)) return;
        const tag = String((event.target as HTMLElement | null)?.tagName || "").toUpperCase();
        if (tag.includes("TEXTFIELD") || tag.includes("TEXTAREA") || tag === "INPUT") return;
        event.preventDefault();
        void referencePanel.onPasteRef();
      });
      await settings.restoreSettings();
      settings.persistSettingsHooks();
      referencePanel.renderThumbs();
      refreshQueue();
      renderBudget();
      setStatus("Ready. Write a prompt and optionally select a region and/or add references.");
      void settings.updateExchangeRates();
    } catch (error) {
      setStatus("Init error: " + errorMessage(error), "error");
    }
  }

  function dispose(): void {
    unsubscribeQueue();
    description.dispose();
    recall.dispose();
    drop.dispose();
    processor.dispose();
  }
  return { init, dispose };
}
