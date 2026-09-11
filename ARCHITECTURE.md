# Mega Musa architecture

Mega Musa separates panel controls, generation workflows and Photoshop operations into modules with explicit responsibilities. Startup begins in [src/main.ts](src/main.ts), which installs the text codec polyfills before loading the panel; [src/panel/app.ts](src/panel/app.ts) then creates the controllers and connects their dependencies.

## Module map

| Location | Responsibility |
| --- | --- |
| `src/panel/` | Controls, settings, prompts, Describe, recall and UI state |
| `src/generation/` | Submission capture, queue, preparation, requests, billing and result placement |
| `src/photoshop/` | Host actions, documents, pixels, selections, masks, metadata and Smart Objects |
| `src/providers/` | Registry, credentials, provider catalogs and API adapters |
| `src/models/`, `src/model-preferences.ts` | Capabilities, settings validation, geometry, prices and saved model preferences |
| `src/references/`, `src/archive/` | Reference processing, embedded assets, recall records and schema validation |
| `src/images/`, `src/webview/` | Image conversion, browser processing and transfer protocol |
| `src/budget.ts`, `src/currency.ts`, `src/exchange-rates/` | USD spending, display conversion and rate sources |
| `public/` | HTML, CSS, manifest and static assets |

Gemini and OpenAI keep their catalogs and adapters in their own folders under `src/providers/`, alongside the shared registry and contracts. Root files such as `photoshop-bridge.ts`, `image-codec.ts` and `models.ts` provide compatibility exports for existing consumers, while internal imports should point directly to the module that owns the implementation.

## Generation flow

The generation controller captures a submission and adds it to the queue, where the workflow prepares image inputs, waits for a provider slot and sends the request. Each job keeps its own prompt, settings, references, Photoshop pixels, selection and destination, so later edits to the panel controls do not change work already submitted.

`GenerationQueue` owns jobs, pending submissions, provider slots and cancellation, with a limit of four active jobs for standard submissions and up to 10 images in one expanded prompt. Provider requests use two slots in first-in, first-out order, while a separate host gate coordinates Photoshop modal work.

Adapters mark dispatch immediately before the first potentially billable request, allowing the workflow to distinguish cancellation before and after that point. Canceling before dispatch adds no charge; after dispatch, the workflow records the captured estimate once unless the provider has confirmed a charge. Late responses must leave the panel and spending totals untouched once cancellation has been handled.

When a result arrives, the workflow records its charge before decoding or placing the image, so a local failure does not lose the billing record. Placement waits up to 30 seconds for Photoshop, including blocked selection reads before edits begin. Any placement failure retains the paid pixels in memory for Retry Placement with the same destination and no new provider request. Failed placement rolls back its document history. Smart Object placement also keeps a raster fallback so a failed conversion can still preserve the result.

Temporary documents are verified against the IDs open before creation. Cleanup closes only a verified temporary ID through a targeted action; it does not use the DOM's select-then-close helper. Scaling and embedding verify the active document before operating, and raster fallback rechecks the original destination before adding a layer.

## State and module boundaries

`ReferenceCollection` owns the panel's current reference list and gives each submission a separate array snapshot. Image conversion has its own lifecycle in `ReferenceImageProcessor`, which tracks pending conversions and timers and must reject unfinished work and clear timers when it disconnects.

Panel controllers own temporary UI state, while model preferences remain separate from global placement and display preferences. Requests receive only the selected provider's credentials, keeping account configuration scoped to the operation that needs it.

Provider, model, archive schema and image codec modules must remain independent of panel and Photoshop code at runtime. Keep domain state typed and contain host-specific types at the host boundary so shared logic can be tested without loading Photoshop.

The panel and WebView use a shared protocol for message names, chunk limits and transfer assembly. Both receivers validate the message source and reject incomplete or invalid transfers before accepting them as images.

## Documents and compatibility

Generated layers store recall metadata in the existing Photoshop namespaces, using a version-1 archive envelope that must remain readable as fields are added. Older records may lack provider IDs, versioned settings or selection geometry, so changes need to preserve those records along with legacy credential keys and their migrations.

References are stored once per source hash in a hidden, locked archive group, allowing later generations to reuse existing assets. Recall must reuse these references without recompressing them and leave the global Smart Object and reduced-storage preferences as the user has set them.

Saved rectangles can be restored only when the document and artboard geometry remains compatible with the stored coordinates. If that check fails, restoration must leave the current selection untouched.

## Host resource handling

Use checked `batchPlay` calls so Photoshop error descriptors become failures that the workflow can handle. Pixel reads must copy the buffer before disposing the host image data, and cleanup belongs in `finally` so image data is released and suspended history is resumed even after an error. If cleanup also fails, preserve the original failure so its cause remains visible.

## Development

The [developer guide](DEVELOPER.md) covers build steps, extension contracts and validation for changes to these modules. Keep tests focused on observable outcomes and module APIs, and introduce shared abstractions when they remove repeated behavior or own a clear lifecycle.
