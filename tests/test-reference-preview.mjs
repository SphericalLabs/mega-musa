/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { deferred, flush, loadModule, panelDocument } from "./test-support.mjs";

const { ReferencePreviewGeometry } = await loadModule("src/panel/reference-preview-geometry.ts");
const unopened = new ReferencePreviewGeometry(852, 828);
unopened.fit();
unopened.zoomTo(unopened.zoom * 1.25);
assert.ok(Number.isFinite(unopened.zoom) && unopened.zoom > 0, "Fit before layout cannot poison zoom with zero");
unopened.resize(NaN, 500);
unopened.resize(500, 0);
assert.equal(unopened.width, 0, "invalid measurements do not replace the viewport size");
const view = new ReferencePreviewGeometry(1600, 800);
view.resize(800, 600);
assert.equal(view.zoom, 0.5);
view.resize(400, 300);
assert.equal(view.zoom, 0.25, "Fit follows the available viewport");
view.zoomTo(1);
view.pan(100, -30);
view.resize(600, 400);
assert.equal(view.zoom, 1, "manual zoom survives resizing");
assert.equal(view.x, 100);
assert.equal(view.y, -30);
view.zoomTo(2);
assert.equal(view.x, 200, "zoom preserves the image point at the center");
assert.equal(view.y, -60);
view.pan(100000, -100000);
assert.equal(view.x, 1300, "dragging cannot lose the image beyond its edge");
assert.equal(view.y, -600);
view.resize(4000, 3000);
assert.equal(view.x, 0);
assert.equal(view.y, 0, "images smaller than the viewport stay centered");
view.zoomTo(10000);
assert.equal(view.zoom, 8);
view.zoomTo(0);
assert.equal(view.zoom, 0.1);
view.fit();
assert.equal(view.zoom, 1, "Fit does not upscale small images");
const huge = new ReferencePreviewGeometry(100000, 100000);
huge.resize(500, 500);
huge.zoomTo(0);
assert.equal(huge.zoom, 0.005, "even very large sources can zoom out to Fit");
const portrait = new ReferencePreviewGeometry(400, 1200);
portrait.resize(600, 400);
assert.equal(portrait.zoom, 1 / 3);
portrait.pan(200, 200);
assert.equal(portrait.x, 0);
assert.equal(portrait.y, 0);

const pixels = new Uint8Array(16 * 8 * 4).fill(255);
const png = encodePng({ width: 16, height: 8, data: pixels, channels: 4, depth: 8 });
const jpg = jpeg.encode({ width: 16, height: 8, data: pixels }, 80).data;
const { readImageDimensions } = await loadModule("src/images/dimensions.ts");
for (const bytes of [png, jpg]) {
  assert.deepEqual({ ...readImageDimensions(bytes) }, { width: 16, height: 8 });
  const padded = new Uint8Array(bytes.length + 10);
  padded.set(bytes, 5);
  assert.deepEqual({ ...readImageDimensions(padded.subarray(5, -5)) }, { width: 16, height: 8 });
}
// Progressive SOF marker and a metadata segment before the frame header.
const progressive = Uint8Array.from([255, 216, 255, 225, 0, 4, 0, 0, 255, 194, 0, 8, 8, 0, 40, 0, 20, 1]);
assert.deepEqual({ ...readImageDimensions(progressive) }, { width: 20, height: 40 });
for (const bytes of [new Uint8Array(), png.slice(0, 20), jpg.slice(0, 10), progressive.slice(0, -1),
  Uint8Array.from([255, 216, 255, 225, 0, 0])]) {
  assert.throws(() => readImageDimensions(bytes), /readable dimensions/);
}

const reference = Object.freeze({ name: "test.png", mimeType: "image/png", base64: Buffer.from(png).toString("base64"), dataUrl: "unused" });
const ids = ["referencePreviewDialog", "referencePreviewContent", "referencePreviewViewport", "referencePreviewMessage", "referencePreviewZoomOut",
  "referencePreviewZoomIn", "referencePreviewFit", "referencePreviewPercent", "referencePreviewClose", "referencePreviewName", "status"];

async function harness(resize = async () => { throw new Error("PNG/JPEG previews must reuse source bytes"); }) {
  const { document, elements } = panelDocument(ids);
  const dialog = elements.referencePreviewDialog;
  const viewport = elements.referencePreviewViewport;
  elements.referencePreviewClose.blur = () => {
    throw new Error("Blurring Close breaks native keyboard shortcut delivery");
  };
  const observers = [];
  const timers = new Map();
  const timerDelays = new Map();
  let modal, timerId = 0;
  for (const id of ids.filter(id => id !== "referencePreviewDialog" && id !== "status")) dialog.appendChild(elements[id]);
  // Reproduce UXP's collapsed flex viewport. Sizing must come from the dialog,
  // including before the first ResizeObserver delivery, not these zero values.
  viewport.clientWidth = 0;
  viewport.clientHeight = 0;
  viewport.setPointerCapture = viewport.releasePointerCapture = () => {
    throw new Error("Trackpad panning must work without pointer capture");
  };
  dialog.showModal = options => {
    dialog.options = options;
    dialog.open = true;
    modal = deferred();
    return modal.promise;
  };
  dialog.close = () => {
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
    modal.resolve();
  };
  const { createReferencePreview } = await loadModule("src/panel/reference-preview.ts", { globals: {
    document, window: { screen: { availWidth: 720, availHeight: 640 } }, Event,
    setTimeout: (callback, delay) => { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId; },
    clearTimeout: id => { timers.delete(id); timerDelays.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(element) { assert.equal(element, viewport); this.connected = true; }
      disconnect() { this.connected = false; }
    }
  } });
  const controller = createReferencePreview({ resize });
  const dispatch = (element, type, values = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, values);
    element.dispatchEvent(event);
    return event;
  };
  const flushResize = () => {
    for (const [id, callback] of [...timers]) {
      if (timerDelays.get(id) !== 16) continue;
      timers.delete(id);
      timerDelays.delete(id);
      callback();
    }
  };
  const flushFocus = () => {
    for (const [id, callback] of [...timers]) {
      if (timerDelays.get(id) !== 16) continue;
      timers.delete(id);
      timerDelays.delete(id);
      callback();
    }
  };
  const notifyViewport = (width, height) => observers.at(-1).callback([{ target: viewport, contentRect: { width, height } }]);
  return { controller, document, elements, dialog, viewport, observers, timers, dispatch, flushResize, flushFocus, notifyViewport,
    resizeDialog: (width, height) => { notifyViewport(width - 24, height - 94); flushResize(); },
    click: id => dispatch(elements[id], "click"),
    image: () => viewport.children.find(child => child.tagName === "IMG"),
    rejectModal: error => { dialog.open = false; modal.reject(error); }
  };
}

{
  const h = await harness();
  const done = h.controller.open(reference);
  assert.equal(h.dialog.options.resize, "both");
  assert.equal(h.dialog.options.lockDocumentFocus, true);
  assert.equal(h.dialog.options.size.width, 640, "opening size accommodates smaller screens");
  assert.equal(h.dialog.options.size.height, 540);
  assert.equal(h.elements.referencePreviewZoomIn.disabled, true);
  assert.equal(h.elements.referencePreviewName.textContent, reference.name);
  const image = h.image();
  assert.equal(image.src, `data:image/png;base64,${reference.base64}`);
  await h.controller.open(reference);
  assert.equal(h.observers.length, 1, "repeated clicks cannot open another dialog");
  h.resizeDialog(32, 100);
  h.dispatch(image, "load");
  assert.equal(h.elements.referencePreviewPercent.textContent, "50%");
  assert.equal(image.style.top, "1px");
  h.resizeDialog(40, 104);
  assert.equal(h.elements.referencePreviewPercent.textContent, "100%");
  h.click("referencePreviewZoomIn");
  assert.equal(h.elements.referencePreviewPercent.textContent, "125%");
  h.dispatch(h.viewport, "mousedown", { button: 0, clientX: 0, clientY: 0 });
  h.dispatch(h.document, "mousemove", { buttons: 1, clientX: 100, clientY: 100 });
  assert.equal(image.style.left, "0px");
  assert.equal(image.style.top, "0px");
  h.resizeDialog(36, 104);
  assert.equal(h.elements.referencePreviewPercent.textContent, "125%", "manual zoom survives host resize");
  h.dispatch(h.document, "mouseup");
  h.dispatch(h.viewport, "keydown", { key: "ArrowRight" });
  assert.equal(image.style.left, "-8px");
  h.click("referencePreviewZoomOut");
  assert.equal(h.elements.referencePreviewPercent.textContent, "100%");
  h.click("referencePreviewFit");
  assert.equal(h.elements.referencePreviewPercent.textContent, "75%");
  h.click("referencePreviewClose");
  await done;
  assert.equal(h.image(), undefined);
  assert.equal(h.observers[0].connected, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.elements.referencePreviewZoomIn.listeners.get("click").length, 0);
  const reopened = h.controller.open(reference);
  h.resizeDialog(36, 104);
  h.dispatch(h.image(), "load");
  assert.equal(h.elements.referencePreviewPercent.textContent, "75%");
  h.rejectModal(new Error("User pressed Escape"));
  await reopened;
  assert.equal(h.image(), undefined);
}

// A pressed trackpad emits mouse events. Dragging must continue outside the
// image area and stop on release, without requiring pointer capture.
{
  const h = await harness();
  const done = h.controller.open(reference);
  h.resizeDialog(32, 98); // 8x4 viewport
  const image = h.image();
  h.dispatch(image, "load");
  h.click("referencePreviewZoomIn"); // 10x5 image, centered at (-1, -0.5)
  h.dispatch(h.viewport, "mousedown", { button: 2, clientX: 10, clientY: 20 });
  const idleMove = h.dispatch(h.document, "mousemove", { buttons: 2, clientX: 11, clientY: 21 });
  assert.equal(image.style.left, "-1px", "secondary click must not start panning");
  assert.equal(idleMove.defaultPrevented, false);
  const down = h.dispatch(h.viewport, "mousedown", { button: 0, clientX: 10, clientY: 20 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(h.document.activeElement, h.viewport);
  assert.equal(h.viewport.style.cursor, "grabbing");
  h.dispatch(h.document, "mousemove", { buttons: 1, clientX: 11, clientY: 21 });
  assert.equal(image.style.left, "0px");
  assert.equal(image.style.top, "0px", "mouse-only drag pans both axes");
  const button = h.elements.referencePreviewZoomIn;
  button.addEventListener("mouseup", event => event.stopPropagation());
  h.dispatch(button, "mouseup", { button: 0 });
  assert.equal(h.viewport.style.cursor, "grab");
  h.dispatch(h.document, "mousemove", { buttons: 1, clientX: -100, clientY: -100 });
  assert.equal(image.style.left, "0px", "release over a control ends the drag");
  h.dispatch(h.viewport, "mousedown", { button: 0, clientX: 10, clientY: 20 });
  h.dispatch(h.document, "mousemove", { buttons: 0, clientX: -100, clientY: -100 });
  h.dispatch(h.document, "mousemove", { buttons: 1, clientX: -100, clientY: -100 });
  assert.equal(image.style.left, "0px", "a release outside the window cannot leave a stuck drag");
  h.dispatch(h.viewport, "mousedown", { button: 0, clientX: 10, clientY: 20 });
  // Some UXP versions omit buttons; movement still works while a drag is active.
  h.dispatch(h.document, "mousemove", { clientX: 9, clientY: 19 });
  assert.equal(image.style.left, "-1px");
  assert.equal(image.style.top, "-1px");
  h.click("referencePreviewClose");
  await done;
  for (const type of ["mousemove", "mouseup"]) {
    assert.equal(h.document.listeners.get(type).length, 0, "close removes document drag listeners");
  }
  const reopened = h.controller.open(reference);
  h.resizeDialog(32, 98);
  h.dispatch(h.image(), "load");
  h.click("referencePreviewZoomIn");
  h.dispatch(h.document, "mousemove", { buttons: 1, clientX: 100, clientY: 100 });
  assert.equal(h.image().style.left, "-1px", "reopening cannot resume an old drag");
  h.click("referencePreviewClose");
  await reopened;
}

// Until native activation completes, keyboard events may still target the
// panel. Command-W must close the preview even without focus inside it.
{
  const h = await harness();
  h.elements.status.focus();
  const done = h.controller.open(reference);
  assert.equal(h.document.activeElement, h.elements.status);
  h.dispatch(h.dialog, "load");
  const event = h.dispatch(h.document.activeElement, "keydown", { key: "w", metaKey: true });
  await done;
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.document.activeElement, h.elements.status);
  assert.equal(h.timers.size, 0, "immediate close cancels deferred focus");
  h.flushFocus();
  assert.equal(h.document.activeElement, h.elements.status);
  const afterClose = h.dispatch(h.document.activeElement, "keydown", { key: "w", metaKey: true });
  assert.equal(afterClose.defaultPrevented, false, "closed previews cannot intercept panel shortcuts");
}

// Reproduce UXP ignoring early focus: the image area becomes focusable
// only after dialog load and a render frame, independently of image decoding.
for (const selectedControl of [null, "referencePreviewZoomIn", "referencePreviewClose"]) {
  const h = await harness();
  h.elements.status.focus();
  let ready = false, focusCalls = 0;
  const focus = h.viewport.focus.bind(h.viewport);
  h.viewport.focus = () => { focusCalls++; if (ready) focus(); };
  const done = h.controller.open(reference);
  h.flushFocus();
  assert.equal(focusCalls, 0, "showModal returning does not mean the native window is ready");
  // Image load bubbles in this harness; it must not be mistaken for dialog load.
  h.dispatch(h.image(), "load");
  h.flushFocus();
  assert.equal(focusCalls, 0);
  h.dispatch(h.dialog, "load");
  assert.equal(focusCalls, 0, "wait one render frame after native load");
  ready = true;
  if (selectedControl) h.elements[selectedControl].focus();
  h.flushFocus();
  assert.equal(h.document.activeElement, selectedControl === "referencePreviewZoomIn" ? h.elements[selectedControl] : h.viewport,
    "focus the image area instead of the default Close button, preserving another selected control");
  const activationCalls = selectedControl === "referencePreviewZoomIn" ? 0 : 1;
  assert.equal(focusCalls, activationCalls, "preserve focus chosen inside the dialog");
  h.elements.referencePreviewZoomIn.focus();
  h.resizeDialog(1000, 800);
  assert.equal(h.document.activeElement, h.elements.referencePreviewZoomIn, "resizing does not move focus");
  h.click("referencePreviewClose");
  await done;
  assert.equal(h.dialog.listeners.get("load").length, 0);
  assert.equal(h.document.activeElement, h.elements.status);
  const reopened = h.controller.open(reference);
  h.dispatch(h.dialog, "load");
  h.flushFocus();
  assert.equal(focusCalls, activationCalls + 1, "reopening still focuses the image area");
  assert.equal(h.document.activeElement, h.viewport, "reopening focuses the image area");
  const shortcut = h.dispatch(h.document.activeElement, "keydown", { key: "w", metaKey: true });
  await reopened;
  assert.equal(shortcut.defaultPrevented, true, "Command-W closes with native focus intact");
}

// Cmd-W works from the image area or a focused Spectrum control, including
// during loading, without forwarding Photoshop's document-close shortcut.
for (const focused of ["referencePreviewViewport", "referencePreviewZoomIn"]) {
  const h = await harness();
  const done = h.controller.open(reference);
  if (focused === "referencePreviewViewport") h.dispatch(h.image(), "load");
  let hostKeys = 0, controlKeys = 0;
  h.document.addEventListener("keydown", () => { hostKeys++; });
  h.elements[focused].addEventListener("keydown", event => {
    controlKeys++;
    event.stopPropagation();
  });
  const event = h.dispatch(h.elements[focused], "keydown", { key: "w", metaKey: true });
  await done;
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.dialog.open, false);
  assert.equal(hostKeys, 0);
  assert.equal(controlKeys, 0, "capture handles Cmd-W before a control swallows it");
  assert.equal(h.timers.size, 0);
  assert.equal(h.image(), undefined);
  assert.equal(h.dialog.listeners.get("keydown").length, 0, "closing removes shortcut listeners");
  assert.equal(h.document.listeners.get("keydown").filter(entry => entry.capture).length, 0,
    "closing removes document-level shortcut capture");
}

{
  const h = await harness();
  const done = h.controller.open(reference);
  for (const keys of [{ key: "w" }, { key: "w", ctrlKey: true },
    { key: "w", metaKey: true, shiftKey: true }, { key: "w", metaKey: true, altKey: true },
    { key: "w", metaKey: true, ctrlKey: true }, { key: "q", metaKey: true }]) {
    const event = h.dispatch(h.viewport, "keydown", keys);
    assert.equal(h.dialog.open, true, "unrelated shortcuts must not close the preview");
    assert.equal(event.defaultPrevented, false);
  }
  const repeat = h.dispatch(h.viewport, "keydown", { key: "w", metaKey: true, repeat: true });
  assert.equal(repeat.defaultPrevented, true);
  assert.equal(h.dialog.open, true, "a held key cannot trigger repeated closes");
  h.dispatch(h.viewport, "keydown", { key: "W", metaKey: true });
  await done;
  const closedEvent = h.dispatch(h.viewport, "keydown", { key: "w", metaKey: true });
  assert.equal(closedEvent.defaultPrevented, false, "the shortcut is scoped to an open preview");
}

// The screenshot regression: source loads while native viewport measurements
// are zero and before a dialog resize event has arrived.
{
  const h = await harness();
  const done = h.controller.open(reference);
  h.dispatch(h.image(), "load");
  assert.equal(h.elements.referencePreviewContent.style.width, undefined, "inline pixels must not override responsive CSS");
  assert.equal(h.viewport.style.height, undefined);
  assert.equal(h.elements.referencePreviewPercent.textContent, "100%");
  assert.equal(h.image().style.width, "16px");
  assert.equal(h.image().style.visibility, "visible");
  h.resizeDialog(0, 0);
  h.resizeDialog(NaN, 600);
  assert.equal(h.image().style.top, "219px", "transient invalid layouts cannot collapse the image area");
  h.resizeDialog(1000, 800);
  assert.equal(h.image().style.left, "480px");
  assert.equal(h.image().style.top, "349px", "image follows the resized viewport");
  h.click("referencePreviewClose");
  await done;
}

// Native UXP window resizing need not resize the <dialog> DOM element. Only
// notify the CSS viewport here, keeping the dialog's DOM dimensions unchanged.
{
  const h = await harness();
  const done = h.controller.open(reference);
  h.dialog.clientWidth = 640;
  h.flushFocus();
  h.dialog.clientHeight = 540;
  const image = h.image();
  h.dispatch(image, "load");
  const source = image.src;
  h.click("referencePreviewZoomIn");
  const writes = [];
  image.style = new Proxy(image.style, { set(target, key, value) {
    writes.push([key, value]); target[key] = value; return true;
  } });
  h.notifyViewport(700, 500);
  h.notifyViewport(800, 600);
  h.notifyViewport(976, 706);
  assert.equal(h.timers.size, 1, "rapid resize events share one pending render");
  assert.equal(writes.length, 0, "intermediate sizes do not cause extra paints");
  h.flushResize();
  assert.equal(image.style.left, "478px");
  assert.equal(image.style.top, "348px");
  assert.equal(h.elements.referencePreviewPercent.textContent, "125%");
  assert.deepEqual(writes.map(([key]) => key), ["left", "top"], "fixed zoom does not rewrite image dimensions");
  assert.equal(h.image(), image);
  assert.equal(image.src, source, "live resizing keeps the decoded image");
  writes.length = 0;
  h.notifyViewport(976, 706);
  h.flushResize();
  assert.equal(writes.length, 0, "duplicate sizes do not repaint");
  h.notifyViewport(1200, 900);
  h.click("referencePreviewClose");
  await done;
  assert.equal(h.timers.size, 0, "closing cancels a pending resize render");
}

// A closed WebP conversion must not populate or overwrite a newer preview.
{
  const conversion = deferred();
  const h = await harness((ref, options) => {
    assert.equal(ref.mimeType, "image/webp");
    assert.equal(options.forcePng, true);
    assert.ok(options.maxEdge > 256);
    return conversion.promise;
  });
  const webp = Object.freeze({ ...reference, mimeType: "image/webp", thumbnailDataUrl: "tiny thumbnail" });
  const closed = h.controller.open(webp);
  assert.equal(h.image().src, undefined);
  h.click("referencePreviewClose");
  await closed;
  const current = h.controller.open(reference);
  const currentImage = h.image();
  conversion.resolve(reference);
  await flush();
  assert.equal(h.image(), currentImage);
  assert.equal(currentImage.src, `data:image/png;base64,${reference.base64}`);
  assert.equal(webp.thumbnailDataUrl, "tiny thumbnail");
  h.controller.dispose();
  await current;
  assert.equal(h.observers.every(observer => !observer.connected), true);
  await h.controller.open(reference);
  assert.equal(h.image(), undefined);
}

{
  const h = await harness(async () => reference);
  const done = h.controller.open({ ...reference, mimeType: "image/webp", thumbnailDataUrl: "tiny thumbnail" });
  await flush();
  assert.equal(h.image().src, `data:image/png;base64,${reference.base64}`);
  h.resizeDialog(32, 100);
  h.dispatch(h.image(), "load");
  assert.equal(h.elements.referencePreviewPercent.textContent, "50%");
  h.click("referencePreviewClose");
  await done;
}

for (const failure of ["conversion", "decode", "timeout", "dimensions"]) {
  const h = await harness(async () => { throw new Error("Processor disconnected"); });
  const input = failure === "conversion" ? { ...reference, mimeType: "image/webp" }
    : failure === "dimensions" ? { ...reference, base64: "AAAA" } : reference;
  const done = h.controller.open(input);
  h.flushFocus();
  await flush();
  if (failure === "decode") h.dispatch(h.image(), "error");
  if (failure === "timeout") [...h.timers.values()][0]();
  assert.match(h.elements.referencePreviewMessage.textContent, /Could not preview this image/);
  assert.equal(h.elements.referencePreviewZoomIn.disabled, true);
  if (failure === "timeout") {
    h.dispatch(h.image(), "load");
    assert.equal(h.elements.referencePreviewZoomIn.disabled, true, "late image loads cannot undo a timeout");
  }
  h.click("referencePreviewClose");
  await done;
  assert.equal(h.timers.size, 0);
}

// Thumbnail activation is separate from its remove badge and remains keyboard accessible.
{
  const { document, elements } = panelDocument(["thumbs", "refCount"]);
  const { createReferencePanel, ReferenceCollection } = await loadModule([
    "src/panel/references.ts", "src/references/collection.ts"
  ], { globals: { document, Event } });
  const references = new ReferenceCollection();
  references.add(reference);
  const opened = [];
  const panel = createReferencePanel({ references, processor: { ready: false }, onChange() {},
    onPreview: async ref => { opened.push(ref); } });
  panel.renderThumbs();
  const [image, remove] = elements.thumbs.children[0].children;
  image.dispatchEvent(new Event("click", { bubbles: true }));
  const enter = new Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(enter, { key: "Enter", repeat: false });
  image.dispatchEvent(enter);
  assert.equal(opened.length, 2);
  assert.equal(opened[0], reference);
  remove.dispatchEvent(new Event("click", { bubbles: true }));
  assert.equal(references.length, 0);
  assert.equal(opened.length, 2, "Remove does not open the preview");
}

console.log("Reference preview: image dimensions, zoom/pan/resize, thumbnail controls, WebP and cleanup passed.");
