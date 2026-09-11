/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({
  stdin: { contents: 'export * from "./src/errors"; export * from "./src/providers/gemini/errors"; export * from "./src/providers/openai/errors"; export * from "./src/gemini"; export * from "./src/openai"; export * from "./src/describe";', resolveDir: process.cwd() },
  bundle: true, format: "esm", platform: "node", write: false,
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const reply = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
const originalFetch = globalThis.fetch;
try {
  const opts = { apiKey: "secret-test-key", model: "test", prompt: "test", references: [], size: "1024x1024" };
  const calls = [
    () => api.generateEdit(opts),
    () => api.generateOpenAIImage(opts),
    ...["gemini", "openai"].map(provider => () => api.describeImages({
      apiKey: opts.apiKey, model: api.DESCRIPTION_MODELS.find((model) => model.provider === provider),
      images: [{ mimeType: "image/png", base64: "test" }],
    })),
  ];
  for (const call of calls) {
    globalThis.fetch = async () => reply({ error: { code: "credit_balance_exhausted", message: "No credit" } }, 429);
    await assert.rejects(call, /credits.*\(CREDIT_BALANCE_EXHAUSTED\)$/);
    const abort = new Error("aborted"); abort.name = "AbortError";
    globalThis.fetch = async () => { throw abort; };
    await assert.rejects(call, error => error === abort);
    globalThis.fetch = async () => reply({ error: { message: `Invalid ${opts.apiKey}` } }, 401);
    await assert.rejects(call, error => error.message.endsWith("(HTTP 401)") && !error.message.includes(opts.apiKey));
    globalThis.fetch = async () => { throw new Error("Offline"); };
    await assert.rejects(call, /connection.*completion is unknown/);
  }
  assert.match(api.apiError("Gemini", { code: 400, status: "FAILED_PRECONDITION" }, 400).message, /billing/);
  assert.match(api.apiError("Gemini", { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] }, 400).message, /API key.*API_KEY_INVALID/);
  assert.match(api.apiError("OpenAI", { code: "slow_down" }, 429).message, /Wait/);
  assert.match(api.apiError("Gemini", { code: "NEW_REASON", message: "Provider detail" }).message, /^Gemini: The request failed\. \(NEW_REASON\)$/);
  for (const code of ["IMAGE_SAFETY", "SPII", "IMAGE_RECITATION"]) {
    assert.throws(() => api.checkGeminiOutput({ candidates: [{ finishReason: code, content: { parts: [{ text: "partial" }] } }] }), /blocked/);
  }
  assert.throws(() => api.checkGeminiOutput({ promptFeedback: { blockReason: "SAFETY" } }), /blocked/);
  api.checkGeminiOutput({ candidates: [{ finishReason: "STOP" }] });
  // Usage must survive an incomplete response, and partial JSON must not be parsed.
  for (const provider of ["gemini", "openai"]) {
    let usageReported = false;
    globalThis.fetch = async () => reply(provider === "openai"
      ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } }
      : { candidates: [{ finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    await assert.rejects(() => api.describeImages({ apiKey: "test", model: api.DESCRIPTION_MODELS.find((model) => model.provider === provider),
      images: [{ mimeType: "image/png", base64: "test" }], onUsage: () => { usageReported = true; } }), /output limit/);
    assert.equal(usageReported, true);
  }
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError(); } });
  await assert.rejects(() => api.generateEdit(opts), /service.*HTTP 503/);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } });
  await assert.rejects(() => api.generateEdit(opts), /unreadable or interrupted/);
  assert.match(api.errorMessage({ number: 9 }), /Photoshop is busy/);
  assert.match(api.errorMessage({ result: -128 }), /canceled/);
  assert.match(api.errorMessage({ result: -25922, message: "Unavailable target" }), /Unavailable target.*-25922/);
  assert.match(api.errorMessage({ name: "OutOfSpaceError", message: "Disk full" }), /Free up disk space/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("error tests passed (all provider paths, codes, safety, truncation, cancellation, redaction and host errors)");
