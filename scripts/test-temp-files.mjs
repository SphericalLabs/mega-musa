/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 */

import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const deleted = [];
const logs = [];
const entry = (name, options = {}) => ({
  name,
  isFile: options.isFile ?? true,
  delete: async () => {
    if (options.error) throw new Error(options.error);
    deleted.push(name);
  },
});
const entries = [
  entry("__mega_musa_result_123_1.png"),
  entry(`mega-musa-${"a".repeat(64)}.png`),
  entry(`mega-musa-restore-${"b".repeat(64)}-abc-1.webp`),
  entry("other-plugin-result.png"),
  entry("mega-musa-not-an-image.txt"),
  entry("mega-musa-folder.png", { isFile: false }),
  entry("mega-musa-locked.jpg", { error: "locked" }),
];
const uxp = {
  storage: {
    localFileSystem: {
      getTemporaryFolder: async () => ({ getEntries: async () => entries }),
    },
  },
};

const bundle = await build({
  entryPoints: ["src/temp-files.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["uxp"],
  write: false,
  logLevel: "silent",
});
const module = { exports: {} };
runInThisContext(`(function(require, module, exports) {\n${bundle.outputFiles[0].text}\n})`)(
  (name) => {
    if (name === "uxp") return uxp;
    throw new Error(`Unexpected external module: ${name}`);
  },
  module,
  module.exports
);
const {
  clearMegaMusaTemporaryFiles,
  deleteMegaMusaTemporaryFile,
  isMegaMusaTemporaryFileName,
} = module.exports;

assert.equal(isMegaMusaTemporaryFileName("__mega_musa_result_123_1.jpg"), true);
assert.equal(isMegaMusaTemporaryFileName(`mega-musa-${"c".repeat(64)}-original.png`), true);
assert.equal(isMegaMusaTemporaryFileName("other-plugin-result.png"), false);
assert.equal(isMegaMusaTemporaryFileName("mega-musa-not-an-image.txt"), false);

const originalLog = console.log;
console.log = (...values) => logs.push(values.map(String).join(" "));
let removed;
try {
  removed = await clearMegaMusaTemporaryFiles();
  assert.equal(await deleteMegaMusaTemporaryFile(entry("unrelated.png")), false);
} finally {
  console.log = originalLog;
}

assert.equal(removed, 3);
assert.deepEqual(deleted, entries.slice(0, 3).map(({ name }) => name));
assert.equal(logs.length, 1);
assert.match(logs[0], /mega-musa-locked\.jpg.*locked/);

console.log("temporary file tests passed (prefix scope, successful cleanup and failure recovery)");
