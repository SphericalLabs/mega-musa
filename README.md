# Mega Musa — Photoshop UXP plugin for Generative AI

*Musa × paradisiaca*

A Photoshop panel for AI image generation and localized editing with Google Gemini image models (Nano Banana) and OpenAI GPT Image models.

![Mega Musa key visual: an open banana reveals Photoshop's transparency checkerboard](public/assets/github-banner-open-peel.jpg)

## Features

- Edit a selection, the full document or the active artboard. Results are placed as embedded Smart Objects by default, sized nondestructively to the same bounds as raster placement at the top of the relevant document, artboard or group and named after the prompt with the model, resolution and quality in brackets. Clear **Place as Smart Object** to place a raster layer instead. Selected regions keep their shape and feathering through a linked, editable layer mask. If Smart Object placement fails, Mega Musa preserves the paid result as a raster layer and reports the fallback.
- Each generated layer stores its complete prompt and generation settings in namespaced Photoshop layer metadata. Selecting the layer shows the archive in Mega Musa, where the prompt can be copied or the controls restored. Stage 1 records reference names but does not embed reference image pixels.
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

To reuse a generation later, select its result layer in Photoshop's Layers panel. **Recall Generations** appears in Mega Musa without changing the current controls. **Copy Prompt** copies the complete prompt. **Load Settings** explicitly restores the prompt, model, supported controls and embedded reference images. Mega Musa stores each unique reference once as an embedded Smart Object in a locked, eye-off `Mega Musa Reference Archive` group, deduplicated by a SHA-256 hash of its original file bytes. Result layers point to those assets in their per-layer metadata. If an asset was removed or changed, the remaining settings still load and the panel reports the missing reference. Older Stage 1 records remain readable but contain reference names only.

**Restore Rectangle** separately replaces the current selection with its saved bounding rectangle. New generations store the original selection bounds separately from the generation crop, along with the original canvas dimensions and artboard geometry. If no selection was drawn, recall restores the generation frame instead. Changed canvas dimensions, a different or changed artboard or a rectangle that does not fit entirely inside the target block restoration and leave the current selection untouched; prompt and settings recall still works. Coordinates are never automatically scaled, shifted or clipped. This restores neither a lasso's shape nor feathering or original source pixels, and it does not track moved content or detect edits that leave the geometry unchanged. Inspect the selection before generating. Older records without geometry keep their existing recall actions but cannot restore a rectangle.

**Generate** stays blue and adds a new row to the generation queue. It is disabled at four active jobs, except that a single brace-expanded submission can add up to 10 jobs. Each row shows its frozen prompt, model, quality, reference count and current state, with its own **Cancel** button. Completed and canceled rows disappear; failed rows remain inline until dismissed and do not block other jobs with a dialog. Canceling before the request is sent costs nothing. Canceling after it has gone out frees that queue slot but not the bill — the provider generates the image regardless, so the estimate is added to the budget and counted as canceled. Once an image is back, that row finishes placing it because the money is already spent. Every arriving result is placed at the top of the document, artboard or group captured when its job was added.

Existing selections are framed to the nearest supported output ratio without changing their original shape. Nothing is added around them — the crop is the selection itself, so select as much surrounding image as the model should see to blend into, and feather the selection for a soft edge. When **Include Photoshop selection** is on, the source is Photoshop's visible composite; hide or delete a previous result before rerunning an edit if it should not be included.

Initial result sizing is nondestructive: the native provider pixels remain stored in the Smart Object while its outer bounds match raster placement. The selection mask is attached only after sizing and placement, so its original size and position are preserved. Masks are linked by default so later Move and Free Transform operations affect the image and mask together; unlink the mask first to reframe the image inside a fixed selection boundary. Enlarging beyond the native provider dimensions cannot create new detail. Paint, erase, clone and similar pixel edits require opening the Smart Object contents or rasterizing the result first.

Mega Musa uses 8-bit sRGB for model inputs and outputs. A 16-bit document shows a precision warning. Partial placements in CMYK, Lab, Grayscale and non-sRGB documents show a color-conversion warning, which is skipped when the result fully and opaquely covers the complete document or active artboard. Either warning can be accepted once per exact mode/profile/depth state during the panel session. A 32-bit/HDR document, Quick Mask mode or a Bitmap, Indexed Color, Duotone or Multichannel document blocks generation before anything is sent and explains how to switch to a supported state.

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
