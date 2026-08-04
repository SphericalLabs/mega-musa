# Nano Banana Pro Edit — Photoshop UXP plugin

A Photoshop panel for AI image generation and localized editing with Google Gemini image models (Nano Banana) and OpenAI GPT Image models.

## Features

- Edit a selection, the full document or the active artboard. Results are placed on a new layer. Selected regions keep their shape and feathering through a layer mask.
- **Include Photoshop selection** controls whether canvas pixels are sent to the model. When off, generation uses only the prompt and optional references; a selection still controls placement and masking.
- Add up to 10 PNG, JPEG or WebP references by file picker, drag and drop or clipboard paste.
- Choose among Gemini 3 Pro Image, Gemini 3.1 Flash Image, Gemini 2.5 Flash Image and OpenAI GPT Image 2, 1.5, 1 or 1 mini. Set model-supported resolution, quality and aspect ratio.
- Track estimated spend locally.

## Requirements

- Adobe Photoshop 24.0+
- Node.js 18+ and npm
- UXP Developer Tool
- A Gemini API key and/or OpenAI API key

Keys are stored in UXP secure storage. Requests go directly to the selected provider. No project server receives your keys or images.

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

Existing selections are framed to the nearest supported output ratio without changing their original shape. When **Include Photoshop selection** is on, the source is Photoshop's visible composite; hide or delete a previous result before rerunning an edit if it should not be included.

## License

[GNU GPLv3](LICENSE)
