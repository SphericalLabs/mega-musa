/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const GEMINI_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_OUTPUT_TOKENS = 8192;

export type DescriptionProvider = "openai" | "gemini";
export type OpenAIReasoningEffort = "none" | "high";
export type GeminiThinkingLevel = "minimal" | "low" | "high";

export interface DescriptionModelSpec {
  id: string;
  label: string;
  provider: DescriptionProvider;
  model: string;
  effort: OpenAIReasoningEffort | GeminiThinkingLevel;
}

export const DEFAULT_OPENAI_DESCRIPTION_MODEL = "openai:gpt-5.6-luna:high";
export const DEFAULT_GEMINI_DESCRIPTION_MODEL = "gemini:gemini-3.7-flash:high";

export const DESCRIPTION_MODELS: ReadonlyArray<DescriptionModelSpec> = [
  {
    id: "openai:gpt-5.6-luna:none",
    label: "OpenAI Luna — Reasoning: None (ca. CHF 0.001–0.002)",
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "none",
  },
  {
    id: DEFAULT_OPENAI_DESCRIPTION_MODEL,
    label: "OpenAI Luna — Reasoning: High (ca. CHF 0.002–0.01)",
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "high",
  },
  {
    id: "openai:gpt-5.6-sol:none",
    label: "OpenAI Sol — Reasoning: None (ca. CHF 0.01–0.03)",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "none",
  },
  {
    id: "openai:gpt-5.6-sol:high",
    label: "OpenAI Sol — Reasoning: High (ca. CHF 0.03–0.15)",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
  },
  {
    id: "gemini:gemini-3.5-flash-lite:minimal",
    label: "Gemini Flash-Lite — Thinking: Minimal (ca. CHF 0.001–0.002)",
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    effort: "minimal",
  },
  {
    id: "gemini:gemini-3.5-flash-lite:high",
    label: "Gemini Flash-Lite — Thinking: High (ca. CHF 0.003–0.02)",
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    effort: "high",
  },
  {
    id: "gemini:gemini-3.7-flash:low",
    label: "Gemini 3.7 Flash — Thinking: Low (ca. CHF 0.002–0.008)",
    provider: "gemini",
    model: "gemini-3.7-flash",
    effort: "low",
  },
  {
    id: DEFAULT_GEMINI_DESCRIPTION_MODEL,
    label: "Gemini 3.7 Flash — Thinking: High (ca. CHF 0.005–0.03)",
    provider: "gemini",
    model: "gemini-3.7-flash",
    effort: "high",
  },
];

export interface DescriptionImage {
  mimeType: string;
  base64: string;
}

export interface DescriptionUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface DescriptionResult {
  descriptions: string[];
  usage?: DescriptionUsage;
}

export interface DescribeImagesOptions {
  apiKey: string;
  model: DescriptionModelSpec;
  images: DescriptionImage[];
  signal?: AbortSignal;
}

const DESCRIPTION_INSTRUCTIONS = `You write precise, visually actionable descriptions for an image-generation or image-editing prompt field.

Describe every supplied visual input in high detail regarding all relevant elements, composition, style, lighting, color palette, contrast, materials, textures, spatial relationships, viewpoint, framing, depth of field, environment and legible text. Cover subjects, objects, poses, expressions and distinctive fine details whenever present.

State only what is visibly supported. Do not invent identities, brands, artist names, hidden details, camera settings or intended edits. When something is uncertain, describe it conservatively. Describe the visual content rather than critiquing it, explaining it or proposing changes.

Return exactly one self-contained description for each input in the exact input order. Keep different images separate and do not merge them into one scene. Do not include image labels; the application adds them. Do not include a preamble, conclusion or safety commentary.

For one input, target 250–450 words. For multiple inputs, target 100–200 words per input.`;

function descriptionSchema(imageCount: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      descriptions: {
        type: "array",
        minItems: imageCount,
        maxItems: imageCount,
        items: { type: "string" },
      },
    },
    required: ["descriptions"],
    additionalProperties: false,
  };
}

function finiteNumber(value: any): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function requestInit(body: unknown, headers: Record<string, string>, signal?: AbortSignal): any {
  const init: any = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return init;
}

function parseDescriptionJson(text: string, imageCount: number): string[] {
  let candidate = text.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("The description model returned invalid structured text.");
  }

  const descriptions = parsed?.descriptions;
  if (!Array.isArray(descriptions) || descriptions.length !== imageCount) {
    throw new Error(
      `The description model returned ${Array.isArray(descriptions) ? descriptions.length : 0} descriptions for ${imageCount} inputs.`
    );
  }
  const clean = descriptions.map((description: unknown) =>
    typeof description === "string" ? description.trim() : ""
  );
  if (clean.some((description: string) => !description)) {
    throw new Error("The description model returned an empty image description.");
  }
  return clean;
}

function openAIOutputText(json: any): string {
  const pieces: string[] = [];
  for (const item of json?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        pieces.push(content.text);
      } else if (content?.type === "refusal" && content.refusal) {
        throw new Error(String(content.refusal));
      }
    }
  }
  return pieces.join("").trim();
}

async function describeWithOpenAI(opts: DescribeImagesOptions): Promise<DescriptionResult> {
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

  let response: Response;
  try {
    response = await fetch(
      OPENAI_RESPONSES_ENDPOINT,
      requestInit(body, { Authorization: `Bearer ${opts.apiKey}` }, opts.signal)
    );
  } catch (error: any) {
    throw new Error(`OpenAI description request failed before an HTTP response: ${error?.message || error}`);
  }

  const json: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(json?.error?.message || json?.error || `HTTP ${response.status} ${response.statusText}`));
  }
  const text = openAIOutputText(json);
  if (!text) throw new Error("OpenAI returned no image description.");

  const usage = json?.usage;
  return {
    descriptions: parseDescriptionJson(text, opts.images.length),
    usage: usage
      ? {
          inputTokens: finiteNumber(usage.input_tokens),
          outputTokens: finiteNumber(usage.output_tokens),
          reasoningTokens: finiteNumber(usage.output_tokens_details?.reasoning_tokens),
          totalTokens: finiteNumber(usage.total_tokens),
        }
      : undefined,
  };
}

function geminiOutputText(json: any): string {
  const pieces: string[] = [];
  for (const candidate of json?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (!part?.thought && typeof part?.text === "string") pieces.push(part.text);
    }
  }
  return pieces.join("").trim();
}

async function describeWithGemini(opts: DescribeImagesOptions): Promise<DescriptionResult> {
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

  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_MODELS_ENDPOINT}/${encodeURIComponent(opts.model.model)}:generateContent`,
      requestInit(body, { "x-goog-api-key": opts.apiKey }, opts.signal)
    );
  } catch (error: any) {
    throw new Error(`Gemini description request failed before an HTTP response: ${error?.message || error}`);
  }

  const json: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(json?.error?.message || json?.error || `HTTP ${response.status} ${response.statusText}`));
  }
  const text = geminiOutputText(json);
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini returned no description (${reason}).` : "Gemini returned no image description.");
  }

  const usage = json?.usageMetadata;
  return {
    descriptions: parseDescriptionJson(text, opts.images.length),
    usage: usage
      ? {
          inputTokens: finiteNumber(usage.promptTokenCount),
          outputTokens: finiteNumber(usage.candidatesTokenCount),
          reasoningTokens: finiteNumber(usage.thoughtsTokenCount),
          totalTokens: finiteNumber(usage.totalTokenCount),
        }
      : undefined,
  };
}

export function descriptionModelSpec(id: string): DescriptionModelSpec | null {
  return DESCRIPTION_MODELS.find((model) => model.id === id) || null;
}

export async function describeImages(opts: DescribeImagesOptions): Promise<DescriptionResult> {
  if (!opts.images.length) throw new Error("Provide at least one image to describe.");
  return opts.model.provider === "openai" ? describeWithOpenAI(opts) : describeWithGemini(opts);
}
