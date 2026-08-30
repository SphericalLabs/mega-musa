# Mega Musa — Photoshop UXP plugin for Generative AI

*Musa × paradisiaca*

A Photoshop panel for AI image generation and localized editing with Google Gemini image models (Nano Banana) and OpenAI GPT Image models.

![Mega Musa key visual: an open banana reveals Photoshop's transparency checkerboard](public/assets/github-banner-open-peel.jpg)

## Features

- Edit a selection, the full document or the active artboard. Results are placed as embedded, image-backed Smart Objects by default, sized nondestructively to the same bounds as raster placement at the top of the document root, above every group and artboard, and named after the prompt with the model, resolution and quality in brackets. This avoids PSB-backed Smart Object sources. Clear **Place as Smart Object** to place a raster layer instead. Nonrectangular and feathered selections keep their shape through a linked, editable layer mask; fully opaque rectangular selections need no mask. If Smart Object placement fails, Mega Musa preserves the paid result as a raster layer and reports the fallback.
- **Reduce document size (JPEG 90, lossy)** is off by default. When enabled, opaque new Smart Object sources and opaque new reference assets use JPEG 90. Assets with transparency use lossless, explicitly tagged sRGB PNG. With the option off, every generated Smart Object source uses lossless sRGB PNG and references retain their original bytes.
- Each generated layer stores its complete prompt, generation settings and storage mode in namespaced Photoshop layer metadata. Selecting the layer shows the archive in Mega Musa, where the prompt can be copied or the controls restored. Reference images are embedded in the document for reuse.
- **Include Photoshop selection** controls whether canvas pixels are sent to the model. When off, generation uses only the prompt and optional references; a selection still controls placement and masking.
- Add up to 10 PNG, JPEG or WebP references by file picker, drag and drop or clipboard paste. References are normalized to sRGB before they are sent.
- Choose Nano Banana Pro, Nano Banana 2 or OpenAI GPT Image 2, then set the selected model's supported resolution, quality and aspect ratio.
- Queue multiple generations while continuing to edit the controls. Each click freezes its prompt, model, quality, references, Photoshop pixels, selection and destination. Plain Generate clicks allow up to four active jobs, while one brace-expanded prompt can add up to 10. Two provider requests run concurrently; additional jobs wait.
- Cancel one queued generation from its row or cancel every waiting and running generation with **Cancel All**. A request that has already reached the provider counts as billed and is added to the spend counter.
- Track image generation and Describe costs in one local CHF total, with separate counts for generated and described images.

## Requirements

- Adobe Photoshop 24.0+
- Node.js 18+ and npm
- UXP Developer Tool
- A Gemini API key and/or OpenAI API key

Keys are stored in UXP secure storage. Requests go directly to the selected provider. No project server receives your keys or images. See [Data retention](#data-retention) for what the provider keeps.

## Build and load

```bash
npm install
npm run build
```

In UXP Developer Tool, add `dist/manifest.json` and click **Load**. After changes, run `npm run watch` and click **Reload**. Run `npm run typecheck` for a TypeScript check.

## Use

1. Save the API key for the selected provider.
2. Open a Photoshop document. Select a region or leave no selection to use the full image or active artboard.
3. Enter a prompt. Add references if needed.
4. Choose the model and settings, then click **Generate**.

### Prompt expansion

Brace groups add multiple concrete prompts to the existing generation queue. Alternatives expand recursively and combine as a Cartesian product: `a {red, blue} {balloon, car}` produces four prompts.

A final positive integer repeats every concrete result before it. `{a photo of a {banana, strawberry}, 3}` queues three banana prompts followed by three strawberry prompts. A click can expand to at most 10 images; a larger or malformed expression reports an error and queues nothing.

Use `\{`, `\}`, `\,` and `\\` for literal braces, commas and backslashes. Commas outside brace groups are already literal. Queue rows and generated layer archives store the concrete expanded prompt, while the prompt field keeps the original template.

To reuse a generation later, select its result layer in Photoshop's Layers panel. **Recall Generations** appears in Mega Musa without changing the current controls. **Copy Prompt** copies the complete prompt. **Load Settings** explicitly restores the prompt, model, supported controls and embedded reference images. It intentionally does not change **Place as Smart Object** or **Reduce document size**: both are global preferences, persist across panel reloads and are frozen separately for each queued submission. **Place as Smart Object** defaults on; lossy size reduction defaults off.

Mega Musa stores each unique reference once as an embedded Smart Object in a locked, eye-off `Mega Musa Reference Archive` group, deduplicated by a SHA-256 hash of its source bytes. With reduced storage enabled, a new opaque reference is stored as JPEG 90 and a new transparent reference as lossless sRGB PNG. If recompressing an existing JPEG would not save space, its original bytes are kept. Existing archived assets always win over creating a recompressed duplicate. Opening an older document, loading its settings or reusing a restored reference never migrates or recompresses its archive. Result layers point to those assets in their per-layer metadata. If an asset was removed or changed, the remaining settings still load and the panel reports the missing reference. Older Stage 1 records remain readable but contain reference names only.

**Restore Rectangle** separately replaces the current selection with its saved bounding rectangle. New generations store the original selection bounds separately from the generation crop, along with the original canvas dimensions and artboard geometry. If no selection was drawn, recall restores the generation frame instead. Changed canvas dimensions, a different or changed artboard or a rectangle that does not fit entirely inside the target block restoration and leave the current selection untouched; prompt and settings recall still works. Coordinates are never automatically scaled, shifted or clipped. This restores neither a lasso's shape nor feathering or original source pixels, and it does not track moved content or detect edits that leave the geometry unchanged. Inspect the selection before generating. Older records without geometry keep their existing recall actions but cannot restore a rectangle.

**Generate** stays blue and adds a new row to the generation queue. It is disabled at four active jobs, except that a single brace-expanded submission can add up to 10 jobs. Each row shows its frozen prompt, model, quality, reference count and current state, with its own **Cancel** button. Completed and canceled rows disappear; failed rows remain inline until dismissed and do not block other jobs with a dialog. Canceling before the request is sent costs nothing. Canceling after it has gone out frees that queue slot but not the bill — the provider generates the image regardless, so the estimate is added to the budget and counted as canceled. Once an image is back, that row finishes placing it because the money is already spent. Every arriving result is placed at the top of the original document root, above every group and artboard.

Existing selections are framed to the nearest supported output ratio without changing their original shape. Nothing is added around them — the crop is the selection itself, so select as much surrounding image as the model should see to blend into, and feather the selection for a soft edge. When **Include Photoshop selection** is on, the source is Photoshop's visible composite; hide or delete a previous result before rerunning an edit if it should not be included.

Initial result sizing is nondestructive: the full provider resolution remains stored in the Smart Object while its outer bounds match raster placement. With reduced storage on, opaque pixels are JPEG-compressed once before embedding; PNG storage remains pixel-lossless. The selection mask is separate from source transparency and is attached only after sizing and placement, so its original size and position are preserved. Masks are linked by default so later Move and Free Transform operations affect the image and mask together; unlink the mask first to reframe the image inside a fixed selection boundary. Enlarging beyond the native provider dimensions cannot create new detail. Paint, erase, clone and similar pixel edits require opening the Smart Object contents or rasterizing the result first.

For a raster result layer, Mega Musa cannot assign JPEG compression to that individual layer. PSD compression and TIFF image/layer compression are chosen by Photoshop when the whole document is saved. The reduced-storage preference still applies to newly embedded reference archive assets in that raster workflow.

Mega Musa uses 8-bit sRGB for model inputs and outputs. A 16-bit document shows a precision warning. Partial placements in CMYK, Lab, Grayscale and non-sRGB documents show a color-conversion warning, which is skipped when the result fully and opaquely covers the complete document or active artboard. Either warning can be accepted once per exact mode/profile/depth state during the panel session. A 32-bit/HDR document, Quick Mask mode or a Bitmap, Indexed Color, Duotone or Multichannel document blocks generation before anything is sent and explains how to switch to a supported state.

### Document structure and reducing file size

A generated document is structured like this:

```text
Photoshop document
├── Generated result layer
│   ├── Embedded JPEG 90 or lossless sRGB PNG source (Smart Object mode)
│   ├── Editable Photoshop layer mask, when selection clipping is needed
│   └── Prompt, settings, geometry and reference pointers in layer metadata
└── Mega Musa Reference Archive (hidden and locked)
    └── One embedded asset per unique reference source
```

With **Place as Smart Object** off, the result contains raster pixels instead of a separate embedded source. A layer mask is separate from source transparency: TIFF's **Save Transparency** option does not control Photoshop layer masks. The small metadata record stores Recall information, not another copy of the generated pixels. Existing reference assets are reused by source hash and are not recompressed when an older document is opened or recalled.

Use these settings according to the required tradeoff:

1. **Smallest file while keeping editable Smart Objects:** leave **Place as Smart Object** and **Reduce document size (JPEG 90, lossy)** on. Opaque new sources and references use JPEG 90; anything with alpha uses lossless sRGB PNG.
2. **Absolute smallest working document:** turn **Place as Smart Object** off and leave **Reduce document size** on. The generated result becomes a raster layer, so its embedded full-resolution source is no longer available. New reference archive assets are still compressed. A flattened delivery copy can be smaller again, but loses layers, masks, Recall and reusable references.
3. **PSD/PSB:** keep file compression enabled. Set **Maximize PSD and PSB File Compatibility** to **Ask** or **Never** only when older Photoshop versions, previews and other applications do not need the extra flattened composite. Adobe notes that omitting this composite can significantly reduce layered file size. See [Adobe's Photoshop performance guidance](https://helpx.adobe.com/ca/photoshop/kb/optimize-photoshop-cc-performance.html).
4. **Layered TIFF:** for lossless storage, choose **ZIP** for both Image Compression and Layer Compression and leave **Save Image Pyramid** off. JPEG Image Compression can make the composite lossy where Photoshop offers it, but it does not JPEG-compress individual layers or embedded Smart Object/reference sources. Use **Save Transparency** only when another application needs the composite alpha channel. Leave **BigTIFF** off unless the document requires it; it raises the size limit rather than improving compression. See [Adobe's TIFF option reference](https://helpx.adobe.com/photoshop/using/saving-files-graphics-formats.html).

PSD is the safest archival master for Photoshop-specific behavior. Photoshop can preserve layer data in TIFF, but other applications may ignore it; verify Mega Musa Recall on a representative layered TIFF before switching an archive workflow from PSD.

### Describe budget

**Describe Images** adds its cost to the same budget as image generation. The **images described** counter counts each input image: one Photoshop selection plus nine references adds 10, even though they share one API request. No Describe request count is shown. The cost for the whole request is added once, without multiplying it by the image count. Returned usage accounts for input, output, reasoning and cached tokens, including OpenAI cache writes. The calculator uses [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), checked August 28, 2026, with the panel's existing USD-to-CHF reference rate. It assumes paid API usage; free tiers, credits, taxes and account-specific discounts are not detected.

If usage is missing, the budget uses the midpoint of the model's displayed price range per input image and marks those images as estimated. Canceling after sending a request also adds that estimate once; its input images count as described and are marked canceled and estimated. A late response does not add cost or images again or replace the estimate. Canceling during preparation adds nothing. Responses with usable billing information still count if their description text cannot be parsed; transport errors and rejected requests without usage add neither cost nor described images.

The total always shows two decimal places; stored amounts are not rounded. Counts and costs survive a panel reload. **Undo** restores the prompt without refunding usage. **Reset** clears spend, generation counts and description counts together. When upgrading from the old Describe request counter, the counters for described images start at zero because historical input counts were not saved. Existing CHF spend, generation counts and the budget's start date are preserved. This is a local estimate, not the provider's invoice.

## Data retention

What a provider keeps is set on your API account, not by this plugin. Every endpoint and model used here is eligible for zero data retention (ZDR).

- **Gemini:** on the free tier Google may use your prompts and images to improve its products. Use a project with billing enabled, and [request ZDR](https://ai.google.dev/gemini-api/docs/zdr) for that project if you need it.
- **OpenAI:** inputs are never used for training, and abuse-monitoring logs are kept for 30 days. Ask OpenAI sales about [ZDR](https://developers.openai.com/api/docs/guides/your-data).

Some non-identifying metadata is retained under ZDR either way.

## License

[GNU GPLv3](LICENSE)
