/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { checkGeminiOutput, requestJson } from "../errors";
import {
  DESCRIPTION_INSTRUCTIONS,
  MAX_OUTPUT_TOKENS,
  descriptionSchema,
  finiteNumber,
  parseDescriptionJson,
  requestInit,
} from "./description-format";
import {
  type DescribeImagesOptions,
  type DescriptionResult,
  type DescriptionUsage,
  type GeminiThinkingLevel,
} from "./description-types";

const GEMINI_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function geminiOutputText(json: any): string {
  const pieces: string[] = [];
  for (const candidate of json?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (!part?.thought && typeof part?.text === "string") pieces.push(part.text);
    }
  }
  return pieces.join("").trim();
}

export async function describeWithGemini(opts: DescribeImagesOptions): Promise<DescriptionResult> {
  const parts: any[] = [
    {
      text: `Describe all ${opts.images.length} supplied visual input${opts.images.length === 1 ? "" : "s"} in exact order.`,
    },
  ];
  for (const image of opts.images) {
    parts.push({
      inlineData: { mimeType: image.mimeType, data: image.base64 },
      mediaResolution: { level: "media_resolution_high" },
    });
  }

  const body = {
    systemInstruction: { parts: [{ text: DESCRIPTION_INSTRUCTIONS }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: opts.model.effort as GeminiThinkingLevel },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseJsonSchema: descriptionSchema(opts.images.length),
    },
  };

  const json = await requestJson("Gemini", `${GEMINI_MODELS_ENDPOINT}/${encodeURIComponent(opts.model.model)}:generateContent`,
    requestInit(body, { "x-goog-api-key": opts.apiKey }, opts.signal));
  const rawUsage = json?.usageMetadata;
  const candidates = finiteNumber(rawUsage?.candidatesTokenCount);
  const thoughts = finiteNumber(rawUsage?.thoughtsTokenCount);
  const usage: DescriptionUsage | undefined = rawUsage
    ? {
      inputTokens: finiteNumber(rawUsage.promptTokenCount),
      cachedInputTokens: finiteNumber(rawUsage.cachedContentTokenCount),
      // Gemini reports thinking separately; OpenAI includes it in output_tokens.
      outputTokens: candidates === undefined ? undefined : candidates + (thoughts ?? 0),
      reasoningTokens: thoughts,
      totalTokens: finiteNumber(rawUsage.totalTokenCount),
    }
    : undefined;
  opts.onUsage?.(usage);
  checkGeminiOutput(json);
  const text = geminiOutputText(json);
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini returned no description (${reason}).` : "Gemini returned no image description.");
  }

  return { descriptions: parseDescriptionJson(text, opts.images.length), usage };
}
