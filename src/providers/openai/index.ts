/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ProviderDefinition } from "../contract";
import { generateOpenAIImage } from "./images";
import { describeWithOpenAI } from "./descriptions";
import { models } from "./models";
import { descriptionModels, DEFAULT_OPENAI_DESCRIPTION_MODEL } from "./description-models";

export const openai: ProviderDefinition = {
  id: "openai", label: "OpenAI", domains: ["https://api.openai.com"],
  credentials: [{ id: "apiKey", label: "OpenAI API key", secret: true, required: true, fieldId: "openaiApiKey", buttonId: "saveOpenAIKey" }],
  models, descriptionModels, defaultDescriptionModel: DEFAULT_OPENAI_DESCRIPTION_MODEL,
  generate(request) {
    const { frame, settings, model } = request;
    if (!frame.width || !frame.height) throw new Error("The OpenAI output size is missing.");
    return generateOpenAIImage({
      ...request, model: model.apiModel, size: `${frame.width}x${frame.height}`, quality: settings.quality,
      background: settings.options.transparent === true ? "transparent" : "opaque",
    });
  },
  describe: describeWithOpenAI,
};
