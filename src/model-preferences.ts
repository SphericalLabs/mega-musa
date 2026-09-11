/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { loadSetting, saveSetting } from "./storage";
import { normalizeModelSettings } from "./models/settings";
import { type ModelSettings, type ModelSpec } from "./models/types";

function key(spec: ModelSpec) { return `modelSettings.${spec.id}`; }

export function loadModelPreferences(spec: ModelSpec) {
  let saved: Partial<ModelSettings> = {};
  try {
    const value = JSON.parse(loadSetting(key(spec), "null"));
    if (value && typeof value === "object") saved = value;
    // Seed only the previously selected model with legacy global preferences.
    else if (loadSetting("model", "gemini-3-pro-image") === spec.id) {
      saved = { resolution: loadSetting("resolution", "2K"), ratio: loadSetting("selRatio", "1:1"), quality: loadSetting("quality", "low") };
    }
  } catch { /* corrupted preferences use model defaults */ }
  return normalizeModelSettings(spec, saved);
}

export function saveModelPreferences(spec: ModelSpec, settings: ModelSettings): void {
  saveSetting(key(spec), JSON.stringify(normalizeModelSettings(spec, settings).settings));
}
