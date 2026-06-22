import { base64ToBytes } from "./image-codec";
import { RefImage, GenerateResult } from "./gemini";

const ENDPOINT = "https://api.openai.com/v1/images/edits";

export const OPENAI_MODEL_PREFIX = "openai:";

export interface OpenAIGenerateOptions {
  apiKey: string;
  model: string;
  prompt: string;
  baseImagePng: Uint8Array;
  references: RefImage[];
  aspectRatio?: string;
  imageSize?: string;
  signal?: AbortSignal;
}

function parseAspectRatio(aspectRatio?: string): number {
  const [w, h] = (aspectRatio || "1:1").split(":").map((v) => Number(v));
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return 1;
  return w / h;
}

function sizeForOpenAI(model: string, aspectRatio?: string, imageSize?: string): string {
  if (!imageSize || imageSize === "auto") return "auto";

  const ratio = parseAspectRatio(aspectRatio);
  if (model === "gpt-image-2") {
    if (imageSize === "4K") {
      if (ratio > 1.18) return "3840x2160";
      if (ratio < 0.85) return "2160x3840";
      return "2048x2048";
    }
    if (imageSize === "2K") {
      if (ratio > 1.18) return "2048x1152";
      if (ratio < 0.85) return "1152x2048";
      return "2048x2048";
    }
  }

  if (ratio > 1.18) return "1536x1024";
  if (ratio < 0.85) return "1024x1536";
  return "1024x1024";
}

function openAIModelId(model: string): string {
  return model.startsWith(OPENAI_MODEL_PREFIX) ? model.slice(OPENAI_MODEL_PREFIX.length) : model;
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
  pushField(parts, boundary, "quality", "auto");
  pushField(parts, boundary, "size", sizeForOpenAI(model, opts.aspectRatio, opts.imageSize));
  pushFile(parts, boundary, "image[]", "selection.png", "image/png", opts.baseImagePng);
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

// Calls OpenAI's Images edit endpoint with the cropped Photoshop region and any
// references as multipart image[] parts. The response is base64 image data.
export async function generateOpenAIEdit(opts: OpenAIGenerateOptions): Promise<GenerateResult> {
  const model = openAIModelId(opts.model);
  const multipart = multipartBody(opts, model);

  const requestInit: any = {
    method: "POST",
    headers: {
      "Content-Type": multipart.contentType,
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: multipart.body,
  };
  if (opts.signal) requestInit.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, requestInit);
  } catch (err: any) {
    throw new Error(`OpenAI network request failed before an HTTP response: ${err?.message || err}`);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(String(msg));
  }

  const first = json?.data?.[0];
  if (first?.b64_json) {
    return {
      mimeType: `image/${json?.output_format || "png"}`,
      bytes: base64ToBytes(first.b64_json),
    };
  }

  throw new Error("No image returned by OpenAI.");
}
