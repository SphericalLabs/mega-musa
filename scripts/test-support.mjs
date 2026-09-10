/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */

import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const bundles = new Map();

export async function loadModule(entry, { modules = {}, globals = {} } = {}) {
  const entries = Array.isArray(entry) ? entry : [entry];
  const key = JSON.stringify(entries);
  if (!bundles.has(key)) bundles.set(key, build({
    stdin: { contents: 'import "./src/polyfills";\n' + entries.map((path) => `export * from ${JSON.stringify("./" + path)};`).join("\n"), resolveDir: process.cwd(), loader: "ts" },
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["photoshop", "uxp"], logLevel: "silent",
  }));
  const bundle = await bundles.get(key);
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => name in modules ? modules[name] : name === "photoshop" ? {} : name === "uxp" ? { storage: {} } : require(name),
    console, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, AbortController,
    atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: memoryStorage(),
    fetch: () => { throw new Error("Tests must supply a provider response."); },
    ...globals,
  });
  return module.exports;
}

export function memoryStorage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

// Minimal Spectrum DOM for controller tests. Real handlers own values and event wiring.
export function panelDocument(ids) {
  class Element {
    value = "";
    textContent = "";
    disabled = false;
    checked = false;
    style = {};
    attributes = new Map();
    children = [];
    listeners = new Map();
    classList = { toggle() { } };
    get firstChild() { return this.children[0]; }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelector(selector) {
      if (selector !== "sp-menu") return null;
      return this.menu ||= new Element();
    }
    querySelectorAll() { return this.menu?.children || []; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    dispatchEvent(event) { return this.listeners.get(event.type)?.(event); }
  }
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: () => new Element(),
    documentElement: new Element(),
    body: new Element(),
  };
  return { elements, document };
}
