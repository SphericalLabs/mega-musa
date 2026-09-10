/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ImageQuality } from "../providers/types";

export const IMAGE_QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export function normalizeImageQuality(value: string): ImageQuality {
  return IMAGE_QUALITY_OPTIONS.find((option) => option.value === value)?.value || "auto";
}

export function imageQualityLabel(value: ImageQuality): string {
  return value[0].toUpperCase() + value.slice(1);
}
