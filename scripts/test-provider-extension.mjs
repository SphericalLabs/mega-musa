/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadModule, panelDocument, memoryStorage } from "./test-support.mjs";

// Register a third module at the real composition boundary without production edits.
const plugins = [{ name: "example-provider", setup(build) {
  build.onLoad({ filter: /\/providers\/registry\.ts$/ }, ({ path }) => ({
    resolveDir: dirname(path), loader: "ts",
    contents: `import { createProviderRegistry } from "./registry-core";
      import { openai } from "./openai"; import { gemini } from "./gemini";
      import { exampleProvider } from ${JSON.stringify(resolve("scripts/fixtures/example-provider.ts"))};
      export const providerRegistry = createProviderRegistry([gemini, openai, exampleProvider]);`,
  }));
} }];
const ids = [...readFileSync("public/index.html", "utf8").matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const { document, elements } = panelDocument(ids);
const values = new Map([["nbp.model", "gemini-3-pro-image"], ["nbp.resolution", "4K"]]);
const secrets = new Map([["nbp.apiKey", "old-gemini-key"], ["nbp.openaiApiKey", "old-openai-key"]]);
const api = await loadModule([
  "src/providers/registry.ts", "src/providers/registry-core.ts", "src/providers/images.ts", "src/providers/descriptions.ts",
  "src/models/catalog.ts", "src/models/settings.ts", "src/models/pricing.ts", "src/model-preferences.ts",
  "src/panel/settings.ts", "src/panel/provider-settings.ts", "src/generation/queue.ts", "src/generation/workflow.ts",
  "src/archive/schema.ts", "src/providers/failure.ts", "scripts/fixtures/example-provider.ts",
], { plugins, globals: { document, localStorage: memoryStorage(values), Event }, modules: { uxp: { storage: { secureStorage: {
  getItem: async key => { if (!secrets.has(key)) throw new Error("missing"); return new TextEncoder().encode(secrets.get(key)); },
  setItem: async (key, value) => secrets.set(key, value), removeItem: async key => secrets.delete(key),
} } } } });

const spec = api.modelSpec("example:artist");
assert.throws(() => api.modelSpec("typo:artist"), /Model unavailable/);
assert.throws(() => api.providerRegistry.provider("missing"), /Provider unavailable/);
assert.throws(() => api.createProviderRegistry([api.exampleProvider, api.exampleProvider]), /duplicate/);
assert.throws(() => api.createProviderRegistry([{ ...api.exampleProvider, models: [spec, spec] }]), /duplicate/);
assert.throws(() => api.createProviderRegistry([{ ...api.exampleProvider, generate: undefined }]), /generation adapter/);
assert.equal(api.estimatedTotalUSD(spec, "1K", undefined, "draft"), 0.2);
await assert.rejects(() => api.describeImages({ model: { id: "missing", provider: "example" }, images: [{}], apiKey: "" }), /does not support descriptions/);

const settings = api.createSettingsController(() => {});
await settings.restoreSettings(); settings.persistSettingsHooks();
assert.equal(elements.geminiApiKey.value, "old-gemini-key");
assert.equal(elements.openaiApiKey.value, "old-openai-key");
assert.equal(elements.resolution.value, "4K", "legacy preferences seed the selected model");
assert.ok(elements.model.querySelectorAll().some(item => item.getAttribute("value") === spec.id));
for (const row of elements.providerCredentials.children) {
  const [label, input, button] = row.children;
  input.value = label.textContent === "Example token" ? "example-secret" : "test-region";
  button.dispatchEvent(new Event("click"));
}
await new Promise(resolve => setImmediate(resolve));
assert.equal(secrets.get("nbp.provider.example.token"), "example-secret");
assert.equal(values.get("nbp.provider.example.region"), "test-region");
assert.equal(values.has("nbp.provider.example.token"), false);

function selectModel(id) { elements.model.value = id; elements.model.dispatchEvent(new Event("change")); }
selectModel(spec.id);
assert.equal(elements.resolution.value, "1K", "a new model uses its own defaults");
assert.equal(elements.quality.value, "draft");
assert.equal(elements.modelOptions.children.length, 4);
const seedInput = elements.modelOptions.children[0].children[1];
seedInput.value = "42"; seedInput.dispatchEvent(new Event("change"));
elements.quality.value = "studio"; elements.quality.dispatchEvent(new Event("change"));
const captured = settings.captureSettings();
let dispatches = 0;
await assert.rejects(() => api.generateImage({ model: spec.id, apiKey: "", credentials: api.providerCredentials("example"),
  prompt: "test", references: [], baseImagePng: new Uint8Array([1]), frame: { ratio: 1, label: "1:1" },
  resolution: "1K", quality: "draft", settings: captured, onDispatch: () => { dispatches++; } }), /does not accept/);
assert.equal(dispatches, 0);
assert.equal(api.exampleRequests.length, 0);
assert.equal(captured.options.seed, 42);
assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.options));
selectModel("gemini-3-pro-image");
assert.equal(elements.resolution.value, "4K");
selectModel(spec.id);
assert.equal(elements.quality.value, "studio");
assert.equal(settings.captureSettings().options.seed, 42);
const restored = api.loadModelPreferences(spec).settings;
assert.equal(restored.options.seed, 42);
assert.equal(api.normalizeModelSettings(spec, { version: 1, options: { oldSeed: 7 } }).settings.options.seed, 7);
assert.equal(api.normalizeModelSettings(spec, { version: 99, options: { seed: 7 } }).settings.options.seed, 1);
assert.equal(api.normalizeModelSettings(spec, { ratio: 123, resolution: {}, quality: [] }).settings.ratio, "1:1");
assert.equal(api.normalizeModelSettings(spec, { options: { seed: 1000, token: "secret" } }).settings.options.seed, 100);
assert.equal("token" in api.normalizeModelSettings(spec, { options: { token: "secret" } }).settings.options, false);
assert.throws(() => api.validateModelInput(spec, captured, true, 0), /does not accept/);
assert.throws(() => api.validateModelInput(spec, captured, false, 3), /at most 2/);
assert.throws(() => api.validateModelInput(spec, { ...captured, resolution: "2K" }, false, 0), /Studio supports/);

// Send through the production workflow, dispatcher and adapter, then inspect placement metadata.
const queue = new api.GenerationQueue();
const [id] = queue.reserve(1);
const bounds = { left: 0, top: 0, right: 1, bottom: 1 };
const job = { id, model: spec.id, provider: "Example", prompt: "A test image", quality: captured.quality, resolution: captured.resolution,
  settings: captured, credentials: api.providerCredentials("example"), apiKey: "", includeSelection: false, references: [],
  archiveReferences: async () => [], placeAsSmartObject: true, reduceDocumentSize: false, docId: 7, docWidth: 1, docHeight: 1,
  activeArtboard: null, rawSelection: null, state: "preparing", cancelRequested: false, requestSent: false, sentCharge: null };
queue.add([job]);
const placements = [], charges = [];
const workflow = api.createGenerationWorkflow({ queue, processor: {}, setStatus() {}, setNote() {}, renderBudget(value) { charges.push(value); },
  confirmDocumentWarnings: async () => true, onRecallRefresh() {}, onQueueRefresh() {},
}, { prepare: async () => ({ frame: { label: "1:1", ratio: 1 }, region: bounds, cropW: 1, cropH: 1, isRegion: false, selectionSnapshot: null,
  notes: [], exactOutputSize: "", outputFrameNote: "1:1", outputDimensions: [], requestReferences: [], basePng: undefined }),
  place: async request => { placements.push(request); return { smartObject: true, clip: "none", archiveSaved: true, referenceArchiveFailures: 0 }; },
});
selectModel("gemini-3-pro-image");
await workflow.runGenerationJob(job);
assert.equal(api.exampleRequests.length, 1);
assert.equal(api.exampleRequests[0].model.apiModel, "artist-v7");
assert.equal(api.exampleRequests[0].settings.options.seed, 42);
assert.equal(api.exampleRequests[0].credentials.token, "example-secret");
assert.equal(api.exampleRequests[0].credentials.region, "test-region");
assert.equal(charges[0].usd, 0.25, "the returned provider charge replaces the estimate");
assert.equal(placements.length, 1);
const archive = placements[0].archive;
assert.equal(archive.providerId, "example");
assert.equal(archive.settings.options.seed, 42);
assert.ok(api.isGenerationArchive(archive));
assert.ok(!JSON.stringify(archive).includes("example-secret"));
assert.ok(!api.isGenerationArchive({ ...archive, settings: { ...archive.settings, options: { seed: Infinity } } }));
settings.applyModelCapabilities(spec.id, archive.ratio, archive.resolution, archive.quality, archive.settings);
assert.equal(settings.captureSettings().options.seed, 42);
assert.equal(queue.items.length, 0);
console.log("Provider extensions: third provider, controls, credentials, validation, settings migration, frozen jobs, costs and archive recall passed.");
