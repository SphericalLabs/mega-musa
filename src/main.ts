import "./polyfills"; // must be first: defines TextEncoder/TextDecoder for fast-png
import {
  getActiveDoc,
  getSelectionBounds,
  padBounds,
  readRegion,
  placeResult,
  setRectSelection,
  Bounds,
} from "./photoshop-bridge";
import { encodePng, decodeImage, toRGBA, coverResampleRGBA, applyAlphaMask } from "./image-codec";
import { generateEdit, nearestSupportedAspectRatio, aspectRatioInfo } from "./gemini";
import { generateOpenAIEdit, OPENAI_MODEL_PREFIX } from "./openai";
import { pickReferenceImages, RefImage } from "./references";
import {
  loadApiKey,
  saveApiKey,
  loadOpenAIApiKey,
  saveOpenAIApiKey,
  loadSetting,
  saveSetting,
} from "./storage";

const { entrypoints } = require("uxp");

const MAX_REFS = 10;
const PICKERS = ["model", "resolution", "selRatio"];

let refs: RefImage[] = [];
let running = false;

function $(id: string): any {
  return document.getElementById(id);
}

function setStatus(message: string, kind: "info" | "error" | "ok" = "info"): void {
  const el = $("status");
  if (!el) return;
  el.textContent = message;
  el.className = kind === "info" ? "" : kind;
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith(OPENAI_MODEL_PREFIX);
}

function modelProviderLabel(model: string): string {
  return isOpenAIModel(model) ? "OpenAI" : "Gemini";
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
    const remove = document.createElement("sp-action-button");
    remove.setAttribute("quiet", "");
    remove.setAttribute("size", "s");
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

async function onGenerate(): Promise<void> {
  if (running) return;
  setStatus("Starting…"); // immediate feedback that the click was received

  const prompt = ($("prompt").value || "").trim();
  const model = $("model").value || "gemini-3-pro-image";
  const provider = modelProviderLabel(model);
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

  const resolution = $("resolution").value || "auto";

  running = true;
  $("generate").disabled = true;
  try {
    const doc = getActiveDoc();
    const docId: number = doc.id;
    const docW: number = doc.width;
    const docH: number = doc.height;

    let sel = await getSelectionBounds();
    // If the selection isn't already an official ratio, fit it to the nearest one
    // (and reflect that in the dropdown) so the crop matches a supported output
    // ratio exactly. A selection already on-ratio (e.g. via Fit selection) is
    // kept as-is, so an explicit ratio choice is honored.
    if (sel && sel.right - sel.left > 1 && sel.bottom - sel.top > 1) {
      const info = aspectRatioInfo(sel.right - sel.left, sel.bottom - sel.top);
      if (info.logDistance > 0.015) {
        setPickerSafe($("selRatio"), info.label);
        saveSetting("selRatio", info.label);
        const [rw, rh] = info.label.split(":").map(Number);
        sel = ratioRect(sel, rw / rh, docW, docH);
        await setRectSelection(sel);
      }
    }
    const isRegion = !!sel && sel.right - sel.left > 1 && sel.bottom - sel.top > 1;

    // Region edit: crop to the selection (+ small padding for blending) so the
    // model spends its full resolution on the detail. Else: whole document.
    const region: Bounds = isRegion
      ? padBounds(sel as Bounds, 0.06, docW, docH)
      : { left: 0, top: 0, right: docW, bottom: docH };
    const cropW = region.right - region.left;
    const cropH = region.bottom - region.top;
    // Always match the request to the crop's shape (nearest official ratio), so
    // the model frames close to the selection and cover-fit trims little.
    const aspectRatio = nearestSupportedAspectRatio(cropW, cropH);

    setStatus(isRegion ? "Reading selected region…" : "Reading image…");
    const read = await readRegion(docId, region, isRegion);
    const basePng = encodePng(read.image.data, cropW, cropH, read.image.components);

    setStatus(
      `Generating ${aspectRatio} @ ${resolution === "auto" ? "default" : resolution} with ${model}…  (10–60s)`
    );
    const request = {
      apiKey,
      model,
      prompt,
      baseImagePng: basePng,
      references: refs.map((r) => ({ mimeType: r.mimeType, base64: r.base64 })),
      aspectRatio,
      imageSize: resolution === "auto" ? undefined : resolution,
    };
    const result = isOpenAIModel(model)
      ? await generateOpenAIEdit(request)
      : await generateEdit(request);

    const decoded = decodeImage(result.mimeType, result.bytes);
    let rgba = toRGBA(decoded.data, decoded.width, decoded.height, decoded.channels);
    // Cover-fit (preserve aspect, center-trim) the result into the crop box.
    rgba = coverResampleRGBA(rgba, decoded.width, decoded.height, cropW, cropH);
    if (read.mask) applyAlphaMask(rgba, read.mask); // clip the edit to the selection

    setStatus("Placing result…");
    await placeResult(
      docId,
      region,
      rgba,
      cropW,
      cropH,
      isRegion ? `${provider} edit (masked)` : `${provider} edit`
    );

    console.log("[NBP]", read.debug);
    setStatus(
      isRegion
        ? "Done — edit clipped to your selection (new layer)."
        : "Done — edit added as a new layer.",
      "ok"
    );
  } catch (err: any) {
    setStatus("Error: " + (err?.message || String(err)), "error");
  } finally {
    running = false;
    $("generate").disabled = false;
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
function ratioRect(sel: Bounds, targetAR: number, docW: number, docH: number): Bounds {
  const w = sel.right - sel.left;
  const h = sel.bottom - sel.top;
  const cx = (sel.left + sel.right) / 2;
  const cy = (sel.top + sel.bottom) / 2;
  let nw = w;
  let nh = h;
  if (targetAR > w / h) nw = h * targetAR;
  else nh = w / targetAR;
  nw = Math.min(nw, docW);
  nh = Math.min(nh, docH);
  let left = Math.round(cx - nw / 2);
  let top = Math.round(cy - nh / 2);
  let right = left + Math.round(nw);
  let bottom = top + Math.round(nh);
  if (left < 0) { right -= left; left = 0; }
  if (top < 0) { bottom -= top; top = 0; }
  if (right > docW) { left -= right - docW; right = docW; }
  if (bottom > docH) { top -= bottom - docH; bottom = docH; }
  return { left: Math.max(0, left), top: Math.max(0, top), right, bottom };
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
    const [rw, rh] = v.split(":").map(Number);
    await setRectSelection(ratioRect(sel, rw / rh, doc.width, doc.height));
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
    const info = aspectRatioInfo(sel.right - sel.left, sel.bottom - sel.top);
    setPickerSafe($("selRatio"), info.label);
    saveSetting("selRatio", info.label);
    const [rw, rh] = info.label.split(":").map(Number);
    await setRectSelection(ratioRect(sel, rw / rh, doc.width, doc.height));
    setStatus(`Fitted to nearest ratio: ${info.label}.`, "ok");
  } catch (err: any) {
    setStatus("Couldn't fit selection: " + (err?.message || String(err)), "error");
  }
}

async function restoreSettings(): Promise<void> {
  setValueSafe($("geminiApiKey"), await loadApiKey());
  setValueSafe($("openaiApiKey"), await loadOpenAIApiKey());
  for (const id of PICKERS) {
    const v = loadSetting(id, "");
    if (v) setPickerSafe($(id), v);
  }
}

function persistSettingsHooks(): void {
  for (const id of PICKERS) {
    $(id)?.addEventListener("change", () => saveSetting(id, $(id).value));
  }
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
    $("clearRefs").addEventListener("click", () => {
      refs = [];
      renderThumbs();
    });
    $("generate").addEventListener("click", onGenerate);
    $("fitSelection").addEventListener("click", onFitSelection);
    $("fitNearest").addEventListener("click", onFitNearest);

    // Cmd/Ctrl+Return in the prompt field fires Generate immediately.
    $("prompt").addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key === "Return")) {
        e.preventDefault();
        onGenerate();
      }
    });

    await restoreSettings();
    persistSettingsHooks();
    renderThumbs();
    setStatus("Ready. Select a region (optional), add references, write a prompt.");
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
