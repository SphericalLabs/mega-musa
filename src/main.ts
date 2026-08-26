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
  captureSelection,
  intersectBounds,
  fitRegionToRatio,
  readRegion,
  placeResult,
  setRectSelection,
  readClipboardImage,
  Bounds,
  SelectionSnapshot,
} from "./photoshop-bridge";
import { encodePng, bytesToBase64, decodeImage, toRGBA } from "./image-codec";
import {
  generateEdit,
  IMAGE_QUALITY_OPTIONS,
  imageQualityLabel,
  normalizeImageQuality,
  ImageQuality,
} from "./gemini";
import { generateOpenAIImage, OPENAI_MODEL_PREFIX } from "./openai";
import {
  describeImages,
  descriptionModelSpec,
  DESCRIPTION_MODELS,
  DEFAULT_GEMINI_DESCRIPTION_MODEL,
  DEFAULT_OPENAI_DESCRIPTION_MODEL,
  DescriptionModelSpec,
} from "./describe";
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
  outputFrame,
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
import { GenerationArchive, readLayerGenerationArchive } from "./archive";
import { restoreReferenceAssets } from "./reference-assets";

const { entrypoints } = require("uxp");
const { action: photoshopAction } = require("photoshop");

const MAX_REFS = 10;
const PICKERS = ["model", "resolution", "quality", "selRatio"];
const REQUEST_MIN_MAX_EDGE = 2048;
// Provider sizes use pixel grids, so small ratio differences are normal.
const RETURNED_RATIO_TOLERANCE = 0.02;
const WEBVIEW_CHUNK_SIZE = 192 * 1024;
const REFERENCE_RESIZE_TIMEOUT_MS = 120000;
const REFERENCE_THUMBNAIL_MAX_EDGE = 256;
const DESCRIPTION_INPUT_MAX_EDGE = 2048;
const SRGB_PROFILE = "sRGB IEC61966-2.1";
const PROMPT_MIN_HEIGHT_PX = 48;
const PROMPT_MAX_HEIGHT_PX = 180;
const COLLAPSIBLE_SECTIONS = [
  "apiKeys",
  "modelSelection",
  "prompt",
  "referenceImages",
  "describeWith",
  "archive",
  "aspectRatio",
] as const;

let refs: RefImage[] = [];
const pendingReferenceThumbnails = new WeakMap<RefImage, Promise<string>>();
// An override applies only to one exact document mode/profile/depth state in
// this panel session. Changing any of those properties creates a new warning.
const acceptedDocumentWarnings = new Set<string>();
let running = false;
let describing = false;
let promptBeforeDescription: string | null = null;
// Set by the Cancel button. The run itself decides what that costs: stopping
// before the request goes out is free, stopping after it has reached the
// provider is not (see onGenerate's catch).
let cancelRequested = false;
// Set only while the HTTP request is out — aborts it and releases the run's
// await at once. Cleared again the moment the image is back, because from there
// on the money is spent and cancelling would only throw it away.
let cancelInFlight: (() => void) | null = null;
let selectedArchive: {
  archive: GenerationArchive;
  layerName: string;
  docId: number;
  layerId: number;
} | null = null;
let archiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let archiveRefreshSequence = 0;
let descriptionInputRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let descriptionInputRefreshSequence = 0;
let hasDescriptionSelection = false;

function $(id: string): any {
  return document.getElementById(id);
}

function syncPromptSizer(): void {
  const prompt = $("prompt");
  const sizer = $("promptSizer");
  if (!prompt || !sizer) return;
  try {
    // Grow with wrapped content until UXP's safe native-control height; longer
    // prompts stay at the cap and use Spectrum's internal scrollbar.
    const value = String(prompt.value || "");
    sizer.textContent = value ? `${value}\n ` : " ";
    const measuredHeight = Math.ceil(sizer.getBoundingClientRect().height || 0);
    prompt.style.height = `${Math.min(
      PROMPT_MAX_HEIGHT_PX,
      Math.max(PROMPT_MIN_HEIGHT_PX, measuredHeight)
    )}px`;
  } catch {
    /* Prompt resizing is cosmetic. */
  }
}

function setSectionExpanded(sectionId: (typeof COLLAPSIBLE_SECTIONS)[number], expanded: boolean): void {
  const section = sectionId === "archive" ? $("archivePanel") : $(`${sectionId}Section`);
  const toggle = $(`${sectionId}SectionToggle`);
  const content = $(`${sectionId}SectionContent`);
  if (!section || !toggle || !content) return;

  if (expanded) section.classList.remove("collapsed");
  else section.classList.add("collapsed");
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  content.setAttribute("aria-hidden", expanded ? "false" : "true");

  // A hidden prompt cannot report its wrapped height. Re-measure as soon as it
  // becomes visible so a long prompt restores at the correct height.
  if (expanded && sectionId === "prompt") syncPromptSizer();
}

function setupCollapsibleSections(): void {
  for (const sectionId of COLLAPSIBLE_SECTIONS) {
    const toggle = $(`${sectionId}SectionToggle`);
    if (!toggle) continue;

    const settingName = `section.${sectionId}.expanded`;
    setSectionExpanded(sectionId, loadSetting(settingName, "1") !== "0");
    const toggleSection = () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      setSectionExpanded(sectionId, expanded);
      saveSetting(settingName, expanded ? "1" : "0");
    };
    toggle.addEventListener("click", toggleSection);
    toggle.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.repeat || !["Enter", " ", "Spacebar"].includes(event.key)) return;
      event.preventDefault();
      toggleSection();
    });
  }
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
  updateDescriptionControls();
}

function updateDescriptionControls(): void {
  const busy = running || describing;
  const describeButton = $("describe");
  if (describeButton) {
    const hasInput = refs.length > 0 || (isChecked($("includeSelection")) && hasDescriptionSelection);
    describeButton.disabled = busy || !hasInput;
  }
  const describeModel = $("describeModel");
  if (describeModel) describeModel.disabled = busy;
  const undo = $("undoDescription");
  if (undo) undo.disabled = busy || promptBeforeDescription === null;
}

function setDescriptionBusy(on: boolean): void {
  describing = on;
  const describeButton = $("describe");
  if (describeButton) describeButton.textContent = on ? "Describing…" : "Describe";
  const prompt = $("prompt");
  if (prompt) prompt.disabled = on;
  const generate = $("generate");
  if (generate) generate.disabled = on;
  updateDescriptionControls();
}

async function refreshDescriptionInputAvailability(sequence: number): Promise<void> {
  let hasSelection = false;
  try {
    const selection = await getSelectionBounds();
    hasSelection =
      !!selection && selection.right - selection.left > 1 && selection.bottom - selection.top > 1;
  } catch {
    /* No document or no readable selection means no Photoshop input. */
  }
  if (sequence !== descriptionInputRefreshSequence) return;
  hasDescriptionSelection = hasSelection;
  updateDescriptionControls();
}

function scheduleDescriptionInputRefresh(): void {
  if (descriptionInputRefreshTimer !== null) clearTimeout(descriptionInputRefreshTimer);
  const sequence = ++descriptionInputRefreshSequence;
  descriptionInputRefreshTimer = setTimeout(() => {
    descriptionInputRefreshTimer = null;
    void refreshDescriptionInputAvailability(sequence);
  }, 60);
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

type ModalNoticeKind = "error" | "blocker" | "warning";
type ModalNoticeAction = "primary" | "cancel";

interface ModalNotice {
  kind: ModalNoticeKind;
  title: string;
  message: string;
  instruction?: string;
  primaryLabel: string;
  cancelLabel?: string;
}

let modalNoticeOpen = false;
let modalNoticeKind: ModalNoticeKind | null = null;
let modalNoticeAction: ModalNoticeAction = "cancel";
let modalNoticeListenersReady = false;
let pendingErrorNotice: string | null = null;

function setupModalNoticeListeners(): void {
  if (modalNoticeListenersReady) return;
  const dialog = $("noticeDialog");
  const cancel = $("noticeDialogCancel");
  const primary = $("noticeDialogPrimary");
  if (!dialog || !cancel || !primary) {
    throw new Error("The Mega Musa message dialog is unavailable.");
  }
  cancel.addEventListener("click", () => {
    modalNoticeAction = "cancel";
    dialog.close();
  });
  primary.addEventListener("click", () => {
    modalNoticeAction = "primary";
    dialog.close();
  });
  modalNoticeListenersReady = true;
}

async function showModalNotice(notice: ModalNotice): Promise<ModalNoticeAction> {
  const dialog = $("noticeDialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    throw new Error("The Mega Musa message dialog could not be opened.");
  }

  // A second error should never stack another modal. Replace an open error's
  // copy, or hold the latest error until a compatibility decision is closed.
  if (modalNoticeOpen) {
    if (notice.kind === "error") {
      if (modalNoticeKind === "error") {
        $("noticeDialogMessage").textContent = notice.message;
        $("noticeDialogInstruction").textContent = "";
      } else {
        pendingErrorNotice = notice.message;
      }
      return "cancel";
    }
    throw new Error("Another Mega Musa message is already open.");
  }

  setupModalNoticeListeners();
  $("noticeDialogTitle").textContent = notice.title;
  $("noticeDialogMessage").textContent = notice.message;
  $("noticeDialogInstruction").textContent = notice.instruction || "";
  const cancel = $("noticeDialogCancel");
  cancel.textContent = notice.cancelLabel || "";
  cancel.style.display = notice.cancelLabel ? "" : "none";
  const primary = $("noticeDialogPrimary");
  primary.textContent = notice.primaryLabel;
  primary.setAttribute("variant", notice.kind === "warning" ? "warning" : "primary");
  primary.style.marginLeft = notice.cancelLabel ? "8px" : "0";

  modalNoticeOpen = true;
  modalNoticeKind = notice.kind;
  modalNoticeAction = "cancel";
  try {
    await dialog.showModal({ lockDocumentFocus: true });
    return modalNoticeAction;
  } catch (err: any) {
    // Escape and the window close button mean Close for notices and Cancel for
    // warnings. Neither should create another user-facing error.
    console.log(`[Mega Musa] ${notice.kind} dialog closed:`, err?.message || String(err));
    return "cancel";
  } finally {
    modalNoticeOpen = false;
    modalNoticeKind = null;
    const pending = pendingErrorNotice;
    pendingErrorNotice = null;
    if (pending) setTimeout(() => showErrorNotice(pending), 0);
  }
}

function showErrorNotice(message: string): void {
  void showModalNotice({
    kind: "error",
    title: "Mega Musa error",
    message,
    primaryLabel: "Close",
  }).catch((err: any) => {
    // The red status remains visible if UXP cannot open the modal.
    console.log("[Mega Musa] error dialog failed:", err?.message || String(err));
  });
}

function setStatus(message: string, kind: "info" | "error" | "ok" = "info"): void {
  const el = $("status");
  if (el) el.textContent = message;
  statusKind = kind;
  applyStatusClass();
  if (kind === "error") showErrorNotice(message);
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
  const { total, counts } = budgetText(b || loadBudget());
  const totalEl = $("budgetTotal");
  const countsEl = $("budgetCounts");
  if (totalEl) totalEl.textContent = total;
  if (countsEl) countsEl.textContent = counts;
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith(OPENAI_MODEL_PREFIX);
}

function modelProviderLabel(model: string): string {
  return isOpenAIModel(model) ? "OpenAI" : "Gemini";
}

function pixelSize(width: number, height: number): string {
  return `${width}×${height}`;
}

function ratioDiffers(width: number, height: number, expected: number): boolean {
  return Math.abs(width / height / expected - 1) > RETURNED_RATIO_TOLERANCE;
}

function placementCoversEntireTarget(
  region: Bounds,
  target: Bounds,
  selection: SelectionSnapshot | null
): boolean {
  if (
    region.left !== target.left ||
    region.top !== target.top ||
    region.right !== target.right ||
    region.bottom !== target.bottom
  ) {
    return false;
  }
  if (!selection) return true;
  // Bounding boxes alone are insufficient: an ellipse or feathered selection
  // can touch every target edge while leaving original pixels visible inside it.
  for (let i = 0; i < selection.data.length; i += 1) {
    if (selection.data[i] !== 255) return false;
  }
  return true;
}

function documentModeLabel(mode: any): string {
  const raw = String(mode || "");
  const token = raw.replace(/[\s_-]/g, "").toUpperCase();
  if (token.includes("INDEXED")) return "Indexed Color";
  if (token.includes("MULTICHANNEL")) return "Multichannel";
  if (token.includes("GRAYSCALE") || token === "GRAY") return "Grayscale";
  if (token.includes("DUOTONE")) return "Duotone";
  if (token.includes("BITMAP")) return "Bitmap";
  if (token.includes("CMYK")) return "CMYK";
  if (token.includes("LAB")) return "Lab";
  if (token.includes("RGB")) return "RGB";
  return raw || "Unknown mode";
}

interface DocumentState {
  mode: string;
  profile: string;
  bitsPerChannel: number | null;
  quickMaskMode: boolean;
  fingerprint: string;
}

interface DocumentBlocker {
  title: string;
  message: string;
  instruction: string;
}

function documentBitsPerChannel(value: any): number | null {
  const numeric = Number(value);
  if (numeric === 1 || numeric === 8 || numeric === 16 || numeric === 32) return numeric;

  // UXP exposes enum values such as "eight", "sixteen" and "thirtyTwo".
  // Normalize defensively in case a host includes the enum name in the string.
  const token = String(value ?? "").replace(/[\s_.-]/g, "").toUpperCase();
  if (token.includes("THIRTYTWO")) return 32;
  if (token.includes("SIXTEEN")) return 16;
  if (token.includes("EIGHT")) return 8;
  if (token.endsWith("ONE")) return 1;
  return null;
}

function readDocumentProfile(doc: any): string {
  try {
    return String(doc?.colorProfileName || "None").trim() || "None";
  } catch {
    return "None";
  }
}

function getDocumentState(doc: any): DocumentState {
  const mode = documentModeLabel(doc?.mode);
  const profile = readDocumentProfile(doc);
  let bitsPerChannel: number | null = null;
  let quickMaskMode = false;
  try {
    bitsPerChannel = documentBitsPerChannel(doc?.bitsPerChannel);
  } catch {
    /* An older host may not expose the DOM property. */
  }
  try {
    quickMaskMode = Boolean(doc?.quickMaskMode);
  } catch {
    /* Quick Mask is unavailable on older hosts. */
  }
  return {
    mode,
    profile,
    bitsPerChannel,
    quickMaskMode,
    fingerprint: [Number(doc?.id), mode, profile.toLowerCase(), bitsPerChannel ?? "unknown"].join("|"),
  };
}

function unsupportedModeInstruction(mode: string): string {
  if (mode === "Bitmap" || mode === "Duotone") {
    return (
      "Save a copy, then choose Image > Mode > Grayscale followed by Image > Mode > RGB Color. " +
      `Finally choose Edit > Convert to Profile… and select ${SRGB_PROFILE}.`
    );
  }
  if (mode === "Multichannel") {
    return (
      "Save a copy, then choose Image > Mode > RGB Color. If RGB Color is unavailable, create a new RGB " +
      `document and copy the artwork into it. Finally convert that document to ${SRGB_PROFILE}.`
    );
  }
  return (
    "Save a copy, then choose Image > Mode > RGB Color. " +
    `Finally choose Edit > Convert to Profile… and select ${SRGB_PROFILE}.`
  );
}

function documentBlocker(state: DocumentState): DocumentBlocker | null {
  if (state.quickMaskMode) {
    return {
      title: "Quick Mask is active",
      message: "Mega Musa needs a normal selection to capture and restore the result mask safely.",
      instruction: "Press Q or click Standard Mode at the bottom of the Tools panel, then try again.",
    };
  }
  if (state.bitsPerChannel === 32) {
    return {
      title: "32-bit documents are not supported",
      message:
        "Mega Musa generates 8-bit sRGB images. Placing them in a 32-bit/HDR document can change " +
        "exposure, brightness and color and may cause visible seams.",
      instruction:
        "Choose Image > Mode > 16 Bits/Channel or 8 Bits/Channel, review Photoshop’s HDR conversion, " +
        "then try again.",
    };
  }
  if (["Bitmap", "Indexed Color", "Duotone", "Multichannel"].includes(state.mode)) {
    return {
      title: `${state.mode} documents are not supported`,
      message: `Mega Musa cannot safely place a generated RGB result in a ${state.mode} document.`,
      instruction: unsupportedModeInstruction(state.mode),
    };
  }
  return null;
}

async function showDocumentBlocker(blocker: DocumentBlocker): Promise<void> {
  await showModalNotice({
    kind: "blocker",
    title: blocker.title,
    message: blocker.message,
    instruction: blocker.instruction,
    primaryLabel: "Close",
  });
}

async function confirmDocumentWarning(
  title: string,
  message: string,
  instruction: string
): Promise<boolean> {
  const action = await showModalNotice({
    kind: "warning",
    title,
    message,
    instruction,
    primaryLabel: "Generate Anyway",
    cancelLabel: "Cancel",
  });
  return action === "primary";
}

async function confirm16BitDocument(state: DocumentState): Promise<boolean> {
  if (state.bitsPerChannel !== 16) return true;
  const key = `16-bit|${state.fingerprint}`;
  if (acceptedDocumentWarnings.has(key)) return true;
  const confirmed = await confirmDocumentWarning(
    "16-bit document may lose tonal precision",
    "Mega Musa processes canvas input and generated results at 8 bits per channel. This document uses 16 bits per channel, so the generated area is limited to 8-bit tonal precision and may show banding in smooth gradients.",
    "To avoid this, choose Image > Mode > 8 Bits/Channel."
  );
  if (!confirmed) return false;
  acceptedDocumentWarnings.add(key);
  return true;
}

async function confirmDocumentColorSpace(state: DocumentState): Promise<boolean> {
  const isSrgb = state.mode === "RGB" && state.profile.toLowerCase() === SRGB_PROFILE.toLowerCase();
  if (isSrgb) return true;
  const key = `color|${state.fingerprint}`;
  if (acceptedDocumentWarnings.has(key)) return true;

  const confirmed = await confirmDocumentWarning(
    "Color conversion may cause visible seams",
    `Mega Musa generates images in sRGB. This document uses ${state.mode} / ${state.profile}, so converting only the generated area may change colors along its edges.`,
    `For the best match, choose Edit > Convert to Profile… and select ${SRGB_PROFILE}.`
  );
  if (!confirmed) return false;
  acceptedDocumentWarnings.add(key);
  return true;
}

async function confirmDocumentWarnings(state: DocumentState, coversEntireTarget: boolean): Promise<boolean> {
  if (!(await confirm16BitDocument(state))) return false;
  // A full, opaque result has no internal boundary against the old pixels. The
  // color conversion still applies, but there is no seam for it to reveal.
  if (!coversEntireTarget && !(await confirmDocumentColorSpace(state))) return false;
  return true;
}

// Photoshop stops accepting a layer name past 255 characters.
const MAX_LAYER_NAME = 255;
const MAX_ARCHIVE_LAYER_NAME_DISPLAY = 50;

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

function archivedLayerNameDisplay(layerName: string): string {
  if (layerName.length <= MAX_ARCHIVE_LAYER_NAME_DISPLAY) return layerName;
  return `${layerName.slice(0, MAX_ARCHIVE_LAYER_NAME_DISPLAY - 1).trimEnd()}…`;
}

function hideArchivedGeneration(): void {
  selectedArchive = null;
  const panel = $("archivePanel");
  if (panel) panel.style.display = "none";
}

function archiveDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString();
  } catch {
    return value;
  }
}

function renderArchivedGeneration(
  archive: GenerationArchive,
  layerName: string,
  docId: number,
  layerId: number
): void {
  selectedArchive = { archive, layerName, docId, layerId };
  const panel = $("archivePanel");
  if (panel) panel.style.display = "block";
  $("archiveLayerName").textContent = archivedLayerNameDisplay(layerName);

  const details = [archive.provider, archive.modelLabel || archive.model, archive.ratio];
  if (archive.resolution) {
    details.push(archive.resolution === "auto" ? "Default resolution" : resolutionLabel(archive.resolution));
  }
  // Quality is an OpenAI API control. Gemini's stored "auto" value is only an
  // internal placeholder and must not be presented as a generation setting.
  if (archive.quality && isOpenAIModel(archive.model)) {
    const requestedQuality = imageQualityLabel(normalizeImageQuality(archive.quality));
    const resolvedQuality = archive.resolvedQuality
      ? imageQualityLabel(normalizeImageQuality(archive.resolvedQuality))
      : "";
    details.push(
      archive.quality === "auto" && resolvedQuality && resolvedQuality !== requestedQuality
        ? `${requestedQuality} quality (resolved ${resolvedQuality})`
        : `${requestedQuality} quality`
    );
  }
  $("archiveDetails").textContent = details.join(" · ");

  const sourceParts = [archive.includeSelection ? "Canvas input included" : "Canvas input excluded"];
  if (archive.referenceNames.length) {
    sourceParts.push(`References: ${archive.referenceNames.join(", ")}`);
  } else {
    sourceParts.push("No reference images");
  }
  sourceParts.push(`placed at ${archive.outputWidth}×${archive.outputHeight}`);
  sourceParts.push(`Generated ${archiveDateLabel(archive.createdAt)}`);
  $("archiveSource").textContent = sourceParts.join(" · ");
}

async function refreshArchivedGeneration(): Promise<void> {
  const sequence = ++archiveRefreshSequence;
  let doc: any;
  try {
    doc = getActiveDoc();
  } catch {
    if (sequence === archiveRefreshSequence) hideArchivedGeneration();
    return;
  }

  const activeLayers: any[] = Array.from(doc.activeLayers || []);
  if (activeLayers.length !== 1) {
    if (sequence === archiveRefreshSequence) hideArchivedGeneration();
    return;
  }
  const layer = activeLayers[0];
  const docId = doc.id;
  const layerId = layer.id;
  const archive = await readLayerGenerationArchive(docId, layerId);
  if (sequence !== archiveRefreshSequence) return;

  // A document or layer may have changed while batchPlay was reading. Never
  // render the old layer's metadata under a newer selection.
  try {
    const currentDoc = getActiveDoc();
    const currentLayers: any[] = Array.from(currentDoc.activeLayers || []);
    if (currentDoc.id !== docId || currentLayers.length !== 1 || currentLayers[0].id !== layerId) {
      scheduleArchivedGenerationRefresh();
      return;
    }
  } catch {
    hideArchivedGeneration();
    return;
  }

  if (archive) renderArchivedGeneration(archive, layer.name || "Generated layer", docId, layerId);
  else hideArchivedGeneration();
}

function scheduleArchivedGenerationRefresh(): void {
  if (archiveRefreshTimer !== null) clearTimeout(archiveRefreshTimer);
  archiveRefreshTimer = setTimeout(() => {
    archiveRefreshTimer = null;
    void refreshArchivedGeneration();
  }, 60);
}

async function setupArchivedGenerationTracking(): Promise<void> {
  try {
    await photoshopAction.addNotificationListener(
      ["select", "set", "make", "delete", "open", "close"],
      () => {
        scheduleArchivedGenerationRefresh();
        scheduleDescriptionInputRefresh();
      }
    );
  } catch (err: any) {
    // Manual refresh on panel show, reference changes and after generation still
    // works if an older host cannot register notifications.
    console.log("[Mega Musa] could not watch Photoshop input:", err?.message || err);
  }
  scheduleArchivedGenerationRefresh();
  scheduleDescriptionInputRefresh();
}

async function onCopyArchivedPrompt(): Promise<void> {
  if (!selectedArchive) return;
  try {
    const clipboard: any = (navigator as any).clipboard;
    if (typeof clipboard?.writeText === "function") {
      await clipboard.writeText(selectedArchive.archive.prompt);
    } else if (typeof clipboard?.setContent === "function") {
      await clipboard.setContent({ "text/plain": selectedArchive.archive.prompt });
    } else {
      throw new Error("Clipboard access is unavailable in this Photoshop version.");
    }
    setStatus("Archived prompt copied to the clipboard.", "ok");
  } catch (err: any) {
    const message = err?.message || String(err);
    setStatus(
      /manifest version|clipboard access not supported/i.test(message)
        ? "Photoshop is still using Mega Musa’s old manifest. Remove the plugin from UXP Developer Tool, add dist/manifest.json again, then reload it."
        : "Could not copy the archived prompt: " + message,
      "error"
    );
  }
}

async function onLoadArchivedSettings(): Promise<void> {
  if (!selectedArchive) return;
  const selected = selectedArchive;
  const archive = selected.archive;
  const promptField = $("prompt");
  setValueSafe(promptField, archive.prompt);
  try {
    promptField?.dispatchEvent(new Event("input"));
  } catch {
    /* Prompt resizing is cosmetic. */
  }
  setCheckedSafe($("includeSelection"), archive.includeSelection);
  saveSetting("includeSelection", archive.includeSelection ? "1" : "0");
  updateDescriptionControls();
  scheduleDescriptionInputRefresh();

  const messages: string[] = [];
  if (hasOption($("model"), archive.model)) {
    setPickerSafe($("model"), archive.model);
    saveSetting("model", archive.model);
    const capabilityNote = applyModelCapabilities(
      archive.model,
      archive.ratio,
      archive.resolution,
      archive.quality
    );
    if (capabilityNote) messages.push(capabilityNote);
  } else {
    messages.push(`${archive.modelLabel || archive.model} is not available in this version, so the current model was kept.`);
  }
  if (archive.references === undefined) {
    if (archive.referenceNames.length) {
      messages.push("This Stage 1 record stores reference names only, so its images could not be loaded.");
    }
    setStatus(["Archived prompt and available settings loaded.", ...messages].join(" "), "ok");
    return;
  }

  if (!archive.references.length && !archive.referenceNames.length) {
    refs = [];
    renderThumbs();
    messages.push("The reference list was cleared because this generation used no references.");
    setStatus(["Archived prompt and available settings loaded.", ...messages].join(" "), "ok");
    return;
  }

  setStatus("Archived prompt and settings loaded. Restoring embedded references…");
  try {
    const restored = await restoreReferenceAssets(
      selected.docId,
      archive.references,
      selected.layerId
    );
    refs = restored.images.slice(0, MAX_REFS);
    renderThumbs();

    const neverEmbedded = Math.max(0, archive.referenceNames.length - archive.references.length);
    const unavailable = neverEmbedded + restored.missing.length + restored.failures.length;
    messages.push(
      `${refs.length} embedded reference image${refs.length === 1 ? "" : "s"} restored.`
    );
    if (unavailable) {
      messages.push(
        `${unavailable} reference image${unavailable === 1 ? " is" : "s are"} missing or unreadable; the prompt and settings were still loaded.`
      );
    }
    setStatus(
      ["Archived prompt and available settings loaded.", ...messages].join(" "),
      unavailable ? "error" : "ok"
    );
  } catch (err: any) {
    setStatus(
      [
        "Archived prompt and available settings loaded.",
        ...messages,
        "Embedded references could not be restored: " + (err?.message || String(err)),
      ].join(" "),
      "error"
    );
  }
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
    img.src = ref.thumbnailDataUrl || ref.dataUrl;
    img.title = ref.name;
    if (dropWebviewReady && ref.mimeType === "image/webp" && !ref.thumbnailDataUrl) {
      void ensureReferenceThumbnail(ref)
        .then((dataUrl) => {
          img.src = dataUrl;
        })
        .catch((err: any) => {
          console.log("[Mega Musa] WebP thumbnail failed:", err?.message || String(err));
        });
    }
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
  updateDescriptionControls();
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

interface RequestReference {
  mimeType: string;
  base64: string;
}

interface PendingReferenceResize {
  name: string;
  maxEdge: number;
  logDimensions: boolean;
  chunks: string[];
  totalChunks: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (image: RequestReference) => void;
  reject: (error: Error) => void;
}

const dropBatches = new Map<string, DropBatchState>();
const pendingDropFiles = new Map<string, PendingDropFile>();
const pendingReferenceResizes = new Map<string, PendingReferenceResize>();
let dropWebviewReady = false;
let dropTheme = "";
let referenceResizeSequence = 0;

// How often the Photoshop theme is re-read. UXP fires no event when the user
// switches it, so the panel restyles itself through CSS while the WebView would
// keep painting the old colours until something tells it otherwise.
const THEME_POLL_MS = 2000;

function safeCount(value: any): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function postToDropWebview(message: Record<string, unknown>): boolean {
  const webview = $("dropWebview");
  if (!dropWebviewReady || !webview || typeof webview.postMessage !== "function") return false;
  try {
    webview.postMessage({ channel: DROP_CHANNEL, ...message });
    return true;
  } catch {
    /* The WebView may still be loading; its ready message retries this. */
    return false;
  }
}

function failReferenceResize(requestId: string, error: Error): void {
  const pending = pendingReferenceResizes.get(requestId);
  if (!pending) return;
  pendingReferenceResizes.delete(requestId);
  clearTimeout(pending.timer);
  pending.reject(error);
}

function onReferenceResizeMessage(message: any): boolean {
  if (!String(message.type || "").startsWith("resize-result") && message.type !== "resize-error") {
    return false;
  }
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  const pending = pendingReferenceResizes.get(requestId);
  if (!pending) return true;

  if (message.type === "resize-error") {
    failReferenceResize(
      requestId,
      new Error(message.message || `Could not prepare reference image “${pending.name}”.`)
    );
    return true;
  }
  if (message.type === "resize-result-start") {
    const totalChunks = safeCount(message.totalChunks);
    const width = safeCount(message.width);
    const height = safeCount(message.height);
    if (!totalChunks || totalChunks > 100000 || !width || !height || Math.max(width, height) > pending.maxEdge) {
      failReferenceResize(requestId, new Error(`Invalid resized data for “${pending.name}”.`));
      return true;
    }
    if (pending.logDimensions) {
      console.log(
        "[Mega Musa]",
        `reference ${pending.name}: ${safeCount(message.sourceWidth)}x${safeCount(message.sourceHeight)} -> ${width}x${height}`
      );
    }
    pending.totalChunks = totalChunks;
    pending.chunks = new Array(totalChunks);
    return true;
  }
  if (message.type === "resize-result-chunk") {
    const index = Number(message.index);
    if (
      !pending.totalChunks ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= pending.totalChunks ||
      typeof message.data !== "string" ||
      message.data.length > MAX_DROP_CHUNK_LENGTH
    ) {
      failReferenceResize(requestId, new Error(`Invalid resized data for “${pending.name}”.`));
      return true;
    }
    pending.chunks[index] = message.data;
    return true;
  }

  if (message.type !== "resize-result-end") return true;
  if (!pending.totalChunks) {
    failReferenceResize(requestId, new Error(`Incomplete resized data for “${pending.name}”.`));
    return true;
  }
  for (let index = 0; index < pending.totalChunks; index += 1) {
    if (typeof pending.chunks[index] !== "string") {
      failReferenceResize(requestId, new Error(`Incomplete resized data for “${pending.name}”.`));
      return true;
    }
  }
  const image = referenceImageFromBase64(pending.name, pending.chunks.join(""));
  if (!image) {
    failReferenceResize(requestId, new Error(`The resized data for “${pending.name}” is not an image.`));
    return true;
  }
  pendingReferenceResizes.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve({ mimeType: image.mimeType, base64: image.base64 });
  return true;
}

function resizeReference(
  ref: RefImage,
  maxEdge: number,
  forcePng = false,
  logDimensions = true,
  normalizeSrgb = true
): Promise<RequestReference> {
  if (!dropWebviewReady) {
    return Promise.reject(new Error("The image processor is not ready. Close and reopen the Mega Musa panel."));
  }
  const requestId = `resize-${Date.now().toString(36)}-${referenceResizeSequence++}`;
  const totalChunks = Math.ceil(ref.base64.length / WEBVIEW_CHUNK_SIZE);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      failReferenceResize(requestId, new Error(`Timed out preparing reference image “${ref.name}”.`));
    }, REFERENCE_RESIZE_TIMEOUT_MS);
    pendingReferenceResizes.set(requestId, {
      name: ref.name,
      maxEdge,
      logDimensions,
      chunks: [],
      totalChunks: 0,
      timer,
      resolve,
      reject,
    });

    if (!postToDropWebview({
      type: "resize-start",
      requestId,
      mimeType: ref.mimeType,
      maxEdge,
      forcePng,
      normalizeSrgb,
      totalChunks,
    })) {
      failReferenceResize(requestId, new Error(`Could not prepare reference image “${ref.name}”.`));
      return;
    }
    for (let index = 0; index < totalChunks; index += 1) {
      if (!postToDropWebview({
        type: "resize-chunk",
        requestId,
        index,
        data: ref.base64.slice(index * WEBVIEW_CHUNK_SIZE, (index + 1) * WEBVIEW_CHUNK_SIZE),
      })) {
        failReferenceResize(requestId, new Error(`Could not prepare reference image “${ref.name}”.`));
        return;
      }
    }
    if (!postToDropWebview({ type: "resize-end", requestId })) {
      failReferenceResize(requestId, new Error(`Could not prepare reference image “${ref.name}”.`));
    }
  });
}

function ensureReferenceThumbnail(ref: RefImage): Promise<string> {
  if (ref.thumbnailDataUrl) return Promise.resolve(ref.thumbnailDataUrl);
  const existing = pendingReferenceThumbnails.get(ref);
  if (existing) return existing;

  const pending = resizeReference(ref, REFERENCE_THUMBNAIL_MAX_EDGE, true, false)
    .then((image) => {
      const dataUrl = `data:${image.mimeType};base64,${image.base64}`;
      ref.thumbnailDataUrl = dataUrl;
      return dataUrl;
    })
    .finally(() => pendingReferenceThumbnails.delete(ref));
  pendingReferenceThumbnails.set(ref, pending);
  return pending;
}

function syncDropCapacity(): void {
  postToDropWebview({ type: "capacity", remaining: MAX_REFS - refs.length });
}

// Photoshop's Interface theme reaches the panel as CSS only, so #themeProbe in
// index.html restates it as a colour this can read: white under the dark themes,
// black under the light ones. Everything unexpected — no probe, a runtime without
// the prefers-color-scheme mapping or without getComputedStyle — counts as dark,
// Photoshop's default. This runs on a timer, so it must never throw: the panel's
// global error handler would otherwise overwrite the status line every tick.
function panelTheme(): "dark" | "light" {
  try {
    const probe = $("themeProbe");
    const color = probe ? String(getComputedStyle(probe).color || "") : "";
    // Black in any notation means the light-theme rule won.
    return /^(#000(000)?$|rgba?\(\s*0\s*,\s*0\s*,\s*0\b)/.test(color.trim().toLowerCase())
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

// The drop target is a real system WebView: left alone it follows the macOS
// appearance rather than Photoshop's theme. Push the panel's theme across the
// bridge so it matches the rest of the panel instead.
function syncDropTheme(force = false): void {
  const theme = panelTheme();
  if (theme === dropTheme && !force) return;
  dropTheme = theme;
  postToDropWebview({ type: "theme", theme });
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
    // Forced: a fresh page starts on its built-in default, so it needs the theme
    // even when nothing has changed since the last time it was sent.
    syncDropTheme(true);
    if (refs.some((ref) => ref.mimeType === "image/webp" && !ref.thumbnailDataUrl)) renderThumbs();
    return;
  }
  if (message.type === "drop-error") {
    setStatus(message.message || "That drop did not contain readable files.", "error");
    return;
  }
  if (onReferenceResizeMessage(message)) return;

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
    syncDropTheme(true);
    if (refs.some((ref) => ref.mimeType === "image/webp" && !ref.thumbnailDataUrl)) renderThumbs();
  });
  webview.addEventListener("loaderror", () => {
    dropWebviewReady = false;
    for (const requestId of Array.from(pendingReferenceResizes.keys())) {
      failReferenceResize(requestId, new Error("The image processor stopped while preparing references."));
    }
    setStatus("Drag-and-drop could not load. Add Files and Paste still work.", "error");
  });
  // Nothing announces a theme switch, so the panel watches for one itself. The
  // check is a single getComputedStyle read and only posts when the theme has
  // actually changed, so it stays idle in the normal case.
  setInterval(() => syncDropTheme(), THEME_POLL_MS);
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

interface PreparedDescriptionInput {
  source: string;
  image: RequestReference;
}

function selectedDescriptionModel(): DescriptionModelSpec | null {
  return descriptionModelSpec($("describeModel")?.value || "");
}

function descriptionApiKey(model: DescriptionModelSpec): string {
  return String(model.provider === "openai" ? $("openaiApiKey")?.value || "" : $("geminiApiKey")?.value || "").trim();
}

async function prepareDescriptionInputs(): Promise<PreparedDescriptionInput[]> {
  const inputs: PreparedDescriptionInput[] = [];
  const includeSelection = isChecked($("includeSelection"));
  const descriptionRefs = refs.slice();

  if (includeSelection) {
    let rawSelection: Bounds | null = null;
    try {
      rawSelection = await getSelectionBounds();
    } catch {
      /* References can still be described without an open Photoshop document. */
    }
    const hasSelection =
      !!rawSelection && rawSelection.right - rawSelection.left > 1 && rawSelection.bottom - rawSelection.top > 1;
    if (hasSelection) {
      setStatus("Reading Photoshop selection for description…");
      const doc = getActiveDoc();
      const documentBounds: Bounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
      const activeArtboard = await getActiveArtboard(doc);
      const targetBounds = activeArtboard?.bounds || documentBounds;
      const region = intersectBounds(rawSelection as Bounds, targetBounds);
      if (!region) {
        throw new Error(
          activeArtboard
            ? `The selection does not overlap the active artboard “${activeArtboard.name}”.`
            : "The selection does not overlap the Photoshop document."
        );
      }

      const read = await readRegion(doc.id, region, false, DESCRIPTION_INPUT_MAX_EDGE);
      const png = encodePng(read.image.data, read.image.width, read.image.height, read.image.components);
      inputs.push({
        source: "Photoshop selection",
        image: { mimeType: "image/png", base64: bytesToBase64(png) },
      });
      console.log("[Mega Musa] description", read.debug);
    }
  }

  for (let index = 0; index < descriptionRefs.length; index += 1) {
    const reference = descriptionRefs[index];
    setStatus(`Preparing reference image ${index + 1}/${descriptionRefs.length} for description…`);
    inputs.push({
      source: `Reference ${index + 1}: ${reference.name}`,
      image: await resizeReference(reference, DESCRIPTION_INPUT_MAX_EDGE),
    });
  }
  return inputs;
}

function formatDescriptions(inputs: PreparedDescriptionInput[], descriptions: string[]): string {
  if (descriptions.length === 1) return descriptions[0].trim();
  return descriptions
    .map((description, index) => `Image ${index + 1} — ${inputs[index].source}\n${description.trim()}`)
    .join("\n\n");
}

function descriptionUsageText(totalTokens?: number, reasoningTokens?: number): string {
  if (totalTokens === undefined) return "";
  const reasoning = reasoningTokens ? `, including ${Math.round(reasoningTokens)} reasoning tokens` : "";
  return ` (${Math.round(totalTokens)} tokens${reasoning})`;
}

async function onDescribe(): Promise<void> {
  if (running || describing) return;
  if (!(refs.length > 0 || (isChecked($("includeSelection")) && hasDescriptionSelection))) {
    setStatus("Add a reference image or draw and include a Photoshop selection.", "error");
    return;
  }
  const model = selectedDescriptionModel();
  if (!model) {
    setStatus("Choose a description model.", "error");
    return;
  }
  const apiKey = descriptionApiKey(model);
  if (!apiKey) {
    setStatus(`Enter your ${model.provider === "openai" ? "OpenAI" : "Gemini"} API key and press Save.`, "error");
    return;
  }

  setDescriptionBusy(true);
  setBusy(true);
  setStatus("Preparing inputs for description…");
  try {
    const inputs = await prepareDescriptionInputs();
    if (!inputs.length) {
      throw new Error("Add a reference image or draw and include a Photoshop selection.");
    }

    setStatus(`Describing ${inputs.length} visual input${inputs.length === 1 ? "" : "s"} with ${model.label}… (10–90s)`);
    const result = await describeImages({
      apiKey,
      model,
      images: inputs.map((input) => input.image),
    });
    const prompt = $("prompt");
    promptBeforeDescription = String(prompt?.value || "");
    setValueSafe(prompt, formatDescriptions(inputs, result.descriptions));
    try {
      prompt?.dispatchEvent(new Event("input"));
    } catch {
      /* Prompt resizing is cosmetic. */
    }
    updateDescriptionControls();
    setStatus(
      `Prompt filled from ${inputs.length} visual input${inputs.length === 1 ? "" : "s"} with ${model.label}${descriptionUsageText(
        result.usage?.totalTokens,
        result.usage?.reasoningTokens
      )}.`,
      "ok"
    );
  } catch (error: any) {
    setStatus("Description error: " + (error?.message || String(error)), "error");
  } finally {
    setDescriptionBusy(false);
    setBusy(false);
  }
}

function onUndoDescription(): void {
  if (promptBeforeDescription === null || running || describing) return;
  const prompt = $("prompt");
  setValueSafe(prompt, promptBeforeDescription);
  promptBeforeDescription = null;
  try {
    prompt?.dispatchEvent(new Event("input"));
  } catch {
    /* Prompt resizing is cosmetic. */
  }
  updateDescriptionControls();
  setStatus("Previous prompt restored.", "ok");
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

  let doc: any;
  let documentState: DocumentState;
  try {
    doc = getActiveDoc();
    documentState = getDocumentState(doc);
    const blocker = documentBlocker(documentState);
    if (blocker) {
      await showDocumentBlocker(blocker);
      setStatus("Generation blocked before anything was sent — nothing was charged.");
      return;
    }
  } catch (err: any) {
    setStatus("Error: " + (err?.message || String(err)), "error");
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
  // Freeze the reference set for this run so the request and its archive still
  // agree if the user edits the thumbnail list while the provider is working.
  const generationRefs = refs.slice();

  // Once the request is out the provider bills it whatever happens next, so the
  // estimate is frozen at that moment for the cancel path to charge.
  let requestSent = false;
  let sentCharge: number | null = null;
  try {
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
    const isRegion = !!sel;

    // Region edit: crop to exactly the selection, so the model spends its full
    // resolution on the detail. No context margin is added around it — how much
    // surrounding image the model gets to blend into, and how soft the edge is,
    // are the user's to decide by drawing (and feathering) the selection. In an
    // artboard document, output framing never escapes the active artboard.
    const baseRegion: Bounds = isRegion ? (sel as Bounds) : targetBounds;
    const baseW = baseRegion.right - baseRegion.left;
    const baseH = baseRegion.bottom - baseRegion.top;

    // Resolve the menu label and exact provider output shape once, then fit the
    // crop to that shape. An existing selection is not modified, so a lasso,
    // ellipse or feathered selection still survives as the result's layer mask.
    const frame = outputFrame(spec, resolution, baseW, baseH);
    const ratioLabel = frame.label;
    const region = fitRegionToRatio(baseRegion, frame.ratio, targetBounds);
    setPickerSafe($("selRatio"), ratioLabel);
    saveSetting("selRatio", ratioLabel);
    refreshResolutionLabels();
    const cropW = region.right - region.left;
    const cropH = region.bottom - region.top;

    if (isRegion) setStatus("Capturing selection…");
    let selectionSnapshot: SelectionSnapshot | null = isRegion ? await captureSelection(docId, region) : null;
    const coversEntireTarget = placementCoversEntireTarget(region, targetBounds, selectionSnapshot);
    if (!(await confirmDocumentWarnings(documentState, coversEntireTarget))) {
      setStatus("Cancelled before anything was sent — nothing was charged.");
      return;
    }

    running = true;
    cancelRequested = false;
    cancelInFlight = null;
    // Geometry checks and compatibility dialogs above are preflight. The button
    // becomes Cancel only once the actual generation run begins.
    setGenerateButton("cancel");
    setBusy(true);

    const openaiDimensions = frame.openaiSize?.split("x").map(Number) || [];
    const exactOutputSize =
      openaiDimensions.length === 2 && openaiDimensions.every(Number.isFinite)
        ? pixelSize(openaiDimensions[0], openaiDimensions[1])
        : "";
    const [pickerRatioW, pickerRatioH] = ratioLabel.split(":").map(Number);
    const pickerIsApproximate =
      !!exactOutputSize &&
      openaiDimensions[0] * pickerRatioH !== openaiDimensions[1] * pickerRatioW;
    const tierLongEdge: Record<string, number> = {
      "512px": 512,
      "1K": 1024,
      "2K": 2048,
      "4K": 4096,
    };
    const outputLongEdge = openaiDimensions.length === 2
      ? Math.max(openaiDimensions[0], openaiDimensions[1])
      : tierLongEdge[resolution] || 1024;
    const requestMaxEdge = Math.max(REQUEST_MIN_MAX_EDGE, outputLongEdge);

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
      // Keep the fitted rectangle as an overflow mask source. It is used only
      // when an unexpected provider ratio makes the native Smart Object extend
      // outside this region; normal full-frame results need no extra mask.
      selectionSnapshot = await captureSelection(docId, region);
      const cropped = cropW !== targetW || cropH !== targetH;
      const what = includeSelection ? "what was sent" : "where the result lands";
      const targetName = activeArtboard ? `active artboard “${activeArtboard.name}”` : "the full image";
      if (cropped) {
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
    const outputFrameNote = exactOutputSize
      ? `${exactOutputSize}${pickerIsApproximate ? `; picker shows nearest ratio ${ratioLabel}` : ""}`
      : `${ratioLabel} at ${resolution === "auto" ? "default resolution" : resolutionLabel(resolution)}`;
    if (isRegion) {
      notes.push(`Region edit — output request: ${outputFrameNote}; result stays clipped to your selection.`);
    } else if (exactOutputSize) {
      notes.push(`Output request: ${outputFrameNote}.`);
    }
    if (!includeSelection) {
      notes.push(
        generationRefs.length
          ? `“Include Photoshop selection” is off — generating from the prompt and ${generationRefs.length} reference image${generationRefs.length === 1 ? "" : "s"} only.`
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
      const read = await readRegion(docId, region, false, requestMaxEdge);
      if (Math.max(read.image.width, read.image.height) > requestMaxEdge) {
        throw new Error("Photoshop returned a canvas input larger than the request limit.");
      }
      basePng = encodePng(read.image.data, read.image.width, read.image.height, read.image.components);
      console.log("[Mega Musa]", read.debug);
    }

    const requestReferences: RequestReference[] = [];
    for (let index = 0; index < generationRefs.length; index += 1) {
      throwIfCancelled();
      setStatus(`Preparing reference image ${index + 1}/${generationRefs.length}…`);
      requestReferences.push(await resizeReference(generationRefs[index], requestMaxEdge));
    }

    const sizeLabel = frame.geminiAspect ?? frame.openaiSize ?? "auto";
    const modeLabel = includeSelection
      ? "editing the canvas"
      : generationRefs.length
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
      references: requestReferences,
    };
    const controller = newAbortController();
    sentCharge = estimatedCHF(spec, resolution, frame.openaiSize, quality);
    requestSent = true;
    const request = isOpenAIModel(model)
      ? generateOpenAIImage({ ...baseReq, size: frame.openaiSize as string, quality, signal: controller.signal })
      : generateEdit({
          ...baseReq,
          aspectRatio: frame.geminiAspect,
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
    const returnedSize = pixelSize(decoded.width, decoded.height);
    const returnedRatioDiffers = ratioDiffers(decoded.width, decoded.height, frame.ratio);
    const returnedSizeDiffers =
      !!exactOutputSize &&
      (decoded.width !== openaiDimensions[0] || decoded.height !== openaiDimensions[1]);
    if (returnedRatioDiffers) {
      notes.push(
        exactOutputSize
          ? `Provider returned ${returnedSize} instead of ${exactOutputSize}. It is cover-fitted without stretching.`
          : `Provider returned ${returnedSize} instead of the requested ${ratioLabel} frame. It is cover-fitted without stretching.`
      );
    } else if (returnedSizeDiffers) {
      notes.push(`Provider returned ${returnedSize} instead of ${exactOutputSize}. It is transformed to fit without stretching.`);
    }
    if (returnedRatioDiffers || returnedSizeDiffers) {
      setNote([notes.join(" "), usageDetails.join("; ")].filter(Boolean).join(" "));
    }
    const rgba = toRGBA(decoded.data, decoded.width, decoded.height, decoded.channels);

    setStatus("Placing result…");
    // What produced this layer, for the bracketed tail of its name. The OpenAI
    // models return one fixed size, so their exact output is more use than the
    // requested tier; the Gemini models frame to a ratio, so there the tier is
    // the resolution. A model with no resolution control contributes neither.
    const layerDetails: string[] = [modelNameWithoutYear(spec.label)];
    const resolutionDetail = frame.openaiSize || (spec.imageSizes.length ? resolutionLabel(resolution) : "");
    if (resolutionDetail) layerDetails.push(resolutionDetail);
    if (resolvedQuality) layerDetails.push(`${imageQualityLabel(resolvedQuality)} quality`);
    const archive: GenerationArchive = {
      v: 1,
      prompt,
      provider,
      model,
      modelLabel: spec.label,
      resolution,
      ratio: ratioLabel,
      quality,
      resolvedQuality,
      includeSelection,
      referenceNames: generationRefs.map((reference) => reference.name),
      requestedSize: exactOutputSize || outputFrameNote,
      outputWidth: cropW,
      outputHeight: cropH,
      createdAt: new Date().toISOString(),
    };
    const placement = await placeResult(
      docId,
      region,
      rgba,
      decoded.width,
      decoded.height,
      resultLayerName(prompt, layerDetails),
      selectionSnapshot,
      !isRegion,
      archive,
      generationRefs
    );
    scheduleArchivedGenerationRefresh();

    if (placement.smartObject) {
      notes.push(
        `The complete native ${returnedSize} result is embedded for nondestructive scaling${returnedRatioDiffers ? "; unlink its mask to reframe inside the fixed target" : ""}.`
      );
      setNote([notes.join(" "), usageDetails.join("; ")].filter(Boolean).join(" "));
    }

    const doneMessage = isRegion
      ? placement.clip === "alpha"
        ? "Done — raster fallback clipped to the selection captured at the start with baked transparency."
        : placement.smartObject
          ? "Done — native result embedded as a Smart Object with an editable linked mask."
          : "Done — raster fallback clipped to your selection with an editable mask."
      : activeArtboard
        ? placement.smartObject
          ? `Done — native result embedded in active artboard “${activeArtboard.name}” as a Smart Object.`
          : `Done — result added to active artboard “${activeArtboard.name}” as a raster layer.`
        : placement.smartObject
          ? "Done — native full-image result embedded as a Smart Object."
          : "Done — full-image result added as a raster layer.";
    const archiveMessages: string[] = [];
    if (!placement.smartObject) {
      archiveMessages.push("Smart Object placement failed; the paid result was preserved as a raster layer.");
    }
    if (!placement.archiveSaved) archiveMessages.push("Prompt archive could not be saved; see the console.");
    if (placement.referenceArchiveFailures) {
      archiveMessages.push(
        `${placement.referenceArchiveFailures} reference image${placement.referenceArchiveFailures === 1 ? " was" : "s were"} not embedded; see the console.`
      );
    }
    const archivedMessage = archiveMessages.length ? ` ${archiveMessages.join(" ")}` : "";
    const completedMessage = usageDetails.length
      ? `${doneMessage} (${usageDetails.join(", ")}).${archivedMessage}`
      : `${doneMessage}${archivedMessage}`;
    setStatus(completedMessage, "ok");
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
  // Keep the capability table intact while exposing only the requested picker entries.
  const visibleModels = MODELS.filter((model) =>
    ["gemini-3-pro-image", "gemini-3.1-flash-image", "openai:gpt-image-2"].includes(model.id)
  );
  buildMenu(
    "model",
    visibleModels.map((m) => ({ value: m.id, label: m.label })),
    DEFAULT_MODEL
  );
}

function preferredDescriptionModel(): string {
  const hasOpenAIKey = String($("openaiApiKey")?.value || "").trim().length > 0;
  const hasGeminiKey = String($("geminiApiKey")?.value || "").trim().length > 0;
  if (hasOpenAIKey) return DEFAULT_OPENAI_DESCRIPTION_MODEL;
  if (hasGeminiKey) return DEFAULT_GEMINI_DESCRIPTION_MODEL;
  return DEFAULT_OPENAI_DESCRIPTION_MODEL;
}

function refreshDescriptionModelSelection(): void {
  const stored = loadSetting("describeModel", "");
  const storedSpec = descriptionModelSpec(stored);
  const selected = storedSpec && descriptionApiKey(storedSpec) ? stored : preferredDescriptionModel();
  buildMenu(
    "describeModel",
    DESCRIPTION_MODELS.map((model) => ({ value: model.id, label: model.label })),
    selected
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
    await setRectSelection(fitRegionToRatio(targetSelection, rw / rh, limit));
    setStatus(`Selection fitted to ${v} — preview the shape, then Generate.`, "ok");
  } catch (err: any) {
    setStatus("Couldn't fit selection: " + (err?.message || String(err)), "error");
  }
}

// "Fit to nearest aspect ratio" — detect the closest official ratio to the
// current selection, set it in the dropdown, and fit the selection to it.
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
    const spec = modelSpec($("model")?.value || DEFAULT_MODEL);
    const resolution = nearestImageSize($("resolution")?.value || "auto", spec);
    const frame = outputFrame(
      spec,
      resolution,
      targetSelection.right - targetSelection.left,
      targetSelection.bottom - targetSelection.top
    );
    setPickerSafe($("selRatio"), frame.label);
    saveSetting("selRatio", frame.label);
    refreshResolutionLabels();
    await setRectSelection(fitRegionToRatio(targetSelection, frame.ratio, limit));
    setStatus(`Fitted to nearest ratio: ${frame.label}.`, "ok");
  } catch (err: any) {
    setStatus("Couldn't fit selection: " + (err?.message || String(err)), "error");
  }
}

async function restoreSettings(): Promise<void> {
  setValueSafe($("geminiApiKey"), await loadApiKey());
  setValueSafe($("openaiApiKey"), await loadOpenAIApiKey());
  refreshDescriptionModelSelection();
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
  $("includeSelection")?.addEventListener("change", () => {
    saveSetting("includeSelection", isChecked($("includeSelection")) ? "1" : "0");
    updateDescriptionControls();
    scheduleDescriptionInputRefresh();
  });
  $("describeModel")?.addEventListener("change", () =>
    saveSetting("describeModel", $("describeModel").value || DEFAULT_OPENAI_DESCRIPTION_MODEL)
  );
}

async function init(): Promise<void> {
  try {
    // Register the panel entrypoint declared in manifest.json.
    entrypoints.setup({
      panels: {
        nbpEditorPanel: {
          show() {
            scheduleArchivedGenerationRefresh();
            scheduleDescriptionInputRefresh();
          },
        },
      },
    });
    setupCollapsibleSections();

    $("saveGeminiKey").addEventListener("click", async () => {
      const apiKey = ($("geminiApiKey").value || "").trim();
      try {
        await saveApiKey(apiKey);
        refreshDescriptionModelSelection();
        setStatus(apiKey ? "Gemini API key saved securely." : "Gemini API key cleared.", "ok");
      } catch (err: any) {
        setStatus("Could not save Gemini API key: " + (err?.message || String(err)), "error");
      }
    });
    $("saveOpenAIKey").addEventListener("click", async () => {
      const apiKey = ($("openaiApiKey").value || "").trim();
      try {
        await saveOpenAIApiKey(apiKey);
        refreshDescriptionModelSelection();
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
    $("describe").addEventListener("click", onDescribe);
    $("undoDescription").addEventListener("click", onUndoDescription);
    $("copyArchivedPrompt").addEventListener("click", onCopyArchivedPrompt);
    $("loadArchivedSettings").addEventListener("click", onLoadArchivedSettings);
    await setupArchivedGenerationTracking();
    $("fitSelection").addEventListener("click", onFitSelection);
    $("fitNearest").addEventListener("click", onFitNearest);
    $("resetBudget").addEventListener("click", () => {
      renderBudget(resetBudget());
      setStatus("Budget counter reset — counting from today.", "ok");
    });

    // Re-measure on edits and panel resizing because both can change wrapping.
    $("prompt").addEventListener("input", syncPromptSizer);
    window.addEventListener("resize", syncPromptSizer);
    syncPromptSizer();

    // The prompt is multiline, so unmodified Return inserts a line break.
    // Cmd+Return on macOS or Ctrl+Return on Windows fires Generate. Ignore the
    // shortcut mid-composition so an IME candidate can still be confirmed.
    $("prompt").addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Return") return;
      if ((e as any).isComposing) return;
      if (!(e.metaKey || e.ctrlKey)) return;
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
