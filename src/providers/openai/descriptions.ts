/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { checkOpenAIOutput } from "./errors";
import { apiError, requestJson } from "../../errors";
import {
  DESCRIPTION_INSTRUCTIONS,
  MAX_OUTPUT_TOKENS,
  descriptionSchema,
  finiteNumber,
  parseDescriptionJson,
  requestInit,
} from "../description-format";
import {
  type DescribeImagesOptions,
  type DescriptionResult,
  type DescriptionUsage,
} from "../description-types";

export type OpenAIReasoningEffort = "none" | "high";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

function openAIOutputText(json: any): string {
  const pieces: string[] = [];
  for (const item of json?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        pieces.push(content.text);
      } else if (content?.type === "refusal" && content.refusal) {
        throw apiError("OpenAI", { code: "refusal", message: content.refusal });
      }
    }
  }
  return pieces.join("").trim();
}

export async function describeWithOpenAI(opts: DescribeImagesOptions): Promise<DescriptionResult> {
  const body = {
    model: opts.model.model,
    store: false,
    instructions: DESCRIPTION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Describe all ${opts.images.length} supplied visual input${opts.images.length === 1 ? "" : "s"} in exact order.`,
          },
          ...opts.images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.base64}`,
            detail: "high",
          })),
        ],
      },
    ],
    reasoning: { effort: opts.model.effort as OpenAIReasoningEffort },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "image_descriptions",
        strict: true,
        schema: descriptionSchema(opts.images.length),
      },
    },
  };

  if (opts.signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  opts.onDispatch?.();
  const json = await requestJson("OpenAI", OPENAI_RESPONSES_ENDPOINT,
    requestInit(body, { Authorization: `Bearer ${opts.apiKey}` }, opts.signal));
  const rawUsage = json?.usage;
  const usage: DescriptionUsage | undefined = rawUsage
    ? {
      inputTokens: finiteNumber(rawUsage.input_tokens),
      cachedInputTokens: finiteNumber(rawUsage.input_tokens_details?.cached_tokens),
      cacheWriteInputTokens: finiteNumber(rawUsage.input_tokens_details?.cache_write_tokens),
      outputTokens: finiteNumber(rawUsage.output_tokens),
      reasoningTokens: finiteNumber(rawUsage.output_tokens_details?.reasoning_tokens),
      totalTokens: finiteNumber(rawUsage.total_tokens),
      serviceTier: json?.service_tier,
    }
    : undefined;
  opts.onUsage?.(usage);
  checkOpenAIOutput(json);
  const text = openAIOutputText(json);
  if (!text) throw new Error("OpenAI returned no image description.");
  return { descriptions: parseDescriptionJson(text, opts.images.length), usage };
}
