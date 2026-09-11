/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { checkOpenAIOutput } from "./errors";
import { requestJson } from "../../errors";
import { base64ToBytes } from "../../images/base64";
import { normalizeImageQuality } from "../../models/quality";
import { type GenerateResult, type ImageQuality, type ImageUsage, type RefImage } from "../types";

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
  onDispatch?: () => void;
}

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

  if (opts.signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  opts.onDispatch?.();
  const json = await requestJson("OpenAI", textOnly ? GENERATIONS_ENDPOINT : EDITS_ENDPOINT, requestInit);
  checkOpenAIOutput(json);

  const result = resultFromJson(json);
  if (result) return result;

  throw new Error("No image returned by OpenAI.");
}
