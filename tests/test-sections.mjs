/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, panelDocument, memoryStorage } from "./test-support.mjs";

const { document, elements } = panelDocument([
  "promptSection", "promptSectionToggle", "promptSectionContent", "outside"
]);
const values = new Map();
const api = await loadModule("src/panel/sections.ts", {
  globals: { document, localStorage: memoryStorage(values) }
});
api.setupCollapsibleSections();
const header = elements.promptSectionToggle;
const label = document.createElement("span");
header.appendChild(label);
function send(target, type, properties = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, ...properties });
  target.dispatchEvent(event);
}
const expanded = () => header.getAttribute("aria-expanded") === "true";

// Every release toggles, including when the host omits subsequent click events.
for (let i = 0; i < 6; i++) {
  const target = i % 2 ? label : header;
  const before = expanded();
  send(target, "mousedown");
  assert.equal(expanded(), before, "wait for release");
  send(target, "mouseup");
  assert.equal(expanded(), !before);
  if (i === 0) send(target, "click");
  else send(target, "dblclick");
  assert.equal(expanded(), !before, "host click must not toggle twice");
  assert.equal(elements.promptSectionContent.getAttribute("aria-hidden"), String(before));
  assert.equal(values.get("nbp.section.prompt.expanded"), before ? "0" : "1");
}

// Cancel outside releases and ignore drags into the header and secondary buttons.
send(header, "mousedown");
send(elements.outside, "mouseup");
send(header, "mouseup");
send(elements.outside, "mousedown");
send(header, "mouseup");
send(header, "mousedown", { button: 2 });
send(header, "mouseup", { button: 2 });
assert.equal(expanded(), true);

send(header, "keydown", { key: "Enter" });
assert.equal(expanded(), false);
send(header, "keydown", { key: "Enter", repeat: true });
assert.equal(expanded(), false);
send(header, "keydown", { key: " " });
assert.equal(expanded(), true);
console.log("Section toggles: omitted clicks, nested targets, canceled presses and keyboard activation passed.");
