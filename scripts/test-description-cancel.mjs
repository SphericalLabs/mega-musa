/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { panelDocument } from "./test-support.mjs";

// Test real panel handlers with controlled host, WebView and provider responses.
const bundle = await build({
  stdin: {
    contents: `
      import "./polyfills";
      export { createDescriptionController } from "./panel/description";
      export { createPromptController } from "./panel/prompt";
      export { createGenerationController } from "./generation/controller";
      export { ReferenceCollection } from "./references/collection";
      export { ReferenceImageProcessor } from "./references/processor";
      export { GenerationQueue } from "./generation/queue";
      export { DESCRIPTION_MODELS, descriptionUsageUSD, estimatedDescriptionUSD } from "./describe";
      export { loadBudget, resetBudget, addToBudget, addDescriptionToBudget, budgetText } from "./budget";
    `,
    resolveDir: resolve("src"),
    loader: "ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["photoshop", "uxp"],
  write: false,
  logLevel: "silent",
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const reference = { name: "test.png", mimeType: "image/png", base64: png, dataUrl: `data:image/png;base64,${png}` };
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function finishesPromptly(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cancel did not release the panel")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function panel(provider = "openai", Controller = AbortController, photoshop = {}, settings = new Map()) {
  const { elements, document } = panelDocument(
    ["describe", "describeModel", "undoPrompt", "redoPrompt", "promptHistoryActions", "prompt", "generate", "includeSelection",
      "openaiApiKey", "geminiApiKey", "status", "dropWebview", "budgetTotal", "budgetCounts"]
  );
  elements.prompt.value = "Original prompt";
  elements.openaiApiKey.value = elements.geminiApiKey.value = "test-key";
  const resizes = [];
  elements.dropWebview.postMessage = (message) => {
    if (message.type === "resize-end") resizes.push(message.requestId);
  };
  const requests = [];
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require(name) {
      if (name === "photoshop") return photoshop;
      if (name === "uxp") return { storage: {} };
      throw new Error(`Unexpected module: ${name}`);
    },
    document,
    localStorage: {
      getItem: (key) => settings.get(key) ?? null,
      setItem: (key, value) => settings.set(key, value),
    },
    AbortController: Controller, Event, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  const exports = module.exports;
  const references = new exports.ReferenceCollection();
  const queue = new exports.GenerationQueue();
  const processor = new exports.ReferenceImageProcessor(elements.dropWebview.postMessage);
  processor.setReady(true);
  const prompt = exports.createPromptController();
  prompt.init();
  const description = exports.createDescriptionController({ references, processor, queue, prompt,
    onBusyChange: () => generation.updateGenerateControl() });
  const generation = exports.createGenerationController({ references, processor, queue,
    workflow: { runGenerationJob() {}, retryGenerationPlacement() {} },
    descriptionBusy: () => description.busy });
  const api = { ...exports, ...description, prompt,
    setTestReferences: (images) => references.replace(images),
    onReferenceResizeMessage: (message) => processor.handleMessage(message),
  };
  const model = api.DESCRIPTION_MODELS.find((model) => model.provider === provider);
  elements.describeModel.value = model.id;
  const reportedUsage = provider === "openai"
    ? { input_tokens: 2000, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 500 },
        output_tokens: 800, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 2800 }
    : { promptTokenCount: 2000, cachedContentTokenCount: 500,
        candidatesTokenCount: 500, thoughtsTokenCount: 300, totalTokenCount: 2800 };
  api.setTestReferences([reference]);
  api.updateDescriptionControls();
  return {
    ...api, elements, resizes, requests, settings, model, reportedUsage,
    finishResize(index = resizes.length - 1) {
      const requestId = resizes[index];
      assert.ok(requestId, "a reference resize must have started");
      api.onReferenceResizeMessage({ type: "resize-result-start", requestId, totalChunks: 1, width: 1, height: 1 });
      api.onReferenceResizeMessage({ type: "resize-result-chunk", requestId, index: 0, data: png });
      api.onReferenceResizeMessage({ type: "resize-result-end", requestId });
    },
    finishRequest(index, description, usage = reportedUsage) {
      const text = JSON.stringify({ descriptions: Array.isArray(description) ? description : [description] });
      requests[index].resolve({
        ok: true,
        json: async () => provider === "openai"
          ? { output: [{ content: [{ type: "output_text", text }] }], usage }
          : { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage },
      });
    },
  };
}

function expectBusy({ elements }) {
  assert.equal(elements.describe.textContent, "Cancel");
  assert.equal(elements.describe.getAttribute("variant"), "warning");
  assert.equal(elements.describe.disabled, false);
  for (const id of ["prompt", "describeModel", "undoPrompt", "redoPrompt", "generate"]) {
    assert.equal(elements[id].disabled, true, `${id} stays disabled during a description`);
  }
}

function expectIdle({ elements }) {
  assert.equal(elements.describe.textContent, "Describe");
  assert.equal(elements.describe.getAttribute("variant"), "primary");
  for (const id of ["prompt", "describeModel", "generate"]) {
    assert.equal(elements[id].disabled, false, `${id} is restored after a description`);
  }
}

// Cancel works without AbortController; late responses cannot overwrite a newer run.
for (const provider of ["openai", "gemini"]) {
  for (const Controller of [AbortController, null]) {
    for (const lateResult of ["success", "error"]) {
      const test = panel(provider, Controller);
      const first = test.onDescribe();
      expectBusy(test);
      test.finishResize();
      await flush();
      assert.equal(test.requests.length, 1);
      if (Controller) assert.equal(test.requests[0].init.signal.aborted, false);
      else assert.equal("signal" in test.requests[0].init, false);

      await test.onDescribe();
      await finishesPromptly(first);
      expectIdle(test);
      assert.equal(test.elements.describe.disabled, false);
      assert.equal(test.elements.prompt.value, "Original prompt");
      assert.equal(test.elements.undoPrompt.disabled, true);
      assert.match(test.elements.status.textContent, /Description canceled.*Estimate:.*added to the budget/);
      assert.equal(test.elements.status.className, "");
      const canceledBudget = test.loadBudget();
      assert.equal(canceledBudget.usd, test.model.estimatedUSD);
      assert.equal(canceledBudget.imagesAnalyzed, 1);
      assert.equal(canceledBudget.analysisCancelled, 1);
      assert.equal(canceledBudget.analysisEstimates, 1);
      assert.equal(canceledBudget.images, 0);
      if (Controller) assert.equal(test.requests[0].init.signal.aborted, true);

      const second = test.onDescribe();
      test.finishResize();
      await flush();
      const currentStatus = test.elements.status.textContent;
      if (lateResult === "success") test.finishRequest(0, "Stale description");
      else test.requests[0].reject(new Error("Late provider failure"));
      await flush();
      expectBusy(test);
      assert.equal(test.elements.prompt.value, "Original prompt");
      assert.equal(test.elements.status.textContent, currentStatus);
      assert.deepEqual(test.loadBudget(), canceledBudget, "late usage must not double-charge a canceled request");

      test.finishRequest(1, "COMPOSITION: Current description.");
      await finishesPromptly(second);
      expectIdle(test);
      assert.equal(test.elements.prompt.value, "COMPOSITION: Current description.");
      assert.equal(test.elements.undoPrompt.disabled, false);
      assert.equal(test.elements.status.className, "ok");
      const usageCost = (provider === "openai"
        ? (1675 * 0.2 + 800 * 1.2)
        : (1550 * 0.3 + 800 * 2.5)) / 1000000;
      assert.ok(Math.abs(test.loadBudget().usd - canceledBudget.usd - usageCost) < 1e-12);
      assert.equal(test.loadBudget().imagesAnalyzed, 2);
      assert.equal(test.loadBudget().analysisEstimates, 1);
      assert.match(test.elements.budgetCounts.textContent, /0 images, 2 images described \(1 canceled, 1 estimated\)/);
      assert.match(test.elements.status.textContent, /Usage cost:.*added to the budget/);
      const completedBudget = test.loadBudget();

      // Canceling another run must preserve the previous successful Undo.
      const third = test.onDescribe();
      await test.onDescribe();
      await finishesPromptly(third);
      test.finishResize();
      await flush();
      test.prompt.undo();
      assert.equal(test.elements.prompt.value, "Original prompt");
      assert.deepEqual(test.loadBudget(), completedBudget, "Undo and canceling preparation never undo or add a charge");
    }
  }
}

// Repeated successful Describe results and manual edits all remain undoable.
{
  const test = panel();
  const first = test.onDescribe();
  test.finishResize();
  await flush();
  test.finishRequest(0, "COMPOSITION: First description.");
  await finishesPromptly(first);
  const described = test.elements.prompt.value;
  const edited = described + " Manual edit.";
  test.elements.prompt.value = edited;
  test.elements.prompt.selectionStart = test.elements.prompt.selectionEnd = edited.length;
  test.elements.prompt.dispatchEvent(new Event("input"));
  const second = test.onDescribe();
  expectBusy(test);
  test.prompt.undo();
  assert.equal(test.elements.prompt.value, edited, "history is locked while Describe is running");
  test.finishResize();
  await flush();
  test.finishRequest(1, "COMPOSITION: Second description.");
  await finishesPromptly(second);
  const secondDescription = test.elements.prompt.value;
  const charged = test.loadBudget();
  for (const expected of [edited, described, "Original prompt"]) {
    test.prompt.undo();
    assert.equal(test.elements.prompt.value, expected);
  }
  for (const expected of [described, edited, secondDescription]) {
    test.prompt.redo();
    assert.equal(test.elements.prompt.value, expected);
  }
  assert.deepEqual(test.loadBudget(), charged, "text history neither repeats requests nor reverses charges");
  assert.equal(test.requests.length, 2);
  test.prompt.dispose();
}

// Cancel during preparation: no paid request, no next reference and no late status.
{
  const test = panel();
  test.setTestReferences([reference, { ...reference, name: "second.png" }]);
  const run = test.onDescribe();
  expectBusy(test);
  test.setTestReferences([]);
  test.updateDescriptionControls();
  expectBusy(test); // Removing all inputs must never disable Cancel.
  await test.onDescribe();
  await finishesPromptly(run);
  expectIdle(test);
  assert.equal(test.elements.describe.disabled, true);
  const canceledStatus = test.elements.status.textContent;
  assert.equal(canceledStatus, "Description canceled. Prompt unchanged.");
  test.finishResize();
  await flush();
  assert.equal(test.resizes.length, 1);
  assert.equal(test.requests.length, 0);
  assert.equal(test.elements.status.textContent, canceledStatus);
  assert.equal(test.loadBudget().imagesAnalyzed, 0);
  assert.equal(test.loadBudget().usd, 0);
}

// A pending Photoshop selection read must also stop before preparing more inputs.
for (const lateSelection of ["selection", "error"]) {
  let resolveSelection;
  let rejectSelection;
  const selection = new Promise((resolve, reject) => {
    resolveSelection = resolve;
    rejectSelection = reject;
  });
  const test = panel("openai", AbortController, {
    app: { activeDocument: { id: 1 } },
    action: { batchPlay: () => selection },
  });
  test.elements.includeSelection.checked = true;
  const run = test.onDescribe();
  await test.onDescribe();
  await finishesPromptly(run);
  expectIdle(test);
  if (lateSelection === "selection") {
    resolveSelection([{ selection: { left: 0, top: 0, right: 100, bottom: 100 } }]);
  } else {
    rejectSelection(new Error("Document closed"));
  }
  await flush();
  assert.equal(test.resizes.length, 0);
  assert.equal(test.requests.length, 0);
  assert.equal(test.elements.status.textContent, "Description canceled. Prompt unchanged.");
}

{
  const test = panel();
  const run = test.onDescribe();
  test.finishResize();
  await flush();
  test.requests[0].reject(new Error("Provider unavailable"));
  await finishesPromptly(run);
  expectIdle(test);
  assert.equal(test.elements.prompt.value, "Original prompt");
  assert.equal(test.elements.undoPrompt.disabled, true);
  assert.match(test.elements.status.textContent, /Description error:.*Could not receive a response/);
  assert.equal(test.elements.status.className, "error");
  assert.equal(test.loadBudget().imagesAnalyzed, 0);
  assert.equal(test.loadBudget().usd, 0);
}

// Account for cached input and reasoning tokens once.
{
  const test = panel();
  const rates = {
    "gpt-5.6-luna": [0.2, 1.2], "gpt-5.6-sol": [4, 20],
    "gemini-3.5-flash-lite": [0.3, 2.5], "gemini-3.7-flash": [0.75, 3.75],
  };
  for (const model of test.DESCRIPTION_MODELS) {
    const usage = { inputTokens: 2000, cachedInputTokens: 500,
      cacheWriteInputTokens: model.provider === "openai" ? 500 : 0, outputTokens: 800, reasoningTokens: 300 };
    const [input, output] = rates[model.model];
    const cost = ((model.provider === "openai" ? 1675 : 1550) * input + 800 * output) / 1000000;
    assert.ok(Math.abs(test.descriptionUsageUSD(model, usage, new Date("2026-08-28")) - cost) < 1e-12);
    assert.equal(test.estimatedDescriptionUSD(model, 3), model.estimatedUSD * 3);
    for (const malformed of [{}, { inputTokens: 20 }, { inputTokens: null, outputTokens: 10 },
      { inputTokens: -1, outputTokens: 10 }, { inputTokens: 20, outputTokens: Infinity },
      { inputTokens: 20, outputTokens: 10, cachedInputTokens: 21 }]) {
      assert.equal(test.descriptionUsageUSD(model, malformed), null);
    }
    if (model.provider === "openai") {
      assert.equal(test.descriptionUsageUSD(model, { ...usage, serviceTier: "fast" }), cost * 2);
      assert.equal(test.descriptionUsageUSD(model, { ...usage, serviceTier: "flex" }), cost * 0.5);
    }
    if (model.model === "gemini-3.7-flash") {
      assert.equal(test.descriptionUsageUSD(model, usage, new Date("2027-01-01")), cost * 2);
    }
  }
}

// Legacy request counts cannot recover image counts; preserve spend and reset date.
{
  const settings = new Map(Object.entries({ "nbp.budgetCHF": "1.25", "nbp.budgetImages": "4",
    "nbp.budgetUnpriced": "1", "nbp.budgetCancelled": "2", "nbp.budgetSince": "2026-08-01T12:00:00.000Z",
    "nbp.budgetDescriptions": "3", "nbp.budgetDescriptionCancelled": "1", "nbp.budgetDescriptionEstimates": "2" }));
  const test = panel("openai", AbortController, {}, settings);
  const initial = test.loadBudget();
  assert.ok(Math.abs(initial.usd - 1.25 / 0.8103) < 1e-12);
  assert.match(test.budgetText(initial).total, /USD 1\.54$/);
  assert.equal(settings.get("nbp.budgetCHF"), "1.25", "retain the old CHF total");
  assert.equal(Number(settings.get("nbp.budgetUSD")), initial.usd);
  assert.equal(test.loadBudget().usd, initial.usd, "migration must run only once");
  assert.equal(initial.imagesAnalyzed, 0);
  assert.equal(initial.analysisCancelled, 0);
  assert.equal(initial.analysisEstimates, 0);
  assert.equal(test.budgetText(initial).counts,
    "(4 images, 0 images described, 1 unpriced, 2 image requests canceled but billed)");
  test.addDescriptionToBudget(0.00125, 10);
  test.addToBudget(0.2);
  test.addDescriptionToBudget(0.0015, 2, true, true);
  const saved = test.loadBudget();
  assert.ok(Math.abs(saved.usd - (1.25 / 0.8103 + 0.20275)) < 1e-12);
  assert.equal(saved.images, 5);
  assert.equal(saved.unpriced, 1);
  assert.equal(saved.cancelled, 2);
  assert.equal(saved.imagesAnalyzed, 12);
  assert.equal(saved.analysisCancelled, 2);
  assert.equal(saved.analysisEstimates, 2);
  assert.equal(saved.since, "2026-08-01T12:00:00.000Z");
  const reloaded = panel("openai", AbortController, {}, settings);
  assert.equal(JSON.stringify(reloaded.loadBudget()), JSON.stringify(saved));
  assert.match(reloaded.budgetText(saved).total, /USD 1\.75$/);
  for (const imagesAnalyzed of [0, 3]) {
    for (const [usd, formatted] of [[0, "0.00"], [0.004, "0.00"], [14.638, "14.64"]]) {
      const budget = { ...saved, imagesAnalyzed, usd };
      assert.ok(reloaded.budgetText(budget).total.endsWith(`USD ${formatted}`));
      assert.equal(budget.usd, usd, "display rounding must preserve the stored amount");
    }
  }
  const reset = reloaded.resetBudget();
  for (const key of ["usd", "images", "unpriced", "cancelled", "imagesAnalyzed", "analysisCancelled", "analysisEstimates"]) {
    assert.equal(reset[key], 0, `${key} resets with the budget`);
  }
  assert.equal(JSON.stringify(reloaded.loadBudget()), JSON.stringify(reset));
}

// Count the captured selection and nine references, even if live inputs change later.
for (const provider of ["openai", "gemini"]) {
  for (const canceled of [false, true]) {
    const test = panel(provider, AbortController, {
      app: { activeDocument: { id: 1, width: 2, height: 2 } },
      action: { batchPlay: async () => [{ selection: { left: 0, top: 0, right: 2, bottom: 2 } }] },
      core: { executeAsModal: async (target) => target({}) },
      imaging: { getPixels: async () => ({ imageData: {
        width: 2, height: 2, components: 3,
        getData: async () => new Uint8Array(12).fill(128),
        dispose() {},
      } }) },
    });
    test.elements.includeSelection.checked = true;
    test.setTestReferences(Array.from({ length: 9 }, (_, index) => ({ ...reference, name: `ref-${index}.png` })));
    const run = test.onDescribe();
    await flush();
    for (let index = 0; index < 9; index += 1) {
      test.finishResize();
      await flush();
    }
    assert.equal(test.requests.length, 1);
    const body = JSON.parse(test.requests[0].init.body);
    const sentImages = provider === "openai"
      ? body.input[0].content.filter((part) => part.type === "input_image")
      : body.contents[0].parts.filter((part) => part.inlineData);
    assert.equal(sentImages.length, 10);
    test.setTestReferences([]);
    test.elements.includeSelection.checked = false;
    const descriptions = Array.from({ length: 10 }, (_, index) => `Image ${index + 1}.`);
    if (canceled) await test.onDescribe();
    else test.finishRequest(0, descriptions);
    await finishesPromptly(run);
    const saved = test.loadBudget();
    assert.equal(saved.imagesAnalyzed, 10);
    assert.equal(saved.analysisCancelled, canceled ? 10 : 0);
    assert.equal(saved.analysisEstimates, canceled ? 10 : 0);
    assert.equal(test.elements.budgetCounts.textContent, canceled
      ? "(0 images, 10 images described (10 canceled, 10 estimated))"
      : "(0 images, 10 images described)");
    const usageCost = test.descriptionUsageUSD(test.model, {
      inputTokens: 2000, cachedInputTokens: 500,
      cacheWriteInputTokens: provider === "openai" ? 500 : 0, outputTokens: 800,
    });
    assert.equal(saved.usd, canceled ? test.model.estimatedUSD * 10 : usageCost,
      "add the whole request cost once, not once per image");
    if (canceled) {
      test.finishRequest(0, descriptions);
      await flush();
      assert.deepEqual(test.loadBudget(), saved, "late usage must not add cost or images again");
    }
  }
}

// Missing or malformed usage falls back to an estimate for every input image.
for (const provider of ["openai", "gemini"]) {
  for (const usage of [null, {}, { input_tokens: null, output_tokens: null,
    promptTokenCount: null, candidatesTokenCount: null }]) {
    const test = panel(provider);
    test.setTestReferences([reference, reference]);
    const run = test.onDescribe();
    test.finishResize();
    await flush();
    test.finishResize();
    await flush();
    test.finishRequest(0, ["First image.", "Second image."], usage);
    await finishesPromptly(run);
    assert.equal(test.loadBudget().usd, test.model.estimatedUSD * 2);
    assert.equal(test.loadBudget().imagesAnalyzed, 2);
    assert.equal(test.loadBudget().analysisEstimates, 2);
    assert.match(test.elements.status.textContent, /Estimate:.*added to the budget/);
  }
}

// Parsing can fail after a paid response, so account for usage before parsing.
for (const provider of ["openai", "gemini"]) {
  const test = panel(provider);
  const run = test.onDescribe();
  test.finishResize();
  await flush();
  test.finishRequest(0, []);
  await finishesPromptly(run);
  assert.equal(test.elements.status.className, "error");
  assert.equal(test.elements.prompt.value, "Original prompt");
  assert.equal(test.loadBudget().imagesAnalyzed, 1);
  assert.equal(test.loadBudget().analysisEstimates, 0);
  assert.ok(test.loadBudget().usd > 0);
}

// Rejected HTTP requests cost nothing here; explicit zero usage is not missing.
for (const provider of ["openai", "gemini"]) {
  const test = panel(provider);
  const rejected = test.onDescribe();
  test.finishResize();
  await flush();
  test.requests[0].resolve({ ok: false, status: 401, json: async () => ({ error: { message: "Invalid key" } }) });
  await finishesPromptly(rejected);
  assert.equal(test.loadBudget().imagesAnalyzed, 0);
  assert.equal(test.loadBudget().usd, 0);
  const successful = test.onDescribe();
  test.finishResize();
  await flush();
  test.finishRequest(1, "Zero usage response.", provider === "openai"
    ? { input_tokens: 0, output_tokens: 0 }
    : { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 });
  await finishesPromptly(successful);
  assert.equal(test.loadBudget().imagesAnalyzed, 1);
  assert.equal(test.loadBudget().usd, 0);
  assert.equal(test.loadBudget().analysisEstimates, 0);
  assert.equal(test.elements.budgetCounts.textContent, "(0 images, 1 image described)");
}

// Reset after cancel must not be undone by a late response.
{
  const test = panel();
  const run = test.onDescribe();
  test.finishResize();
  await flush();
  await test.onDescribe();
  await finishesPromptly(run);
  test.resetBudget();
  test.finishRequest(0, "Stale description.");
  await flush();
  assert.equal(test.loadBudget().usd, 0);
  assert.equal(test.loadBudget().imagesAnalyzed, 0);
}

console.log("description tests passed (cancellation, usage pricing, image counts, estimates, shared budget, persistence, reset and Undo)");

// Existing USD (including zero) wins over legacy CHF. All counters survive migration.
for (const usd of [undefined, "0", "2.5"]) {
  const settings = new Map(Object.entries({
    "nbp.budgetCHF": "8.103", "nbp.budgetSince": "2026-08-01T12:00:00.000Z",
    "nbp.budgetImages": "7", "nbp.budgetImagesAnalyzed": "9",
    "nbp.budgetAnalysisCancelled": "2", "nbp.budgetAnalysisEstimates": "3",
  }));
  if (usd !== undefined) settings.set("nbp.budgetUSD", usd);
  const test = panel("openai", AbortController, {}, settings);
  const budget = test.loadBudget();
  assert.ok(Math.abs(budget.usd - (usd === undefined ? 10 : Number(usd))) < 1e-12);
  assert.equal(budget.images, 7);
  assert.equal(budget.imagesAnalyzed, 9);
  assert.equal(budget.analysisCancelled, 2);
  assert.equal(budget.analysisEstimates, 3);
  test.resetBudget();
  assert.equal(panel("openai", AbortController, {}, settings).loadBudget().usd, 0);
  assert.equal(settings.get("nbp.budgetCHF"), "8.103");
}
console.log("USD migration tests passed (one-time conversion, existing zero, counters and reset).");
