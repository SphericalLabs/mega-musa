/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { nearestImageSize, nearestRatioLabel } from "./geometry";
import { type ModelOptions, type ModelSettings, type ModelSpec, type SettingDefinition, type SettingValue } from "./types";

function fieldValue(field: SettingDefinition, value: unknown): SettingValue {
  switch (field.type) {
    case "boolean": return typeof value === "boolean" ? value : field.default;
    case "text": return typeof value === "string" ? value.slice(0, field.maxLength ?? 4096) : field.default;
    case "select": return field.options.some((option) => option.value === value) ? value as string : field.default;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return field.default;
      let number = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, value));
      if (field.step && field.step > 0) number = (field.min ?? 0) + Math.round((number - (field.min ?? 0)) / field.step) * field.step;
      return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, number));
    }
  }
}

export function normalizeModelSettings(spec: ModelSpec, saved: Partial<ModelSettings> = {}) {
  const notes: string[] = [];
  const version = spec.settingsVersion ?? 1;
  if (saved.version !== undefined && saved.version !== version) {
    try {
      saved = saved.version < version && spec.migrateSettings
        ? spec.migrateSettings(saved as ModelSettings) : {};
    } catch { saved = {}; }
    notes.push(`${spec.label}: settings version changed; supported settings were restored.`);
  }
  const resolution = nearestImageSize(typeof saved.resolution === "string" ? saved.resolution : spec.defaults.resolution, spec);
  const ratio = nearestRatioLabel(typeof saved.ratio === "string" ? saved.ratio : spec.defaults.ratio, spec.aspectRatios);
  const wantedQuality = typeof saved.quality === "string" ? saved.quality : spec.defaults.quality;
  const quality = spec.qualities.includes(wantedQuality) ? wantedQuality
    : spec.qualities.includes("high") ? "high" : spec.defaults.quality;
  const options: ModelOptions = {};
  for (const field of spec.settings || []) {
    const value = saved.options?.[field.key];
    options[field.key] = fieldValue(field, value);
    if (value !== undefined && value !== options[field.key]) notes.push(`${field.label} was adjusted to a supported value.`);
  }
  if (saved.resolution && saved.resolution !== resolution) notes.push(`Resolution set to ${resolution}.`);
  if (saved.ratio && saved.ratio !== ratio) notes.push(`Aspect ratio set to ${ratio}.`);
  if (saved.quality && saved.quality !== quality) notes.push(`Quality set to ${quality}.`);
  const settings: ModelSettings = { version, resolution, ratio, quality, options };
  return { settings, notes };
}

export function validateModelInput(spec: ModelSpec, settings: ModelSettings, canvas: boolean, references: number): void {
  if (canvas && !spec.inputs.canvas) throw new Error(`${spec.label} does not accept Photoshop canvas input. Clear Include Photoshop selection.`);
  if (references > spec.inputs.references) throw new Error(`${spec.label} accepts at most ${spec.inputs.references} reference images.`);
  if (spec.inputs.maxImages !== undefined && references + Number(canvas) > spec.inputs.maxImages) {
    throw new Error(`${spec.label} accepts at most ${spec.inputs.maxImages} images including the canvas.`);
  }
  const error = spec.validateSettings?.(settings);
  if (error) throw new Error(error);
}

export function freezeModelSettings(settings: ModelSettings): ModelSettings {
  return Object.freeze({ ...settings, options: Object.freeze({ ...settings.options }) });
}
