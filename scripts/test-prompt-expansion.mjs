/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const testDirectory = await mkdtemp(join(tmpdir(), "mega-musa-prompt-expansion-"));
const bundlePath = join(testDirectory, "prompt-expansion.mjs");

try {
  await build({
    entryPoints: ["src/prompt-expansion.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
  const { expandPromptTemplate } = await import(pathToFileURL(bundlePath).href);

  const checks = [
    () => assert.deepEqual(expandPromptTemplate("a plain prompt"), ["a plain prompt"]),
    () => assert.deepEqual(expandPromptTemplate("commas, outside, groups"), ["commas, outside, groups"]),
    () => assert.deepEqual(expandPromptTemplate("a {banana, strawberry}"), ["a banana", "a strawberry"]),
    () =>
      assert.deepEqual(expandPromptTemplate("a {red, blue} {balloon, car}"), [
        "a red balloon",
        "a red car",
        "a blue balloon",
        "a blue car",
      ]),
    () =>
      assert.deepEqual(expandPromptTemplate("{a photo of a {banana, strawberry}, 3}"), [
        "a photo of a banana",
        "a photo of a banana",
        "a photo of a banana",
        "a photo of a strawberry",
        "a photo of a strawberry",
        "a photo of a strawberry",
      ]),
    () =>
      assert.deepEqual(expandPromptTemplate("a {small {red, blue}, large} car"), [
        "a small red car",
        "a small blue car",
        "a large car",
      ]),
    () =>
      assert.deepEqual(expandPromptTemplate("{banana, strawberry, 2}"), [
        "banana",
        "banana",
        "strawberry",
        "strawberry",
      ]),
    () =>
      assert.deepEqual(expandPromptTemplate(String.raw`a \{literal\} {red\, white, blue} \\`), [
        "a {literal} red, white \\",
        "a {literal} blue \\",
      ]),
    () => assert.throws(() => expandPromptTemplate("a {banana}"), /needs alternatives or a multiplier/),
    () => assert.throws(() => expandPromptTemplate("a {banana, strawberry"), /no matching closing brace/),
    () => assert.throws(() => expandPromptTemplate("a {banana, }"), /empty alternative/),
    () => assert.throws(() => expandPromptTemplate("a {banana, 0}"), /positive integer/),
    () => assert.throws(() => expandPromptTemplate("a {banana, 1.5}"), /positive integer/),
    () => assert.throws(() => expandPromptTemplate("a banana}"), /no matching opening brace/),
    () => assert.equal(expandPromptTemplate("{a, b, c, d, e, 2}").length, 10),
    () => assert.throws(() => expandPromptTemplate("a {one, two} {a, b, c, d, e, f}"), /more than 10 images/),
  ];

  for (const check of checks) check();
  console.log(`prompt expansion tests passed (${checks.length} checks)`);
} finally {
  await rm(testDirectory, { recursive: true, force: true });
}
