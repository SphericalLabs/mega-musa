/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import {
  CURRENCIES,
  currencyNote,
  displayCurrency,
  formatMoneyRange,
  refreshExchangeRates,
  setDisplayCurrency,
} from "../currency";
import { DEFAULT_MODEL, MODELS, modelSpec } from "../models/catalog";
import {
  DEFAULT_GEMINI_DESCRIPTION_MODEL,
  DEFAULT_OPENAI_DESCRIPTION_MODEL,
  DESCRIPTION_MODELS,
  descriptionModelSpec,
} from "../models/description-catalog";
import { nearestImageSize, nearestRatioLabel } from "../models/geometry";
import { resolutionLabel, resolutionMenuLabel } from "../models/labels";
import { isOpenAIModel } from "../models/provider";
import { IMAGE_QUALITY_OPTIONS, normalizeImageQuality } from "../models/quality";
import { type DescriptionModelSpec } from "../providers/description-types";
import { type ImageQuality } from "../providers/types";
import { loadApiKey, loadOpenAIApiKey, loadSetting, saveSetting } from "../storage";
import { $, buildMenu, hasOption, isChecked, setCheckedSafe, setPickerSafe, setValueSafe } from "./controls";
import { renderBudget, setStatus } from "./status";

export function descriptionApiKey(model: DescriptionModelSpec): string {
  return String(model.provider === "openai" ? $("openaiApiKey")?.value || "" : $("geminiApiKey")?.value || "").trim();
}

export function createSettingsController(onSelectionChange: () => void) {
  const PICKERS = ["model", "resolution", "quality", "selRatio"];

  function buildModelMenu(): void {
    // Retain hidden models in the table for archive recall.
    const visibleModels = MODELS.filter((model) =>
      ["gemini-3-pro-image", "gemini-3.1-flash-image", "openai:gpt-image-2.5-sunburst", "openai:gpt-image-2.5-flare", "openai:gpt-image-2"].includes(model.id)
    );
    buildMenu(
      "model",
      visibleModels.map((m) => ({ value: m.id, label: m.label })),
      DEFAULT_MODEL
    );
  }

  function preferredDescriptionModel(): string {
    const hasOpenAIKey = String($("openaiApiKey")?.value || "").trim().length > 0;
    const hasGeminiKey = String($("geminiApiKey")?.value || "").trim().length > 0;
    if (hasOpenAIKey) return DEFAULT_OPENAI_DESCRIPTION_MODEL;
    if (hasGeminiKey) return DEFAULT_GEMINI_DESCRIPTION_MODEL;
    return DEFAULT_OPENAI_DESCRIPTION_MODEL;
  }

  function refreshDescriptionModelSelection(current?: string): void {
    const stored = loadSetting("describeModel", "");
    const storedSpec = descriptionModelSpec(stored);
    const selected = storedSpec && descriptionApiKey(storedSpec) ? stored : preferredDescriptionModel();
    buildMenu(
      "describeModel",
      DESCRIPTION_MODELS.map((model) => ({
        value: model.id, label: `${model.label} (ca. ${formatMoneyRange(...model.estimateRangeUSD)})`,
      })),
      current || selected
    );
  }

  function refreshCurrencyLabels(): void {
    $("currencyNote").textContent = currencyNote();
    refreshResolutionLabels();
    refreshDescriptionModelSelection($("describeModel")?.value);
    renderBudget();
  }

  async function updateExchangeRates(): Promise<void> {
    await refreshExchangeRates();
    refreshCurrencyLabels();
  }

  function buildQualityMenu(modelId: string, selected: string): ImageQuality {
    const field = $("qualityField");
    const openai = isOpenAIModel(modelId);
    if (field) field.style.display = openai ? "flex" : "none";
    if (!openai) {
      setValueSafe($("quality"), "auto");
      return "auto";
    }
    const spec = modelSpec(modelId);
    const options = IMAGE_QUALITY_OPTIONS.filter((option) =>
      option.value === "auto" || (spec.outputQualityFactors
        ? spec.outputQualityFactors[option.value] !== undefined
        : option.value !== "xhigh" && option.value !== "max")
    );
    const requested = normalizeImageQuality(selected);
    const quality = options.some((option) => option.value === requested) ? requested : "high";
    buildMenu(
      "quality",
      options.map((option) => ({ value: option.value, label: option.label })),
      quality
    );
    saveSetting("quality", quality);
    return quality;
  }

  function buildResolutionMenu(
    spec: ReturnType<typeof modelSpec>,
    ratio: string,
    selected: string,
    quality: ImageQuality = "auto"
  ): string {
    const size = nearestImageSize(selected, spec);
    buildMenu(
      "resolution",
      [{ value: "auto", label: resolutionMenuLabel("auto", spec, ratio, quality) }].concat(
        spec.imageSizes.map((s) => ({ value: s, label: resolutionMenuLabel(s, spec, ratio, quality) }))
      ),
      size
    );
    saveSetting("resolution", size);
    return size;
  }

  function refreshResolutionLabels(): void {
    const model = $("model")?.value || DEFAULT_MODEL;
    const spec = modelSpec(model);
    const quality = isOpenAIModel(model) ? normalizeImageQuality($("quality")?.value || "auto") : "auto";
    buildResolutionMenu(spec, $("selRatio")?.value || "1:1", $("resolution")?.value || "auto", quality);
  }

  // Restore preferred settings and reconcile them with model capabilities. Return notes
  // for adjusted ratio or resolution choices.
  function applyModelCapabilities(
    modelId: string,
    preferRatio?: string,
    preferSize?: string,
    preferQuality?: string
  ): string {
    const spec = modelSpec(modelId);
    const notes: string[] = [];
    const quality = buildQualityMenu(
      modelId,
      isOpenAIModel(modelId)
        ? preferQuality || loadSetting("quality", "low")
        : "auto"
    );

    const wantRatio = preferRatio || $("selRatio")?.value || "1:1";
    const ratio = nearestRatioLabel(wantRatio, spec.aspectRatios);
    buildMenu(
      "selRatio",
      spec.aspectRatios.map((r) => ({ value: r, label: r })),
      ratio
    );
    saveSetting("selRatio", ratio);
    if (ratio !== wantRatio) {
      notes.push(`${spec.label} cannot do ${wantRatio} — ratio set to ${ratio}.`);
    }

    const wantSize = preferSize || $("resolution")?.value || "auto";
    const size = buildResolutionMenu(spec, ratio, wantSize, quality);
    if (size !== wantSize) {
      notes.push(
        spec.imageSizes.length
          ? `${spec.label} does not output ${resolutionLabel(wantSize)} — resolution set to ${resolutionLabel(size)}.`
          : `${spec.label} has no resolution control — its output size follows the ratio.`
      );
    }
    return notes.join(" ");
  }

  async function restoreSettings(): Promise<void> {
    buildMenu("displayCurrency", CURRENCIES, displayCurrency());
    $("currencyNote").textContent = currencyNote();
    setValueSafe($("geminiApiKey"), await loadApiKey());
    setValueSafe($("openaiApiKey"), await loadOpenAIApiKey());
    refreshDescriptionModelSelection();
    // Restore only visible model options so stale settings cannot leave the picker blank.
    buildModelMenu();
    const storedModel = loadSetting("model", "");
    if (storedModel && hasOption($("model"), storedModel)) setPickerSafe($("model"), storedModel);
    else if (storedModel) saveSetting("model", "");
    applyModelCapabilities(
      $("model").value || DEFAULT_MODEL,
      loadSetting("selRatio", "1:1"),
      loadSetting("resolution", "2K"),
      loadSetting("quality", "low")
    );
    // Lossy document-size reduction is opt-in.
    setCheckedSafe($("includeSelection"), loadSetting("includeSelection", "1") !== "0");
    refreshResolutionLabels();
    setCheckedSafe($("placeAsSmartObject"), loadSetting("placeAsSmartObject", "1") !== "0");
    setCheckedSafe($("reduceDocumentSize"), loadSetting("reduceDocumentSize", "0") !== "0");
  }

  function persistSettingsHooks(): void {
    $("displayCurrency")?.addEventListener("change", () => {
      setDisplayCurrency($("displayCurrency").value);
      refreshCurrencyLabels();
      void updateExchangeRates();
    });
    for (const id of PICKERS) {
      if (id === "selRatio" || id === "quality") continue;
      $(id)?.addEventListener("change", () => saveSetting(id, $(id).value));
    }
    $("quality")?.addEventListener("change", () => {
      saveSetting("quality", normalizeImageQuality($("quality").value || "auto"));
      refreshResolutionLabels();
    });
    $("selRatio")?.addEventListener("change", () => {
      saveSetting("selRatio", $("selRatio").value);
      refreshResolutionLabels();
    });
    $("model")?.addEventListener("change", () => {
      const note = applyModelCapabilities($("model").value || DEFAULT_MODEL);
      if (note) setStatus(note);
    });
    $("includeSelection")?.addEventListener("change", () => {
      saveSetting("includeSelection", isChecked($("includeSelection")) ? "1" : "0");
      onSelectionChange();
    });
    $("placeAsSmartObject")?.addEventListener("change", () =>
      saveSetting("placeAsSmartObject", isChecked($("placeAsSmartObject")) ? "1" : "0")
    );
    $("reduceDocumentSize")?.addEventListener("change", () =>
      saveSetting("reduceDocumentSize", isChecked($("reduceDocumentSize")) ? "1" : "0")
    );
    $("describeModel")?.addEventListener("change", () =>
      saveSetting("describeModel", $("describeModel").value || DEFAULT_OPENAI_DESCRIPTION_MODEL)
    );
  }
  return { restoreSettings, persistSettingsHooks, applyModelCapabilities, refreshDescriptionModelSelection, refreshResolutionLabels, updateExchangeRates };
}
export type SettingsController = ReturnType<typeof createSettingsController>;
