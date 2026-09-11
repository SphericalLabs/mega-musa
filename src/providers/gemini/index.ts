/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ProviderDefinition } from "../contract";
import { generateEdit } from "./images";
import { describeWithGemini } from "./descriptions";
import { models } from "./models";
import { descriptionModels, DEFAULT_GEMINI_DESCRIPTION_MODEL } from "./description-models";

export const gemini: ProviderDefinition = {
  id: "gemini", label: "Gemini", domains: ["https://generativelanguage.googleapis.com"],
  credentials: [{ id: "apiKey", label: "Gemini API key", secret: true, required: true, fieldId: "geminiApiKey", buttonId: "saveGeminiKey" }],
  models, descriptionModels, defaultDescriptionModel: DEFAULT_GEMINI_DESCRIPTION_MODEL,
  generate(request) {
    return generateEdit({ ...request, model: request.model.apiModel, aspectRatio: request.frame.label,
      imageSize: request.settings.resolution === "auto" ? undefined : request.settings.resolution });
  },
  describe: describeWithGemini,
};
