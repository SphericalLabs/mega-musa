/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, panelDocument } from "./test-support.mjs";
const { ChunkAssembler, sendChunks, WEBVIEW_CHUNK_SIZE, MAX_DROP_CHUNK_LENGTH, bridgeMessage, DROP_CHANNEL } = await loadModule("src/webview/protocol.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const ref = { name: "test.png", mimeType: "image/png", base64: png, dataUrl: `data:image/png;base64,${png}` };
assert.equal(bridgeMessage({ channel: "unrelated", type: "ready" }), null);
assert.equal(bridgeMessage(null), null);
const assembler = new ChunkAssembler(2);
assembler.add(1, "second");
assert.throws(() => assembler.join(), /Incomplete/);
assembler.add(0, "first");
assert.equal(assembler.join(), "firstsecond");
assert.throws(() => assembler.add(2, "invalid"), /Invalid/);
assert.throws(() => assembler.add(0, "x".repeat(MAX_DROP_CHUNK_LENGTH + 1)), /Invalid/);
for (const count of [0, -1, 1.5, Infinity, 100001]) assert.throws(() => new ChunkAssembler(count), /Invalid/);
const payload = "x".repeat(WEBVIEW_CHUNK_SIZE + 17);
const chunks = [];
sendChunks(payload, (index, data) => { chunks[index] = data; });
assert.equal(chunks.length, 2);
assert.equal(chunks.join(""), payload);

// Pending requests are settled and timers removed on every exit path.
const timers = new Map();
const { ReferenceImageProcessor } = await loadModule("src/references/processor.ts", {
  globals: {
    setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  }
});
const sent = [];
const processor = new ReferenceImageProcessor((message) => sent.push(message));
await assert.rejects(processor.resize(ref, { maxEdge: 100 }), /not ready/);
processor.setReady(true);
const start = () => {
  const promise = processor.resize(ref, { maxEdge: 100, logDimensions: false });
  const requestId = sent.at(-1).requestId;
  const message = (type, fields = {}) => processor.handleMessage({ type, requestId, ...fields });
  assert.equal(sent.at(-1).type, "resize-end");
  assert.equal(sent.at(-1).channel, DROP_CHANNEL);
  return { promise, message };
};
{
  const { promise, message } = start();
  message("resize-result-start", { totalChunks: 2, width: 1, height: 1 });
  message("resize-result-chunk", { index: 1, data: png.slice(30) });
  message("resize-result-chunk", { index: 0, data: png.slice(0, 30) });
  message("resize-result-end");
  assert.equal((await promise).base64, png);
  assert.equal(timers.size, 0);
}
for (const failure of ["missing", "dimensions", "timeout", "disconnect", "dispose", "error"]) {
  const { promise, message } = start();
  const rejected = assert.rejects(promise);
  if (failure === "missing") {
    message("resize-result-start", { totalChunks: 2, width: 1, height: 1 });
    message("resize-result-chunk", { index: 0, data: png });
    message("resize-result-end");
  } else if (failure === "dimensions") message("resize-result-start", { totalChunks: 1, width: 101, height: 1 });
  else if (failure === "timeout") [...timers.values()][0]();
  else if (failure === "disconnect") processor.setReady(false);
  else if (failure === "dispose") processor.dispose();
  else message("resize-error", { message: "Decode failed" });
  await rejected;
  assert.equal(timers.size, 0, failure);
  message("resize-result-end"); // A late reply cannot settle another request.
  processor.setReady(true);
}
const broken = new ReferenceImageProcessor(() => { throw new Error("send failed"); });
broken.setReady(true);
await assert.rejects(broken.resize(ref, { maxEdge: 100 }), /Could not prepare/);
assert.equal(timers.size, 0);

// Exercise the panel's source check and real chunk receiver.
const { elements, document } = panelDocument(["dropWebview", "status", "note"]);
const { createDropController, ReferenceCollection } = await loadModule(["src/panel/drop.ts", "src/references/collection.ts"], { globals: { document } });
const references = new ReferenceCollection();
let changes = 0;
const drop = createDropController({ references, processor, onReferencesChanged() { changes++; } });
const receive = (data, source = elements.dropWebview) => drop.onDropWebviewMessage({ source, data: { channel: DROP_CHANNEL, ...data } });
receive({ type: "batch-start", batchId: "foreign", expected: 1 }, {});
receive({ type: "file-start", batchId: "foreign", fileId: "ignored", name: "ignored.png", totalChunks: 1 });
receive({ type: "file-chunk", batchId: "foreign", fileId: "ignored", index: 0, data: png });
receive({ type: "file-end", batchId: "foreign", fileId: "ignored" });
assert.equal(references.length, 0);
for (const complete of [false, true]) {
  const batchId = `batch-${complete}`, fileId = `file-${complete}`;
  receive({ type: "batch-start", batchId, expected: 1 });
  receive({ type: "file-start", batchId, fileId, name: "test.png", totalChunks: 2 });
  receive({ type: "file-chunk", batchId, fileId, index: 1, data: png.slice(30) });
  if (complete) receive({ type: "file-chunk", batchId, fileId, index: 0, data: png.slice(0, 30) });
  receive({ type: "file-end", batchId, fileId });
  receive({ type: "batch-end", batchId });
  assert.equal(references.length, complete ? 1 : 0);
}
assert.equal(changes, 1);
assert.equal(references.snapshot()[0].base64, png);

// Browser canvas conversion preserves dimensions, forces PNG when requested and
// uses JPEG 90 only for opaque compact archives.
for (const [alpha, forcePng, compactStorage, expectedMime] of [
  [255, false, true, "image/jpeg"], [0, false, true, "image/png"], [255, true, false, "image/png"],
]) {
  const encodings = [];
  class Image {
    naturalWidth = 400;
    naturalHeight = 200;
    set src(_value) { queueMicrotask(() => this.onload()); }
  }
  const { resizeImage } = await loadModule("src/webview/image-processing.ts", {
    globals: {
      Image,
      document: {
        createElement() {
          return {
            getContext(_kind, options) {
              assert.equal(options.colorSpace, "srgb"); return {
                drawImage() { }, getImageData() { return { data: Uint8Array.of(0, 0, 0, alpha) }; },
              };
            },
            toDataURL(mime, quality) { encodings.push({ mime, quality }); return `data:${mime};base64,${png}`; },
          };
        }
      },
    }
  });
  const resized = await resizeImage({ base64: png, mimeType: "image/webp", maxEdge: 100, normalizeSrgb: true, forcePng, compactStorage });
  assert.equal(resized.width, 100);
  assert.equal(resized.height, 50);
  assert.equal(resized.sourceWidth, 400);
  assert.equal(encodings[0].mime, expectedMime);
  if (compactStorage) assert.equal(encodings[0].quality, 0.9);
}
console.log("WebView: chunk validation, source checks, request cleanup and canvas storage choices passed.");
