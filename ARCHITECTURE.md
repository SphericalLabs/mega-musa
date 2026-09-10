# Source architecture

The plugin uses feature modules with a few objects that own state. There is no application framework, dependency container or class hierarchy.

`src/main.ts` installs the required text codec polyfills before importing the panel, then starts the application. `src/panel/app.ts` creates the controllers and connects their callbacks.

## Module map

| Location | Responsibility |
| --- | --- |
| `src/panel/` | Spectrum controls, settings, description, recall, reference UI, notices and application wiring |
| `src/generation/controller.ts` | UI adapter that validates a submission and captures its inputs |
| `src/generation/queue.ts` | Queue state, pending submissions, FIFO provider slots and cancellation |
| `src/generation/prepare.ts` | Capture Photoshop pixels and selection, calculate the frame and prepare request references |
| `src/generation/workflow.ts` | Coordinate preparation, provider requests, cancellation and billing |
| `src/generation/result.ts` | Decode returned images and construct the archive and pending placement |
| `src/generation/placement.ts` | Place results, retain paid pixels after a modal timeout and retry placement |
| `src/photoshop/` | Document access, checked action descriptors, selection, pixels, masks, metadata and placement |
| `src/references/` | Reference collection, WebView image processing, archive preparation, deduplication and restoration |
| `src/providers/` | Provider request/response formats and shared image and description contracts |
| `src/models/` | Model catalogs, supported sizes, geometry, labels and pricing |
| `src/archive/` | Persisted metadata types and validation, including older records |
| `src/images/` | Encoding, decoding, color tags, channel conversion and resampling |
| `src/webview/` | Browser entry, canvas conversion and the shared message/chunk protocol |
| `public/` | HTML, CSS, manifest and static assets |

Existing root entry modules such as `photoshop-bridge.ts`, `image-codec.ts` and `models.ts` re-export the new implementations. Internal imports point directly to the owning module. The placement API now takes a `PlacementRequest` object and a separate optional `PlacementContext` instead of 14 positional arguments.

## State ownership and boundaries

- `GenerationQueue` owns jobs, pending submission IDs, provider slot waiters and queue notifications. `GenerationInput` separates the captured, readonly fields from mutable execution state.
- `ReferenceCollection` owns the current reference list and its capacity. A submission receives a separate array snapshot.
- `ReferenceImageProcessor` owns pending resize requests, timers and thumbnail deduplication. Disconnecting rejects pending requests and clears their timers.
- Description, recall and drop controllers keep their transient state inside their factory closures. The panel composition root connects them through explicit dependencies and callbacks.
- Provider, model, archive schema and image codec modules do not load panel or Photoshop code at runtime. The bundle test checks these boundaries and rejects runtime dependency cycles.
- Photoshop host objects and Spectrum elements still use explicit `any` at parts of the host boundary. The project has no complete SDK type definitions. Domain state, placement options and outgoing WebView messages are typed; implicit `any` and unused variables are compiler errors.

## Behavior that must remain stable

1. Plain submissions stop at four active jobs. One brace-expanded submission can contain up to 10 images. Provider requests use two slots with FIFO ordering; Photoshop modal work uses its separate host gate.
2. A queued job retains its submitted prompt, model, reference list, placement preferences and original document ID. Later panel edits cannot replace those captured fields.
3. Canceling before dispatch adds no budget charge. Canceling after dispatch records the frozen estimate once. Late responses cannot overwrite the panel or charge again. Successful responses are counted before image decoding or placement.
4. A host modal timeout during placement retains the returned pixels. Retry uses the same pixels and destination without another provider request. Other placement failures retain the existing raster fallback and error behavior.
5. Archive version 1, metadata namespaces and storage keys remain unchanged. Recall supports older records and leaves global Smart Object and reduced-storage preferences alone. Restored references are not recompressed and existing originals take priority over compressed duplicates.
6. The panel and WebView share message names, chunk limits and transfer assembly. Both receivers check their message source. Missing or invalid chunks cannot be accepted as complete images.

## Separate correctness fixes

These changes were made after the structural extraction and have focused regression coverage:

- Metadata writes use the shared checked `batchPlay` helper. An error descriptor can no longer be reported as a successful archive write.
- Grayscale-plus-alpha images expand correctly to RGBA, retaining their alpha channel.
- Pixel reads copy the host buffer and dispose Photoshop image data in `finally`, including when `getData()` rejects.
- Placement resumes suspended history in `finally`. A cleanup failure does not replace the original placement error.

## Validation and development

```sh
npm run typecheck
npm test
npm run build
```

The test runner discovers `scripts/test-*.mjs`, excluding the shared support module. Tests bundle in memory and use controlled host and provider responses. They do not send paid provider requests. Coverage includes provider payloads, queue ordering, cancellation and billing, paid placement retry, settings recall, archive reuse, Smart Object cleanup, image formats, WebView transfers and entry-point initialization without native text codecs.

The build emits `dist/index.js` and `dist/drop-target.js`, with their HTML, CSS and assets. `public/drop-target.js` is only a placeholder; edit `src/webview/drop-target.ts`. An alternate output directory is supported through `node esbuild.config.mjs --outdir=/absolute/path`. Builds overwrite outputs without deleting existing files. As before, watch mode watches the source bundles; rerun the build after static HTML or CSS changes.

Automated host doubles cannot verify Photoshop's actual layer transforms, mask linkage, history behavior or UXP styling. Reload `dist/manifest.json` and check a rectangular selection, a feathered selection, a full document and an artboard. Also check drop/paste, Describe with cancellation, queued jobs and recall from an existing document. Provider generation smoke tests incur the usual API cost.

## Keeping future changes lean

- Put new model capabilities and prices in the model catalogs. Keep provider-specific HTTP details in the corresponding provider module.
- Add an abstraction when it removes repeated behavior or owns a real lifecycle. Small stateless functions remain functions; a shared base class for every provider or controller would add indirection without solving a current problem.
- Keep tests aimed at outcomes and public module APIs. Avoid checking source text or injecting private exports into the application entry point.
- Preserve small differences in host action descriptors when their behavior differs. Deduplicate the common host boundary and resource handling, not every superficially similar command.
- Retire compatibility re-export files only when their consumers no longer need them and file removal has been agreed. They contain no duplicate implementations.
