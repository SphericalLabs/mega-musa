# Extending Mega Musa

Providers are TypeScript modules bundled with the Photoshop plugin. Adding a provider requires its module, one registry entry and any new network domains in the UXP manifest. Rebuild and reload the plugin after registration. There is no runtime download or installation of provider code.

Start with the tested [example provider](scripts/fixtures/example-provider.ts). Its registration is exercised by [the extension test](scripts/test-provider-extension.mjs), including custom controls, two credentials, pricing, a frozen queued request and archive recall. The example returns a local test image and makes no network requests. It is excluded from the application build.

## Add a provider

1. Create `src/providers/<provider-id>/index.ts` exporting a `ProviderDefinition`. Use a stable lowercase ID such as `example`. Keep the model catalog and API adapters in that folder as they grow.
2. Define credentials and models using the contracts below. Implement `generate`, `describe` or both. A provider with no generation models does not need a generation adapter.
3. Import the definition in `src/providers/registry.ts` and add it to `createProviderRegistry([...])`. The model menu, credential controls and operation routing use this registry automatically.
4. List API and result-download origins in the provider's `domains`, then add them to `public/manifest.json` under `requiredPermissions.network.domains`. Metadata alone does not grant UXP network access. `test-extension-config.mjs` checks that declared domains are in the manifest.
5. Add mocked request/response tests, run the checks below and reload `dist/manifest.json` in UXP Developer Tool for Photoshop validation.

The registry rejects duplicate provider/model IDs, mismatched ownership, missing operation adapters and invalid capability definitions. An unknown model or provider fails explicitly. IDs never select a provider by prefix.

```text
src/providers/example/
  index.ts                 Provider definition and adapter wiring
  models.ts                Image models, defaults and capabilities
  description-models.ts    Optional description presets
  images.ts                Image-generation HTTP implementation
  descriptions.ts          Optional description HTTP implementation
  errors.ts                Provider response validation
  pricing.ts               Provider-specific pricing, when needed
```

See [ProviderDefinition and ProviderRequest](src/providers/contract.ts) for the exact interfaces. OpenAI and Gemini are working examples in `src/providers/openai/` and `src/providers/gemini/`; each provider owns its image and description adapters, response checks and model catalogs. OpenAI also owns its flexible geometry, image-size calculations and pricing helpers. Shared contracts, dispatchers and description formatting remain directly under `src/providers/`.

## Credentials and provider configuration

Each credential declares `id`, `label`, `secret` and optionally `required`. Secret values use UXP secure storage. Nonsecret configuration, such as a region or project ID, uses local preferences. New controls appear automatically under API Keys / Currency.

```ts
credentials: [
  { id: "token", label: "Example token", secret: true, required: true },
  { id: "region", label: "Example region", secret: false, required: true },
]
```

Read these values from `request.credentials.token` and `request.credentials.region` inside the adapter. `request.apiKey` remains a convenience for providers whose credential is named `apiKey`. Only the selected provider's values enter a request. Do not put credentials in model settings, generation metadata, logs or provider error messages.

`fieldId` and `buttonId` connect the built-in providers to their existing HTML controls. New providers can omit both. Existing Gemini and OpenAI secure-storage keys are preserved, including the legacy Gemini key migration. New values use `nbp.provider.<provider-id>.<credential-id>`.

## Add or change an image model

Add a model to its provider's `models` array. Keep these identities separate:

| Field | Purpose |
| --- | --- |
| `id` | Stable application and archive identity, for example `example:artist` |
| `provider` | Registered provider ID |
| `apiModel` | Exact identifier sent to the service, for example `artist-v7` |
| `label` | User-visible name |
| `visible` | Set to `false` to retain an older catalog entry without offering new selections |

Changing `apiModel` does not require changing the archive ID. If behavior is incompatible, use a new ID or provide a settings migration. Recall still displays the saved model name when that model is unavailable, keeps the current model and explains what could not be restored.

Declare `imageSizes`, `aspectRatios`, `qualities`, `defaults` and `inputs` explicitly. Quality names may differ between providers. A one-option quality list hides the quality control. Pricing fields never determine which quality controls or geometry algorithms are used.

`inputs` declares whether canvas input is supported, the maximum number of reference images and the maximum prepared input edge in pixels. Optional `maxImages` limits references plus the canvas together. The application still caps the reference collection at 10. Unsupported input combinations fail before Photoshop preparation or a paid request; switching to a less capable model does not discard the user's references.

For framing, the default resolver chooses the nearest supported aspect ratio. `fixedSizes` supplies fixed pixel dimensions. A model with other sizing rules supplies `resolveFrame(spec, tier, width, height)` and returns a normalized frame with `label`, `ratio` and optional exact `width`/`height`. See the OpenAI flexible-size resolver. The shared workflow uses dimensions rather than provider-specific request fields. The older `openaiSize` and `geminiAspect` fields remain compatibility outputs.

The ratio picker retains its existing Photoshop framing behavior: it is a target for selection-fitting tools. Generation derives the actual output frame from the captured selection or document geometry.

## Model-specific settings

Common settings are resolution, ratio and quality. Add extra controls through `settings` on the model:

```ts
settingsVersion: 1,
settings: [
  { key: "seed", label: "Seed", type: "number", default: 1, min: 0, max: 100, step: 1 },
  { key: "transparent", label: "Transparency", type: "boolean", default: false },
  { key: "avoid", label: "Avoid", type: "text", default: "", maxLength: 1000 },
  {
    key: "style", label: "Style", type: "select", default: "photo",
    options: [{ value: "photo", label: "Photo" }, { value: "ink", label: "Ink" }],
  },
]
```

The panel renders these controls and stores preferences per model at `nbp.modelSettings.<model-id>`. Switching models restores that model's values. Only the previously selected model inherits old global resolution, ratio and quality preferences. Other models start with their own defaults.

| Scope | Examples | Storage and lifetime |
| --- | --- | --- |
| Global | Display currency, include canvas, placement and document-size preferences | Existing local preference keys |
| Provider | API key, region, project identifier | Secure storage for secrets; local preferences otherwise |
| Model | Resolution, quality, ratio and extra options | Versioned record per stable model ID |
| Submission | Validated model settings and selected provider credentials | Frozen in memory for each queued submission |

Extra values must be strings, finite numbers or booleans. Undeclared options are dropped. Numbers are bounded and snapped to their declared step. Invalid selections use defaults. Adjustments made during restore are reported.

Use `validateSettings(settings)` for combinations such as “Studio quality supports 1K only”. Return a short explanation or `null`. Validation runs at submission and at the adapter boundary. API field names and wire formats belong in the adapter; do not send the settings object wholesale.

Increment `settingsVersion` when a setting's meaning changes. Supply `migrateSettings(oldSettings)` to return a partial current settings object. The shared normalizer validates the result. Older versions without a migration and unknown future versions use current defaults with a note. Keep migrations deterministic and free of network or Photoshop calls.

New layer archives retain the version-1 envelope and existing fields, with optional `providerId` and `settings` fields. The complete normalized settings record is frozen and archived, including custom options. Credentials are excluded. Older archives still load; their missing extra settings use model defaults. Recall continues to leave global Smart Object and document-size preferences alone.

## Different API families and request lifecycles

An adapter receives the registered model definition, frozen settings, credentials, input images, frame, optional abort signal and `onDispatch` callback. It returns PNG or JPEG bytes with a MIME type, optional usage and optional `costUSD`. Download URL-based results and normalize other formats inside the adapter before returning; declare download origins in the manifest.

Different models from one provider can use separate functions selected inside that provider's `generate` or `describe` implementation. Keep JSON, multipart requests, upload steps, polling, response parsing and error interpretation there. No shared base class is required.

1. Perform local validation and payload construction before dispatch. Check the abort signal before starting each network step.
2. Call `onDispatch?.()` immediately before the first potentially billable request. If uploads are billable, that means the upload. The callback also stops work when cancellation was requested in a runtime without a working abort controller.
3. Pass the signal to requests and stop polling after cancellation. If an upload is not billable, still check cancellation before starting generation.
4. Return normalized bytes and billing information. Do not place Photoshop layers or update UI/budget state in an adapter.
5. Add tests for accepted responses, invalid payloads, cancellation before and after dispatch and failures after billing.

Canceling the local wait does not prove remote cancellation. Once dispatch occurs, the existing workflow records the frozen estimate once and ignores late results. A provider that confirms cancellation before the local wait has settled can throw `new ProviderFailure(message, { canceled: true, costUSD: 0 })`. Use a nonzero amount if the service reports a charge. Omit `costUSD` when it is unknown; zero explicitly means no charge. Late cancellation confirmations do not retroactively reconcile the budget.

An adapter can also throw `ProviderFailure` with a known `costUSD` after a billed response fails parsing. Preserve the original provider outcome without reporting guesses as actual billing. Successful results are charged before decoding and placement, and placement retries reuse paid pixels.

## Pricing

All cost contracts use USD. Display-currency conversion belongs exclusively to `currency.ts`.

Image models can use the existing output price tables plus the USD 0.01 input allowance, or supply `estimateCost(settings, outputSize)` for a complete estimate including inputs. This callback receives extra model options, so prices may depend on them. It overrides the built-in allowance. Return `null` when there is no credible estimate.

For returned usage, supply model-specific `actualCost(usage)` or the existing token-rate fields. A valid `GenerateResult.costUSD` takes precedence. Unknown and invalid costs stay unknown; they are never treated as free. Keep provider pricing snapshots next to the provider catalog and update them deliberately when API prices change.

Description presets declare their API model, optional effort/options, estimate and optional `actualCost(usage, at)`. Add them to `descriptionModels` and implement `describe`. The existing presets keep effort in the model selector. Custom description adapters translate those presets into their own API fields. Return ordered `descriptions` corresponding to the input images and call `onUsage` on an accepted response before text parsing, since parsing can still fail after billing. The panel also records returned usage if that callback was not needed. Use `null` estimates/ranges for unknown prices.

## Add a display currency

1. Verify that the selected exchange-rate source publishes the currency. The default source is Frankfurter restricted to ECB rates; not every currency is necessarily covered.
2. Add `{ value: "CODE", label: "CODE — Currency name" }` to `CURRENCIES` in `src/currency.ts`, using the real three-letter currency code. No separate picker or request URL change is needed.
3. Update the response fixtures in `scripts/test-currency.mjs` and add a check for the new currency. Keep an offline test using an older cache that lacks the new quote.
4. Run the checks and update the supported-currency list in `README.md`.

Rates are units of the quote currency per **one USD**. A USD 2 amount with a rate of 0.9 is displayed as 1.8 units of that currency. Formatting intentionally retains fractional units for small API charges, even for currencies commonly displayed without cents.

The cache validates rates individually. A newly added, missing or malformed quote does not invalidate unrelated cached rates. Publication dates and successful lookup dates are separate. Quotes checked today are reused; missing quotes remain eligible for retry. Timeouts and failed requests preserve valid rates. Older publication dates cannot replace newer cached rates. If the selected quote is unavailable, amounts are explicitly displayed in USD.

USD spending totals are never rewritten by rate updates. Historical spending is displayed at the latest cached rate, rather than maintaining a separate exchange-rate history for every generation.

## Add an exchange-rate source

1. Implement `ExchangeRateSource` in `src/exchange-rates/`. Give it a stable `id`, a user-facing `label`, allowed `domains` and `fetchRates(quotes, signal)`.
2. Normalize the response to `{ currency, rate, date }[]`, with an ISO calendar date and a numeric rate per one USD. If the upstream base is another currency, convert to USD before returning. Do not return inverse rates or string numbers.
3. Register the source in `src/exchange-rates/registry.ts` and add its domains to the UXP manifest.
4. Set `source: "your-source-id"` on currencies assigned to it. Each currency has one designated source. Caches use `nbp.exchangeRates.<source-id>` and never silently mix sources.
5. Add mocked tests for attribution, independent caching, partial data and failures. `test-extension-config.mjs` includes a second-source example.

The shared refresh wrapper supplies the five-second timeout and request deduplication per source. Source modules receive currency codes and a signal only. Prompts, images, API credentials and spending amounts do not enter this path.

## Verify a change

```sh
npm run typecheck
npm test
npm run build
```

Automated tests make no paid requests. The extension fixture verifies that another provider works without edits to shared workflow code. The bundle suite rejects dependency cycles and provider/model imports of panel or Photoshop modules.

In Photoshop, check existing keys after reload, switching between models, custom controls, queueing followed by control changes, cancellation and recall from both old and new documents. Check currency switching offline. Spectrum layout, actual network permissions and Photoshop host behavior still require this manual check. Live provider smoke tests incur the provider's usual charges.
