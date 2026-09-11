/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, flush } from "./test-support.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
function imageData(data, width, height, components = 4) {
  return { width, height, components, getData: async () => data, dispose() { data.fill(0); } };
}
const doc = { id: 7, width: 1400, height: 1000, mode: "RGB", bitsPerChannel: 8, artboards: [], layers: [], activeLayers: [], selection: null };
let modalDepth = 0, selectionReads = 0, pixelReads = 0;
let readPixels = async ({ sourceBounds }) => {
  const width = sourceBounds.right - sourceBounds.left, height = sourceBounds.bottom - sourceBounds.top;
  return { sourceBounds, imageData: imageData(new Uint8Array(width * height * 4).fill(255), width, height) };
};
const ps = {
  app: { activeDocument: doc, documents: [doc] },
  core: { async executeAsModal(fn) { assert.equal(modalDepth++, 0); try { return await fn({}); } finally { modalDepth--; } } },
  action: { async batchPlay(commands) { return commands.map(command => {
    assert.equal(modalDepth, 1, "selection coordinates are read inside the same modal scope as pixels");
    if (command._obj === "get" && command._target[0]._property === "selection") return { selection: doc.selection?.bounds };
    if (command._obj === "get" && command._target[0]._ref === "layer") return { artboard: { artboardRect: doc.artboards[0].bounds } };
    if (command._obj === "set" && command.to?._obj === "rectangle") {
      const bounds = Object.fromEntries(["left", "top", "right", "bottom"].map(key => [key, command.to[key]._value]));
      doc.selection = { bounds, coverage: () => 255 };
      return {};
    }
    throw new Error(`Unexpected command: ${command._obj}`);
  }); } },
  imaging: {
    async getSelection({ sourceBounds }) {
      assert.equal(modalDepth, 1);
      selectionReads++;
      const width = sourceBounds.right - sourceBounds.left, height = sourceBounds.bottom - sourceBounds.top;
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        data[y * width + x] = doc.selection.coverage(x + sourceBounds.left, y + sourceBounds.top);
      }
      return { sourceBounds, imageData: imageData(data, width, height, 1) };
    },
    async getPixels(options) { pixelReads++; return readPixels(options); },
  },
};
const api = await loadModule(["src/generation/snapshot.ts", "src/generation/prepare.ts", "src/photoshop/pixels.ts", "src/images/codec.ts", "src/host-modal.ts"], { modules: { photoshop: ps } });
const context = { queue: { latestId: 1, update() {} }, processor: {}, setNote() {}, confirmDocumentWarnings: async () => true };
const capture = include => api.captureGenerationCanvas(7, null, "gemini-3-pro-image", "2K", include);
const full = { left: 0, top: 0, right: 1400, bottom: 1000 };

// The reported 7:5 canvas must not shrink to a 4:3 destination, with or without a selection.
for (const selected of [false, true]) {
  doc.selection = selected ? { bounds: full, coverage: () => 255 } : null;
  const canvas = await capture(false);
  assert.deepEqual(plain(canvas.region), full);
  assert.equal(canvas.frame.label, "4:3");
  assert.deepEqual(plain(doc.selection.bounds), full);
  assert.equal(canvas.selectionSnapshot?.data.length ?? 0, selected ? 1400000 : 0);
  if (selected) assert.ok(canvas.selectionSnapshot.data.every(value => value === 255), "disposed host buffers must not invalidate snapshots");
  const prepared = await api.prepareGeneration({ ...canvas, id: 1, resolution: "2K", references: [] }, context);
  assert.equal(prepared.cropW, 1400);
  assert.equal(prepared.cropH, 1000);
}

// An edge selection keeps all of its coverage; context can extend beyond the canvas.
const edge = { left: 0, top: 0, right: 680, bottom: 1000 };
doc.selection = { bounds: edge, coverage: (x, y) => x === 0 || y === 0 ? 128 : 255 };
const edgeInput = await capture(false);
assert.deepEqual(plain(edgeInput.region), edge);
assert.ok(edgeInput.inputBounds.top < 0);
assert.equal(edgeInput.selectionSnapshot.data[0], 128);
assert.equal(edgeInput.selectionSnapshot.data.at(-1), 255);
assert.deepEqual(plain(doc.selection.bounds), edge);

// Wait for Photoshop first, then capture bounds, mask and canvas together. Later
// preparation (including expanded jobs) must never re-read the mutable document.
const gate = await api.acquireHostModalTask();
const pending = capture(true);
await flush();
const frozenBounds = { left: 20, top: 10, right: 120, bottom: 110 };
doc.selection = { bounds: frozenBounds, coverage: x => x < 70 ? 64 : 255 };
gate.release();
const frozen = await pending;
assert.deepEqual(plain(frozen.rawSelection), frozenBounds);
assert.equal(frozen.selectionSnapshot.data[0], 64);
assert.equal(frozen.selectionSnapshot.data[99], 255);
const reads = [selectionReads, pixelReads];
doc.selection = { bounds: { left: 900, top: 100, right: 1100, bottom: 400 }, coverage: () => 0 };
for (const id of [1, 2]) {
  const prepared = await api.prepareGeneration({ ...frozen, id, resolution: "2K", references: [], includeSelection: true }, context);
  assert.equal(prepared.basePng, frozen.basePng);
  assert.equal(prepared.selectionSnapshot, frozen.selectionSnapshot);
  assert.deepEqual(plain(prepared.region), frozenBounds);
}
assert.deepEqual([selectionReads, pixelReads], reads);

// Photoshop trims to x=20..80 and may return cache-level coordinates. The full
// request still has transparent margins, with content in its original position.
for (const level of [0, 1, 2]) {
  readPixels = async () => ({
    level,
    sourceBounds: { left: 20 / 2 ** level, top: 0, right: 80 / 2 ** level, bottom: 100 / 2 ** level },
    imageData: imageData(new Uint8Array(30 * 50 * 4).fill(255), 30, 50),
  });
  const { image } = await api.readRegion(7, { left: 0, top: 0, right: 100, bottom: 100 }, false, 50);
  assert.equal(image.width, 50);
  assert.equal(image.height, 50);
  const alpha = x => image.data[x * 4 + 3];
  assert.equal(alpha(9), 0);
  assert.equal(alpha(10), 255);
  assert.equal(alpha(39), 255);
  assert.equal(alpha(40), 0);
}

// The same mapping works on an artboard with a negative origin, and reads cannot
// pick up pixels from neighboring artboards outside the intended target.
const artboardBounds = { left: -300, top: 20, right: 100, bottom: 320 };
doc.artboards = [{ id: 10, name: "Page", bounds: artboardBounds }];
doc.selection = null;
readPixels = async ({ sourceBounds }) => {
  assert.deepEqual(plain(sourceBounds), artboardBounds);
  return { sourceBounds, imageData: imageData(new Uint8Array(400 * 300 * 4).fill(255), 400, 300) };
};
const artboard = await capture(true);
assert.deepEqual(plain(artboard.region), artboardBounds);
const decoded = api.decodePng(artboard.basePng);
assert.equal(decoded.width, 400);
assert.equal(decoded.height, 300);
assert.equal(decoded.data.at(-1), 255);

// No pixel data is a transparent frame, never an arbitrary smaller crop.
readPixels = async () => ({ imageData: null });
const empty = await api.readRegion(7, { left: 0, top: 0, right: 10, bottom: 10 }, false);
assert.equal(empty.image.data.length, 400);
assert.ok(empty.image.data.every(value => value === 0));
console.log("Generation geometry: full coverage, atomic snapshots, feathering, transparent margins, cache levels and artboard origins passed.");
