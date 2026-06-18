import "./polyfills"; // must be first: defines TextEncoder/TextDecoder for fast-png
import { getActiveDoc, getSelectionBounds, padBounds, readRegion, placeResult, Bounds } from "./photoshop-bridge";
import { encodePng, decodeImage, toRGBA, resampleRGBA } from "./image-codec";
import { generateEdit } from "./gemini";
import { pickReferenceImages, RefImage } from "./references";
import { loadApiKey, saveApiKey, loadSetting, saveSetting } from "./storage";

const { entrypoints } = require("uxp");

const MAX_REFS = 10;
const PICKERS = ["model", "resolution", "aspect"];

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

  const apiKey = ($("apiKey").value || "").trim();
  const prompt = ($("prompt").value || "").trim();
  if (!apiKey) {
    setStatus("Enter your Gemini API key and press Save.", "error");
    return;
  }
  if (!prompt) {
    setStatus("Enter a prompt describing the edit.", "error");
    return;
  }

  const model = $("model").value || "gemini-3-pro-image";
  const resolution = $("resolution").value || "auto";
  const aspect = $("aspect").value || "auto";
  const padFrac = Number($("padding").value || 0) / 100;

  running = true;
  $("generate").disabled = true;
  try {
    const doc = getActiveDoc();
    const docId: number = doc.id;
    const docW: number = doc.width;
    const docH: number = doc.height;

    const sel = await getSelectionBounds();
    const isRegion = !!sel && sel.right - sel.left > 1 && sel.bottom - sel.top > 1;

    const region: Bounds = isRegion
      ? padBounds(sel as Bounds, padFrac, docW, docH)
      : { left: 0, top: 0, right: docW, bottom: docH };

    setStatus(isRegion ? "Reading selected region…" : "Reading whole image…");
    const px = await readRegion(docId, region, isRegion);
    const basePng = encodePng(px.data, px.width, px.height, px.components);

    setStatus(`Generating with ${model}…  (this can take 10–40s)`);
    const result = await generateEdit({
      apiKey,
      model,
      prompt,
      baseImagePng: basePng,
      references: refs.map((r) => ({ mimeType: r.mimeType, base64: r.base64 })),
      aspectRatio: aspect === "auto" ? undefined : aspect,
      imageSize: resolution === "auto" ? undefined : resolution,
    });

    const decoded = decodeImage(result.mimeType, result.bytes);
    let rgba = toRGBA(decoded.data, decoded.width, decoded.height, decoded.channels);
    rgba = resampleRGBA(rgba, decoded.width, decoded.height, px.width, px.height);

    setStatus("Placing result…");
    await placeResult(docId, region, rgba, px.width, px.height, "Nano Banana Pro edit", isRegion);

    setStatus(
      isRegion ? "Done — edit added as a masked layer." : "Done — edit added as a new layer.",
      "ok"
    );
  } catch (err: any) {
    setStatus("Error: " + (err?.message || String(err)), "error");
  } finally {
    running = false;
    $("generate").disabled = false;
  }
}

function restoreSettings(): void {
  $("apiKey").value = loadApiKey();
  for (const id of PICKERS) {
    const v = loadSetting(id, "");
    if (v) $(id).value = v;
  }
  const pad = loadSetting("padding", "");
  if (pad) $("padding").value = pad;
}

function persistSettingsHooks(): void {
  for (const id of PICKERS) {
    $(id)?.addEventListener("change", () => saveSetting(id, $(id).value));
  }
  $("padding")?.addEventListener("change", () => saveSetting("padding", String($("padding").value)));
}

function init(): void {
  try {
    // Register the panel entrypoint declared in manifest.json.
    entrypoints.setup({ panels: { nbpEditorPanel: { show() {} } } });

    $("saveKey").addEventListener("click", () => {
      saveApiKey(($("apiKey").value || "").trim());
      setStatus("API key saved.", "ok");
    });
    $("addRefs").addEventListener("click", onAddRefs);
    $("clearRefs").addEventListener("click", () => {
      refs = [];
      renderThumbs();
    });
    $("generate").addEventListener("click", onGenerate);

    restoreSettings();
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
