/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { CURRENCIES, currencyNote, displayCurrency, formatMoneyRange, refreshExchangeRates, setDisplayCurrency } from "../currency";
import { DEFAULT_MODEL, MODELS, modelSpec } from "../models/catalog";
import { DESCRIPTION_MODELS, descriptionModelSpec } from "../models/description-catalog";
import { resolutionMenuLabel } from "../models/labels";
import { imageQualityLabel } from "../models/quality";
import { normalizeModelSettings, freezeModelSettings } from "../models/settings";
import { type ModelSettings } from "../models/types";
import { loadModelPreferences, saveModelPreferences } from "../model-preferences";
import { type DescriptionModelSpec } from "../providers/description-types";
import { providerRegistry } from "../providers/registry";
import { loadSetting, saveSetting } from "../storage";
import { $, buildMenu, hasOption, isChecked, setCheckedSafe, setPickerSafe } from "./controls";
import { providerCredentials, missingCredential, restoreProviderSettings } from "./provider-settings";
import { createModelOptions } from "./model-options";
import { renderBudget, setStatus } from "./status";

export function descriptionApiKey(model: DescriptionModelSpec): string {
  return providerCredentials(model.provider).apiKey || "";
}

export function createSettingsController(onSelectionChange: () => void) {
  const options = createModelOptions();
  let activeModel = "";

  function refreshDescriptionModelSelection(current?: string): void {
    const stored = descriptionModelSpec(loadSetting("describeModel", ""));
    const ready = providerRegistry.providers.filter((provider) => provider.describe && !missingCredential(provider.id));
    // Preserve the existing OpenAI-first default preference through provider metadata order.
    const preferred = [...ready].reverse().find((provider) => provider.defaultDescriptionModel)?.defaultDescriptionModel;
    const fallback = [...providerRegistry.providers].reverse().find((provider) => provider.defaultDescriptionModel)?.defaultDescriptionModel || DESCRIPTION_MODELS[0]?.id || "";
    buildMenu("describeModel", DESCRIPTION_MODELS.map((model) => ({
      value: model.id, label: model.estimateRangeUSD ? `${model.label} (ca. ${formatMoneyRange(...model.estimateRangeUSD)})` : `${model.label} (price unknown)`,
    })), current || (stored && !missingCredential(stored.provider) ? stored.id : preferred || fallback));
  }

  function captureSettings(): ModelSettings {
    const spec = modelSpec(activeModel || $("model")?.value || DEFAULT_MODEL);
    const normalized = normalizeModelSettings(spec, {
      resolution: $("resolution")?.value, ratio: $("selRatio")?.value, quality: $("quality")?.value,
      options: options.read(),
    });
    return freezeModelSettings(normalized.settings);
  }

  function persistModel(): void {
    if (activeModel) saveModelPreferences(modelSpec(activeModel), captureSettings());
  }

  function refreshResolutionLabels(): void {
    const spec = modelSpec($("model")?.value || DEFAULT_MODEL);
    const settings = captureSettings();
    buildMenu("resolution", ["auto", ...spec.imageSizes].map((size) => ({
      value: size, label: resolutionMenuLabel(size, spec, settings.ratio, settings.quality, settings),
    })), settings.resolution);
    persistModel();
  }

  function applyModelCapabilities(modelId: string, preferRatio?: string, preferSize?: string, preferQuality?: string, archived?: ModelSettings): string {
    const spec = modelSpec(modelId);
    const loaded = loadModelPreferences(spec);
    const normalized = normalizeModelSettings(spec, archived || {
      ...loaded.settings,
      ...(preferRatio ? { ratio: preferRatio } : {}),
      ...(preferSize ? { resolution: preferSize } : {}),
      ...(preferQuality ? { quality: preferQuality } : {}),
      // Old archives have no extra options: restore defaults for those fields.
      ...(preferRatio ? { options: {} } : {}),
    });
    const { settings } = normalized;
    activeModel = modelId;
    if ($("qualityField")) $("qualityField").style.display = spec.qualities.length > 1 ? "flex" : "none";
    buildMenu("quality", spec.qualities.map((value) => ({ value, label: imageQualityLabel(value) })), settings.quality);
    buildMenu("selRatio", spec.aspectRatios.map((value) => ({ value, label: value })), settings.ratio);
    buildMenu("resolution", ["auto", ...spec.imageSizes].map((value) => ({
      value, label: resolutionMenuLabel(value, spec, settings.ratio, settings.quality, settings),
    })), settings.resolution);
    options.render(spec, settings.options, onOptionChange);
    saveModelPreferences(spec, settings);
    return [...loaded.notes, ...normalized.notes].join(" ");
  }

  function onOptionChange(): void {
    const spec = modelSpec(activeModel);
    const current = normalizeModelSettings(spec, { ...captureSettings(), options: options.read() });
    options.render(spec, current.settings.options, onOptionChange);
    saveModelPreferences(spec, current.settings);
    refreshResolutionLabels();
    if (current.notes.length) setStatus(current.notes.join(" "));
  }

  async function updateExchangeRates(): Promise<void> {
    await refreshExchangeRates();
    refreshCurrencyLabels();
  }
  function refreshCurrencyLabels(): void {
    $("currencyNote").textContent = currencyNote();
    refreshResolutionLabels();
    refreshDescriptionModelSelection($("describeModel")?.value);
    renderBudget();
  }

  async function restoreSettings(): Promise<string> {
    buildMenu("displayCurrency", CURRENCIES, displayCurrency());
    $("currencyNote").textContent = currencyNote();
    await restoreProviderSettings(() => refreshDescriptionModelSelection());
    refreshDescriptionModelSelection();
    buildMenu("model", MODELS.filter((model) => model.visible !== false).map((model) => ({ value: model.id, label: model.label })), DEFAULT_MODEL);
    const stored = loadSetting("model", "");
    if (stored && hasOption($("model"), stored)) setPickerSafe($("model"), stored);
    const note = applyModelCapabilities($("model").value || DEFAULT_MODEL);
    for (const [id, fallback] of [["includeSelection", "1"], ["placeAsSmartObject", "1"], ["reduceDocumentSize", "0"]]) {
      setCheckedSafe($(id), loadSetting(id, fallback) !== "0");
    }
    return note;
  }

  function persistSettingsHooks(): void {
    $("displayCurrency")?.addEventListener("change", () => {
      setDisplayCurrency($("displayCurrency").value);
      refreshCurrencyLabels();
      void updateExchangeRates();
    });
    // Keep the native picker's items intact while it commits its selection.
    // Resolution changes do not affect the option labels or available tiers.
    $("resolution")?.addEventListener("change", persistModel);
    for (const id of ["quality", "selRatio"]) $(id)?.addEventListener("change", () => {
      persistModel(); refreshResolutionLabels();
    });
    $("model")?.addEventListener("change", () => {
      const model = $("model").value || DEFAULT_MODEL;
      const note = applyModelCapabilities(model);
      saveSetting("model", model);
      if (note) setStatus(note);
      onSelectionChange();
    });
    for (const id of ["includeSelection", "placeAsSmartObject", "reduceDocumentSize"]) $(id)?.addEventListener("change", () => {
      saveSetting(id, isChecked($(id)) ? "1" : "0");
      if (id === "includeSelection") onSelectionChange();
    });
    $("describeModel")?.addEventListener("change", () => saveSetting("describeModel", $("describeModel").value || ""));
  }
  return { restoreSettings, persistSettingsHooks, applyModelCapabilities, captureSettings, refreshDescriptionModelSelection, refreshResolutionLabels, updateExchangeRates };
}
export type SettingsController = ReturnType<typeof createSettingsController>;
