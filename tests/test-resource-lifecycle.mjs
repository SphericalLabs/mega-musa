/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule } from "./test-support.mjs";
const hostError = { _obj: "error", message: "simulated command failure", result: -1 };
const metadata = await loadModule("src/photoshop/metadata.ts", { modules: { photoshop: { action: { batchPlay: async (_commands, options) => {
  assert.equal(options.propagateErrorToDefaultHandler, false);
  return [hostError];
} } } } });
await assert.rejects(metadata.writeLayerGenerationArchive(1, 2, {}), error => error.message === hostError.message && error.result === -1,
  "metadata errors and Photoshop codes must reach the caller");

let disposed = 0;
let failPixels = true;
const pixelHost = {
  core: { executeAsModal: async (fn) => fn({}) },
  imaging: {
    getPixels: async () => ({
      imageData: {
        width: 2, height: 1, components: 4,
        getData: async () => { if (failPixels) throw new Error("pixel read failed"); return Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8); },
        dispose: () => disposed++,
      }
    })
  },
};
const pixels = await loadModule("src/photoshop/pixels.ts", { modules: { photoshop: pixelHost } });
await assert.rejects(pixels.readRegion(1, { left: 0, top: 0, right: 2, bottom: 1 }, false), /pixel read failed/);
assert.equal(disposed, 1, "failed reads must release host image data");
failPixels = false;
const read = await pixels.readRegion(1, { left: 0, top: 0, right: 2, bottom: 1 }, false);
assert.equal(disposed, 2);
assert.deepEqual([...read.image.data], [1, 2, 3, 4, 5, 6, 7, 8]);

let suspended = 0, resumed = 0;
const doc = { id: 1, layers: [], activeLayers: [] };
const placementHost = {
  app: { activeDocument: doc, documents: [doc] },
  constants: {},
  action: { batchPlay: async commands => [commands[0]._obj === "get" ? {} : hostError] },
  core: {
    executeAsModal: async (fn) => fn({
      hostControl: {
        suspendHistory: async () => { suspended++; return {}; },
        resumeHistory: async (_suspension, commit) => { assert.equal(commit, false); resumed++; },
      }
    })
  },
};
const placement = await loadModule("src/photoshop/placement.ts", { modules: { photoshop: placementHost } });
await assert.rejects(placement.placeResult({
  docId: 1, bounds: { left: 0, top: 0, right: 1, bottom: 1 }, rgba: Uint8Array.of(0, 0, 0, 255), width: 1, height: 1,
  layerName: "test", selection: null, placeAsSmartObject: false, reduceDocumentSize: false, archive: {}, references: [],
}), /simulated command failure/);
assert.equal(suspended, 1);
assert.equal(resumed, 1, "failed placement must close its explicit history scope");
console.log("Host failures: metadata error reporting, image disposal and history cleanup passed.");

// Scratch ownership must protect every existing document, even if Photoshop returns
// an existing document from creation or rejects the explicit close command.
{
  const original = { id: 1 }, other = { id: 2 }, scratch = { id: 3 };
  let returned = other, rejectClose = true;
  const app = { activeDocument: original, documents: [original, other], createDocument: async () => {
    if (returned === scratch) app.documents.push(scratch);
    return returned;
  } };
  const commands = [];
  const runtime = await loadModule("src/photoshop/runtime.ts", { modules: { photoshop: {
    app, action: { batchPlay: async ([command]) => {
      commands.push(command);
      assert.equal(command._obj, "close");
      assert.equal(command._target[0]._id, scratch.id);
      if (rejectClose) return [{ _obj: "error", result: 9, message: "Close blocked" }];
      app.documents = [original, other];
      return [{}];
    } },
  } } });
  await assert.rejects(runtime.createScratchDocument({}), /did not return a new temporary document/);
  await assert.rejects(runtime.closeScratchDocument(original.id), /Refusing to close/);
  await assert.rejects(runtime.closeScratchDocument(other.id), /Refusing to close/);
  assert.equal(commands.length, 0);
  returned = scratch;
  await runtime.createScratchDocument({});
  await assert.rejects(runtime.closeScratchDocument(scratch.id), /Close blocked/);
  assert.deepEqual(app.documents, [original, other, scratch]);
  assert.equal(commands.length, 1, "a blocked targeted close must never fall back to closing the active document");
  rejectClose = false;
  await runtime.closeScratchDocument(scratch.id);
  assert.deepEqual(app.documents, [original, other]);
}
