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
}

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
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2 (2026)",
    // The only model with the 512px tier.
    imageSizes: ["512px", "1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Nano Banana (2025)",
    imageSizes: ["1K"],
    aspectRatios: GEMINI_RATIOS,
  },
  {
    id: "openai:gpt-image-2",
    // Takes any width/height on a 16px grid, so the tier just sets a pixel
    // budget (see gptImage2Size) and the crop's own ratio is used as-is.
    label: "OpenAI GPT Image 2 (2026)",
    imageSizes: ["1K", "2K", "4K"],
    aspectRatios: GEMINI_RATIOS,
  },
  {
    id: "openai:gpt-image-1.5",
    label: "OpenAI GPT Image 1.5 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
  },
  {
    id: "openai:gpt-image-1",
    label: "OpenAI GPT Image 1 (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
  },
  {
    id: "openai:gpt-image-1-mini",
    label: "OpenAI GPT Image 1 mini (2025)",
    imageSizes: [],
    aspectRatios: OPENAI_FIXED.map((p) => p.label),
    fixedSizes: OPENAI_FIXED,
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
