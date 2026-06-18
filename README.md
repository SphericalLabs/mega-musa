# Nano Banana Pro Edit — Photoshop (UXP) plugin

A Photoshop panel that edits images with Google's **Nano Banana Pro**  
(`gemini-3-pro-image`) and **Nano Banana** (`gemini-2.5-flash-image`) models.

*   **Region editing** — make a selection, the plugin crops it (plus context  
    padding), sends it to the model with your prompt, and composites the result  
    back onto a **new layer masked to your selection** (non-destructive).
*   **Whole-image editing** — with no selection, the whole canvas is edited onto a  
    new layer.
*   **Up to 10 reference images** picked from disk, with thumbnail previews, sent  
    alongside the prompt (Nano Banana Pro composites/blends from references).
*   **Controls** for model, resolution (Auto/1K/2K/4K), aspect ratio, and the  
    context-padding amount.
*   **Each user supplies their own Gemini API key**, stored locally on their  
    machine. There is **no server** to run.

Built with TypeScript + Spectrum UXP widgets. It calls the Gemini REST API  
directly via `fetch` (more robust inside UXP than bundling the Node SDK), using  
the same model id and request shape as the sibling `nbp-api-scripted` Python  
tool.

---

## How a region edit works

```
Photoshop selection
   → crop bbox + padding (clamped to canvas)
   → read pixels (imaging.getPixels)  →  encode PNG  →  base64
   → POST to Gemini (base image + up to 10 refs + prompt)
   → decode returned PNG  →  resample to the crop size
   → new layer (imaging.putPixels)  →  layer mask from the saved selection
```

The Gemini image models have **no mask/inpaint parameter**, so the localized  
edit is implemented on the Photoshop side: the selection becomes a layer mask  
after the fact. Padding gives the model surrounding context for coherent  
blending while the mask keeps only the selected area.

---

## Prerequisites

1.  **Adobe Photoshop 2024 (v25) or newer** recommended (manifest v5 needs  
    23.3+; the `imaging` pixel APIs are most reliable on 24+).
2.  **Node.js 18+** and npm (to build). This repo was built with Node 26.
3.  **Adobe UXP Developer Tool (UDT)** — free, from Creative Cloud Desktop  
    (_Marketplace → search "UXP Developer Tool"_). Used to load the plugin.
4.  **A Gemini API key** — create one at \<https://aistudio.google.com/apikey\>.

---

## Get an API key

1.  Sign in at \<https://aistudio.google.com/apikey\>.
2.  Create an API key (the free tier is enough to start; image generation has  
    per-image token costs — see **Cost** below).
3.  Keep it handy; you paste it into the panel once and it is remembered.

---

## Build

```
cd nbp-photoshop-plugin
npm install
npm run build      # generates icons, bundles src/ -> dist/
```

This produces a loadable plugin in `**dist/**` (manifest.json, index.html,  
index.js, icons). During development use:

```
npm run watch      # rebuilds dist/ on every save (then click Reload in UDT)
npm run typecheck  # tsc --noEmit, no output
```

---

## Install / load in Photoshop

1.  Launch **Photoshop**, then open the **UXP Developer Tool**.
2.  Click **Add Plugin** and choose `**nbp-photoshop-plugin/dist/manifest.json**`.
3.  In the plugin's row, click **Load** (the **•••** menu also has _Load_ /  
    _Reload_ / _Watch_).
4.  The **Nano Banana Pro Edit** panel appears in Photoshop. If it doesn't,  
    open it from _Plugins → Nano Banana Pro Edit_ in the Photoshop menu bar.

After a rebuild (`npm run build` or `npm run watch`), click **Reload** in UDT to  
pick up changes.

### Sharing with students / packaging

To hand a single file to students instead of having them build:

*   In UDT, use the plugin's **••• → Package** action to produce a `**.ccx**`  
    file. Double-clicking a `.ccx` installs it via Creative Cloud (no developer  
    tooling needed on the student's side).
*   Students still each enter **their own** Gemini API key in the panel.

---

## Use

1.  **Paste your API key** into the field at the top and click **Save** (once).
2.  Open an image in Photoshop.
3.  **Optional:** make a selection (any shape) for a localized edit. With no  
    selection, the whole image is edited.
4.  **Optional:** click **Add references…** and pick up to 10 images. Thumbnails  
    appear; the ✕ on a thumbnail removes it.
5.  Type a **prompt** describing the change.
6.  Pick **Model / Resolution / Aspect** (leave Resolution and Aspect on **Auto**  
    for edits — that lets the model match your input).
7.  Adjust **Context padding %** if needed (region edits only).
8.  Click **Generate edit**. The result is added as a new layer; for region edits  
    it is masked to your selection. Re-run, tweak the prompt, or delete the layer  
    freely.

---

## Settings reference

| Control | Notes |
| --- | --- |
| Model | `gemini-3-pro-image` (Pro, best) or `gemini-2.5-flash-image` (fast/cheap for iterating). |
| Resolution | **Auto** (recommended for edits), or force 1K/2K/4K. |
| Aspect | **Auto** (recommended for edits), or force a ratio. |
| Context padding % | Extra area around the selection sent for context. ~10–20% is a good start. Region edits only. |

Your key and these settings are remembered in the panel's local storage.

---

## Project structure

```
nbp-photoshop-plugin/
  public/
    manifest.json          # UXP manifest v5 (permissions, panel entrypoint)
    index.html             # panel UI (Spectrum UXP widgets)
    icons/                 # generated placeholder icons
  src/
    main.ts                # UI wiring + orchestration
    gemini.ts              # Gemini REST client (fetch)
    photoshop-bridge.ts    # selection, imaging get/put, layer + mask (batchPlay)
    image-codec.ts         # base64, PNG encode/decode, RGBA, bilinear resample
    references.ts          # file picker + thumbnails
    storage.ts             # local persistence of key + settings
    uxp.d.ts               # minimal typings for the UXP runtime modules
  esbuild.config.mjs       # bundles src/ -> dist/ and copies public/
  scripts/make-icons.mjs   # generates placeholder icons
  dist/                    # build output — load dist/manifest.json in UDT
```

---

## Cost (rough)

Nano Banana Pro charges per output image by size: ~1120 tokens at 1K/2K~  
~(~1–4 MP) and ~2000 tokens at 4K (~16 MP), plus tokens for input images. For a  
workshop, iterate on `gemini-2.5-flash-image` and switch to `gemini-3-pro-image`  
for finals; keep Resolution on Auto/1K/2K. Each student's usage bills to their  
own key.

---

## Troubleshooting

*   **"Network … permission denied" / fetch blocked.** The manifest already lists  
    `https://generativelanguage.googleapis.com` under  
    `requiredPermissions.network.domains`. After editing the manifest you must  
    **Reload** in UDT. Some PS/UXP versions are picky — confirm the domain matches  
    exactly (https, no trailing path).
*   **"Open a document in Photoshop first."** There is no active document.
*   **API errors (401/403).** Check the key, and that the Gemini API is enabled  
    for it. 429 = rate/quota limit on your key.
*   **"No image returned (…)"** The model returned text or was blocked (safety).  
    The message includes the reason; rephrase the prompt.
*   **"Unsupported image type from model: image/webp…"** The plugin decodes PNG  
    and JPEG (the model returns one of these). WebP would need a decoder added in  
    `image-codec.ts`; in practice keeping Resolution/Aspect on **Auto** returns  
    PNG/JPEG.
*   **Result looks offset or wrong size.** The model can return a different  
    resolution/aspect than the crop; the plugin resamples to fit. Keeping  
    Aspect/Resolution on Auto minimizes reframing.

### If the Photoshop pixel/layer steps error on first run

`src/photoshop-bridge.ts` uses the documented UXP `imaging` API and `batchPlay`  
descriptors, but these can vary slightly by Photoshop version and were not  
runtime-tested in this build environment. If `getPixels` / `putPixels`,  
`createImageDataFromBuffer`, the _make layer_, or the _layer-mask-from-selection_  
step fail, that file is the one place to adjust — each step is small and  
isolated, and the error message in the panel says which phase failed  
(_read region_ vs _place result_). Everything else (UI, references, the Gemini  
request, PNG/base64/resample) is plain JS and is verified by the build.

---

## License / attribution

Internal workshop tool. Uses [`fast-png`](https://github.com/image-js/fast-png)  
(MIT) for PNG encode/decode. Generated images may carry Google's invisible  
**SynthID** watermark.