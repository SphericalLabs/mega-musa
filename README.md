# Nano Banana Pro Edit — Photoshop (UXP) plugin

A Photoshop panel that edits images with Google's **Nano Banana Pro**
(`gemini-3-pro-image`) and **Nano Banana** (`gemini-2.5-flash-image`) models.

- **Region editing** — make a selection; the plugin crops to it (plus a little
  padding), sends *only that region* to the model so it spends its full
  resolution on your detail, then scales the result back and composites it onto
  a **new layer clipped to your selection** (non-destructive).
- **Whole-image editing** — with no selection, the whole canvas is edited onto a
  new layer.
- **Up to 10 reference images** picked from disk, with thumbnail previews, sent
  alongside the prompt.
- **Controls** for model, resolution (Auto/1K/2K/4K) and aspect ratio.
- **Each user supplies their own Gemini API key**, stored in UXP secure storage.
  No server.

Built with TypeScript + Spectrum UXP widgets. It calls the Gemini REST API
directly via `fetch` (more robust inside UXP than bundling the Node SDK), using
the same model id and request shape as the sibling `nbp-api-scripted` Python
tool.

---

## How a region edit works

```
Photoshop selection
   → crop to selection bbox + ~6% padding
   → read pixels (imaging.getPixels)              → encode PNG → base64
   → POST to Gemini (cropped region + refs + prompt) at chosen 1K/2K/4K
   → decode returned PNG/JPEG → scale to the crop size
   → read selection coverage (imaging.getSelection, positioned by its
     returned sourceBounds) → bake it into the layer's alpha
   → new layer (imaging.putPixels) at the crop's location
```

The Gemini image models have **no mask/inpaint parameter**, so the clip-to-
selection is done on the Photoshop side: the selection (feather included) becomes
the new layer's alpha. Because only the cropped region is sent, fine detail and
text survive far better than editing the whole frame at once.

> **Tip:** for soft, blended edges, *feather* your selection
> (Select → Modify → Feather) before generating — the feather is carried into
> the layer's transparency. A hard selection gives a hard edge.

---

## Prerequisites

1. **Adobe Photoshop 2024 (v25) or newer** (built/tested on Photoshop Beta).
   Manifest v5 needs 23.3+; the `imaging` pixel APIs are most reliable on 24+.
2. **Node.js 18+** and npm (to build). This repo was built with Node 26.
3. **Adobe UXP Developer Tool** — free, from Creative Cloud Desktop
   (*Marketplace → search "UXP Developer Tool"*). Used to load the plugin.
4. **A Gemini API key** — create one at <https://aistudio.google.com/apikey>.

---

## Build

```bash
cd nbp-photoshop-plugin
npm install
npm run build      # bundles src/ -> dist/
```

This produces a loadable plugin in **`dist/`** (manifest.json, index.html,
index.js). During development:

```bash
npm run watch      # rebuilds dist/ on save (then click Reload in UDT)
npm run typecheck  # tsc --noEmit
```

---

## Install / load in Photoshop

1. Launch **Photoshop**, then open the **UXP Developer Tool** (a separate app).
2. **Add Plugin** → choose **`nbp-photoshop-plugin/dist/manifest.json`**.
3. On the plugin row, click **Load** (the **•••** menu also has *Reload*).
4. The **Nano Banana Pro Edit** panel appears in Photoshop (also under
   *Plugins → Nano Banana Pro Edit*).

After a rebuild, click **Reload** in UDT to pick up changes.

### Sharing with students / packaging

In UDT, use the plugin's **••• → Package** to produce a **`.ccx`** that installs
via Creative Cloud — no developer tooling needed on the student's side. Students
still each enter their own Gemini API key.

---

## Use

1. **Paste your API key** at the top and click **Save** (once).
2. Open an image.
3. **Optional:** make a selection (any shape) for a localized edit. Feather it
   for soft edges. With no selection, the whole image is edited.
4. **Optional:** **Add references…** (up to 10). The ✕ on a thumbnail removes it.
5. Type a **prompt**. For replacing something, instruction-style prompts blend
   best, e.g. *"replace the person with a dragon, same pose and lighting; keep
   the background unchanged."*
6. Pick **Model / Resolution / Aspect**. For region edits, a higher Resolution
   (2K/4K) on a small selection is what preserves fine detail and text.
7. Click **Generate edit**. The result is added as a new layer; for region edits
   it's clipped to your selection.

> **The source is the flattened composite of *visible* layers.** Hide a layer to
> exclude it. Note that re-running reads the current composite — so it will
> include the previous edit layer; **hide or delete the previous edit layer**
> before re-rolling the same edit.

---

## Settings reference

| Control     | Notes |
|-------------|-------|
| Model       | `gemini-3-pro-image` (Pro, best) or `gemini-2.5-flash-image` (fast/cheap for iterating). |
| Resolution  | **Auto**, or force 1K/2K/4K. Higher res on a small selection = more preserved detail. |
| Aspect      | **Auto** (recommended for edits — matches the input) or force a ratio. |

Your key is remembered in UXP secure storage. These settings are remembered in
the panel's local storage.

---

## Project structure

```
nbp-photoshop-plugin/
  public/
    manifest.json          # UXP manifest v5 (permissions, panel entrypoint)
    index.html             # panel UI (Spectrum UXP widgets)
  src/
    main.ts                # UI wiring + orchestration
    polyfills.ts           # TextEncoder/TextDecoder for UXP (fast-png needs them)
    gemini.ts              # Gemini REST client (fetch)
    photoshop-bridge.ts    # selection, imaging get/put, layer placement
    image-codec.ts         # base64, PNG/JPEG decode, RGBA, resample, alpha mask
    references.ts          # file picker + thumbnails
    storage.ts             # secure key storage + local setting persistence
    uxp.d.ts / jpeg-js.d.ts# ambient typings
  esbuild.config.mjs       # bundles src/ -> dist/ and copies public/
  scripts/make-icons.mjs   # (optional) generate placeholder icons
  dist/                    # build output — load dist/manifest.json in UDT
```

---

## Cost (rough)

Nano Banana Pro charges per output image by size (~1120 tokens at 1K/2K, ~2000
at 4K) plus input-image tokens. Cropping to the selection keeps input small.
Iterate on `gemini-2.5-flash-image`; switch to `gemini-3-pro-image` for finals.
Each student's usage bills to their own key.

---

## UXP gotchas handled (notes for future maintenance)

This plugin works around several UXP-runtime quirks discovered while building it:

- **No `TextEncoder`/`TextDecoder`** in the panel runtime → polyfilled in
  `polyfills.ts` (imported first) so `fast-png` can load.
- **`fetch` throws on `signal: undefined`** → the `signal` key is only included
  when an AbortSignal is provided (`gemini.ts`).
- **No `innerHTML`** → DOM cleared via `removeChild` (`main.ts`).
- **Spectrum `sp-picker` / `sp-slider` `.value` is getter-only** → settings are
  restored via the reflected attribute / selected menu item (`main.ts`).
- **`imaging.getSelection` returns the mask at the selection's own bounds**, not
  the requested `sourceBounds` → we read its returned `sourceBounds` and place
  the mask at the correct offset in the crop (`photoshop-bridge.ts`). Getting
  this wrong causes a stretched-blob mask and horizontal striping.
- **Layer-mask via `batchPlay` "Make" can be "not currently available"** →
  avoided entirely by baking the selection into the layer's alpha instead.
- **Icons** are intentionally omitted from the manifest; malformed icon entries
  caused load failures. The plugin loads with a default icon. To add real
  artwork, re-add a correctly-formed `icons` block and test loading.

---

## Troubleshooting

- **"Network … permission denied" / fetch blocked.** The manifest lists
  `https://generativelanguage.googleapis.com` under
  `requiredPermissions.network.domains`. Reload in UDT after manifest edits.
- **"Open a document in Photoshop first."** No active document.
- **API 401/403** → bad key / API not enabled. **429** → rate limit. **503 /
  "high demand"** → the model is overloaded; retry or switch to the fast model.
- **"No image returned (…)"** → the model returned text or was blocked (safety);
  the message includes the reason. Rephrase.
- **Edit appears outside the selection / striping** → would indicate a mask
  alignment regression; check the `getSelection` `sourceBounds` handling in
  `photoshop-bridge.ts` (see the gotchas above).

---

## Attribution

Internal workshop tool. Uses [`fast-png`](https://github.com/image-js/fast-png)
and [`jpeg-js`](https://github.com/jpeg-js/jpeg-js) (MIT) for image decode.
Generated images may carry Google's invisible **SynthID** watermark.
