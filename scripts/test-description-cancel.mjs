/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Bundle the real panel with test-only access to its handlers and input state.
// Photoshop, the resize WebView and provider responses stay under test control.
const bundle = await build({
  stdin: {
    contents: `${await readFile("src/main.ts", "utf8")}
      export { onDescribe, onUndoDescription, updateDescriptionControls, onReferenceResizeMessage, DESCRIPTION_MODELS };
      export { loadBudget, resetBudget, addToBudget, addDescriptionToBudget, budgetText, descriptionUsageCHF, estimatedDescriptionCHF };
      export function setTestReferences(images) { refs = images; dropWebviewReady = true; }
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
  const elements = Object.fromEntries(
    ["describe", "describeModel", "undoDescription", "prompt", "generate", "includeSelection",
      "openaiApiKey", "geminiApiKey", "status", "dropWebview", "budgetTotal", "budgetCounts"].map((id) => [id, {
      value: "", textContent: "", disabled: false, checked: false, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      dispatchEvent() {},
    }])
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
    document: { readyState: "loading", getElementById: (id) => elements[id], addEventListener() {} },
    localStorage: {
      getItem: (key) => settings.get(key) ?? null,
      setItem: (key, value) => settings.set(key, value),
    },
    AbortController: Controller, Event, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  const api = module.exports;
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
  assert.equal(elements.describe.attributes.variant, "warning");
  assert.equal(elements.describe.disabled, false);
  for (const id of ["prompt", "describeModel", "undoDescription", "generate"]) {
    assert.equal(elements[id].disabled, true, `${id} stays disabled during a description`);
  }
}

function expectIdle({ elements }) {
  assert.equal(elements.describe.textContent, "Describe");
  assert.equal(elements.describe.attributes.variant, "primary");
  for (const id of ["prompt", "describeModel", "generate"]) {
    assert.equal(elements[id].disabled, false, `${id} is restored after a description`);
  }
}

// Cancel even when fetch ignores its signal or AbortController is unavailable.
// An old response or error must not overwrite a new description or its controls.
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
      assert.equal(test.elements.undoDescription.disabled, true);
      assert.match(test.elements.status.textContent, /Description canceled.*Estimate:.*added to the budget/);
      assert.equal(test.elements.status.className, "");
      const canceledBudget = test.loadBudget();
      assert.equal(canceledBudget.chf, test.model.estimatedCHF);
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
      assert.equal(test.elements.undoDescription.disabled, false);
      assert.equal(test.elements.status.className, "ok");
      const usageCost = (provider === "openai"
        ? (1675 * 0.2 + 800 * 1.2)
        : (1550 * 0.3 + 800 * 2.5)) / 1000000 * 0.8103;
      assert.ok(Math.abs(test.loadBudget().chf - canceledBudget.chf - usageCost) < 1e-12);
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
      test.onUndoDescription();
      assert.equal(test.elements.prompt.value, "Original prompt");
      assert.deepEqual(test.loadBudget(), completedBudget, "Undo and canceling preparation never undo or add a charge");
    }
  }
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
  assert.equal(test.loadBudget().chf, 0);
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

// A real provider error still reports failure and restores the controls.
{
  const test = panel();
  const run = test.onDescribe();
  test.finishResize();
  await flush();
  test.requests[0].reject(new Error("Provider unavailable"));
  await finishesPromptly(run);
  expectIdle(test);
  assert.equal(test.elements.prompt.value, "Original prompt");
  assert.equal(test.elements.undoDescription.disabled, true);
  assert.match(test.elements.status.textContent, /Description error:.*Provider unavailable/);
  assert.equal(test.elements.status.className, "error");
  assert.equal(test.loadBudget().imagesAnalyzed, 0);
  assert.equal(test.loadBudget().chf, 0);
}

// Published rates, cache read/write prices and output reasoning are applied once.
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
    const cost = ((model.provider === "openai" ? 1675 : 1550) * input + 800 * output) / 1000000 * 0.8103;
    assert.ok(Math.abs(test.descriptionUsageCHF(model, usage, new Date("2026-08-28")) - cost) < 1e-12);
    assert.equal(test.estimatedDescriptionCHF(model, 3), model.estimatedCHF * 3);
    for (const malformed of [{}, { inputTokens: 20 }, { inputTokens: null, outputTokens: 10 },
      { inputTokens: -1, outputTokens: 10 }, { inputTokens: 20, outputTokens: Infinity },
      { inputTokens: 20, outputTokens: 10, cachedInputTokens: 21 }]) {
      assert.equal(test.descriptionUsageCHF(model, malformed), null);
    }
    if (model.provider === "openai") {
      assert.equal(test.descriptionUsageCHF(model, { ...usage, serviceTier: "fast" }), cost * 2);
      assert.equal(test.descriptionUsageCHF(model, { ...usage, serviceTier: "flex" }), cost * 0.5);
    }
    if (model.model === "gemini-3.7-flash") {
      assert.equal(test.descriptionUsageCHF(model, usage, new Date("2027-01-01")), cost * 2);
    }
  }
}

// Legacy request counts are not image counts. Start the new counters at zero
// without clearing any existing spend, generation counts or the reset date.
{
  const settings = new Map(Object.entries({ "nbp.budgetCHF": "1.25", "nbp.budgetImages": "4",
    "nbp.budgetUnpriced": "1", "nbp.budgetCancelled": "2", "nbp.budgetSince": "2026-08-01T12:00:00.000Z",
    "nbp.budgetDescriptions": "3", "nbp.budgetDescriptionCancelled": "1", "nbp.budgetDescriptionEstimates": "2" }));
  const test = panel("openai", AbortController, {}, settings);
  const initial = test.loadBudget();
  assert.equal(initial.imagesAnalyzed, 0);
  assert.equal(initial.analysisCancelled, 0);
  assert.equal(initial.analysisEstimates, 0);
  assert.equal(test.budgetText(initial).counts,
    "(4 images, 0 images described, 1 unpriced, 2 image requests canceled but billed)");
  test.addDescriptionToBudget(0.00125, 10);
  test.addToBudget(0.2);
  test.addDescriptionToBudget(0.0015, 2, true, true);
  const saved = test.loadBudget();
  assert.ok(Math.abs(saved.chf - 1.45275) < 1e-12);
  assert.equal(saved.images, 5);
  assert.equal(saved.unpriced, 1);
  assert.equal(saved.cancelled, 2);
  assert.equal(saved.imagesAnalyzed, 12);
  assert.equal(saved.analysisCancelled, 2);
  assert.equal(saved.analysisEstimates, 2);
  assert.equal(saved.since, "2026-08-01T12:00:00.000Z");
  const reloaded = panel("openai", AbortController, {}, settings);
  assert.equal(JSON.stringify(reloaded.loadBudget()), JSON.stringify(saved));
  assert.match(reloaded.budgetText(saved).total, /CHF 1\.45$/);
  for (const imagesAnalyzed of [0, 3]) {
    for (const [chf, formatted] of [[0, "0.00"], [0.004, "0.00"], [14.638, "14.64"]]) {
      const budget = { ...saved, imagesAnalyzed, chf };
      assert.ok(reloaded.budgetText(budget).total.endsWith(`CHF ${formatted}`));
      assert.equal(budget.chf, chf, "display rounding must preserve the stored amount");
    }
  }
  const reset = reloaded.resetBudget();
  for (const key of ["chf", "images", "unpriced", "cancelled", "imagesAnalyzed", "analysisCancelled", "analysisEstimates"]) {
    assert.equal(reset[key], 0, `${key} resets with the budget`);
  }
  assert.equal(JSON.stringify(reloaded.loadBudget()), JSON.stringify(reset));
}

// One Photoshop selection plus nine references is ten described images in one
// request. Changing the current inputs must not change that request's count.
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
    const usageCost = test.descriptionUsageCHF(test.model, {
      inputTokens: 2000, cachedInputTokens: 500,
      cacheWriteInputTokens: provider === "openai" ? 500 : 0, outputTokens: 800,
    });
    assert.equal(saved.chf, canceled ? test.model.estimatedCHF * 10 : usageCost,
      "add the whole request cost once, not once per image");
    if (canceled) {
      test.finishRequest(0, descriptions);
      await flush();
      assert.deepEqual(test.loadBudget(), saved, "late usage must not add cost or images again");
    }
  }
}

// Missing or malformed usage estimates and counts every input image.
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
    assert.equal(test.loadBudget().chf, test.model.estimatedCHF * 2);
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
  assert.ok(test.loadBudget().chf > 0);
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
  assert.equal(test.loadBudget().chf, 0);
  const successful = test.onDescribe();
  test.finishResize();
  await flush();
  test.finishRequest(1, "Zero usage response.", provider === "openai"
    ? { input_tokens: 0, output_tokens: 0 }
    : { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 });
  await finishesPromptly(successful);
  assert.equal(test.loadBudget().imagesAnalyzed, 1);
  assert.equal(test.loadBudget().chf, 0);
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
  assert.equal(test.loadBudget().chf, 0);
  assert.equal(test.loadBudget().imagesAnalyzed, 0);
}

console.log("description tests passed (cancellation, usage pricing, image counts, estimates, shared budget, persistence, reset and Undo)");
