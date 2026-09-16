/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { apiError, providerError } from "../../errors";

function geminiError(code: string, input: boolean, ratings: any, message: unknown, apiKey?: string): Error {
  const reasons: Record<string, string> = {
    SAFETY: "a safety check",
    IMAGE_SAFETY: "an image safety check",
    PROHIBITED_CONTENT: "prohibited content",
    IMAGE_PROHIBITED_CONTENT: "prohibited image content",
    BLOCKLIST: "blocked terms",
    SPII: "potential sensitive personal information",
    RECITATION: "potential reproduction of existing content",
    IMAGE_RECITATION: "potential reproduction of existing image content",
    ESCALATION: "an escalation rule",
  };
  // Ratings can include categories that passed. Only blocked ratings explain a block.
  const categories = Array.isArray(ratings) ? [...new Set(ratings
    .filter((rating: any) => rating?.blocked === true && typeof rating.category === "string"
      && rating.category !== "HARM_CATEGORY_UNSPECIFIED")
    .map((rating: any) => rating.category.replace(/^HARM_CATEGORY_/, "").replace(/_/g, " ").toLowerCase()))].join(", ") : "";
  let help: string;
  if (input || reasons[code] || categories) {
    const subject = input ? "Input" : code.startsWith("IMAGE_") ? "Generated image" : "Generated output";
    help = `${subject} blocked`;
    help += categories ? ` — ${categories}.` : reasons[code] ? ` by ${reasons[code]}.` : ".";
    if (input) help += " Exact text or image not identified.";
    if (!categories && !reasons[code] && !(typeof message === "string" && message.trim())) {
      help += " The server provided no specific reason.";
    }
  } else if (code === "OTHER" || code === "IMAGE_OTHER") {
    help = "Generation stopped for an unspecified reason.";
  } else if (code === "NO_IMAGE") {
    help = "The model returned no image.";
  } else {
    return apiError("Gemini", { code, message }, undefined, apiKey);
  }
  return providerError("Gemini", help, code, message, apiKey);
}

export function checkGeminiOutput(json: any, apiKey?: string): void {
  const block = json?.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
    throw geminiError(block, true, json.promptFeedback.safetyRatings, undefined, apiKey);
  }
  for (const candidate of json?.candidates || []) {
    const code = candidate?.finishReason;
    if (code && code !== "STOP" && code !== "FINISH_REASON_UNSPECIFIED") {
      throw geminiError(code, false, candidate.safetyRatings, candidate.finishMessage, apiKey);
    }
  }
}
