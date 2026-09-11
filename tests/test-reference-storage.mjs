/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule } from "./test-support.mjs";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const reference = { name: "source.png", mimeType: "image/png", base64: png, dataUrl: `data:image/png;base64,${png}` };
const { prepareReferenceArchiveImages } = await loadModule("src/references/preparation.ts");
let conversions = 0;
const processor = { resize: async () => { conversions++; return { mimeType: "image/png", base64: png }; } };
const source = [reference];
assert.equal(await prepareReferenceArchiveImages(processor, source, false), source);
const restored = { ...reference, archivedHash: "a".repeat(64), archivedStorageMode: "original" };
assert.equal((await prepareReferenceArchiveImages(processor, [restored], true))[0], restored);
assert.equal(conversions, 0, "restored assets must never be recompressed");
const compact = (await prepareReferenceArchiveImages(processor, source, true))[0];
assert.equal(conversions, 1);
assert.equal(compact.base64, reference.base64, "provider input remains the original source");
assert.equal(compact.archiveAsset.storageMode, "png-srgb");
assert.equal(compact.archiveAsset.lossy, false);

function temporaryStorage() {
  const files = [];
  const folder = {
    async createFile(name) {
      const file = {
        name, isFile: true, deleted: false, bytes: null,
        async write(buffer) { this.bytes = new Uint8Array(buffer); },
        async delete() { this.deleted = true; },
      };
      files.push(file);
      return file;
    }
  };
  return {
    files, storage: {
      formats: { binary: "binary" }, localFileSystem: {
        getTemporaryFolder: async () => folder, createSessionToken: (file) => file.name,
      }
    }
  };
}

// Existing originals win over compressed alternatives; repeated new assets embed once.
for (const existingOriginal of [true, false]) {
  const { storage, files } = temporaryStorage();
  const hash = "a".repeat(64);
  const original = { id: 48, name: "original", visible: false };
  const group = { id: 20, name: "Mega Musa Reference Archive", layers: existingOriginal ? [original] : [], visible: true, allLocked: true };
  const resultLayer = { id: 30 };
  const doc = { id: 7, layers: [group, resultLayer], activeLayers: [resultLayer] };
  const app = { activeDocument: doc };
  const metadata = new Map([[20, { kind: "referenceAssetPool", v: 1, name: group.name }]]);
  if (existingOriginal) metadata.set(48, {
    kind: "referenceAsset", v: 1, id: hash, hash, name: "original.png",
    mimeType: "image/png", byteLength: 68, createdAt: "2026-08-28T12:00:00.000Z", storageMode: "original"
  });
  let placements = 0;
  const { archiveReferenceAssetsInActiveDocument } = await loadModule("src/references/archive.ts", {
    modules: {
      uxp: { storage }, photoshop: {
        app, constants: { ElementPlacement: { PLACEINSIDE: "inside" } },
        action: {
          async batchPlay([command]) {
            if (command._target?.[0]._property === "generatorSettings") {
              const id = command._target[1]._id;
              if (command._obj === "set") metadata.set(id, JSON.parse(command.to.json));
              return [{ generatorSettings: { json: JSON.stringify(metadata.get(id)) } }];
            }
            if (command._obj === "placeEvent") {
              placements++;
              const layer = { id: 80, parent: group };
              group.layers.push(layer);
              doc.activeLayers = [layer];
            } else if (command._obj === "select") {
              doc.activeLayers = [command._target[0]._id === group.id ? group : resultLayer];
            } else throw new Error(`Unexpected archive command: ${command._obj}`);
            return [{}];
          }
        },
      },
    }
  });
  const image = { ...compact, archivedHash: hash };
  const result = await archiveReferenceAssetsInActiveDocument(7, [image, image], 30);
  assert.equal(result.failures.length, 0);
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0].layerId, existingOriginal ? 48 : 80);
  assert.equal(result.references[0].storageMode, existingOriginal ? "original" : "png-srgb");
  assert.equal(result.references[0].layerId, result.references[1].layerId);
  assert.equal(placements, existingOriginal ? 0 : 1);
  assert.equal(files.length, placements);
  assert.ok(files.every((file) => file.deleted));
  assert.equal(group.visible, false);
  assert.equal(group.allLocked, true);
  assert.equal(doc.activeLayers[0], resultLayer);
}

// Embed source image files directly and clean scratch documents on success or failure.
for (const mode of ["lossless", "compact", "failure"]) {
  const { storage, files } = temporaryStorage();
  const target = { id: 7, layers: [], activeLayers: [] };
  const app = {
    activeDocument: target, documents: [target], async createDocument() {
      const scratch = {
        id: 9, layers: [], activeLayers: [],
        async duplicateLayers([source], destination) { destination.layers.push({ id: 99, name: source.name }); },
        async closeWithoutSaving() { app.documents.splice(app.documents.indexOf(this), 1); },
      };
      this.documents.push(scratch);
      this.activeDocument = scratch;
      return scratch;
    }
  };
  const commands = [];
  const { createFileSmartObject } = await loadModule("src/photoshop/smart-object.ts", {
    modules: {
      uxp: { storage }, photoshop: {
        app, action: {
          async batchPlay([command]) {
            commands.push(command);
            const doc = app.activeDocument;
            if (command._obj === "placeEvent") {
              if (mode === "failure") return [{ _obj: "error", message: "Cannot embed" }];
              const layer = { id: 70, name: "embedded" };
              doc.layers.push(layer);
              doc.activeLayers = [layer];
            } else if (command._obj === "select" && command._target[0]._ref === "document") {
              app.activeDocument = app.documents.find(item => item.id === command._target[0]._id);
            } else if (command._obj === "close") {
              assert.equal(command._target[0]._id, 9);
              app.documents = [target];
              app.activeDocument = target;
            } else if (command._obj === "select") doc.activeLayers = doc.layers.filter((layer) => layer.id === command._target[0]._id);
            else if (command._obj === "set") doc.activeLayers[0].name = command.to.name;
            else if (command._obj !== "imageSize") throw new Error(`Unexpected placement command: ${command._obj}`);
            return [{}];
          }
        }
      },
    }
  });
  const placed = createFileSmartObject(target, Uint8Array.of(20, 40, 60, 255, 20, 40, 60, 255), 2, 1,
    { left: 0, top: 0, right: 4, bottom: 2 }, "Result", mode === "compact");
  if (mode === "failure") await assert.rejects(placed, /Cannot embed/);
  else {
    const result = await placed;
    assert.equal(result.layer.name, "Result");
    assert.equal(result.storage.mode, mode === "compact" ? "jpeg-90" : "png-srgb");
    assert.equal(commands.filter((command) => command._obj === "imageSize").length, 1);
  }
  assert.equal(commands.filter((command) => command._obj === "placeEvent").length, 1);
  assert.equal(commands.find((command) => command._obj === "placeEvent").linked, false);
  assert.equal(commands.some((command) => command._obj === "newPlacedLayer"), false);
  assert.equal(files.length, 1);
  assert.equal(files[0].deleted, true);
  assert.ok(files[0].bytes.length > 0);
  assert.equal(app.documents.length, 1);
  assert.equal(app.activeDocument, target);
}
console.log("Reference storage: original reuse, deduplication, source preservation and file Smart Object cleanup passed.");
