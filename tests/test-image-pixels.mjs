/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule } from "./test-support.mjs";
const { toRGBA } = await loadModule("src/images/pixels.ts");
const { encodePng, decodeImage } = await loadModule("src/images/codec.ts");
const image = decodeImage("image/png", encodePng(Uint8Array.of(128, 64, 30, 0), 2, 1, 2));
assert.equal(image.channels, 2);
assert.deepEqual([...toRGBA(image.data, 2, 1, image.channels)], [128, 128, 128, 64, 30, 30, 30, 0]);
assert.deepEqual([...toRGBA(Uint8Array.of(50), 1, 1, 1)], [50, 50, 50, 255]);
assert.deepEqual([...toRGBA(Uint8Array.of(10, 20, 30), 1, 1, 3)], [10, 20, 30, 255]);
const rgba = Uint8Array.of(10, 20, 30, 40);
assert.equal(toRGBA(rgba, 1, 1, 4), rgba);
console.log("Image pixels: grayscale, grayscale alpha, RGB and RGBA conversion passed.");
