/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ProviderDefinition } from "./contract";

// Construct once at startup. Also usable with isolated provider fixtures in tests.
export function createProviderRegistry(definitions: ProviderDefinition[]) {
  const providers = new Map<string, ProviderDefinition>();
  const models = definitions.flatMap((provider) => provider.models);
  const descriptionModels = definitions.flatMap((provider) => provider.descriptionModels || []);
  const modelIds = new Set<string>();
  for (const provider of definitions) {
    if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || providers.has(provider.id)) {
      throw new Error(`Invalid or duplicate provider ID: ${provider.id}`);
    }
    providers.set(provider.id, provider);
    const credentialIds = new Set<string>();
    for (const credential of provider.credentials) {
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(credential.id) || credentialIds.has(credential.id)) {
        throw new Error(`Invalid or duplicate credential ID: ${credential.id}`);
      }
      credentialIds.add(credential.id);
    }
    for (const model of [...provider.models, ...(provider.descriptionModels || [])]) {
      if (!model.id || model.provider !== provider.id || modelIds.has(model.id)) {
        throw new Error(`Invalid or duplicate model registration: ${model.id}`);
      }
      modelIds.add(model.id);
    }
    if (provider.models.length && !provider.generate) throw new Error(`${provider.label} needs a generation adapter.`);
    if (provider.descriptionModels?.length && !provider.describe) throw new Error(`${provider.label} needs a description adapter.`);
    for (const model of provider.models) {
      if (!model.apiModel || !model.aspectRatios.length || !model.qualities.length ||
          !model.qualities.includes(model.defaults.quality) || !model.aspectRatios.includes(model.defaults.ratio) ||
          !Number.isFinite(model.inputs.maxEdge) || model.inputs.maxEdge < 1 ||
          !Number.isInteger(model.inputs.references) || model.inputs.references < 0) {
        throw new Error(`Invalid capabilities for ${model.id}`);
      }
      const keys = new Set<string>();
      for (const field of model.settings || []) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(field.key) || ["__proto__", "constructor", "prototype"].includes(field.key) || keys.has(field.key)) {
          throw new Error(`Invalid or duplicate setting: ${model.id}.${field.key}`);
        }
        keys.add(field.key);
        if ((field.type === "select" && !field.options.some((option) => option.value === field.default)) ||
            (field.type === "number" && (!Number.isFinite(field.default) || field.default < (field.min ?? -Infinity) ||
              field.default > (field.max ?? Infinity) || (field.step !== undefined && (!Number.isFinite(field.step) || field.step <= 0))))) {
          throw new Error(`Invalid setting default or range: ${model.id}.${field.key}`);
        }
      }
    }
  }
  return {
    providers: [...definitions], models, descriptionModels,
    provider(id: string) {
      const provider = providers.get(id);
      if (!provider) throw new Error(`Provider unavailable: ${id}`);
      return provider;
    },
    model(id: string) {
      const model = models.find((item) => item.id === id);
      if (!model) throw new Error(`Model unavailable: ${id}`);
      return model;
    },
  };
}
