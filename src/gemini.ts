import { bytesToBase64, base64ToBytes } from "./image-codec";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface RefImage {
  mimeType: string;
  base64: string;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  prompt: string;
  baseImagePng: Uint8Array;
  references: RefImage[];
  aspectRatio?: string; // undefined => let the model match the input
  imageSize?: string; // undefined => let the model match the input
  signal?: AbortSignal;
}

export interface GenerateResult {
  mimeType: string;
  bytes: Uint8Array;
}

// Calls the Gemini generateContent REST endpoint with an image-in / image-out
// request. Mirrors the request shape validated in generate_images.py, using the
// JSON (camelCase) field names the REST API expects.
export async function generateEdit(opts: GenerateOptions): Promise<GenerateResult> {
  const parts: any[] = [{ text: opts.prompt }];
  parts.push({ inlineData: { mimeType: "image/png", data: bytesToBase64(opts.baseImagePng) } });
  for (const ref of opts.references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } });
  }

  const body: any = { contents: [{ role: "user", parts }] };
  if (opts.aspectRatio || opts.imageSize) {
    const imageConfig: any = {};
    if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
    if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
    body.generationConfig = { imageConfig };
  }

  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": opts.apiKey,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

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

  // No image came back — surface any text or block reason the model returned.
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
