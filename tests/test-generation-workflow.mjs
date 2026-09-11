/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, memoryStorage, deferred, flush } from "./test-support.mjs";
const { GenerationQueue } = await loadModule("src/generation/queue.ts");
const { encodePng } = await loadModule("src/images/codec.ts");
const image = { mimeType: "image/png", bytes: encodePng(Uint8Array.of(20, 40, 60, 255), 1, 1, 4) };
const bounds = { left: 0, top: 0, right: 1, bottom: 1 };

async function harness({ prepare, generate, place, dispatch = true } = {}) {
  const storage = memoryStorage();
  const { createGenerationWorkflow, HostModalTimeoutError, ProviderFailure } = await loadModule(["src/generation/workflow.ts", "src/host-modal.ts", "src/providers/failure.ts"], { globals: { localStorage: storage } });
  const queue = new GenerationQueue();
  const [id] = queue.reserve(1);
  const job = {
    id, model: "gemini-3-pro-image", provider: "Gemini", prompt: "frozen prompt", apiKey: "test-key", quality: "auto", resolution: "1K",
    includeSelection: false, placeAsSmartObject: true, reduceDocumentSize: false, references: [], archiveReferences: async () => [],
    docId: 7, docWidth: 1, docHeight: 1, anchorLayerId: 3, activeArtboard: null, rawSelection: null, documentState: {}, state: "preparing", status: "",
    cancelRequested: false, cancelInFlight: null, cancelSlotWait: null, slotAcquired: false, requestSent: false, sentCharge: null, pendingPlacement: null
  };
  queue.add([job]);
  const requests = [], placements = [], charges = [];
  const context = {
    queue, processor: { resize() { throw new Error("unexpected resize"); } },
    setStatus() { }, setNote() { }, renderBudget(budget) { charges.push(budget); }, confirmDocumentWarnings: async () => true, onRecallRefresh() { }, onQueueRefresh() { }
  };
  const workflow = createGenerationWorkflow(context, {
    prepare: prepare || (async () => ({
      frame: { label: "1:1", ratio: 1, geminiAspect: "1:1" }, region: bounds, cropW: 1, cropH: 1, isRegion: false, selectionSnapshot: null,
      notes: [], exactOutputSize: "", outputFrameNote: "1:1 at 1K", outputDimensions: [], requestReferences: [], basePng: undefined
    })),
    generate: async (request) => { if (dispatch) request.onDispatch?.(); requests.push(request); return generate ? generate(request) : image; },
    place: async (request) => { placements.push(request); return place ? place(request, HostModalTimeoutError) : { smartObject: true, clip: "none", archiveSaved: true, referenceArchiveFailures: 0 }; },
  });
  return { queue, job, workflow, requests, placements, charges, storage, ProviderFailure };
}

// Cancellation before dispatch neither sends nor charges a provider request.
{
  const gate = deferred();
  const h = await harness({ prepare: () => gate.promise });
  const run = h.workflow.runGenerationJob(h.job);
  h.queue.cancel(h.job);
  gate.reject(Object.assign(new Error("cancel"), { nbpCancelled: true }));
  await run;
  assert.equal(h.requests.length, 0);
  assert.equal(h.charges.length, 0);
  assert.equal(h.queue.items.length, 0);
}
// An adapter can perform local preparation before any billable dispatch.
{
  const gate = deferred();
  const h = await harness({ dispatch: false, generate: () => gate.promise });
  const run = h.workflow.runGenerationJob(h.job);
  await flush();
  assert.equal(h.job.requestSent, false);
  h.queue.cancel(h.job);
  await run;
  assert.equal(h.charges.length, 0);
  gate.resolve(image);
  await flush();
  assert.equal(h.placements.length, 0);
}
// Canceling in flight charges once and ignores late success or failure.
for (const late of ["success", "failure"]) {
  const gate = deferred();
  const h = await harness({ generate: () => gate.promise });
  const run = h.workflow.runGenerationJob(h.job);
  await flush();
  assert.equal(h.requests.length, 1);
  h.queue.cancel(h.job);
  await run;
  assert.equal(h.charges.length, 1);
  assert.equal(h.charges[0].cancelled, 1);
  if (late === "success") gate.resolve(image); else gate.reject(new Error("late rejection"));
  await flush();
  assert.equal(h.charges.length, 1);
  assert.equal(h.placements.length, 0);
}
// Paid results retain their original destination and are counted before decoding.
{
  const h = await harness(); await h.workflow.runGenerationJob(h.job);
  assert.equal(h.placements[0].docId, 7);
  assert.equal(h.placements[0].archive.prompt, "frozen prompt");
  assert.equal(h.placements[0].placeAsSmartObject, true);
  assert.equal(h.charges.length, 1);
  assert.equal(h.queue.items.length, 0);
  const broken = await harness({ generate: async () => ({ mimeType: "image/not-supported", bytes: Uint8Array.of(1) }) });
  await broken.workflow.runGenerationJob(broken.job);
  assert.equal(broken.charges.length, 1);
  assert.equal(broken.placements.length, 0);
  assert.equal(broken.job.state, "failed");
}
// Placement timeouts keep the paid pixels. Retrying never calls or bills the provider again.
{
  let attempts = 0;
  const h = await harness({
    place: async (_request, TimeoutError) => {
      if (attempts++ === 0) throw new TimeoutError("place", 30);
      return { smartObject: true, clip: "none", archiveSaved: true };
    }
  });
  await h.workflow.runGenerationJob(h.job);
  assert.equal(h.job.state, "placement-failed");
  assert.equal(h.requests.length, 1);
  assert.equal(h.charges.length, 1);
  const paidPixels = h.job.pendingPlacement.rgba;
  await h.workflow.retryGenerationPlacement(h.job);
  assert.equal(h.placements.length, 2);
  assert.equal(h.placements[1].rgba, paidPixels);
  assert.equal(h.placements[1].docId, 7);
  assert.equal(h.requests.length, 1);
  assert.equal(h.charges.length, 1);
  assert.equal(h.queue.items.length, 0);
}
console.log("Generation workflow: frozen destination, cancellation, billing, decoding failures and paid placement retry passed.");

// Confirmed remote cancellation uses known billing, including an explicit zero.
for (const costUSD of [0, 0.12]) {
  let h;
  h = await harness({ generate: async () => { throw new h.ProviderFailure("Remote canceled", { canceled: true, costUSD }); } });
  await h.workflow.runGenerationJob(h.job);
  assert.equal(h.charges.length, 1);
  assert.equal(h.charges[0].usd, costUSD);
  assert.equal(h.queue.items.length, 0);
}
