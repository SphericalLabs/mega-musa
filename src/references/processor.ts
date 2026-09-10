/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type RefImage as RequestReference } from "../providers/types";
import { referenceImageFromBase64, type RefImage } from "../references";
import {
  ChunkAssembler,
  chunkCount,
  DROP_CHANNEL,
  safeCount,
  sendChunks,
  type HostMessage,
  type ResizeOptions,
} from "../webview/protocol";

const RESIZE_TIMEOUT_MS = 120000;
const THUMBNAIL_MAX_EDGE = 256;

interface PendingResize {
  name: string;
  maxEdge: number;
  logDimensions: boolean;
  chunks: ChunkAssembler | null;
  timer: ReturnType<typeof setTimeout>;
  resolve(image: RequestReference): void;
  reject(error: Error): void;
}

export class ReferenceImageProcessor {
  private connected = false;
  private sequence = 0;
  private readonly pending = new Map<string, PendingResize>();
  private readonly thumbnails = new WeakMap<RefImage, Promise<string>>();

  constructor(private readonly send: (message: HostMessage & { channel: string }) => void) { }

  get ready(): boolean { return this.connected; }

  setReady(ready: boolean): void {
    this.connected = ready;
    if (!ready) {
      for (const id of this.pending.keys()) this.fail(id, new Error("The image processor stopped while preparing references."));
    }
  }

  post(message: HostMessage): boolean {
    if (!this.connected) return false;
    try {
      this.send({ channel: DROP_CHANNEL, ...message });
      return true;
    } catch {
      return false;
    }
  }

  private fail(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  handleMessage(message: Record<string, unknown>): boolean {
    if (!String(message.type || "").startsWith("resize-result") && message.type !== "resize-error") return false;
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const pending = this.pending.get(requestId);
    if (!pending) return true;
    try {
      switch (message.type) {
        case "resize-error":
          throw new Error(typeof message.message === "string" ? message.message : `Could not prepare reference image “${pending.name}”.`);
        case "resize-result-start": {
          const width = safeCount(message.width);
          const height = safeCount(message.height);
          if (!width || !height || Math.max(width, height) > pending.maxEdge) throw new Error(`Invalid resized data for “${pending.name}”.`);
          pending.chunks = new ChunkAssembler(safeCount(message.totalChunks));
          if (pending.logDimensions) console.log("[Mega Musa]", `reference ${pending.name}: ${safeCount(message.sourceWidth)}x${safeCount(message.sourceHeight)} -> ${width}x${height}`);
          break;
        }
        case "resize-result-chunk":
          if (!pending.chunks) throw new Error(`Invalid resized data for “${pending.name}”.`);
          pending.chunks.add(Number(message.index), message.data);
          break;
        case "resize-result-end": {
          if (!pending.chunks) throw new Error(`Incomplete resized data for “${pending.name}”.`);
          const image = referenceImageFromBase64(pending.name, pending.chunks.join());
          if (!image) throw new Error(`The resized data for “${pending.name}” is not an image.`);
          this.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.resolve({ mimeType: image.mimeType, base64: image.base64 });
        }
      }
    } catch (error) {
      this.fail(requestId, error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  resize(ref: RefImage, options: ResizeOptions): Promise<RequestReference> {
    if (!this.ready) return Promise.reject(new Error("The image processor is not ready. Close and reopen the Mega Musa panel."));
    const { maxEdge, forcePng = false, normalizeSrgb = true, compactStorage = false, logDimensions = true } = options;
    const requestId = `resize-${Date.now().toString(36)}-${this.sequence++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(requestId, new Error(`Timed out preparing reference image “${ref.name}”.`)), RESIZE_TIMEOUT_MS);
      this.pending.set(requestId, { name: ref.name, maxEdge, logDimensions, chunks: null, timer, resolve, reject });
      const post = (message: HostMessage) => {
        if (!this.post(message)) throw new Error(`Could not prepare reference image “${ref.name}”.`);
      };
      try {
        post({ type: "resize-start", requestId, mimeType: ref.mimeType, maxEdge, forcePng, normalizeSrgb, compactStorage, totalChunks: chunkCount(ref.base64) });
        sendChunks(ref.base64, (index, data) => post({ type: "resize-chunk", requestId, index, data }));
        post({ type: "resize-end", requestId });
      } catch (error) {
        this.fail(requestId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  thumbnail(ref: RefImage): Promise<string> {
    if (ref.thumbnailDataUrl) return Promise.resolve(ref.thumbnailDataUrl);
    const existing = this.thumbnails.get(ref);
    if (existing) return existing;
    const pending = this.resize(ref, { maxEdge: THUMBNAIL_MAX_EDGE, forcePng: true, logDimensions: false })
      .then((image) => {
        const dataUrl = `data:${image.mimeType};base64,${image.base64}`;
        ref.thumbnailDataUrl = dataUrl;
        return dataUrl;
      }).finally(() => this.thumbnails.delete(ref));
    this.thumbnails.set(ref, pending);
    return pending;
  }

  dispose(): void { this.setReady(false); }
}
