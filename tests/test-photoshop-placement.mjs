/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule } from "./test-support.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const target = { left: 12, top: 20, right: 16, bottom: 24 };
const rectangle = bounds => ({ bounds: { ...bounds }, data: new Uint8Array((bounds.right - bounds.left) * (bounds.bottom - bounds.top)).fill(255) });
const copySelection = selection => selection && { bounds: { ...selection.bounds }, data: selection.data.slice() };
const allLayers = doc => doc.layers.flatMap(layer => [layer, ...(layer.layers || [])]);
const hostImage = (data, width, height, components = 4) => ({ width, height, components, data, getData: async () => data, dispose() { data.fill(0); } });

async function harness({ liveSelection = rectangle(target), failSmartObject = false, failRaster = false, failMask = false, nested = false, initialLeft = -17.25,
  blockedReads = 0, blockedMaskReads = 0, failPixelWrites = 0, failLegacyCloseSelection = false, failScratchActivation = false } = {}) {
  const doc = { id: 7, width: 1400, height: 1000, layers: [], activeLayers: [], selection: copySelection(liveSelection) };
  const app = { activeDocument: doc, documents: [doc] };
  const files = [], commands = [], moves = [], commits = [], closedDocuments = [];
  let nextId = 20, historyClosed = 0;
  function layer(document, extra = {}) {
    const result = { id: nextId++, name: "Layer", parent: document, ...extra };
    result.move = () => {
      const owner = result.parent;
      owner.layers.splice(owner.layers.indexOf(result), 1);
      result.parent = document;
      document.layers.unshift(result);
      // Extracting from an artboard may change coordinates. Position must be checked afterward.
      if (result.bounds) { result.bounds.left += 90; result.bounds.right += 90; }
    };
    document.layers.unshift(result);
    document.activeLayers = [result];
    return result;
  }
  const anchor = layer(doc, nested ? { layers: [], name: "Artboard" } : {});
  app.createDocument = async options => {
    const scratch = { id: nextId++, ...options, layers: [], activeLayers: [], selection: null };
    layer(scratch);
    scratch.duplicateLayers = async ([source], destination) => {
      const copied = layer(destination, {
        name: source.name, source: source.source,
        bounds: { left: initialLeft, top: 8.5, right: initialLeft + scratch.width, bottom: 8.5 + scratch.height },
      });
      if (nested) {
        destination.layers.splice(destination.layers.indexOf(copied), 1);
        anchor.layers.push(copied);
        copied.parent = anchor;
      }
    };
    // Photoshop's DOM close selects the scratch, then issues an untargeted close.
    // A blocked selection can leave the user's document as that close's target.
    scratch.closeWithoutSaving = async () => {
      if (!failLegacyCloseSelection) app.activeDocument = scratch;
      const victim = app.activeDocument;
      closedDocuments.push(victim.id);
      app.documents.splice(app.documents.indexOf(victim), 1);
    };
    app.documents.push(scratch);
    if (!failScratchActivation) app.activeDocument = scratch;
    return scratch;
  };
  const ps = {
    app, constants: { ElementPlacement: { PLACEBEFORE: "before" } },
    core: { executeAsModal: async fn => fn({ hostControl: {
      suspendHistory: async () => ({ layers: doc.layers.slice(), activeLayers: doc.activeLayers.slice(), selection: copySelection(doc.selection) }),
      resumeHistory: async (snapshot, commit) => {
        historyClosed++; commits.push(commit);
        if (!commit) Object.assign(doc, snapshot);
      },
    } }) },
    action: { async batchPlay(batch, options) {
      assert.equal(options.propagateErrorToDefaultHandler, false);
      return batch.map(command => {
        commands.push(command);
        const document = app.activeDocument;
        if (command._obj === "get" && command._target[0]._property === "selection") {
          assert.equal(command._options.dialogOptions, "silent", "blocked selection reads must not show a native error dialog");
          if (blockedReads-- > 0) return { _obj: "error", result: -25920, message: "Simulated localized command error" };
          return { selection: document.selection?.bounds };
        }
        if (command._obj === "get" && command._target[0]._ref === "layer") {
          const b = allLayers(document).find(item => item.id === command._target[0]._id).bounds;
          return { smartObjectMore: { transform: [b.left, b.top, b.right, b.top, b.right, b.bottom, b.left, b.bottom] } };
        }
        if (command._obj === "close") {
          const id = command._target?.[0]?._id;
          assert.ok(id && id !== doc.id, "cleanup must explicitly target a temporary document");
          const index = app.documents.findIndex(item => item.id === id);
          assert.ok(index >= 0);
          closedDocuments.push(id);
          app.documents.splice(index, 1);
          if (app.activeDocument.id === id) app.activeDocument = doc;
        } else if (command._obj === "select" && command._target[0]._ref === "document") {
          const id = command._target[0]._id;
          if (failScratchActivation && id !== doc.id) return { _obj: "error", result: 9, message: "Blocked document activation" };
          app.activeDocument = app.documents.find(item => item.id === id);
          if (!app.activeDocument) throw new Error("Unknown document");
        } else if (command._obj === "select") {
          document.activeLayers = allLayers(document).filter(item => item.id === command._target[0]._id);
        } else if (command._obj === "set" && command._target[0]._property === "selection") {
          document.selection = command.to._value === "none" ? null : rectangle(Object.fromEntries(["left", "top", "right", "bottom"].map(key => [key, command.to[key]._value])));
        } else if (command._obj === "set" && command._target[0]._property === "generatorSettings") {
          allLayers(document).find(item => item.id === command._target[1]._id).archive = JSON.parse(command.to.json);
        } else if (command._obj === "set") {
          document.activeLayers[0].name = command.to.name;
        } else if (command._obj === "placeEvent") {
          if (failSmartObject) return { _obj: "error", message: "Simulated embedding failure" };
          const source = api.decodePng(files.find(file => file.name === command.null._path).bytes);
          layer(document, { source });
        } else if (command._obj === "imageSize") {
          assert.equal(command.constrainProportions, true, "aspect changes must never stretch the source");
          document.width = command.width._value;
          document.height = command.height._value;
        } else if (command._obj === "move") {
          const dx = command.to.horizontal._value, dy = command.to.vertical._value;
          moves.push({ dx, dy, hadSelection: !!document.selection });
          const b = document.activeLayers[0].bounds;
          b.left += dx; b.right += dx; b.top += dy; b.bottom += dy;
          if (document.selection) {
            // Simulate Photoshop moving the live marquee along with the layer.
            document.selection.bounds.left += dx;
            document.selection.bounds.right += dx;
          }
        } else if (command._obj === "make" && command._target?.[0]._ref === "layer") {
          if (failRaster) return { _obj: "error", message: "Simulated raster failure" };
          layer(document);
        } else if (command._obj === "make" && command.new?._class === "channel") {
          if (failMask) return { _obj: "error", message: "Simulated mask failure" };
          document.activeLayers[0].mask = copySelection(document.selection);
        } else if (command._obj === "delete") {
          const item = allLayers(document).find(item => item.id === command._target[0]._id);
          item.parent.layers.splice(item.parent.layers.indexOf(item), 1);
        } else throw new Error(`Unexpected command: ${command._obj}`);
        return {};
      });
    } },
    imaging: {
      async getSelection({ documentID, sourceBounds }) {
        if (blockedMaskReads-- > 0) throw Object.assign(new Error("Simulated modal error"), { number: 9 });
        const selection = app.documents.find(item => item.id === documentID).selection;
        assert.deepEqual(plain(sourceBounds), plain(selection.bounds));
        return { sourceBounds, imageData: hostImage(selection.data.slice(), sourceBounds.right - sourceBounds.left, sourceBounds.bottom - sourceBounds.top, 1) };
      },
      async createImageDataFromBuffer(data, options) { return hostImage(data.slice(), options.width, options.height, options.components); },
      async putSelection({ documentID, targetBounds, imageData }) {
        app.documents.find(item => item.id === documentID).selection = { bounds: { ...targetBounds }, data: imageData.data.slice() };
      },
      async putPixels({ documentID, layerID, imageData, targetBounds }) {
        if (failPixelWrites-- > 0) throw Object.assign(new Error("Pixel write is not currently available"), { number: -25920 });
        const document = app.documents.find(item => item.id === documentID);
        const item = allLayers(document).find(item => item.id === layerID);
        item.source = { data: imageData.data.slice(), width: imageData.width, height: imageData.height, channels: imageData.components };
        item.bounds = { ...targetBounds };
      },
      async getPixels({ documentID, sourceBounds }) {
        const document = app.documents.find(item => item.id === documentID);
        const source = document.layers[0].source;
        const resized = api.resampleRGBA(source.data, source.width, source.height, document.width, document.height);
        const width = sourceBounds.right - sourceBounds.left, height = sourceBounds.bottom - sourceBounds.top;
        const data = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          const start = ((y + sourceBounds.top) * document.width + sourceBounds.left) * 4;
          data.set(resized.subarray(start, start + width * 4), y * width * 4);
        }
        return { sourceBounds, imageData: hostImage(data, width, height) };
      },
    },
  };
  const storage = { formats: { binary: "binary" }, localFileSystem: {
    getTemporaryFolder: async () => ({ createFile: async name => {
      const file = { name, isFile: true, async write(bytes) { this.bytes = new Uint8Array(bytes); }, async delete() { this.deleted = true; } };
      files.push(file); return file;
    } }), createSessionToken: file => file.name,
  } };
  const api = await loadModule(["src/photoshop/placement.ts", "src/images/codec.ts", "src/images/resample.ts"], { modules: { photoshop: ps, uxp: { storage } } });
  const rgba = new Uint8Array(6 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) rgba.set([x * 30, y * 30, 80, 255], (y * 6 + x) * 4);
  const request = { docId: 7, bounds: target, rgba, width: 6, height: 4, layerName: "Result", selection: rectangle(target), placeAsSmartObject: true, reduceDocumentSize: false, archive: {}, references: [], anchorLayerId: anchor.id };
  return { app, doc, api, request, files, commands, moves, commits, closedDocuments, historyClosed: () => historyClosed };
}

// A 3:2 result must cover a square selection without distorting it. Both paths
// show the middle four source columns, and the live selection never travels.
for (const smart of [true, false]) {
  const h = await harness({ nested: true });
  const result = await h.api.placeResult({ ...h.request, placeAsSmartObject: smart });
  const layer = h.doc.layers[0];
  assert.equal(result.smartObject, smart);
  assert.equal(result.layerId, layer.id);
  assert.deepEqual(plain(h.doc.selection.bounds), target);
  assert.ok(h.doc.selection.data.every(value => value === 255));
  if (smart) {
    assert.deepEqual(plain(layer.bounds), { left: 11, top: 20, right: 17, bottom: 24 });
    assert.deepEqual(plain(layer.mask.bounds), target);
    assert.equal(layer.source.width, 6, "the embedded source remains full resolution");
  } else {
    assert.deepEqual(plain(layer.bounds), target);
    assert.deepEqual([layer.source.data[0], layer.source.data[4], layer.source.data[8], layer.source.data[12]], [30, 60, 90, 120]);
  }
  assert.ok(h.moves.every(move => !move.hadSelection));
  assert.equal(h.app.documents.length, 1);
  assert.equal(h.app.activeDocument, h.doc);
  assert.equal(h.historyClosed(), 1);
  assert.deepEqual(h.commits, [true]);
  assert.ok(h.files.every(file => file.deleted));
}

// Capture-based clipping must not overwrite a different, feathered live selection
// made while waiting for the provider. Also exercise proportional downscaling.
const live = rectangle({ left: 50, top: 60, right: 54, bottom: 64 });
live.data[0] = 32; live.data[5] = 128;
const captured = rectangle(target);
captured.data[0] = 0; captured.data[1] = 128;
for (const mode of ["smart", "raster", "fallback", "alpha"]) {
  const h = await harness({ liveSelection: live, failSmartObject: mode === "fallback", failMask: mode === "alpha" });
  const rgba = h.api.resampleRGBA(h.request.rgba, 6, 4, 12, 8);
  const result = await h.api.placeResult({ ...h.request, rgba, width: 12, height: 8, selection: captured, placeAsSmartObject: mode !== "raster" && mode !== "alpha" });
  assert.deepEqual(plain(h.doc.selection.bounds), live.bounds);
  assert.deepEqual([...h.doc.selection.data], [...live.data]);
  assert.ok(h.moves.every(move => !move.hadSelection));
  const layer = h.doc.layers[0];
  if (mode === "alpha") {
    assert.equal(result.clip, "alpha");
    assert.equal(layer.source.data[3], 0);
    assert.equal(layer.source.data[7], 128);
  } else {
    assert.deepEqual(plain(layer.mask.bounds), target);
    assert.deepEqual([...layer.mask.data], [...captured.data]);
  }
  if (mode === "smart") assert.deepEqual(plain(layer.bounds), { left: 11, top: 20, right: 17, bottom: 24 });
  else assert.equal(result.smartObject, false);
}

// Same-ratio opaque placement requires no mask, but fractional translation must
// still be corrected. Deselecting while a job runs stays deselected afterward.
{
  const h = await harness({ liveSelection: null, initialLeft: target.left + 0.75 });
  const rgba = new Uint8Array(4 * 4 * 4).fill(255);
  const result = await h.api.placeResult({ ...h.request, rgba, width: 4, height: 4 });
  assert.deepEqual(plain(h.doc.layers[0].bounds), target);
  assert.equal(result.clip, "none");
  assert.equal(h.doc.selection, null);
  assert.equal(h.moves[0].dx, -0.75);
}

// Placement errors still restore selection coverage and close the history scope.
{
  const h = await harness({ liveSelection: live, failRaster: true });
  await assert.rejects(h.api.placeResult({ ...h.request, placeAsSmartObject: false, width: 4, height: 4, rgba: new Uint8Array(64) }), /Simulated raster failure/);
  assert.deepEqual(plain(h.doc.selection.bounds), live.bounds);
  assert.deepEqual([...h.doc.selection.data], [...live.data]);
  assert.equal(h.historyClosed(), 1);
  assert.deepEqual(h.commits, [false]);
}

// A tool menu may block Get or the selection-mask read after entering executeAsModal.
// Closing it permits a single placement with the current selection intact.
for (const blocked of [{ blockedReads: 2 }, { blockedMaskReads: 2 }]) {
  const h = await harness({ ...blocked, liveSelection: live });
  await h.api.placeResult(h.request, { timeoutSeconds: 1 });
  assert.equal(h.commands.filter(command => command._obj === "get" && command._target[0]._property === "selection").length, 3);
  assert.equal(h.doc.layers.length, 2, "retrying read-only preparation must create just one result");
  assert.deepEqual(h.commits, [true], "blocked reads must not open history scopes");
  assert.deepEqual(plain(h.doc.selection), plain(live));
}
// Keeping the menu open times out without touching layers, selection or temporary files.
{
  const h = await harness({ blockedReads: Infinity, liveSelection: live });
  await assert.rejects(h.api.placeResult(h.request, { timeoutSeconds: 0.1 }), error => error.name === "HostModalTimeoutError");
  assert.equal(h.doc.layers.length, 1);
  assert.equal(h.files.length, 0);
  assert.equal(h.commits.length, 0);
  assert.ok(h.commands.every(command => command._obj === "get"));
  assert.deepEqual(plain(h.doc.selection), plain(live));
}
// A failure after layer creation must roll back, never automatically replay edits.
// A subsequent manual retry then creates one complete result.
{
  const h = await harness({ failPixelWrites: 1, liveSelection: live });
  const request = { ...h.request, placeAsSmartObject: false, width: 4, height: 4, rgba: new Uint8Array(64) };
  await assert.rejects(h.api.placeResult(request), /Pixel write is not currently available/);
  assert.equal(h.doc.layers.length, 1, "history rollback removes the incomplete layer");
  assert.deepEqual(h.commits, [false]);
  assert.deepEqual(plain(h.doc.selection), plain(live));
  await h.api.placeResult(request);
  assert.equal(h.doc.layers.length, 2);
  assert.deepEqual(h.commits, [false, true]);
}
// Reproduce a menu blocking the selection inside Photoshop's DOM close helper.
// Both scaling and Smart Object cleanup must leave the original document open.
for (const smart of [false, true]) {
  const h = await harness({ failLegacyCloseSelection: true, failScratchActivation: !smart });
  await h.api.placeResult({ ...h.request, placeAsSmartObject: smart }).catch(() => {});
  assert.ok(h.app.documents.includes(h.doc), "scratch cleanup must never close the original document");
  assert.ok(h.closedDocuments.length > 0 && h.closedDocuments.every(id => id !== h.doc.id));
  assert.equal(h.app.documents.length, 1);
}
// Creating a scratch need not make it active while Photoshop is busy. Stop before
// any untargeted resize/place command, close only the scratch and preserve the canvas.
{
  const h = await harness({ failScratchActivation: true });
  const rgba = h.api.resampleRGBA(h.request.rgba, 6, 4, 12, 8);
  await h.api.placeResult({ ...h.request, rgba, width: 12, height: 8, placeAsSmartObject: false });
  assert.equal(h.doc.width, 1400);
  assert.equal(h.doc.height, 1000);
  assert.ok(!h.commands.some(command => command._obj === "imageSize"));
  assert.equal(h.doc.layers.length, 2);
  assert.equal(h.app.documents.length, 1);
}
console.log("Photoshop placement: geometry, selection restoration, busy menus and temporary-document safety passed.");
