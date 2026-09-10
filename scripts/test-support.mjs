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
    tagName = "DIV";
    selectionStart = 0;
    selectionEnd = 0;
    selectionDirection = "none";
    scrollTop = 0;
    scrollLeft = 0;
    parentNode = null;
    attributes = new Map();
    children = [];
    listeners = new Map();
    classList = { toggle() { }, add() { }, remove() { } };
    get firstChild() { return this.children[0]; }
    appendChild(child) { this.children.push(child); child.parentNode = this; }
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
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
    focus() { document.activeElement = this; this.dispatchEvent(new Event("focus")); }
    addEventListener(type, callback, options = false) {
      const capture = typeof options === "boolean" ? options : !!options.capture;
      const entries = this.listeners.get(type) || [];
      if (!entries.some((entry) => entry.callback === callback && entry.capture === capture)) entries.push({ callback, capture });
      this.listeners.set(type, entries);
    }
    removeEventListener(type, callback, options = false) {
      const capture = typeof options === "boolean" ? options : !!options.capture;
      this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.callback !== callback || entry.capture !== capture));
    }
    dispatchEvent(event) {
      Object.defineProperty(event, "target", { value: this, configurable: true });
      let immediate = false;
      const stop = event.stopImmediatePropagation;
      event.stopImmediatePropagation = function () { immediate = true; stop.call(this); };
      const path = [];
      for (let node = this; node; node = node.parentNode) path.push(node);
      const invoke = (node, capture) => {
        Object.defineProperty(event, "currentTarget", { value: node, configurable: true });
        for (const entry of [...(node.listeners.get(event.type) || [])]) {
          if (entry.capture === capture) entry.callback(event);
          if (immediate) break;
        }
      };
      try {
        for (const node of [...path].reverse()) {
          invoke(node, true);
          if (event.cancelBubble) return !event.defaultPrevented;
        }
        for (const node of event.bubbles ? path : [this]) {
          invoke(node, false);
          if (event.cancelBubble) break;
        }
        return !event.defaultPrevented;
      } finally {
        event.stopImmediatePropagation = stop;
      }
    }
  }
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const document = new Element();
  document.getElementById = (id) => elements[id] || null;
  document.createElement = (tag = "div") => Object.assign(new Element(), { tagName: tag.toUpperCase() });
  document.documentElement = new Element();
  document.body = new Element();
  document.appendChild(document.documentElement);
  document.documentElement.appendChild(document.body);
  for (const [id, element] of Object.entries(elements)) {
    element.id = id;
    document.body.appendChild(element);
  }
  if (elements.prompt) elements.prompt.tagName = "SP-TEXTAREA";
  return { elements, document };
}
