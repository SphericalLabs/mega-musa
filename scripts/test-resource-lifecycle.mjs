/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule } from "./test-support.mjs";
const hostError = { _obj: "error", message: "simulated command failure", result: -1 };
const metadata = await loadModule("src/photoshop/metadata.ts", { modules: { photoshop: { action: { batchPlay: async () => [hostError] } } } });
await assert.rejects(metadata.writeLayerGenerationArchive(1, 2, {}), /simulated command failure/, "metadata errors must reach the caller");

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
  action: { batchPlay: async () => [hostError] },
  core: {
    executeAsModal: async (fn) => fn({
      hostControl: {
        suspendHistory: async () => { suspended++; return {}; },
        resumeHistory: async () => { resumed++; },
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
