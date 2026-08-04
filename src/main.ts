import "./polyfills"; // must be first: defines TextEncoder/TextDecoder for fast-png
import {
  getActiveDoc,
  getSelectionBounds,
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
import { generateEdit, nearestSupportedAspectRatio, aspectRatioInfo } from "./gemini";
import { generateOpenAIImage, OPENAI_MODEL_PREFIX, gptImage2Size, isGptImage2 } from "./openai";
import { pickReferenceImages, RefImage } from "./references";
import {
  MODELS,
  DEFAULT_MODEL,
  modelSpec,
  resolutionLabel,
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

// A second, persistent line under the status box. Status text is replaced on
// every step of a run; the note survives so framing decisions the plugin made on
// the user's behalf stay readable while the request is in flight and afterwards.
function setNote(message: string): void {
  const el = $("note");
  if (!el) return;
  el.textContent = message;
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
    console.log("[NBP] paste failed:", err?.message || String(err));
    setStatus("Could not paste: " + (err?.message || String(err)), "error");
  }
}

async function onGenerate(): Promise<void> {
  if (running) return;
  setStatus("Starting…"); // immediate feedback that the click was received
  setNote(""); // drop the previous run's framing note

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

  const spec = modelSpec(model);
  // The resolution menu is already rebuilt per model, but clamp again here so a
  // tier this model cannot produce can never reach the API.
  const resolution = nearestImageSize($("resolution").value || "auto", spec);
  // Unticked: the canvas contributes nothing to the request. With no reference
  // images either, that makes this a plain text-to-image generation which is
  // still placed into the selection's area and shape.
  const includeSelection = isChecked($("includeSelection"));

  running = true;
  $("generate").disabled = true;
  try {
    const doc = getActiveDoc();
    const docId: number = doc.id;
    const docW: number = doc.width;
    const docH: number = doc.height;

    const sel = await getSelectionBounds();
    // Reflect the selection's nearest supported ratio in the picker — display
    // only. An existing selection is never modified, so lasso / ellipse /
    // feathered shapes survive to become the result's mask. The crop is framed to
    // a supported ratio later (fitRegionToRatio) using only the bounding box.
    // (When there is no selection we do set one — see the !isRegion block below.)
    if (sel && sel.right - sel.left > 1 && sel.bottom - sel.top > 1) {
      const info = aspectRatioInfo(sel.right - sel.left, sel.bottom - sel.top);
      setPickerSafe($("selRatio"), info.label);
      saveSetting("selRatio", info.label);
    }
    const isRegion = !!sel && sel.right - sel.left > 1 && sel.bottom - sel.top > 1;

    // Region edit: crop to the selection (+ small padding for blending) so the
    // model spends its full resolution on the detail. Else: whole document.
    const basePad: Bounds = isRegion
      ? padBounds(sel as Bounds, 0.06, docW, docH)
      : { left: 0, top: 0, right: docW, bottom: docH };
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
        region = fitRegionToRatio(basePad, best.ratio, docW, docH);
      }
    } else {
      geminiAspect = nearestSupportedAspectRatio(padW, padH);
      ratioLabel = geminiAspect;
      const [rw, rh] = geminiAspect.split(":").map(Number);
      region = fitRegionToRatio(basePad, rw / rh, docW, docH);
    }
    const cropW = region.right - region.left;
    const cropH = region.bottom - region.top;

    // Nothing was selected: treat the whole document as the target, framed to the
    // ratio the model will return, and make that framing the live selection so
    // the user can see exactly which area is in play.
    const notes: string[] = [];
    if (!isRegion) {
      await setRectSelection(region);
      if (ratioLabel) {
        setPickerSafe($("selRatio"), ratioLabel);
        saveSetting("selRatio", ratioLabel);
      }
      const cropped = cropW !== docW || cropH !== docH;
      const what = includeSelection ? "what was sent" : "where the result lands";
      if (!ratioLabel) {
        notes.push(`No selection — used the full image (${docW}×${docH}); this model matches its shape.`);
      } else if (cropped) {
        const trimmed =
          cropW !== docW ? `${docW - cropW}px off the width` : `${docH - cropH}px off the height`;
        notes.push(
          `No selection — selected the full image and fit it to ${ratioLabel}: ` +
            `${cropW}×${cropH} of ${docW}×${docH} (${trimmed}). The selection shows ${what}.`
        );
      } else {
        notes.push(
          `No selection — selected the full image (${docW}×${docH}), already ${ratioLabel}, so nothing was cropped.`
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
      setStatus(isRegion ? "Reading selected region…" : "Reading full image…");
      // withMask=false: the selection shape is applied later as a Photoshop layer
      // mask, so we don't read/resample it here (and leave the selection untouched).
      const read = await readRegion(docId, region, false);
      basePng = encodePng(read.image.data, cropW, cropH, read.image.components);
      console.log("[NBP]", read.debug);
    }

    const sizeLabel = geminiAspect ?? openaiSize ?? "auto";
    const modeLabel = includeSelection
      ? "editing the canvas"
      : refs.length
        ? "from references"
        : "text-to-image";
    setStatus(
      `Generating ${sizeLabel} @ ${resolution === "auto" ? "default" : resolution} with ${model} — ${modeLabel}…  (10–60s)`
    );
    const baseReq = {
      apiKey,
      model,
      prompt,
      baseImagePng: basePng,
      references: refs.map((r) => ({ mimeType: r.mimeType, base64: r.base64 })),
    };
    const result = isOpenAIModel(model)
      ? await generateOpenAIImage({ ...baseReq, size: openaiSize as string })
      : await generateEdit({
          ...baseReq,
          aspectRatio: geminiAspect,
          imageSize: resolution === "auto" ? undefined : resolution,
        });

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
        console.log("[NBP] Photoshop scale failed, using JS resample:", e?.message || e);
        rgba = coverResampleRGBA(rgba, decoded.width, decoded.height, cropW, cropH);
      }
    }

    setStatus("Placing result…");
    const kind = includeSelection ? "edit" : "image";
    await placeResult(
      docId,
      region,
      rgba,
      cropW,
      cropH,
      isRegion ? `${provider} ${kind} (masked)` : `${provider} ${kind}`,
      isRegion
    );

    setStatus(
      isRegion
        ? "Done — result clipped to your selection (new layer)."
        : "Done — full-image result added as a new layer.",
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

// Rebuild the ratio and resolution menus from the picked model's entry in the
// capability table. A choice the new model also supports is kept; anything else
// snaps to the nearest thing it can actually do, and the caller gets a sentence
// explaining the move so it never happens silently.
// `preferRatio`/`preferSize` override what the pickers currently show — used at
// startup, where the stored settings should win over the markup's defaults.
function applyModelCapabilities(modelId: string, preferRatio?: string, preferSize?: string): string {
  const spec = modelSpec(modelId);
  const notes: string[] = [];

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
  const size = nearestImageSize(wantSize, spec);
  buildMenu(
    "resolution",
    [{ value: "auto", label: "Auto" }].concat(
      spec.imageSizes.map((s) => ({ value: s, label: resolutionLabel(s) }))
    ),
    size
  );
  saveSetting("resolution", size);
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
    loadSetting("resolution", "auto")
  );
  // Defaults to on — only an explicit "0" from a previous session turns it off.
  setCheckedSafe($("includeSelection"), loadSetting("includeSelection", "1") !== "0");
}

function persistSettingsHooks(): void {
  for (const id of PICKERS) {
    $(id)?.addEventListener("change", () => saveSetting(id, $(id).value));
  }
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
