/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 */

import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

// Exercise the actual archive and bridge without Photoshop or disk fixtures.
const bundle = await build({
  stdin: {
    contents: `
      export { readLayerGenerationArchive, writeLayerGenerationArchive } from "./src/archive";
      export { restoreArchivedSelection, setRectSelection } from "./src/photoshop-bridge";
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["photoshop", "uxp"],
  write: false,
  logLevel: "silent",
});

const geometry = {
  selectionBounds: { left: 100, top: 200, right: 500, bottom: 600 },
  generationBounds: { left: 50, top: 200, right: 550, bottom: 600 },
  documentWidth: 3000,
  documentHeight: 2000,
  artboard: null,
};
const archive = {
  v: 1, prompt: "Add a tree", provider: "Gemini", model: "test-model", modelLabel: "Test model",
  resolution: "1K", ratio: "5:4", quality: "auto", includeSelection: true,
  placeAsSmartObject: true, reduceDocumentSize: true,
  resultStorage: { mode: "jpeg-90", mimeType: "image/jpeg", byteLength: 1234, lossy: true },
  referenceNames: [], references: [], requestedSize: "5:4 at 1K",
  outputWidth: 500, outputHeight: 400, createdAt: "2026-08-28T12:00:00.000Z",
};
const clone = (value) => structuredClone(value);
const app = { activeDocument: null, documents: [] };
let modal = false;
let beforeModal = null;
let selectionWrites = 0;
let selectionError = null;
let metadata;

const photoshop = {
  app,
  constants: { LayerKind: { GROUP: "group" } },
  core: {
    executeAsModal: async (target) => {
      const hook = beforeModal;
      beforeModal = null;
      if (hook) hook();
      assert.equal(modal, false, "recall must not nest Photoshop modal operations");
      modal = true;
      try {
        return await target({});
      } finally {
        modal = false;
      }
    },
  },
  action: {
    batchPlay: async ([command]) => {
      if (command._target[0]._property === "generatorSettings") {
        if (command._obj === "set") metadata = command.to.json;
        return [{ generatorSettings: { json: metadata } }];
      }
      assert.equal(modal, true, "geometry reads and selection changes must be inside the modal scope");
      if (command._obj === "get") {
        const artboard = app.activeDocument.artboards.find((item) => item.id === command._target[0]._id);
        assert.ok(artboard, "unexpected Photoshop read");
        return [{ artboard: { artboardRect: artboard.bounds } }];
      }
      assert.equal(command._obj, "set");
      assert.equal(command._target[0]._property, "selection");
      assert.equal(command.to._obj, "rectangle");
      if (selectionError) return [{ _obj: "error", message: selectionError }];
      selectionWrites += 1;
      app.activeDocument.selection = Object.fromEntries(
        ["left", "top", "right", "bottom"].map((edge) => [edge, command.to[edge]._value])
      );
      return [{}];
    },
  },
};
const module = { exports: {} };
const loadBundle = runInThisContext(`(function(require, module, exports) {\n${bundle.outputFiles[0].text}\n})`);
loadBundle((name) => {
  if (name === "photoshop") return photoshop;
  if (name === "uxp") return { storage: {} };
  throw new Error(`Unexpected external module: ${name}`);
}, module, module.exports);
const { readLayerGenerationArchive, writeLayerGenerationArchive, restoreArchivedSelection, setRectSelection } = module.exports;

function resetDocument(savedGeometry = geometry) {
  const artboard = savedGeometry.artboard ? { ...clone(savedGeometry.artboard), name: "Artboard" } : null;
  const layer = { id: 2, parent: artboard };
  app.activeDocument = {
    id: 1, width: savedGeometry.documentWidth, height: savedGeometry.documentHeight,
    quickMaskMode: false, activeLayers: [layer], layers: [layer], artboards: artboard ? [artboard] : [],
    selection: { left: 10, top: 20, right: 30, bottom: 40 },
  };
  app.documents = [app.activeDocument];
  selectionWrites = 0;
  selectionError = null;
  beforeModal = null;
  return app.activeDocument;
}

async function expectBlocked(savedGeometry, pattern) {
  const doc = app.activeDocument;
  const previousSelection = clone(doc?.selection);
  const previousWrites = selectionWrites;
  await assert.rejects(restoreArchivedSelection(1, 2, savedGeometry), pattern);
  assert.deepEqual(doc?.selection, previousSelection, "a rejected recall must preserve the existing selection");
  assert.equal(selectionWrites, previousWrites, "a rejected recall must not write a clipped or adjusted selection");
}

// Both rectangles survive serialization. Missing or malformed optional geometry
// must not hide the prompt/settings or infer a position from output size.
await writeLayerGenerationArchive(1, 2, { ...archive, geometry });
assert.deepEqual(await readLayerGenerationArchive(1, 2), { ...archive, geometry });
const legacyArchive = clone(archive);
delete legacyArchive.placeAsSmartObject;
delete legacyArchive.reduceDocumentSize;
delete legacyArchive.resultStorage;
await writeLayerGenerationArchive(1, 2, legacyArchive);
assert.deepEqual(await readLayerGenerationArchive(1, 2), legacyArchive, "older archives remain readable");
await writeLayerGenerationArchive(1, 2, archive);
assert.deepEqual(await readLayerGenerationArchive(1, 2), archive);
resetDocument();
await expectBlocked(undefined, /no readable saved rectangle/);
for (const invalid of [null, {}, { ...geometry, documentWidth: 0 },
  { ...geometry, selectionBounds: { ...geometry.selectionBounds, right: 100 } },
  { ...geometry, generationBounds: { ...geometry.generationBounds, left: "50" } },
  { ...geometry, artboard: { id: 10 } }]) {
  await writeLayerGenerationArchive(1, 2, { ...archive, geometry: invalid });
  assert.deepEqual(await readLayerGenerationArchive(1, 2), { ...archive, geometry: undefined });
  await expectBlocked(invalid, /no readable saved rectangle/);
}

resetDocument();
await restoreArchivedSelection(1, 2, geometry);
assert.deepEqual(app.activeDocument.selection, geometry.selectionBounds, "restore the original selection, not the fitted crop");
assert.equal(selectionWrites, 1);
resetDocument();
app.activeDocument.activeLayers[0].bounds = { left: 1000, top: 1200, right: 1500, bottom: 1600 };
await restoreArchivedSelection(1, 2, geometry);
assert.deepEqual(app.activeDocument.selection, geometry.selectionBounds, "content movement does not change original coordinates");
resetDocument();
await restoreArchivedSelection(1, 2, { ...geometry, selectionBounds: null });
assert.deepEqual(app.activeDocument.selection, geometry.generationBounds, "without a drawn selection, restore the generation frame");

// Reject growth and shrinkage, including changes made while recall waits.
for (const [width, height] of [[3600, 2000], [2500, 2000], [3000, 1500], [NaN, 2000]]) {
  const doc = resetDocument();
  doc.width = width;
  doc.height = height;
  await expectBlocked(geometry, /Canvas changed|Could not read the current canvas/);
}
resetDocument();
beforeModal = () => { app.activeDocument.width = 3600; };
await expectBlocked(geometry, /3000 × 2000 to 3600 × 2000/);
for (const edge of [{ left: -1 }, { top: -1 }, { right: 3001 }, { bottom: 2001 }]) {
  resetDocument();
  await expectBlocked({ ...geometry, selectionBounds: { ...geometry.selectionBounds, ...edge } }, /does not fit entirely/);
}
resetDocument();
await restoreArchivedSelection(1, 2, { ...geometry, selectionBounds: { left: 0, top: 0, right: 3000, bottom: 2000 } });
assert.deepEqual(app.activeDocument.selection, { left: 0, top: 0, right: 3000, bottom: 2000 });

// Artboards can have negative coordinates. Use their own bounds and identity.
const artboardGeometry = {
  ...geometry,
  artboard: { id: 10, bounds: { left: -500, top: 100, right: 500, bottom: 1100 } },
  selectionBounds: { left: -400, top: 200, right: 300, bottom: 600 },
  generationBounds: { left: -450, top: 200, right: 350, bottom: 600 },
};
resetDocument(artboardGeometry);
await restoreArchivedSelection(1, 2, artboardGeometry);
assert.deepEqual(app.activeDocument.selection, artboardGeometry.selectionBounds);
for (const change of [
  (doc) => { doc.artboards = []; },
  (doc) => { doc.artboards[0].id = 11; },
  (doc) => { doc.artboards[0].bounds.left -= 100; doc.artboards[0].bounds.right -= 100; },
  (doc) => { doc.artboards[0].bounds.bottom += 100; },
]) {
  change(resetDocument(artboardGeometry));
  await expectBlocked(artboardGeometry, /original artboard/);
}
resetDocument(artboardGeometry);
await expectBlocked(geometry, /original artboard/);
await expectBlocked({ ...artboardGeometry, selectionBounds: { ...artboardGeometry.selectionBounds, left: -600 } }, /inside the artboard/);

// Never follow a stale recall target or alter Quick Mask. Check after acquiring
// the modal scope, even if the panel was current when the button was clicked.
for (const change of [
  (doc) => { doc.id = 99; },
  (doc) => { doc.activeLayers = [{ id: 3 }]; },
  (doc) => { doc.activeLayers = [{ id: 2 }, { id: 3 }]; },
  (doc) => { doc.quickMaskMode = true; },
]) {
  change(resetDocument());
  await expectBlocked(geometry, /current selection is unchanged/);
}
resetDocument();
beforeModal = () => { app.activeDocument = { ...app.activeDocument, id: 99 }; };
await expectBlocked(geometry, /Select the archived result layer/);
assert.equal(app.activeDocument.id, 99, "recall must not switch back to a stale document");
app.activeDocument = null;
await expectBlocked(geometry, /Open a document/);

resetDocument();
selectionError = "Selection command unavailable";
await expectBlocked(geometry, /Selection command unavailable/);
selectionError = null;
await setRectSelection(geometry.generationBounds, 1);
assert.deepEqual(app.activeDocument.selection, geometry.generationBounds, "existing fit-selection callers still work");

console.log("generation recall tests passed (metadata, geometry, artboards, stale targets and host errors)");
