/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

import "./polyfills"; // must be first: defines TextEncoder/TextDecoder for fast-png
import {
  getActiveDoc,
  getActiveArtboard,
  getSelectionBounds,
  intersectBounds,
  padBounds,
  fitRegionToRatio,
  readRegion,
  placeResult,
  scaleViaPhotoshop,
  setRectSelection,
  readClipboardImage,
  Bounds,
} from "./photoshop-bridge";
import { encodePng, bytesToBase64, decodeImage, toRGBA, coverResampleRGBA } from "./image-codec";
import {
  generateEdit,
  nearestSupportedAspectRatio,
  aspectRatioInfo,
  IMAGE_QUALITY_OPTIONS,
  imageQualityLabel,
  normalizeImageQuality,
  ImageQuality,
} from "./gemini";
import { generateOpenAIImage, OPENAI_MODEL_PREFIX, gptImage2Size, isGptImage2 } from "./openai";
import { pickReferenceImages, referenceImageFromBase64, REF_FORMATS, RefImage } from "./references";
import {
  MODELS,
  DEFAULT_MODEL,
  modelSpec,
  resolutionLabel,
  resolutionMenuLabel,
  estimatedCHF,
  actualUsageCHF,
  formatCHF,
  nearestImageSize,
  nearestRatioLabel,
} from "./models";
import {
  loadApiKey,
  saveApiKey,
  loadOpenAIApiKey,
  saveOpenAIApiKey,
  loadSetting,
  saveSetting,
} from "./storage";
import { Budget, loadBudget, addToBudget, resetBudget, budgetText } from "./budget";

const { entrypoints } = require("uxp");

const MAX_REFS = 10;
const PICKERS = ["model", "resolution", "quality", "selRatio"];

let refs: RefImage[] = [];
let running = false;
// Set by the Cancel button. The run itself decides what that costs: stopping
// before the request goes out is free, stopping after it has reached the
// provider is not (see onGenerate's catch).
let cancelRequested = false;
// Set only while the HTTP request is out — aborts it and releases the run's
// await at once. Cleared again the moment the image is back, because from there
// on the money is spent and cancelling would only throw it away.
let cancelInFlight: (() => void) | null = null;

function $(id: string): any {
  return document.getElementById(id);
}

// A cancel is not a failure, so the run's catch has to tell the two apart. The
// AbortError check covers UXP's fetch rejecting the request itself first.
function cancelledError(): Error {
  const err: any = new Error("Cancelled.");
  err.nbpCancelled = true;
  return err;
}

function isCancelledError(err: any): boolean {
  return !!err?.nbpCancelled || err?.name === "AbortError";
}

function throwIfCancelled(): void {
  if (cancelRequested) throw cancelledError();
}

// Best-effort teardown of the in-flight request. UXP's fetch reads `signal`, but
// AbortController is not guaranteed to exist in every UXP build — where it is
// missing we simply send no signal, and the run still ends immediately because
// awaitCancellable settles on its own.
function newAbortController(): { signal?: any; abort(): void } {
  const Ctor: any = (globalThis as any).AbortController;
  if (typeof Ctor === "function") {
    try {
      return new Ctor();
    } catch {
      /* fall through to the no-op controller */
    }
  }
  return { abort() {} };
}

// Cancel must free the panel at once, so the run waits on a race between the
// request and the Cancel button rather than on the request alone. Whichever
// settles first wins; the loser's later settlement is handled here, so an
// abandoned request cannot reach the global unhandledrejection hook and overwrite
// the status the user is reading.
function awaitCancellable<T>(request: Promise<T>, controller: { abort(): void }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    cancelInFlight = () => {
      try {
        controller.abort();
      } catch {
        /* nothing to abort in this runtime, or already past it */
      }
      reject(cancelledError());
    };
    request.then(resolve, reject);
  });
}

// The one button carries the whole run. "cancel" is the only state the user can
// act on; "cancelling" and "finishing" are the two short unwinds where there is
// nothing left to press.
type GenerateButtonMode = "generate" | "cancel" | "cancelling" | "finishing";

const GENERATE_BUTTON_LABELS: Record<GenerateButtonMode, string> = {
  generate: "Generate",
  cancel: "Cancel",
  cancelling: "Cancelling…",
  finishing: "Finishing…",
};

function setGenerateButton(mode: GenerateButtonMode): void {
  const el = $("generate");
  if (!el) return;
  try {
    el.textContent = GENERATE_BUTTON_LABELS[mode];
    // Red while the click would stop something, back to the call-to-action blue
    // once it would start something.
    el.setAttribute("variant", mode === "generate" ? "cta" : "warning");
  } catch {
    /* Label and colour are cosmetic. This also runs from the run's `finally`,
       where a throw would mask the run's own outcome — so never throw. */
  }
  el.disabled = mode === "cancelling" || mode === "finishing";
}

let statusKind: "info" | "error" | "ok" = "info";
let pulseTimer: any = null;
let pulseStep = 0;
let pulseDir = 1;
const PULSE_STEPS = 15; // must match the #status.pulseN rules in index.html
// 28 frames per breath (up and back down), so this sets the period: 1.68s.
const PULSE_MS = 60;

// The status box's class carries the kind (which picks the gray / green / red
// tint) and, while a request is in flight, the current step of the pulse. Deriving
// it in one place means a status update mid-run cannot knock the pulse out.
function applyStatusClass(): void {
  const el = $("status");
  if (!el) return;
  // Only the neutral gray breathes — a finished run's green or red sits still.
  if (statusKind === "info") {
    el.className = pulseTimer === null ? "" : `pulse${pulseStep}`;
    return;
  }
  el.className = statusKind;
}

// Breathe the status box's background while a request is in flight, so a 10-60s
// wait doesn't look frozen. UXP supports no CSS animations or transitions, so the
// pulse is a timer walking the #status.pulseN classes up and back down. Only the
// background moves; the text is never dimmed or faded.
function setBusy(on: boolean): void {
  if (on === (pulseTimer !== null)) return;
  if (on) {
    pulseStep = 0;
    pulseDir = 1;
    pulseTimer = setInterval(() => {
      pulseStep += pulseDir;
      if (pulseStep >= PULSE_STEPS - 1) pulseDir = -1;
      else if (pulseStep <= 0) pulseDir = 1;
      applyStatusClass();
    }, PULSE_MS);
  } else {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  applyStatusClass();
}

function setStatus(message: string, kind: "info" | "error" | "ok" = "info"): void {
  const el = $("status");
  if (!el) return;
  el.textContent = message;
  statusKind = kind;
  applyStatusClass();
}

// A second, persistent line under the status box. Status text is replaced on
// every step of a run; the note survives so framing decisions the plugin made on
// the user's behalf stay readable while the request is in flight and afterwards.
function setNote(message: string): void {
  const el = $("note");
  if (!el) return;
  el.textContent = message;
}

function renderBudget(b?: Budget): void {
  const el = $("budget");
  if (el) el.textContent = budgetText(b || loadBudget());
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith(OPENAI_MODEL_PREFIX);
}

function modelProviderLabel(model: string): string {
  return isOpenAIModel(model) ? "OpenAI" : "Gemini";
}

// Photoshop stops accepting a layer name past 255 characters.
const MAX_LAYER_NAME = 255;

// Picker labels carry a release year — "Nano Banana Pro (2025)" — which tells the
// models apart when choosing one and is just noise once it is on a layer.
function modelNameWithoutYear(label: string): string {
  return label.replace(/\s*\(\d{4}\)\s*$/, "");
}

// Name a result layer after the prompt that produced it, with the settings in
// brackets at the end, so a stack of results stays readable at a glance. Only an
// overlong prompt is cut — the bracketed settings are short and always survive.
function resultLayerName(prompt: string, details: string[]): string {
  // A layer name is one line, so a multi-line prompt collapses into one.
  const text = prompt.replace(/\s+/g, " ").trim();
  const suffix = details.length ? ` [${details.join(", ")}]` : "";
  const room = Math.max(1, MAX_LAYER_NAME - suffix.length);
  if (text.length <= room) return `${text}${suffix}`;
  const clipped = text.slice(0, room - 1); // one character back for the ellipsis
  const lastSpace = clipped.lastIndexOf(" ");
  // Prefer a word boundary, but only a late one — cutting a long prompt back to
  // its first few words would lose more than ending mid-word does.
  const cut = lastSpace > room * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut}…${suffix}`;
}

// UXP's DOM does not support setting innerHTML — clear by removing children.
function clearChildren(el: any): void {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

function renderThumbs(): void {
  const wrap = $("thumbs");
  clearChildren(wrap);
  refs.forEach((ref, index) => {
    const cell = document.createElement("div");
    cell.className = "thumb";
    const img = document.createElement("img");
    img.src = ref.dataUrl;
    img.title = ref.name;
    // A plain element, not an sp-action-button: Spectrum paints the glyph in the
    // theme's text colour, which vanished on light references. The badge styles
    // itself against the thumbnail instead (see .thumb .remove in index.html).
    const remove = document.createElement("div");
    remove.className = "remove";
    remove.title = `Remove ${ref.name}`;
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      refs.splice(index, 1);
      renderThumbs();
    });
    cell.appendChild(img);
    cell.appendChild(remove);
    wrap.appendChild(cell);
  });
  $("refCount").textContent = `${refs.length}/${MAX_REFS}`;
  syncDropCapacity();
}

async function onAddRefs(): Promise<void> {
  try {
    const remaining = MAX_REFS - refs.length;
    if (remaining <= 0) {
      setStatus(`Maximum ${MAX_REFS} reference images.`, "error");
      return;
    }
    const picked = await pickReferenceImages(remaining);
    if (picked.length) {
      refs = refs.concat(picked).slice(0, MAX_REFS);
      renderThumbs();
    }
  } catch (err: any) {
    setStatus("Could not load references: " + (err?.message || String(err)), "error");
  }
}

const DROP_CHANNEL = "nbp-reference-drop-v1";
const MAX_DROP_CHUNK_LENGTH = 256 * 1024;

interface DropBatchState {
  expected: number;
  completed: number;
  added: number;
  ignored: number;
  invalid: number;
  overflow: number;
  failed: number;
}

interface PendingDropFile {
  batchId: string;
  name: string;
  chunks: string[];
  totalChunks: number;
}

const dropBatches = new Map<string, DropBatchState>();
const pendingDropFiles = new Map<string, PendingDropFile>();
let dropWebviewReady = false;

function safeCount(value: any): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function syncDropCapacity(): void {
  const webview = $("dropWebview");
  if (!dropWebviewReady || !webview || typeof webview.postMessage !== "function") return;
  try {
    webview.postMessage({ channel: DROP_CHANNEL, type: "capacity", remaining: MAX_REFS - refs.length });
  } catch {
    /* The WebView may still be loading; its ready message retries this. */
  }
}

function failPendingDropFile(fileId: string): void {
  const file = pendingDropFiles.get(fileId);
  if (!file) return;
  pendingDropFiles.delete(fileId);
  const batch = dropBatches.get(file.batchId);
  if (batch) {
    batch.failed += 1;
    batch.completed += 1;
  }
}

function finishDropBatch(batchId: string): void {
  const batch = dropBatches.get(batchId);
  if (!batch) return;
  for (const [fileId, file] of pendingDropFiles) {
    if (file.batchId === batchId) {
      pendingDropFiles.delete(fileId);
      batch.failed += 1;
      batch.completed += 1;
    }
  }
  batch.failed += Math.max(0, batch.expected - batch.completed);
  dropBatches.delete(batchId);

  const skipped: string[] = [];
  const unsupported = batch.ignored + batch.invalid;
  if (unsupported) skipped.push(`${unsupported} not ${REF_FORMATS}`);
  if (batch.overflow) skipped.push(`${batch.overflow} over the ${MAX_REFS}-image limit`);
  if (batch.failed) skipped.push(`${batch.failed} unreadable`);
  const tail = skipped.length ? ` Skipped ${skipped.join(", ")}.` : "";
  setStatus(
    batch.added
      ? `Added ${batch.added} reference image${batch.added === 1 ? "" : "s"}.${tail}`
      : `Nothing added.${tail}`,
    batch.added ? "ok" : "error"
  );
  syncDropCapacity();
}

function onDropWebviewMessage(event: any): void {
  const webview = $("dropWebview");
  // The bridge is local-only in the manifest. Checking the exact WebView source
  // as well prevents another embedded page from injecting image data.
  if (!webview || event.source !== webview) return;
  const message = event.data;
  if (!message || message.channel !== DROP_CHANNEL || typeof message.type !== "string") return;

  if (message.type === "ready") {
    dropWebviewReady = true;
    syncDropCapacity();
    return;
  }
  if (message.type === "drop-error") {
    setStatus(message.message || "That drop did not contain readable files.", "error");
    return;
  }

  const batchId = typeof message.batchId === "string" ? message.batchId : "";
  if (!batchId || batchId.length > 120) return;

  if (message.type === "batch-start") {
    dropBatches.set(batchId, {
      expected: safeCount(message.expected),
      completed: 0,
      added: 0,
      ignored: safeCount(message.ignored),
      invalid: 0,
      overflow: safeCount(message.overflow),
      failed: 0,
    });
    setNote("");
    if (message.expected) {
      setStatus(`Reading ${message.expected} dropped image${message.expected === 1 ? "" : "s"}…`);
    }
    return;
  }

  const batch = dropBatches.get(batchId);
  if (!batch) return;

  if (message.type === "file-error") {
    batch.failed += 1;
    batch.completed += 1;
    return;
  }

  const fileId = typeof message.fileId === "string" ? message.fileId : "";
  if (message.type === "file-start") {
    const totalChunks = safeCount(message.totalChunks);
    if (!fileId || fileId.length > 180 || !totalChunks || totalChunks > 100000) {
      batch.failed += 1;
      batch.completed += 1;
      return;
    }
    pendingDropFiles.set(fileId, {
      batchId,
      name: String(message.name || "dropped image").slice(0, 512),
      chunks: new Array(totalChunks),
      totalChunks,
    });
    return;
  }

  if (message.type === "file-chunk") {
    const file = pendingDropFiles.get(fileId);
    const index = Number(message.index);
    if (
      !file ||
      file.batchId !== batchId ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= file.totalChunks ||
      typeof message.data !== "string" ||
      message.data.length > MAX_DROP_CHUNK_LENGTH
    ) {
      failPendingDropFile(fileId);
      return;
    }
    file.chunks[index] = message.data;
    return;
  }

  if (message.type === "file-end") {
    const file = pendingDropFiles.get(fileId);
    if (!file || file.batchId !== batchId) return;
    pendingDropFiles.delete(fileId);
    batch.completed += 1;
    let complete = true;
    for (let index = 0; index < file.totalChunks; index += 1) {
      if (typeof file.chunks[index] !== "string") {
        complete = false;
        break;
      }
    }
    if (!complete) {
      batch.failed += 1;
      return;
    }
    if (refs.length >= MAX_REFS) {
      batch.overflow += 1;
      return;
    }
    try {
      const image = referenceImageFromBase64(file.name, file.chunks.join(""));
      if (!image) {
        batch.invalid += 1;
        return;
      }
      refs.push(image);
      batch.added += 1;
      renderThumbs();
    } catch {
      batch.failed += 1;
    }
    return;
  }

  if (message.type === "batch-end") finishDropBatch(batchId);
}

function setupDropWebview(): void {
  const webview = $("dropWebview");
  if (!webview) return;
  window.addEventListener("message", onDropWebviewMessage);
  webview.addEventListener("loadstop", () => {
    dropWebviewReady = true;
    syncDropCapacity();
  });
  webview.addEventListener("loaderror", () => {
    dropWebviewReady = false;
    setStatus("Drag-and-drop could not load. Add Files and Paste still work.", "error");
  });
}

// Add the clipboard image as a reference. Photoshop performs the paste (see
// readClipboardImage), so this covers everything it can paste — an image copied
// in a browser, a file copied in Finder, another app's canvas.
async function onPasteRef(): Promise<void> {
  if (refs.length >= MAX_REFS) {
    setStatus(`Maximum ${MAX_REFS} reference images.`, "error");
    return;
  }
  setStatus("Pasting from the clipboard…");
  try {
    const img = await readClipboardImage();
    const base64 = bytesToBase64(encodePng(img.data, img.width, img.height, img.components));
    refs = refs
      .concat({
        name: `Pasted ${img.width}×${img.height}`,
        mimeType: "image/png",
        base64,
        dataUrl: `data:image/png;base64,${base64}`,
      })
      .slice(0, MAX_REFS);
    renderThumbs();
    const shrunk = img.width !== img.originalWidth || img.height !== img.originalHeight;
    setStatus(
      shrunk
        ? `Pasted reference added — ${img.originalWidth}×${img.originalHeight} scaled down to ${img.width}×${img.height}.`
        : `Pasted reference added (${img.width}×${img.height}).`,
      "ok"
    );
  } catch (err: any) {
    // The bridge attaches a step-by-step trace to the message; mirror it to the
    // console too, since the status box is narrow.
    console.log("[Mega Musa] paste failed:", err?.message || String(err));
    setStatus("Could not paste: " + (err?.message || String(err)), "error");
  }
}

// The Generate button is also the Cancel button — one click target for the one
// thing a run can be told to do at any moment.
function onGenerateClick(): void {
  if (running) onCancel();
  else onGenerate();
}

function onCancel(): void {
  if (!running || cancelRequested) return;
  cancelRequested = true;
  setGenerateButton("cancelling");
  setStatus("Cancelling…");
  const stop = cancelInFlight;
  cancelInFlight = null;
  // With a request out this ends the wait now; without one the run stops at its
  // next checkpoint, before anything is sent.
  if (stop) stop();
}

async function onGenerate(): Promise<void> {
  if (running) return;
  setStatus("Starting…"); // immediate feedback that the click was received
  setNote(""); // drop the previous run's framing note

  const prompt = ($("prompt").value || "").trim();
  const model = $("model").value || "gemini-3-pro-image";
  const provider = modelProviderLabel(model);
  const quality: ImageQuality = isOpenAIModel(model)
    ? normalizeImageQuality($("quality")?.value || "auto")
    : "auto";
  const apiKey = (
    isOpenAIModel(model) ? $("openaiApiKey").value || "" : $("geminiApiKey").value || ""
  ).trim();
  if (!apiKey) {
    setStatus(`Enter your ${provider} API key and press Save.`, "error");
    return;
  }
  if (!prompt) {
    setStatus("Enter a prompt describing the edit.", "error");
    return;
  }

  const spec = modelSpec(model);
  // The resolution menu is already rebuilt per model, but clamp again here so a
  // tier this model cannot produce can never reach the API.
  const resolution = nearestImageSize($("resolution").value || "auto", spec);
  // Unticked: the canvas contributes nothing to the request. With no reference
  // images either, that makes this a plain text-to-image generation which is
  // still placed into the selection's area and shape.
  const includeSelection = isChecked($("includeSelection"));

  running = true;
  cancelRequested = false;
  cancelInFlight = null;
  // Turns to Cancel for the length of the run — nothing is sent yet, so a click
  // now costs nothing.
  setGenerateButton("cancel");
  setBusy(true);
  // Once the request is out the provider bills it whatever happens next, so the
  // estimate is frozen at that moment for the cancel path to charge.
  let requestSent = false;
  let sentCharge: number | null = null;
  try {
    const doc = getActiveDoc();
    const docId: number = doc.id;
    const docW: number = doc.width;
    const docH: number = doc.height;
    const documentBounds: Bounds = { left: 0, top: 0, right: docW, bottom: docH };
    const activeArtboard = await getActiveArtboard(doc);
    const targetBounds = activeArtboard?.bounds || documentBounds;
    const targetW = targetBounds.right - targetBounds.left;
    const targetH = targetBounds.bottom - targetBounds.top;

    const rawSelection = await getSelectionBounds();
    const hasSelection =
      !!rawSelection && rawSelection.right - rawSelection.left > 1 && rawSelection.bottom - rawSelection.top > 1;
    const sel = hasSelection ? intersectBounds(rawSelection as Bounds, targetBounds) : null;
    if (hasSelection && activeArtboard && !sel) {
      throw new Error(`The selection does not overlap the active artboard “${activeArtboard.name}”.`);
    }
    // Reflect the selection's nearest supported ratio in the picker — display
    // only. An existing selection is never modified, so lasso / ellipse /
    // feathered shapes survive to become the result's mask. The crop is framed to
    // a supported ratio later (fitRegionToRatio) using only the bounding box.
    // (When there is no selection we do set one — see the !isRegion block below.)
    if (sel && sel.right - sel.left > 1 && sel.bottom - sel.top > 1) {
      const info = aspectRatioInfo(sel.right - sel.left, sel.bottom - sel.top);
      setPickerSafe($("selRatio"), info.label);
      saveSetting("selRatio", info.label);
      refreshResolutionLabels();
    }
    const isRegion = !!sel;

    // Region edit: crop to the selection (+ small padding for blending) so the
    // model spends its full resolution on the detail. In an artboard document,
    // padding and output framing never escape the active artboard.
    const basePad: Bounds = isRegion
      ? padBounds(sel as Bounds, 0.06, targetBounds)
      : targetBounds;
    const padW = basePad.right - basePad.left;
    const padH = basePad.bottom - basePad.top;

    // Pick the exact ratio the model will output, then reshape the crop to match
    // it, so the later cover-fit is a pure scale — no zoom, trim or shift. This
    // applies to whole-image edits too: framing the canvas to the ratio the model
    // actually returns is what keeps the result from coming back stretched.
    // gpt-image-2 is the exception — it takes any size, so we request the crop's
    // own ratio and leave the crop alone.
    let region = basePad;
    let geminiAspect: string | undefined;
    let openaiSize: string | undefined;
    let ratioLabel = ""; // "" => the model matched the crop's own shape
    if (isOpenAIModel(model)) {
      if (isGptImage2(model)) {
        openaiSize = gptImage2Size(padW, padH, resolution === "auto" ? undefined : resolution);
      } else {
        // Fixed-size models: the crop's shape picks one of the sizes the model
        // actually returns (see fixedSizes in the capability table).
        const presets = spec.fixedSizes || [];
        if (!presets.length) {
          throw new Error(`${spec.label} has no fixedSizes in the model table — cannot pick an output size.`);
        }
        const cr = padW / padH;
        const best = presets.reduce((a, b) =>
          Math.abs(Math.log(b.ratio) - Math.log(cr)) < Math.abs(Math.log(a.ratio) - Math.log(cr)) ? b : a
        );
        openaiSize = best.size;
        ratioLabel = best.label;
        region = fitRegionToRatio(basePad, best.ratio, targetBounds);
      }
    } else {
      geminiAspect = nearestSupportedAspectRatio(padW, padH);
      ratioLabel = geminiAspect;
      const [rw, rh] = geminiAspect.split(":").map(Number);
      region = fitRegionToRatio(basePad, rw / rh, targetBounds);
    }
    const cropW = region.right - region.left;
    const cropH = region.bottom - region.top;

    // Nothing was selected: use the active artboard, or the full image in a
    // non-artboard document. Make that framing the live selection so the user
    // can see exactly which area is in play.
    const notes: string[] = [];
    if (
      isRegion &&
      activeArtboard &&
      rawSelection &&
      (sel!.left !== rawSelection.left ||
        sel!.top !== rawSelection.top ||
        sel!.right !== rawSelection.right ||
        sel!.bottom !== rawSelection.bottom)
    ) {
      notes.push(`Only the part of the selection inside active artboard “${activeArtboard.name}” is used.`);
    }
    if (!isRegion) {
      // Cancelled while the document was being read: stop before touching the
      // user's selection, and before anything has been sent.
      throwIfCancelled();
      await setRectSelection(region);
      if (ratioLabel) {
        setPickerSafe($("selRatio"), ratioLabel);
        saveSetting("selRatio", ratioLabel);
        refreshResolutionLabels();
      }
      const cropped = cropW !== targetW || cropH !== targetH;
      const what = includeSelection ? "what was sent" : "where the result lands";
      const targetName = activeArtboard ? `active artboard “${activeArtboard.name}”` : "the full image";
      if (!ratioLabel) {
        notes.push(`No selection — used ${targetName} (${targetW}×${targetH}); this model matches its shape.`);
      } else if (cropped) {
        const trimmed =
          cropW !== targetW ? `${targetW - cropW}px off the width` : `${targetH - cropH}px off the height`;
        notes.push(
          `No selection — selected ${targetName} and fit it to ${ratioLabel}: ` +
            `${cropW}×${cropH} of ${targetW}×${targetH} (${trimmed}). The selection shows ${what}.`
        );
      } else {
        notes.push(
          `No selection — selected ${targetName} (${targetW}×${targetH}), already ${ratioLabel}, so nothing was cropped.`
        );
      }
    }
    if (!includeSelection) {
      notes.push(
        refs.length
          ? `“Include Photoshop selection” is off — generating from the prompt and ${refs.length} reference image${refs.length === 1 ? "" : "s"} only.`
          : "“Include Photoshop selection” is off and there are no references — plain text-to-image from the prompt."
      );
    }
    setNote(notes.join(" "));

    let basePng: Uint8Array | undefined;
    if (includeSelection) {
      setStatus(
        isRegion
          ? "Reading selected region…"
          : activeArtboard
            ? `Reading active artboard “${activeArtboard.name}”…`
            : "Reading full image…"
      );
      // withMask=false: the selection shape is applied later as a Photoshop layer
      // mask, so we don't read/resample it here (and leave the selection untouched).
      const read = await readRegion(docId, region, false);
      basePng = encodePng(read.image.data, cropW, cropH, read.image.components);
      console.log("[Mega Musa]", read.debug);
    }

    const sizeLabel = geminiAspect ?? openaiSize ?? "auto";
    const modeLabel = includeSelection
      ? "editing the canvas"
      : refs.length
        ? "from references"
        : "text-to-image";
    const qualitySuffix = isOpenAIModel(model) ? `, ${imageQualityLabel(quality)} quality` : "";
    // Last free exit: after this the request is on its way and is billed.
    throwIfCancelled();
    setStatus(
      `Generating ${sizeLabel} @ ${resolution === "auto" ? "default" : resolution}${qualitySuffix} with ${model} — ${modeLabel}…  (10–60s, cancellable)`
    );
    const baseReq = {
      apiKey,
      model,
      prompt,
      baseImagePng: basePng,
      references: refs.map((r) => ({ mimeType: r.mimeType, base64: r.base64 })),
    };
    const controller = newAbortController();
    sentCharge = estimatedCHF(spec, resolution, openaiSize, quality);
    requestSent = true;
    const request = isOpenAIModel(model)
      ? generateOpenAIImage({ ...baseReq, size: openaiSize as string, quality, signal: controller.signal })
      : generateEdit({
          ...baseReq,
          aspectRatio: geminiAspect,
          imageSize: resolution === "auto" ? undefined : resolution,
          signal: controller.signal,
        });
    const result = await awaitCancellable(request, controller);
    // The image is here and paid for. Cancelling from now on could only throw it
    // away, so the button stops offering it for the rest of the run.
    cancelInFlight = null;
    setGenerateButton("finishing");

    // Charged the moment the image comes back, not once it lands on the canvas —
    // a failure in the scaling or placing below still costs money. GPT Image 2
    // can replace the preflight estimate with its completed-event usage.
    const actualCost = result.usage ? actualUsageCHF(spec, result.usage) : null;
    const budgetCharge = actualCost ?? sentCharge;
    renderBudget(addToBudget(budgetCharge));
    const resolvedQuality = isOpenAIModel(model) ? result.usage?.quality || quality : undefined;
    const usageDetails: string[] = [];
    if (resolvedQuality) usageDetails.push(`${imageQualityLabel(resolvedQuality)} quality`);
    if (actualCost !== null) usageDetails.push(`actual ca. CHF ${formatCHF(actualCost)}`);
    else if (isOpenAIModel(model) && sentCharge !== null) {
      usageDetails.push(`estimate ca. CHF ${formatCHF(sentCharge)}`);
    }
    if (usageDetails.length) setNote([notes.join(" "), usageDetails.join("; ")].filter(Boolean).join(" "));

    const decoded = decodeImage(result.mimeType, result.bytes);
    let rgba = toRGBA(decoded.data, decoded.width, decoded.height, decoded.channels);
    // Resample the result to the crop box. Hand it to Photoshop's Image Size
    // engine (bicubic sharper for reductions, smoother for enlargements) — far
    // better than a JS bilinear pass — and fall back to the JS resampler if the
    // scratch-document plumbing fails, so a generation never dies here.
    if (decoded.width !== cropW || decoded.height !== cropH) {
      setStatus("Scaling result…");
      try {
        rgba = await scaleViaPhotoshop(rgba, decoded.width, decoded.height, cropW, cropH);
      } catch (e: any) {
        console.log("[Mega Musa] Photoshop scale failed, using JS resample:", e?.message || e);
        rgba = coverResampleRGBA(rgba, decoded.width, decoded.height, cropW, cropH);
      }
    }

    setStatus("Placing result…");
    // What produced this layer, for the bracketed tail of its name. The OpenAI
    // models return one fixed size, so their exact output is more use than the
    // requested tier; the Gemini models frame to a ratio, so there the tier is
    // the resolution. A model with no resolution control contributes neither.
    const layerDetails: string[] = [modelNameWithoutYear(spec.label)];
    const resolutionDetail = openaiSize || (spec.imageSizes.length ? resolutionLabel(resolution) : "");
    if (resolutionDetail) layerDetails.push(resolutionDetail);
    if (resolvedQuality) layerDetails.push(`${imageQualityLabel(resolvedQuality)} quality`);
    await placeResult(docId, region, rgba, cropW, cropH, resultLayerName(prompt, layerDetails), isRegion);

    const doneMessage = isRegion
      ? "Done — result clipped to your selection (new layer)."
      : activeArtboard
        ? `Done — result added to active artboard “${activeArtboard.name}” as a new layer.`
        : "Done — full-image result added as a new layer.";
    setStatus(
      usageDetails.length ? `${doneMessage} (${usageDetails.join(", ")}).` : doneMessage,
      "ok"
    );
  } catch (err: any) {
    if (isCancelledError(err)) {
      // Stopping the wait does not stop the provider: once the request is out it
      // is generated and billed whether or not the answer is ever collected. So a
      // cancel from that point on is charged like any other image, at the frozen
      // estimate — the real usage figure only ever arrives with the response.
      if (requestSent) {
        renderBudget(addToBudget(sentCharge, true));
        setStatus(
          sentCharge === null
            ? "Cancelled — the request was already sent, so it counts as billed. This tier has no published price, so no amount was added."
            : `Cancelled — the request was already sent, so it counts as billed: ca. CHF ${formatCHF(sentCharge)} added to the budget.`
        );
      } else {
        setStatus("Cancelled before anything was sent — nothing was charged.");
      }
    } else {
      setStatus("Error: " + (err?.message || String(err)), "error");
    }
  } finally {
    running = false;
    cancelRequested = false;
    cancelInFlight = null;
    setGenerateButton("generate");
    // After the catch above, so the resting colour is the run's final ok/error tint.
    setBusy(false);
  }
}

// Some Spectrum widgets (sp-picker, sp-slider) expose `value` as a getter only,
// so assigning to it throws. Set the property when allowed, else fall back to the
// reflected attribute — and never throw out of settings restore.
function setValueSafe(el: any, v: string): void {
  if (!el) return;
  try {
    el.value = v;
    return;
  } catch {
    /* getter-only property */
  }
  try {
    el.setAttribute("value", v);
  } catch {
    /* ignore */
  }
}

// sp-checkbox exposes `checked` as a property, but fall back to the reflected
// attribute (and default to on) so a runtime quirk can never silently turn the
// canvas input off.
function isChecked(el: any): boolean {
  if (!el) return true;
  if (typeof el.checked === "boolean") return el.checked;
  try {
    return el.hasAttribute("checked");
  } catch {
    return true;
  }
}

function setCheckedSafe(el: any, on: boolean): void {
  if (!el) return;
  try {
    el.checked = on;
  } catch {
    /* getter-only property */
  }
  try {
    if (on) el.setAttribute("checked", "");
    else el.removeAttribute("checked");
  } catch {
    /* ignore */
  }
}

// Replace a picker's options wholesale and select `selected`.
function buildMenu(pickerId: string, options: { value: string; label: string }[], selected: string): void {
  const picker = $(pickerId);
  const menu = picker?.querySelector("sp-menu");
  if (!menu) return;
  clearChildren(menu);
  for (const opt of options) {
    const item = document.createElement("sp-menu-item");
    item.setAttribute("value", opt.value);
    item.textContent = opt.label;
    if (opt.value === selected) item.setAttribute("selected", "");
    menu.appendChild(item);
  }
  setValueSafe(picker, selected);
}

function buildModelMenu(): void {
  buildMenu(
    "model",
    MODELS.map((m) => ({ value: m.id, label: m.label })),
    DEFAULT_MODEL
  );
}

function buildQualityMenu(modelId: string, selected: string): ImageQuality {
  const field = $("qualityField");
  const openai = isOpenAIModel(modelId);
  if (field) field.style.display = openai ? "flex" : "none";
  if (!openai) {
    setValueSafe($("quality"), "auto");
    return "auto";
  }
  const quality = normalizeImageQuality(selected);
  buildMenu(
    "quality",
    IMAGE_QUALITY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    quality
  );
  saveSetting("quality", quality);
  return quality;
}

function buildResolutionMenu(
  spec: ReturnType<typeof modelSpec>,
  ratio: string,
  selected: string,
  quality: ImageQuality = "auto"
): string {
  const size = nearestImageSize(selected, spec);
  buildMenu(
    "resolution",
    [{ value: "auto", label: resolutionMenuLabel("auto", spec, ratio, quality) }].concat(
      spec.imageSizes.map((s) => ({ value: s, label: resolutionMenuLabel(s, spec, ratio, quality) }))
    ),
    size
  );
  saveSetting("resolution", size);
  return size;
}

function refreshResolutionLabels(): void {
  const model = $("model")?.value || DEFAULT_MODEL;
  const spec = modelSpec(model);
  const quality = isOpenAIModel(model) ? normalizeImageQuality($("quality")?.value || "auto") : "auto";
  buildResolutionMenu(spec, $("selRatio")?.value || "1:1", $("resolution")?.value || "auto", quality);
}

// Rebuild the ratio and resolution menus from the picked model's entry in the
// capability table. A choice the new model also supports is kept; anything else
// snaps to the nearest thing it can actually do, and the caller gets a sentence
// explaining the move so it never happens silently.
// `preferRatio`/`preferSize`/`preferQuality` override what the pickers currently
// show — used at startup, where stored settings should win over markup defaults.
function applyModelCapabilities(
  modelId: string,
  preferRatio?: string,
  preferSize?: string,
  preferQuality?: string
): string {
  const spec = modelSpec(modelId);
  const notes: string[] = [];
  const quality = buildQualityMenu(
    modelId,
    isOpenAIModel(modelId)
      ? preferQuality || loadSetting("quality", $("quality")?.value || "auto")
      : "auto"
  );

  const wantRatio = preferRatio || $("selRatio")?.value || "1:1";
  const ratio = nearestRatioLabel(wantRatio, spec.aspectRatios);
  buildMenu(
    "selRatio",
    spec.aspectRatios.map((r) => ({ value: r, label: r })),
    ratio
  );
  saveSetting("selRatio", ratio);
  if (ratio !== wantRatio) {
    notes.push(`${spec.label} cannot do ${wantRatio} — ratio set to ${ratio}.`);
  }

  const wantSize = preferSize || $("resolution")?.value || "auto";
  const size = buildResolutionMenu(spec, ratio, wantSize, quality);
  if (size !== wantSize) {
    notes.push(
      spec.imageSizes.length
        ? `${spec.label} does not output ${resolutionLabel(wantSize)} — resolution set to ${resolutionLabel(size)}.`
        : `${spec.label} has no resolution control — its output size follows the ratio.`
    );
  }
  return notes.join(" ");
}

function hasOption(picker: any, v: string): boolean {
  if (!picker) return false;
  try {
    const items: any[] = Array.from(picker.querySelectorAll("sp-menu-item"));
    return items.some((item) => item.getAttribute("value") === v);
  } catch {
    return false;
  }
}

function setPickerSafe(picker: any, v: string): void {
  if (!picker) return;
  setValueSafe(picker, v);
  // Ensure the matching menu item reflects as selected.
  try {
    picker.querySelectorAll("sp-menu-item").forEach((item: any) => {
      if (item.getAttribute("value") === v) item.setAttribute("selected", "");
      else item.removeAttribute("selected");
    });
  } catch {
    /* ignore */
  }
}

// Grow `sel` outward around its center to exactly `targetAR` (w/h), clamped to
// the canvas. Growing (not shrinking) keeps all originally-selected content.
function ratioRect(sel: Bounds, targetAR: number, limit: Bounds): Bounds {
  const w = sel.right - sel.left;
  const h = sel.bottom - sel.top;
  const cx = (sel.left + sel.right) / 2;
  const cy = (sel.top + sel.bottom) / 2;
  let nw = w;
  let nh = h;
  if (targetAR > w / h) nw = h * targetAR;
  else nh = w / targetAR;
  nw = Math.min(nw, limit.right - limit.left);
  nh = Math.min(nh, limit.bottom - limit.top);
  let left = Math.round(cx - nw / 2);
  let top = Math.round(cy - nh / 2);
  let right = left + Math.round(nw);
  let bottom = top + Math.round(nh);
  if (left < limit.left) { right += limit.left - left; left = limit.left; }
  if (top < limit.top) { bottom += limit.top - top; top = limit.top; }
  if (right > limit.right) { left -= right - limit.right; right = limit.right; }
  if (bottom > limit.bottom) { top -= bottom - limit.bottom; bottom = limit.bottom; }
  return { left: Math.max(limit.left, left), top: Math.max(limit.top, top), right, bottom };
}

// Manual "Fit selection" — reshape the current selection to the chosen ratio
// now, so the user can preview the shape. Generate also does this automatically.
async function onFitSelection(): Promise<void> {
  const v = $("selRatio").value || "1:1";
  try {
    const doc = getActiveDoc();
    const sel = await getSelectionBounds();
    if (!sel || sel.right - sel.left < 2 || sel.bottom - sel.top < 2) {
      setStatus("Draw a selection first, then click Fit selection.", "error");
      return;
    }
    const activeArtboard = await getActiveArtboard(doc);
    const limit = activeArtboard?.bounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
    const targetSelection = intersectBounds(sel, limit);
    if (!targetSelection) {
      setStatus("The selection does not overlap the active artboard.", "error");
      return;
    }
    const [rw, rh] = v.split(":").map(Number);
    await setRectSelection(ratioRect(targetSelection, rw / rh, limit));
    setStatus(`Selection fitted to ${v} — preview the shape, then Generate.`, "ok");
  } catch (err: any) {
    setStatus("Couldn't fit selection: " + (err?.message || String(err)), "error");
  }
}

// "Fit to nearest aspect ratio" — detect the closest official ratio to the
// current selection, set it in the dropdown, and grow the selection to it.
async function onFitNearest(): Promise<void> {
  try {
    const doc = getActiveDoc();
    const sel = await getSelectionBounds();
    if (!sel || sel.right - sel.left < 2 || sel.bottom - sel.top < 2) {
      setStatus("Draw a selection first, then click Fit to nearest.", "error");
      return;
    }
    const activeArtboard = await getActiveArtboard(doc);
    const limit = activeArtboard?.bounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
    const targetSelection = intersectBounds(sel, limit);
    if (!targetSelection) {
      setStatus("The selection does not overlap the active artboard.", "error");
      return;
    }
    const info = aspectRatioInfo(
      targetSelection.right - targetSelection.left,
      targetSelection.bottom - targetSelection.top
    );
    setPickerSafe($("selRatio"), info.label);
    saveSetting("selRatio", info.label);
    refreshResolutionLabels();
    const [rw, rh] = info.label.split(":").map(Number);
    await setRectSelection(ratioRect(targetSelection, rw / rh, limit));
    setStatus(`Fitted to nearest ratio: ${info.label}.`, "ok");
  } catch (err: any) {
    setStatus("Couldn't fit selection: " + (err?.message || String(err)), "error");
  }
}

async function restoreSettings(): Promise<void> {
  setValueSafe($("geminiApiKey"), await loadApiKey());
  setValueSafe($("openaiApiKey"), await loadOpenAIApiKey());
  // The model menu is generated from the capability table. Only restore a stored
  // model the table still lists — one dropped since last session would otherwise
  // leave the picker blank while still being sent to the API.
  buildModelMenu();
  const storedModel = loadSetting("model", "");
  if (storedModel && hasOption($("model"), storedModel)) setPickerSafe($("model"), storedModel);
  else if (storedModel) saveSetting("model", "");
  // Ratio and resolution menus follow from the model, restoring each stored
  // choice that model supports and snapping the rest.
  applyModelCapabilities(
    $("model").value || DEFAULT_MODEL,
    loadSetting("selRatio", "1:1"),
    loadSetting("resolution", "auto"),
    loadSetting("quality", "auto")
  );
  // Defaults to on — only an explicit "0" from a previous session turns it off.
  setCheckedSafe($("includeSelection"), loadSetting("includeSelection", "1") !== "0");
}

function persistSettingsHooks(): void {
  for (const id of PICKERS) {
    if (id === "selRatio" || id === "quality") continue;
    $(id)?.addEventListener("change", () => saveSetting(id, $(id).value));
  }
  $("quality")?.addEventListener("change", () => {
    saveSetting("quality", normalizeImageQuality($("quality").value || "auto"));
    refreshResolutionLabels();
  });
  $("selRatio")?.addEventListener("change", () => {
    saveSetting("selRatio", $("selRatio").value);
    refreshResolutionLabels();
  });
  // Switching model re-derives which ratios and resolutions are on offer.
  $("model")?.addEventListener("change", () => {
    const note = applyModelCapabilities($("model").value || DEFAULT_MODEL);
    if (note) setStatus(note);
  });
  $("includeSelection")?.addEventListener("change", () =>
    saveSetting("includeSelection", isChecked($("includeSelection")) ? "1" : "0")
  );
}

async function init(): Promise<void> {
  try {
    // Register the panel entrypoint declared in manifest.json.
    entrypoints.setup({ panels: { nbpEditorPanel: { show() {} } } });

    $("saveGeminiKey").addEventListener("click", async () => {
      const apiKey = ($("geminiApiKey").value || "").trim();
      try {
        await saveApiKey(apiKey);
        setStatus(apiKey ? "Gemini API key saved securely." : "Gemini API key cleared.", "ok");
      } catch (err: any) {
        setStatus("Could not save Gemini API key: " + (err?.message || String(err)), "error");
      }
    });
    $("saveOpenAIKey").addEventListener("click", async () => {
      const apiKey = ($("openaiApiKey").value || "").trim();
      try {
        await saveOpenAIApiKey(apiKey);
        setStatus(apiKey ? "OpenAI API key saved securely." : "OpenAI API key cleared.", "ok");
      } catch (err: any) {
        setStatus("Could not save OpenAI API key: " + (err?.message || String(err)), "error");
      }
    });
    $("addRefs").addEventListener("click", onAddRefs);
    $("pasteRef").addEventListener("click", onPasteRef);
    $("clearRefs").addEventListener("click", () => {
      refs = [];
      renderThumbs();
    });
    setupDropWebview();
    $("generate").addEventListener("click", onGenerateClick);
    $("fitSelection").addEventListener("click", onFitSelection);
    $("fitNearest").addEventListener("click", onFitNearest);
    $("resetBudget").addEventListener("click", () => {
      renderBudget(resetBudget());
      setStatus("Budget counter reset — counting from today.", "ok");
    });

    // Return in the prompt field fires Generate immediately — the field is
    // single-line, so Return has nothing else to do. Ignore it mid-composition
    // so an IME candidate can still be confirmed with Return.
    $("prompt").addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Return") return;
      if ((e as any).isComposing) return;
      e.preventDefault();
      onGenerate();
    });

    // Cmd/Ctrl+V pastes the clipboard image as a reference — but only outside a
    // text field, so pasting text into the prompt or a key field still works.
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== "v" && e.key !== "V")) return;
      const tag = String((e.target as any)?.tagName || "").toUpperCase();
      if (tag.includes("TEXTFIELD") || tag.includes("TEXTAREA") || tag === "INPUT") return;
      e.preventDefault();
      onPasteRef();
    });

    await restoreSettings();
    persistSettingsHooks();
    renderThumbs();
    renderBudget();
    setStatus("Ready. Write a prompt and optionally select a region and/or add references.");
  } catch (err: any) {
    setStatus("Init error: " + (err?.message || String(err)), "error");
  }
}

// Surface otherwise-silent errors directly in the panel.
try {
  const g: any = globalThis as any;
  g.addEventListener?.("unhandledrejection", (e: any) =>
    setStatus("Async error: " + (e?.reason?.message || e?.reason || "unknown"), "error")
  );
  g.addEventListener?.("error", (e: any) =>
    setStatus("Script error: " + (e?.message || "unknown"), "error")
  );
} catch {
  /* no global event target in this runtime */
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
