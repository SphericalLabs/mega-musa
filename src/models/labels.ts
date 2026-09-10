/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { formatMoney, formatMoneyRange } from "../currency";
import { type ImageQuality } from "../providers/types";
import { outputSizeFor } from "./geometry";
import { INPUT_OVERHEAD_USD, outputPriceRangeUSD, qualityPriceUSD } from "./pricing";
import { type ModelSpec } from "./types";

export function resolutionLabel(token: string): string {
  if (token === "auto") return "Auto";
  // Keep the API/storage token as 512px; display it as part of the K-tier scale.
  if (token === "512px") return "0.5K";
  return token;
}

export function priceLabel(spec: ModelSpec, token: string, ratio: string, quality: ImageQuality): string {
  const allowance = INPUT_OVERHEAD_USD;
  const size = outputSizeFor(spec, token, ratio);
  if (quality !== "auto") {
    const exact = qualityPriceUSD(spec, size, quality);
    if (exact !== null) return formatMoney(exact + allowance);
  }
  const range = outputPriceRangeUSD(spec, token, size, ratio);
  if (!range) return "";
  const low = range[0] + allowance;
  const high = range[1] + allowance;
  return formatMoneyRange(low, high);
}

export function resolutionMenuLabel(
  token: string,
  spec: ModelSpec,
  ratio = "1:1",
  quality: ImageQuality = "auto"
): string {
  const label = resolutionLabel(token);
  // Show an Auto price only when there are no explicit resolution tiers. Budget
  // estimates still use Auto prices.
  if (token === "auto" && spec.imageSizes.length) return label;
  const price = priceLabel(spec, token, ratio, quality);
  return price ? `${label} / ${price}` : label;
}
