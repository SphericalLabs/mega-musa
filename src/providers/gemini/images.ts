/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { checkGeminiOutput } from "./errors";
import { requestJson } from "../../errors";
import { base64ToBytes, bytesToBase64 } from "../../images/base64";
import { type GenerateOptions, type GenerateResult } from "../types";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export async function generateEdit(opts: GenerateOptions): Promise<GenerateResult> {
  const parts: any[] = [{ text: opts.prompt }];
  if (opts.baseImagePng) {
    parts.push({ inlineData: { mimeType: "image/png", data: bytesToBase64(opts.baseImagePng) } });
  }
  for (const ref of opts.references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } });
  }

  const generationConfig: any = { responseModalities: ["IMAGE"] };
  if (opts.aspectRatio || opts.imageSize) {
    const imageConfig: any = {};
    if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
    if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
    generationConfig.imageConfig = imageConfig;
  }
  const body: any = { contents: [{ role: "user", parts }], generationConfig };

  // Omit absent signals: some UXP fetch implementations throw on signal: undefined.
  const requestInit: any = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": opts.apiKey,
    },
    body: JSON.stringify(body),
  };
  if (opts.signal) requestInit.signal = opts.signal;

  if (opts.signal?.aborted) throw Object.assign(new Error("Canceled before dispatch."), { name: "AbortError" });
  opts.onDispatch?.();
  const json = await requestJson("Gemini", `${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`, requestInit);
  checkGeminiOutput(json, opts.apiKey);

  const candidates: any[] = json?.candidates || [];
  for (const cand of candidates) {
    const candParts: any[] = cand?.content?.parts || [];
    for (const part of candParts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        return {
          mimeType: inline.mimeType || inline.mime_type || "image/png",
          bytes: base64ToBytes(inline.data),
        };
      }
    }
  }

  let text = "";
  for (const cand of candidates) {
    for (const part of cand?.content?.parts || []) {
      if (part.text) text += part.text + " ";
    }
  }
  const block = json?.promptFeedback?.blockReason || candidates[0]?.finishReason;
  throw new Error(
    text.trim() || (block ? `No image returned (${block}).` : "No image returned by the model.")
  );
}
