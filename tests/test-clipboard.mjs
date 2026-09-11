/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, panelDocument } from "./test-support.mjs";

let pasteError = { _obj: "error", message: 'The command "Paste" is not currently available.', result: -25920 };
let alpha = 255;
let closed = 0;
let reads = 0;
const commands = [];
const userDoc = { id: 1 };
const scratch = { id: 2, width: 1, height: 1, closeWithoutSaving: async () => { closed++; } };
const host = {
  app: { activeDocument: userDoc, createDocument: async () => scratch },
  core: { executeAsModal: async (fn) => fn({}) },
  action: { batchPlay: async ([command]) => {
    assert.equal(command._options?.dialogOptions, "silent", "clipboard commands must suppress native error dialogs");
    commands.push(command._obj);
    return command._obj === "paste" && pasteError ? [pasteError] : [{}];
  } },
  imaging: { getPixels: async () => {
    reads++;
    return { imageData: {
      width: 1, height: 1, components: 4,
      getData: async () => Uint8Array.of(10, 20, 30, alpha), dispose() {},
    } };
  } },
};
const { readClipboardImage } = await loadModule("src/photoshop/clipboard.ts", { modules: { photoshop: host } });
assert.equal(await readClipboardImage(), null);
assert.deepEqual(commands, ["paste"], "unavailable Paste must stop before trim or pixel extraction");
assert.equal(reads, 0);
assert.equal(closed, 1, "empty clipboard must still close the scratch document");

host.app.activeDocument = userDoc;
pasteError = null;
const image = await readClipboardImage();
assert.deepEqual([...image.data], [10, 20, 30, 255]);
assert.equal(closed, 2);

host.app.activeDocument = userDoc;
alpha = 0;
assert.equal(await readClipboardImage(), null, "silent no-op must not add a blank reference");
assert.equal(closed, 3);

host.app.activeDocument = userDoc;
pasteError = { _obj: "error", message: "Unexpected host failure" };
await assert.rejects(readClipboardImage(), /Unexpected host failure/);
assert.equal(closed, 4, "unexpected failures must also close the scratch document");

host.app.activeDocument = userDoc;
pasteError = { _obj: "error", message: 'The command "Paste" is not currently available.' };
const { document, elements } = panelDocument([
  "status", "noticeDialog", "noticeDialogTitle", "noticeDialogMessage",
  "noticeDialogInstruction", "noticeDialogCancel", "noticeDialogPrimary",
]);
let notices = 0;
elements.noticeDialog.showModal = async () => {
  notices++;
  assert.equal(closed, 5, "scratch document must close before the warning opens");
};
const { createReferencePanel } = await loadModule("src/panel/references.ts", {
  modules: { photoshop: host }, globals: { document },
});
const panel = createReferencePanel({
  references: { length: 0, add() { assert.fail("empty clipboard must not add a reference"); } },
  processor: {}, onChange() { assert.fail("empty clipboard must not change references"); },
});
await panel.onPasteRef();
assert.equal(elements.status.textContent, "No image on the clipboard. Copy an image first.");
assert.equal(elements.status.className, "", "missing clipboard image is informational");
assert.equal(notices, 1);
assert.equal(elements.noticeDialogTitle.textContent, "Mega Musa — No image on the clipboard");
assert.equal(elements.noticeDialogMessage.textContent, "Copy an image to the clipboard first, then click Paste.");
assert.equal(elements.noticeDialogPrimary.textContent, "OK");
assert.equal(elements.noticeDialogPrimary.getAttribute("variant"), "warning");
console.log("Clipboard: unavailable paste, valid pixels, empty pixels, cleanup and panel status passed.");
