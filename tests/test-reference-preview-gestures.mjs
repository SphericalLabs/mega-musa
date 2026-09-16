/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule } from "./test-support.mjs";

const { previewScrollZoomFactor: factor } = await loadModule("src/panel/reference-preview-gestures.ts");
assert.ok(factor(-44, 0, 500) > 1, "scroll up zooms in");
assert.ok(factor(44, 0, 500) < 1, "scroll down zooms out");
assert.ok(Math.abs(factor(-44, 0, 500) * factor(44, 0, 500) - 1) < 1e-12,
  "opposite scroll deltas reverse the same zoom step");
assert.equal(factor(2, 1, 500), factor(32, 0, 500), "line deltas normalize to pixels");
assert.equal(factor(0.1, 2, 500), factor(50, 0, 500), "page deltas use viewport height");
assert.equal(factor(-100000, 0, 500), factor(-100, 0, 500), "large events have bounded zoom steps");
for (const delta of [0, NaN, Infinity, -Infinity]) assert.equal(factor(delta, 0, 500), 1);
console.log("Preview scroll zoom: direction, reversible steps, delta modes and large/invalid input passed.");
