/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ProviderDefinition, type ProviderRequest } from "../../src/providers/contract";
import { encodePng } from "../../src/images/codec";

export const exampleRequests: ProviderRequest[] = [];
export const exampleProvider: ProviderDefinition = {
  id: "example", label: "Example", domains: ["https://example.invalid"],
  credentials: [
    { id: "token", label: "Example token", secret: true, required: true },
    { id: "region", label: "Example region", secret: false, required: true },
  ],
  models: [{
    id: "example:artist", provider: "example", apiModel: "artist-v7", label: "Example Artist",
    imageSizes: ["1K", "2K"], aspectRatios: ["1:1", "2:1"], qualities: ["draft", "studio"],
    defaults: { resolution: "1K", ratio: "1:1", quality: "draft" },
    inputs: { canvas: false, references: 2, maxEdge: 1024 }, settingsVersion: 2,
    settings: [
      { key: "seed", label: "Seed", type: "number", default: 1, min: 0, max: 100, step: 1 },
      { key: "style", label: "Style", type: "select", default: "photo", options: [{ value: "photo", label: "Photo" }, { value: "ink", label: "Ink" }] },
      { key: "transparent", label: "Transparency", type: "boolean", default: false },
      { key: "negative", label: "Avoid", type: "text", default: "", maxLength: 100 },
    ],
    migrateSettings: (old) => ({ ...old, options: { ...old.options, seed: old.options.oldSeed ?? 1 } }),
    validateSettings: (settings) => settings.quality === "studio" && settings.resolution === "2K" ? "Studio supports 1K only." : null,
    estimateCost: (settings) => settings.quality === "studio" ? 0.4 : 0.2,
  }],
  async generate(request) {
    request.onDispatch?.();
    exampleRequests.push(request);
    return { mimeType: "image/png", bytes: encodePng(Uint8Array.of(10, 20, 30, 255), 1, 1, 4), costUSD: 0.25 };
  },
};
