# Develop Mega Musa

This guide covers building the plugin, checking changes and extending its providers and models. For the release installer and basic use, see [README.md](README.md); the [architecture guide](ARCHITECTURE.md) explains how the modules fit together and which compatibility rules they preserve.

## Build and load

You need Photoshop 27.4 or later, Node.js 18+ with npm and the [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2021/devtool/installation/), with developer mode enabled when prompted.

From the repository root, install the dependencies and build the plugin:

```sh
npm install
npm run build
```

With Photoshop running, add `dist/manifest.json` in UXP Developer Tool and click **Load** to open the development build.

During development, `npm run watch` rebuilds the source bundles as you edit them, after which you can click **Reload** in UXP Developer Tool. Changes to HTML, CSS or static assets need a full `npm run build` before reloading because watch mode does not copy those files again.

The build copies `public/` and the license files into `dist/`, then bundles `src/main.ts` as `dist/index.js` and `src/webview/drop-target.ts` as `dist/drop-target.js`. Make changes to the WebView's TypeScript source, since `public/drop-target.js` is only a placeholder that the build replaces.

## Check a change

Run the TypeScript check, automated tests and build before checking your change in Photoshop:

```sh
npm run typecheck
npm test
npm run build
```

The tests use simulated Photoshop and provider responses, so they run without making paid API requests. The bundle tests also catch dependency cycles and runtime imports that would couple provider or model code to the panel or Photoshop host.

After reloading the plugin, check the workflows affected by your change. For generation changes, the main cases are:

- Rectangular and feathered selections, a full document and an artboard.
- Smart Object and raster placement, layer masks and recall from an existing document.
- Reference drop/paste and Describe, including cancellation.
- Queued jobs after control changes, cancellation and placement retry.
- Model settings, saved keys and currency switching while offline.

These host checks cover behavior that simulated responses cannot verify, such as actual layer transforms, UXP layout and network permissions. Tests that call a live provider incur its usual API charges.

For reference previews, click a PNG, JPEG and WebP thumbnail. Check Fit, zoom buttons, drag-to-pan and resizing the dialog in both Fit and zoomed modes. Close with the button, Escape, Command-W on macOS and the window control, then reopen. Check Command-W with focus on the image area and a zoom button; the Photoshop document must stay open. Also close while WebP is loading and check a long filename and light/dark themes. Zoom until the image exceeds the viewport, then test trackpad click-drag in both axes, moving outside the image area and releasing over a toolbar button. Moving afterward must not continue panning, including after closing mid-drag and reopening. Trackpad dragging uses mouse events without pointer capture; two-finger scrolling and pinch-to-zoom are not implemented.

## Add a provider

The [example provider](tests/fixtures/example-provider.ts) and its [extension test](tests/test-provider-extension.mjs) provide a working starting point for a new integration. The fixture returns a local image and stays outside the plugin build, so you can use it to understand the extension contract without calling an API.

1. Create `src/providers/<provider-id>/index.ts` and export a [ProviderDefinition](src/providers/contract.ts) containing a stable ID, credentials and model catalogs.
2. Implement `generate`, `describe` or both, keeping request formats and response checks inside the provider folder.
3. Register the definition in [src/providers/registry.ts](src/providers/registry.ts) so the panel can expose its models and credentials.
4. Declare API and result-download origins in both the provider's `domains` and `public/manifest.json` under `requiredPermissions.network.domains`, since provider metadata alone does not grant network access.
5. Add tests for valid responses, invalid payloads, cancellation and billing failures, then run the checks above and reload the rebuilt plugin.

The registry handles model menus, credential controls and request routing from the provider definition. The Gemini and OpenAI folders show how production adapters organize their catalogs and API code.

### Credentials and requests

Each credential declares `id`, `label`, `secret` and optionally `required`, with secret values stored in UXP secure storage and other values kept in local preferences. Adapters read these values from `request.credentials`, which contains only the selected provider's credentials. Keep those values out of model settings, archives, logs and error messages.

An adapter receives the captured settings, input images, output geometry and credentials, along with an optional abort signal and an `onDispatch` callback. Its request lifecycle follows these steps:

1. Validate the inputs and construct the payload locally, checking for cancellation before each network step.
2. Call `onDispatch?.()` immediately before the first potentially billable request so the workflow can track whether cancellation may still incur a charge.
3. Pass the abort signal to network requests and stop any polling when cancellation occurs.
4. Return PNG or JPEG bytes with their MIME type and available usage or `costUSD`, handling result downloads and format conversion inside the adapter.

The shared workflow owns Photoshop placement, panel state and spending totals, so adapters should report outcomes without changing those directly. If a request fails after a confirmed charge, report the amount through `ProviderFailure`; `costUSD: 0` means a confirmed zero charge, while an omitted value means the cost is unknown. Keep late responses from adding a second charge, following the [request contracts](src/providers/contract.ts) and [failure contracts](src/providers/failure.ts).

## Add a model or setting

Models belong in their provider's catalog, using the contract in [src/models/types.ts](src/models/types.ts). The following fields separate the model's identity in saved documents from the identifier used by the API:

| Field | Purpose |
| --- | --- |
| `id` | Stable application and archive identity |
| `provider` | Registered provider ID |
| `apiModel` | Identifier sent to the API |
| `label` | Name shown in the panel |
| `visible: false` | Preserve an old model for recall without offering it for new selections |

Declare `imageSizes`, `aspectRatios`, `qualities`, `defaults` and `inputs` explicitly so the panel and workflow can determine which controls and inputs the model supports. Input limits cover canvas support, references and prepared image size, while `fixedSizes` or `resolveFrame` handles model-specific output geometry. Keep these capabilities independent of pricing so a price update cannot change controls or framing behavior.

Additional `settings` can define text, number, boolean and select controls, which the panel validates and saves separately for each model. Use `validateSettings` for constraints between values and let the adapter translate the validated settings into API fields.

When a setting changes meaning, increment `settingsVersion` and provide a deterministic `migrateSettings` function to restore older values. Unknown versions fall back to current defaults with a notice, while stable model IDs allow existing archives to remain readable.

## Pricing and Describe

All cost contracts and stored totals use USD, with [src/currency.ts](src/currency.ts) handling conversion only when amounts are displayed.

Image models can use price tables with a USD 0.01 input allowance or provide `estimateCost(settings, outputSize)` for a complete estimate. Return `null` when there is no credible estimate, and keep pricing data alongside the provider catalog. When a response arrives, a valid `costUSD` takes precedence over `actualCost(usage)` and token-rate calculations.

To support Describe, add `descriptionModels` and implement `describe` so it returns descriptions in the same order as the input images. Call `onUsage` after an accepted response but before parsing its text, which preserves billing data even if parsing fails.

Describe counts input images and adds each request's cost once, using the saved estimate when usage is missing or cancellation happens after dispatch. Cancellation before dispatch adds no cost, and late responses must not add cost or image counts again. The **Reset** action clears both generation and description totals.

## Add currencies or rate sources

To add a currency, first verify that its rate source supports it, then add its code and label to `CURRENCIES` in [src/currency.ts](src/currency.ts). Extend [tests/test-currency.mjs](tests/test-currency.mjs) with response fixtures and an offline check using a cache that lacks the new currency.

A new rate source needs an adapter, registration and tests:

1. Implement [ExchangeRateSource](src/exchange-rates/types.ts) with a stable ID, label, domains and `fetchRates(quotes, signal)`.
2. Return `{ currency, rate, date }[]`, using numeric rates expressed as units per one USD and dates in ISO calendar format.
3. Register the source in [src/exchange-rates/registry.ts](src/exchange-rates/registry.ts), add its domains to the manifest and assign it to currencies through `source`.
4. Test partial responses, separate caches, timeouts and offline behavior to make sure a failed lookup preserves usable rates.

The shared wrapper handles timeouts and duplicate requests, while rate sources receive only currency codes and an abort signal. Preserve valid cached quotes when another quote fails, and leave stored USD spending unchanged when converting amounts for display.
