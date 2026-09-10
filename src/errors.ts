/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export function errorMessage(error: any): string {
  const message = typeof error?.message === "string" ? error.message
    : typeof error === "string" ? error : "Unexpected error.";
  const code = error?.number ?? error?.result;
  if (Number(code) === -128) return "Photoshop operation canceled. [Photoshop -128]";
  if (Number(code) === 9) return "Photoshop is busy. Finish the active tool or dialog, then retry. [Photoshop 9]";
  const storageHelp: Record<string, string> = {
    OutOfSpaceError: "Storage is full. Free up disk space, then retry.",
    PermissionDeniedError: "File access was denied. Choose an accessible file or folder.",
    FileIsReadOnlyError: "The file is read-only. Choose a writable destination.",
  };
  const help = storageHelp[error?.name];
  return help ? `${help} [${error.name}] ${message}`
    : code !== undefined ? `${message} [Photoshop ${code}]` : message;
}

export function apiError(provider: string, value: any, status?: number): Error {
  const details = Array.isArray(value?.details) ? value.details : [];
  const reason = details.find((detail: any) => typeof detail?.reason === "string")?.reason;
  const code = reason || value?.status || value?.code || value?.type;
  const label = typeof code === "string" && code ? code
    : status ? `HTTP ${status}` : typeof code === "number" ? `HTTP ${code}` : "";
  const key = String(code || "").toLowerCase();
  let help = "The request failed.";
  if (/credit_balance|insufficient_quota|spend_limit|usage_limit|failed_precondition/.test(key)) {
    help = "Check API credits, billing and account limits before retrying.";
  } else if (/api_key|authentication/.test(key) || status === 401) {
    help = "Check your API key and account access in Settings, then save the key again.";
  } else if (/permission|access_denied/.test(key) || status === 403) {
    help = "Access was denied. Check API permissions and account availability.";
  } else if (/safety|policy|prohibited|blocklist|recitation|spii|refusal|content_filter|bio_policy|escalation/.test(key)) {
    help = "The provider declined or blocked this content. Review your prompt and input images.";
  } else if (/max_tokens|max_output_tokens|max_messages/.test(key)) {
    help = "The output limit was reached. Try fewer images or a shorter request.";
  } else if (/rate_limit|slow_down|resource_exhausted/.test(key) || status === 429) {
    help = "An API rate or usage limit was reached. Wait before retrying; check account limits if it persists.";
  } else if (/cancelled|canceled/.test(key) || status === 499) {
    help = "The provider canceled the request.";
  } else if (/deadline|timeout/.test(key) || status === 504 || status === 408) {
    help = "The request timed out. Completion could not be confirmed.";
  } else if (/server_error|overloaded|unavailable|^internal$/.test(key) || (status && status >= 500)) {
    help = "The service could not complete the request. Try again later.";
  } else if (/not_found/.test(key) || status === 404) {
    help = "The requested model or resource is unavailable. Check the selected model and inputs.";
  } else if (/invalid|unsupported|image_too|image_file_too|image_parse|empty_image|language|malformed/.test(key)
    || status === 400 || status === 422) {
    help = "The request or input format was rejected. Check the settings and images.";
  }
  const error = new Error(`${provider}: ${help}${label ? ` (${label})` : ""}`);
  return error;
}

// Preserve AbortError identity so panel cancellation and budget handling still work.
async function requestJsonRaw(provider: string, url: string, init: any): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error: any) {
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    throw new Error(`${provider}: Could not receive a response. Check your connection. Request completion is unknown.`);
  }
  let json: any;
  try {
    json = await response.json();
  } catch (error: any) {
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    if (!response.ok) throw apiError(provider, null, response.status);
    throw new Error(`${provider}: The response was unreadable or interrupted. (HTTP ${response.status})`);
  }
  if (!response.ok) throw apiError(provider, json?.error, response.status);
  if (!json || typeof json !== "object") throw new Error(`${provider}: The response contained no usable data.`);
  return json;
}

export async function requestJson(provider: string, url: string, init: any): Promise<any> {
  try {
    return await requestJsonRaw(provider, url, init);
  } catch (error: any) {
    // Providers sometimes echo an invalid key. Never display the submitted key.
    if (error?.name === "AbortError" || init.signal?.aborted) throw error;
    const key = init.headers?.["x-goog-api-key"] || init.headers?.Authorization?.replace(/^Bearer /, "");
    if (key && typeof error?.message === "string") error.message = error.message.split(key).join("[redacted]");
    throw error;
  }
}

export function checkGeminiOutput(json: any): void {
  const block = json?.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
    throw apiError("Gemini", { code: block });
  }
  for (const candidate of json?.candidates || []) {
    const code = candidate?.finishReason;
    if (code && code !== "STOP" && code !== "FINISH_REASON_UNSPECIFIED") {
      throw apiError("Gemini", { code, message: candidate.finishMessage });
    }
  }
}

export function checkOpenAIOutput(json: any): void {
  if (json?.error) throw apiError("OpenAI", json.error);
  if (["failed", "incomplete", "cancelled", "queued", "in_progress"].includes(json?.status)) {
    throw apiError("OpenAI", { code: json.incomplete_details?.reason || json.status });
  }
}
