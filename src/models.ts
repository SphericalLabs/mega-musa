import { SUPPORTED_ASPECT_RATIOS } from "./gemini";

// Single source of truth for what each model can actually do. Both the UI (which
// menu items exist) and the request builder (what gets sent) read this table, so
// a picker can never offer something the API would reject. Adding a model is one
// entry here — nothing in index.html, nothing in the request code.

export interface ModelSpec {
  id: string; // the picker value; "openai:" prefix routes to the OpenAI client
  label: string; // what the dropdown shows
  // imageSize tokens the model accepts, coarsest-last. Empty = the model has no
  // resolution control at all (its size falls out of the chosen ratio instead).
  imageSizes: string[];
  // Ratios the model can frame to, as "w:h" labels.
  aspectRatios: string[];
  // OpenAI models with a fixed menu of output sizes: the ratio picks the size.
  fixedSizes?: { ratio: number; size: string; label: string }[];
  // USD for one OUTPUT image, keyed by imageSize token — the prompt and any input
  // images (the canvas crop, reference photos) are billed on top of this. A
  // [min, max] pair because for the OpenAI models the published price also
  // depends on things the resolution menu does not pick. Omit a key to show no
  // price for that tier; "auto" is only listed where the default is documented.
  prices?: Record<string, [number, number]>;
}

// Published prices are USD. ECB reference rate of 2026-08-03 via frankfurter.dev
// — the francs in the menu move with this one constant, so bump it if the rate
// drifts far enough to matter.
const USD_CHF = 0.808;

// Every Gemini image model frames to the same ten ratios — that part does not
// vary by model, only the resolution tiers do.
const GEMINI_RATIOS = SUPPORTED_ASPECT_RATIOS.map((r) => r.label);

// gpt-image-1 / 1.5 / mini only ever return these three.
const OPENAI_FIXED = [
  { ratio: 1, size: "1024x1024", label: "1:1" },
  { ratio: 3 / 2, size: "1536x1024", label: "3:2" },
  { ratio: 2 / 3, size: "1024x1536", label: "2:3" },
];

export const DEFAULT_MODEL = "gemini-3-pro-image";

export const MODELS: ModelSpec[] = [
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro (2025)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // 1120 output tokens for both 1K and 2K, 2000 for 4K, at $120/1M — so 2K is
    // free extra resolution here. Gemini defaults to 1K when no size is sent.
    prices: {
      auto: [0.134, 0.134],
      "1K": [0.134, 0.134],
      "2K": [0.134, 0.134],
      "4K": [0.24, 0.24],
    },
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2 (2026)",
    // The only model with the 512px tier.
    imageSizes: ["512px", "1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // 747 / 1120 / 1680 / 2520 output tokens at $60/1M.
    prices: {
      auto: [0.067, 0.067],
      "512px": [0.045, 0.045],
      "1K": [0.067, 0.067],
      "2K": [0.101, 0.101],
      "4K": [0.151, 0.151],
    },
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Nano Banana (2025)",
    imageSizes: ["1K"],
    aspectRatios: GEMINI_RATIOS,
    // 1290 output tokens at $30/1M.
    prices: { auto: [0.039, 0.039], "1K": [0.039, 0.039] },
  },
  {
    id: "openai:gpt-image-2",
    // Takes any width/height on a 16px grid, so the tier just sets a pixel
    // budget (see gptImage2Size) and the crop's own ratio is used as-is.
    label: "OpenAI GPT Image 2 (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
    // OpenAI publishes per-image prices for three legacy sizes only, and states
    // that gpt-image-2 supports "thousands of valid resolutions" without giving a
    // formula — its token count does not even rise monotonically with pixels. So
    // only the 1K tier gets a price: $0.165 (3:2) to $0.211 (1:1) at high
    // quality, which is what "auto" is assumed to pick. 2K and 4K cost more by an
    // amount OpenAI does not publish, so they show no figure rather than a guess.
    prices: { "1K": [0.165, 0.211] },
  },
  {
    id: "openai:gpt-image-1.5",
    label: "OpenAI GPT Image 1.5 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
    // High quality, 1024² up to 1536×1024 — the ratio picker moves within this.
    prices: { auto: [0.133, 0.2] },
  },
  {
    id: "openai:gpt-image-1",
    label: "OpenAI GPT Image 1 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
    prices: { auto: [0.167, 0.25] },
  },
  {
    id: "openai:gpt-image-1-mini",
    label: "OpenAI GPT Image 1 mini (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
    prices: { auto: [0.036, 0.052] },
  },
];

export function modelSpec(id: string): ModelSpec {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL)!;
}

// Smallest-to-largest, for snapping a tier the newly-picked model cannot do to
// the closest one it can.
const TIER_ORDER = ["512px", "1K", "2K", "4K"];

export function resolutionLabel(token: string): string {
  if (token === "auto") return "Auto";
  if (token === "512px") return "512 px (0.5K)";
  return token;
}

// CHF for one output image. Where the published price spans a range this menu
// cannot pick between — for the OpenAI models the aspect ratio, plus the quality
// tier they choose themselves — take the middle of it and mark it "ca.".
export function estimatedCHF(spec: ModelSpec, token: string): number | null {
  const range = spec.prices && spec.prices[token];
  if (!range) return null;
  return ((range[0] + range[1]) / 2) * USD_CHF;
}

function priceLabel(spec: ModelSpec, token: string): string {
  const chf = estimatedCHF(spec, token);
  if (chf === null) return "";
  const range = spec.prices![token];
  return `${range[0] === range[1] ? "" : "ca. "}CHF ${chf.toFixed(2)}`;
}

// What the resolution picker shows: the tier plus what one output image costs, so
// the price is visible at the moment you pick the resolution.
export function resolutionMenuLabel(token: string, spec: ModelSpec): string {
  const label = resolutionLabel(token);
  // Auto hands the choice to the model, so a figure beside it would read as a
  // promise. Price it only where Auto is the entire menu (the fixed-size OpenAI
  // models) and no tier row is there to carry the number. The table still knows
  // what Auto costs — the budget counter uses it.
  if (token === "auto" && spec.imageSizes.length) return label;
  const price = priceLabel(spec, token);
  return price ? `${label} / ${price}` : label;
}

// Closest ratio in `options` to `want`, compared in log space so e.g. 2:1 sits
// midway between 1:1 and 4:1 rather than being pulled toward the wide end.
export function nearestRatioLabel(want: string, options: string[]): string {
  if (!options.length) return "1:1";
  if (options.includes(want)) return want;
  const [ww, wh] = want.split(":").map(Number);
  if (!ww || !wh) return options[0];
  const target = Math.log(ww / wh);
  let best = options[0];
  let bestDist = Infinity;
  for (const opt of options) {
    const [ow, oh] = opt.split(":").map(Number);
    if (!ow || !oh) continue;
    const dist = Math.abs(Math.log(ow / oh) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = opt;
    }
  }
  return best;
}

// Closest tier `model` supports to `want`. "auto" always survives; an unknown or
// unsupported token lands on the nearest neighbour in TIER_ORDER.
export function nearestImageSize(want: string, spec: ModelSpec): string {
  if (want === "auto" || !spec.imageSizes.length) return "auto";
  if (spec.imageSizes.includes(want)) return want;
  const wanted = TIER_ORDER.indexOf(want);
  if (wanted < 0) return "auto";
  let best = spec.imageSizes[0];
  let bestDist = Infinity;
  for (const size of spec.imageSizes) {
    const dist = Math.abs(TIER_ORDER.indexOf(size) - wanted);
    if (dist < bestDist) {
      bestDist = dist;
      best = size;
    }
  }
  return best;
}
