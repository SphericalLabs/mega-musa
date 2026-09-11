/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, panelDocument, memoryStorage, flush } from "./test-support.mjs";
const { elements, document } = panelDocument([
  "displayCurrency", "currencyNote", "geminiApiKey", "openaiApiKey", "describeModel", "model", "quality", "qualityField",
  "selRatio", "resolution", "includeSelection", "placeAsSmartObject", "reduceDocumentSize", "prompt", "status",
  "recallSection", "recallLayerName", "recallDetails", "recallSource", "restoreRecallSelection", "recallSelectionNote",
  "undoPrompt", "redoPrompt", "promptHistoryActions",
]);
const values = new Map();
const storage = memoryStorage(values);
const layer = { id: 11, name: "Saved generation", bounds: { left: 0, top: 0, right: 2, bottom: 2 } };
const doc = { id: 7, activeLayers: [layer] };
const archive = {
  v: 1, prompt: "Saved prompt", provider: "Gemini", model: "gemini-3-pro-image", modelLabel: "Gemini",
  resolution: "1K", ratio: "5:4", quality: "auto", includeSelection: false,
  placeAsSmartObject: true, reduceDocumentSize: false,
  referenceNames: [], references: [], requestedSize: "5:4 at 1K",
  outputWidth: 500, outputHeight: 400, createdAt: "2026-08-28T12:00:00.000Z",
};
const timers = new Map();
let selectionChanges = 0, referenceChanges = 0;
const api = await loadModule(["src/panel/settings.ts", "src/panel/recall.ts", "src/panel/prompt.ts", "src/references/collection.ts"], {
  globals: {
    document, localStorage: storage, Event,
    setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  },
  modules: {
    photoshop: {
      app: { activeDocument: doc, documents: [doc] },
      action: { batchPlay: async () => [{ generatorSettings: { json: JSON.stringify(archive) } }] },
      core: { executeAsModal: async (callback) => callback({}) },
      imaging: {
        getPixels: async () => ({
          imageData: {
            width: 1, height: 1, components: 4,
            getData: async () => Uint8Array.of(20, 40, 60, 255), dispose() { }
          }
        })
      },
    }
  },
});
const onSelectionChange = () => { selectionChanges++; };
const settings = api.createSettingsController(onSelectionChange);
await settings.restoreSettings();
assert.equal(elements.includeSelection.checked, true);
assert.equal(elements.placeAsSmartObject.checked, true);
assert.equal(elements.reduceDocumentSize.checked, false, "lossy storage is opt-in");
settings.persistSettingsHooks();
for (const [id, value] of [["includeSelection", false], ["placeAsSmartObject", false], ["reduceDocumentSize", true]]) {
  elements[id].checked = value;
  elements[id].dispatchEvent(new Event("change"));
  assert.equal(values.get("nbp." + id), value ? "1" : "0");
}
await settings.restoreSettings();
assert.equal(elements.placeAsSmartObject.checked, false);
assert.equal(elements.reduceDocumentSize.checked, true);
assert.ok(selectionChanges > 0);
const references = new api.ReferenceCollection();
references.add({ name: "old reference" });
const prompt = api.createPromptController();
prompt.init();
const recall = api.createRecallController({
  queue: { hasActive: false }, references, settings, prompt,
  onSelectionChange, onReferencesChanged() { referenceChanges++; }
});
recall.scheduleGenerationRecallRefresh();
for (const callback of timers.values()) callback();
timers.clear();
await flush();
assert.equal(elements.recallSection.style.display, "block");
prompt.setLocked(true);
await recall.onLoadRecallSettings();
assert.equal(elements.prompt.value, "");
assert.equal(references.length, 1, "Recall cannot change the prompt or settings while Describe owns the prompt");
assert.equal(prompt.canUndo, false);
prompt.setLocked(false);
await recall.onLoadRecallSettings();
assert.equal(elements.prompt.value, "Saved prompt");
assert.equal(elements.model.value, archive.model);
assert.equal(elements.selRatio.value, "5:4");
assert.equal(elements.resolution.value, "1K");
assert.equal(references.length, 0);
assert.equal(referenceChanges, 1);
assert.equal(elements.placeAsSmartObject.checked, false, "recall must leave global placement preferences alone");
assert.equal(elements.reduceDocumentSize.checked, true);
assert.equal(values.get("nbp.placeAsSmartObject"), "0");
assert.equal(values.get("nbp.reduceDocumentSize"), "1");
prompt.undo();
assert.equal(elements.prompt.value, "");
assert.equal(elements.selRatio.value, "5:4", "prompt undo does not undo recalled settings");
prompt.redo();
assert.equal(elements.prompt.value, "Saved prompt");
await recall.onLoadRecallSettings();
prompt.undo();
assert.equal(elements.prompt.value, "", "recalling identical text must not add a duplicate history entry");
recall.dispose();
prompt.dispose();

// A native picker must keep its menu items while handling its own selection.
// Replacing them during change can interrupt the host's selection commit.
const visibleModels = elements.model.querySelectorAll("sp-menu-item").map(item => item.getAttribute("value"));
const chosenResolutions = new Map();
for (const model of visibleModels) {
  elements.model.value = model;
  elements.model.dispatchEvent(new Event("change"));
  const menu = elements.resolution.querySelector("sp-menu");
  for (const item of [...menu.children]) {
    const resolution = item.getAttribute("value");
    elements.resolution.value = resolution;
    elements.resolution.dispatchEvent(new Event("change"));
    assert.ok(menu.children.includes(item), `${model}: selecting a resolution must not replace its active menu item`);
    assert.equal(elements.resolution.value, resolution);
    assert.equal(settings.captureSettings().resolution, resolution);
    assert.equal(JSON.parse(values.get(`nbp.modelSettings.${model}`)).resolution, resolution);
    chosenResolutions.set(model, resolution);
  }
}
await settings.restoreSettings();
for (const [model, resolution] of chosenResolutions) {
  elements.model.value = model;
  elements.model.dispatchEvent(new Event("change"));
  assert.equal(elements.resolution.value, resolution, "resolution survives reload and switching models");
}
console.log("Panel settings: defaults, persistence and recall without changing global storage preferences passed.");
