/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { loadModule, panelDocument, flush } from "./test-support.mjs";
import { readFileSync } from "node:fs";

const bundle = await build({
  entryPoints: { index: "src/main.ts", "drop-target": "src/webview/drop-target.ts" },
  outdir: "dist", bundle: true, format: "iife", platform: "browser", target: "es2020",
  external: ["photoshop", "uxp"], write: false, metafile: true, logLevel: "silent",
});
// Test the real panel entry with UXP's missing text codecs. This catches import
// reordering that loads fast-png before the required polyfills.
const startup = [];
const context = {
  require: (name) => name === "uxp" ? { storage: {} } : {},
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { readyState: "loading", addEventListener: (type, callback) => startup.push({ type, callback }) },
};
runInNewContext(bundle.outputFiles.find((file) => file.path.endsWith("/index.js")).text, context);
assert.equal(typeof context.TextEncoder, "function");
assert.equal(typeof context.TextDecoder, "function");
assert.equal(startup[0].type, "DOMContentLoaded");

const { document, elements } = panelDocument(["dropZone", "fileInput", "label"]);
const messages = [], handlers = new Map();
const uxpHost = { postMessage: (message) => messages.push(message) };
const window = { uxpHost, addEventListener: (type, callback) => handlers.set(type, callback) };
runInNewContext(bundle.outputFiles.find((file) => file.path.endsWith("/drop-target.js")).text,
  { document, window, setTimeout, clearTimeout, console });
assert.equal(messages[0].type, "ready");
assert.equal(elements.fileInput.disabled, false);
const capacity = { channel: messages[0].channel, type: "capacity", remaining: 0 };
handlers.get("message")({ source: {}, data: capacity });
assert.equal(elements.fileInput.disabled, false);
handlers.get("message")({ source: uxpHost, data: capacity });
assert.equal(elements.fileInput.disabled, true);
assert.equal(elements.label.textContent, "Reference limit reached");

// Runtime dependencies must remain acyclic. Provider/domain modules must not load
// the panel or Photoshop merely to calculate model geometry, pricing or requests.
const visited = new Set();
function visit(path, stack = []) {
  assert.ok(!stack.includes(path), `Dependency cycle: ${[...stack, path].join(" -> ")}`);
  if (visited.has(path)) return;
  for (const dep of bundle.metafile.inputs[path]?.imports || []) {
    if (/^src\/(models|providers|images|archive)\//.test(path)) {
      assert.ok(!/^src\/(panel|photoshop)\//.test(dep.path), `${path} unexpectedly loads ${dep.path}`);
    }
    if (!dep.external) visit(dep.path, [...stack, path]);
  }
  visited.add(path);
}
for (const path of Object.keys(bundle.metafile.inputs)) visit(path);

// Initialize the real composition root against the current HTML. This catches
// stale action IDs and verifies that prompt history and Generate coexist.
{
  const ids = [...readFileSync("public/index.html", "utf8").matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const { document, elements } = panelDocument(ids);
  const timers = new Map();
  let entrypoints;
  const { createPanel } = await loadModule("src/panel/app.ts", {
    globals: {
      document,
      window: document,
      setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      setInterval() { return 1; }, clearInterval() {},
    },
    modules: {
      uxp: {
        entrypoints: { setup(value) { entrypoints = value; } },
        storage: { localFileSystem: { getTemporaryFolder: async () => ({ getEntries: async () => [] }) } },
      },
      photoshop: { app: {}, action: { addNotificationListener: async () => {} } },
    },
  });
  const panel = createPanel();
  await panel.init();
  await flush();
  assert.match(elements.status.textContent, /^Ready\./);
  elements.prompt.value = "A typed prompt";
  elements.prompt.selectionStart = elements.prompt.selectionEnd = 14;
  elements.prompt.dispatchEvent(new Event("input"));
  assert.equal(elements.undoPrompt.style.display, "block");
  entrypoints.panels.nbpEditorPanel.show();
  elements.undoPrompt.dispatchEvent(new Event("click"));
  assert.equal(elements.prompt.value, "", "showing the panel does not reset prompt history");
  elements.redoPrompt.dispatchEvent(new Event("click"));
  assert.equal(elements.prompt.value, "A typed prompt");
  const enter = new Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(enter, { key: "Enter", metaKey: true });
  elements.prompt.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true, "Generate keeps its own prompt shortcut");
  assert.match(elements.status.textContent, /API key/, "Generate handler still runs and validates the missing test key");
  panel.dispose();
}
console.log("Bundles: UXP polyfill ordering, WebView startup and runtime module boundaries passed.");
