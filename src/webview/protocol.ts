/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export const DROP_CHANNEL = "nbp-reference-drop-v1";
export const WEBVIEW_CHUNK_SIZE = 192 * 1024;
export const MAX_DROP_CHUNK_LENGTH = 256 * 1024;
export const MAX_TRANSFER_CHUNKS = 100000;
export const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export interface ResizeOptions {
  maxEdge: number;
  forcePng?: boolean;
  normalizeSrgb?: boolean;
  compactStorage?: boolean;
  logDimensions?: boolean;
}

export type HostMessage =
  | ({ type: "resize-start"; requestId: string; mimeType: string; totalChunks: number } & ResizeOptions)
  | { type: "resize-chunk"; requestId: string; index: number; data: string }
  | { type: "resize-end"; requestId: string }
  | { type: "capacity"; remaining: number }
  | { type: "theme"; theme: "dark" | "light"; backgroundColor: string; surfaceColor: string };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "scroll"; deltaY: number; deltaMode: number }
  | { type: "drop-error"; message: string }
  | { type: "batch-start"; batchId: string; expected: number; ignored: number; overflow: number }
  | { type: "batch-end"; batchId: string }
  | { type: "file-start"; batchId: string; fileId: string; name: string; totalChunks: number }
  | { type: "file-chunk"; batchId: string; fileId: string; index: number; data: string }
  | { type: "file-end"; batchId: string; fileId: string }
  | { type: "file-error"; batchId: string; fileId: string; message: string }
  | { type: "resize-result-start"; requestId: string; totalChunks: number; sourceWidth: number; sourceHeight: number; width: number; height: number }
  | { type: "resize-result-chunk"; requestId: string; index: number; data: string }
  | { type: "resize-result-end"; requestId: string }
  | { type: "resize-error"; requestId: string; message: string };

// An envelope check does not validate the payload; receiving handlers validate fields.
export function bridgeMessage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  return message.channel === DROP_CHANNEL && typeof message.type === "string" ? message : null;
}

export function safeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function chunkCount(base64: string): number {
  return Math.ceil(base64.length / WEBVIEW_CHUNK_SIZE);
}

export function sendChunks(base64: string, send: (index: number, data: string) => void): void {
  for (let index = 0; index < chunkCount(base64); index += 1) {
    send(index, base64.slice(index * WEBVIEW_CHUNK_SIZE, (index + 1) * WEBVIEW_CHUNK_SIZE));
  }
}

// Shared by the UXP panel and browser. Missing chunks are never accepted as an image.
export class ChunkAssembler {
  private readonly chunks: string[];

  constructor(totalChunks: number) {
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_TRANSFER_CHUNKS) {
      throw new Error("Invalid image chunk count.");
    }
    this.chunks = new Array(totalChunks);
  }

  add(index: unknown, data: unknown): void {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= this.chunks.length ||
      typeof data !== "string" || data.length > MAX_DROP_CHUNK_LENGTH) {
      throw new Error("Invalid image chunk.");
    }
    this.chunks[index] = data;
  }

  join(): string {
    for (let index = 0; index < this.chunks.length; index += 1) {
      if (typeof this.chunks[index] !== "string") throw new Error("Incomplete image transfer.");
    }
    return this.chunks.join("");
  }
}
