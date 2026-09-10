/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
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

import { requestJson, checkOpenAIOutput } from "./errors";

import { base64ToBytes } from "./image-codec";
import {
  ImageQuality,
  ImageUsage,
  normalizeImageQuality,
  RefImage,
  GenerateResult,
} from "./gemini";

const EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits";
const GENERATIONS_ENDPOINT = "https://api.openai.com/v1/images/generations";

export const OPENAI_MODEL_PREFIX = "openai:";

export interface OpenAIGenerateOptions {
  apiKey: string;
  model: string;
  prompt: string;
  baseImagePng?: Uint8Array;
  references: RefImage[];
  size: string; // Exact pixel dimensions, e.g. "1456x1088".
  quality?: ImageQuality;
  signal?: AbortSignal;
}

// Flexible output limits; dimensions also use a 16px grid and at most a 3:1 ratio.
const G2_MAX_EDGE = 3840;
const G2_MIN_PX = 655360;
const G2_MAX_PX = 8294400;

function finiteNumber(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function usageFromApi(value: any): ImageUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value.input_tokens_details || value.inputTokensDetails || {};
  const quality = value.quality;
  const usage: ImageUsage = {
    quality:
      quality === "low" || quality === "medium" || quality === "high" || quality === "xhigh" || quality === "max" || quality === "auto"
        ? quality
        : undefined,
    inputTokens: finiteNumber(value.input_tokens ?? value.inputTokens),
    inputImageTokens: finiteNumber(details.image_tokens ?? details.imageTokens),
    inputTextTokens: finiteNumber(details.text_tokens ?? details.textTokens),
    outputTokens: finiteNumber(value.output_tokens ?? value.outputTokens),
    totalTokens: finiteNumber(value.total_tokens ?? value.totalTokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function resultFromJson(json: any): GenerateResult | null {
  const first = json?.data?.[0];
  if (!first?.b64_json) return null;
  const rawUsage = json?.usage || first?.usage;
  return {
    mimeType: `image/${json?.output_format || first?.output_format || "png"}`,
    bytes: base64ToBytes(first.b64_json),
    usage: usageFromApi(
      rawUsage ? { ...rawUsage, quality: json?.quality || first?.quality } : undefined
    ),
  };
}

function floor16(n: number): number {
  return Math.max(16, Math.floor(n / 16) * 16);
}

function ceil16(n: number): number {
  return Math.max(16, Math.ceil(n / 16) * 16);
}

// Approximate the crop ratio within the size limits and 16px grid. An omitted tier uses
// the crop pixel count, clamped to those limits.
export function gptImage2Size(cropW: number, cropH: number, tier?: string): string {
  const ratio = Math.min(3, Math.max(1 / 3, cropW / cropH));
  let targetPx: number;
  if (tier === "4K") targetPx = G2_MAX_PX;
  else if (tier === "2K") targetPx = 4194304;
  else if (tier === "1K") targetPx = 1048576;
  else targetPx = Math.min(G2_MAX_PX, Math.max(G2_MIN_PX, cropW * cropH));

  let w = Math.sqrt(targetPx * ratio);
  let h = Math.sqrt(targetPx / ratio);
  const longest = Math.max(w, h);
  if (longest > G2_MAX_EDGE) {
    const k = G2_MAX_EDGE / longest;
    w *= k;
    h *= k;
  }
  // Round down to avoid exceeding the edge and pixel ceilings.
  w = floor16(w);
  h = floor16(h);
  if (w / h > 3) w = floor16(h * 3);
  if (h / w > 3) h = floor16(w * 3);
  // Rounding down may require restoring the minimum pixel area.
  if (w * h < G2_MIN_PX) {
    const k = Math.sqrt(G2_MIN_PX / (w * h));
    w = Math.min(G2_MAX_EDGE, ceil16(w * k));
    h = Math.min(G2_MAX_EDGE, ceil16(h * k));
  }
  return `${w}x${h}`;
}

function openAIModelId(model: string): string {
  return model.startsWith(OPENAI_MODEL_PREFIX) ? model.slice(OPENAI_MODEL_PREFIX.length) : model;
}

export function isGptImage2(model: string): boolean {
  return openAIModelId(model) === "gpt-image-2";
}

function mimeExt(mimeType: string): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pushField(parts: Uint8Array[], boundary: string, name: string, value: string): void {
  parts.push(textBytes(`--${boundary}\r\n`));
  parts.push(textBytes(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
  parts.push(textBytes(`${value}\r\n`));
}

function pushFile(
  parts: Uint8Array[],
  boundary: string,
  name: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array
): void {
  parts.push(textBytes(`--${boundary}\r\n`));
  parts.push(
    textBytes(
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
    )
  );
  parts.push(bytes);
  parts.push(textBytes("\r\n"));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function multipartBody(opts: OpenAIGenerateOptions, model: string): { body: ArrayBuffer; contentType: string } {
  const boundary = `----nbp-openai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const parts: Uint8Array[] = [];
  pushField(parts, boundary, "model", model);
  pushField(parts, boundary, "prompt", opts.prompt);
  pushField(parts, boundary, "n", "1");
  pushField(parts, boundary, "output_format", "png");
  pushField(parts, boundary, "quality", normalizeImageQuality(opts.quality || "auto"));
  pushField(parts, boundary, "size", opts.size);
  if (opts.baseImagePng) {
    pushFile(parts, boundary, "image[]", "selection.png", "image/png", opts.baseImagePng);
  }
  opts.references.forEach((ref, index) => {
    pushFile(
      parts,
      boundary,
      "image[]",
      `reference-${index + 1}.${mimeExt(ref.mimeType)}`,
      ref.mimeType,
      base64ToBytes(ref.base64)
    );
  });
  parts.push(textBytes(`--${boundary}--\r\n`));
  const bytes = concatBytes(parts);
  return {
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// The edits endpoint requires input images; prompt-only requests use generations.
export async function generateOpenAIImage(opts: OpenAIGenerateOptions): Promise<GenerateResult> {
  const model = openAIModelId(opts.model);
  const textOnly = !opts.baseImagePng && opts.references.length === 0;

  const requestInit: any = {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  };
  if (textOnly) {
    requestInit.headers["Content-Type"] = "application/json";
    requestInit.body = JSON.stringify({
      model,
      prompt: opts.prompt,
      n: 1,
      output_format: "png",
      quality: normalizeImageQuality(opts.quality || "auto"),
      size: opts.size,
    });
  } else {
    const multipart = multipartBody(opts, model);
    requestInit.headers["Content-Type"] = multipart.contentType;
    requestInit.body = multipart.body;
  }
  if (opts.signal) requestInit.signal = opts.signal;

  const json = await requestJson("OpenAI", textOnly ? GENERATIONS_ENDPOINT : EDITS_ENDPOINT, requestInit);
  checkOpenAIOutput(json);

  const result = resultFromJson(json);
  if (result) return result;

  throw new Error("No image returned by OpenAI.");
}
