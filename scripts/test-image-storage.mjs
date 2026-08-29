/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/image-codec.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const module = { exports: {} };
const require = createRequire(import.meta.url);
runInThisContext(`(function(require, module, exports) {\n${bundle.outputFiles[0].text}\n})`)(
  require,
  module,
  module.exports
);
const { decodeImage, encodeEmbeddedImage } = module.exports;

function pngChunkTypes(bytes) {
  const types = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length =
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    types.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    offset += length + 12;
  }
  return types;
}

const opaque = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255);
// Photoshop UXP has no Node Buffer. Reproduce that runtime explicitly so this
// test cannot pass merely because it is running under Node.
const nodeBuffer = globalThis.Buffer;
globalThis.Buffer = undefined;
let compact;
try {
  compact = encodeEmbeddedImage(opaque, 2, 1, true);
  assert.equal(globalThis.Buffer, undefined, "JPEG encoding must restore the UXP global");
} finally {
  globalThis.Buffer = nodeBuffer;
}
assert.equal(compact.storageMode, "jpeg-90");
assert.equal(compact.lossy, true);
assert.deepEqual(Array.from(compact.bytes.subarray(0, 8)), [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x34, 0x45, 0x78]);
assert.equal(decodeImage(compact.mimeType, compact.bytes).width, 2);

const transparent = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 0);
const compactTransparent = encodeEmbeddedImage(transparent, 2, 1, true);
assert.equal(compactTransparent.storageMode, "png-srgb");
assert.equal(compactTransparent.lossy, false);
assert.ok(pngChunkTypes(compactTransparent.bytes).includes("sRGB"));
assert.equal(decodeImage("image/png", compactTransparent.bytes).data[7], 0);

const lossless = encodeEmbeddedImage(opaque, 2, 1, false);
assert.equal(lossless.storageMode, "png-srgb");
assert.ok(pngChunkTypes(lossless.bytes).includes("sRGB"));
assert.deepEqual(Array.from(decodeImage("image/png", lossless.bytes).data), Array.from(opaque));

const [html, main, bridge, references, webview] = await Promise.all([
  readFile("public/index.html", "utf8"),
  readFile("src/main.ts", "utf8"),
  readFile("src/photoshop-bridge.ts", "utf8"),
  readFile("src/reference-assets.ts", "utf8"),
  readFile("public/drop-target.js", "utf8"),
]);
assert.match(html, /id="placeAsSmartObject" checked/);
const reduceCheckbox = html.match(/<sp-checkbox[^>]*id="reduceDocumentSize"[^>]*>/)?.[0] || "";
assert.ok(reduceCheckbox, "the Reduce document size checkbox must exist");
assert.doesNotMatch(reduceCheckbox, /\schecked\b/);
assert.match(main, /loadSetting\("placeAsSmartObject", "1"\)/);
assert.match(main, /loadSetting\("reduceDocumentSize", "0"\)/);
assert.match(main, /saveSetting\("placeAsSmartObject"/);
assert.match(main, /saveSetting\("reduceDocumentSize"/);
const recallStart = main.indexOf("async function onLoadRecallSettings");
const recallLoader = main.slice(recallStart, main.indexOf("// UXP's DOM does not support", recallStart));
assert.doesNotMatch(recallLoader, /placeAsSmartObject|reduceDocumentSize/);
assert.doesNotMatch(bridge, /_obj: "newPlacedLayer"/);
assert.match(bridge, /_obj: "placeEvent"/);
assert.match(main, /if \(reference\.archivedHash\)/);
assert.match(references, /existing\.originalByHash\.get\(hash\)/);
assert.match(webview, /outputQuality = 0\.9/);

console.log("image storage tests passed (JPEG 90, transparent PNG, sRGB tags, global controls and no PSB conversion)");
