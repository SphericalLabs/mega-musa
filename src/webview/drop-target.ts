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

import { resizeImage } from "./image-processing";
import {
  ChunkAssembler,
  DROP_CHANNEL,
  MAX_TRANSFER_CHUNKS,
  SUPPORTED_TYPES,
  bridgeMessage,
  chunkCount,
  safeCount,
  sendChunks,
  type ResizeOptions,
  type WebviewMessage,
} from "./protocol";
declare global { interface Window { uxpHost: { postMessage(message: WebviewMessage & { channel: string }): void }; } }

const dropZone = document.getElementById("dropZone")!;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const label = document.getElementById("label")!;
let remaining = 10;
let dragDepth = 0;
let dragIdleTimer: number | null = null;
let promiseTimer: number | null = null;
let receivingPromise = false;
const pendingResizes = new Map<string, ResizeOptions & { mimeType: string; chunks: ChunkAssembler }>();

function send(message: WebviewMessage) {
  window.uxpHost.postMessage({ channel: DROP_CHANNEL, ...message });
}

// Forward wheel deltas because WebView events cannot bubble into the panel.
window.addEventListener("wheel", (event) => {
  if (event.ctrlKey || !event.deltaY) return;
  event.preventDefault();
  send({ type: "scroll", deltaY: event.deltaY, deltaMode: event.deltaMode });
}, { passive: false });

function updateLabel() {
  const full = remaining <= 0;
  dropZone.classList.toggle("full", full);
  fileInput.disabled = full;
  label.textContent = full
    ? "Reference limit reached"
    : receivingPromise
      ? "Receiving macOS screenshot…"
      : "Drop PNG, JPEG or WebP here";
}

function looksSupported(file: File) {
  const type = String(file.type || "").toLowerCase();
  return SUPPORTED_TYPES.includes(type) || /\.(png|jpe?g|webp)$/i.test(String(file.name || ""));
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) reject(new Error("The browser did not return image data."));
      else resolve(dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}

function sendResizeError(requestId: string, error: unknown): void {
  send({ type: "resize-error", requestId, message: error instanceof Error ? error.message : "The reference image could not be resized." });
}

async function finishResize(requestId: string): Promise<void> {
  const pending = pendingResizes.get(requestId);
  if (!pending) return;
  pendingResizes.delete(requestId);
  try {
    const image = await resizeImage({ ...pending, base64: pending.chunks.join() });
    send({
      type: "resize-result-start", requestId, totalChunks: chunkCount(image.base64), sourceWidth: image.sourceWidth,
      sourceHeight: image.sourceHeight, width: image.width, height: image.height
    });
    sendChunks(image.base64, (index, data) => send({ type: "resize-result-chunk", requestId, index, data }));
    send({ type: "resize-result-end", requestId });
  } catch (error) { sendResizeError(requestId, error); }
}

function resetDragState() {
  if (dragIdleTimer !== null) window.clearTimeout(dragIdleTimer);
  dragIdleTimer = null;
  dragDepth = 0;
  dropZone.classList.remove("over");
}

function keepDragActive() {
  if (receivingPromise) stopPromiseWait();
  if (dragIdleTimer !== null) window.clearTimeout(dragIdleTimer);
  dragIdleTimer = window.setTimeout(() => {
    // Check the native input: macOS file promises can arrive without a drop event.
    dragIdleTimer = null;
    dragDepth = 0;
    dropZone.classList.remove("over");
    startPromiseWait();
  }, 600);
}

function filesFromTransfer(transfer: DataTransfer | null) {
  const files = Array.from((transfer && transfer.files) || []);
  if (files.length) return files;

  const itemFiles: File[] = [];
  for (const item of Array.from((transfer && transfer.items) || [])) {
    if (item.kind !== "file" || typeof item.getAsFile !== "function") continue;
    const file = item.getAsFile();
    if (file) itemFiles.push(file);
  }
  return itemFiles;
}

function stopPromiseWait() {
  if (promiseTimer !== null) window.clearTimeout(promiseTimer);
  promiseTimer = null;
  receivingPromise = false;
  updateLabel();
}

function startPromiseWait() {
  stopPromiseWait();
  receivingPromise = true;
  updateLabel();
  const deadline = Date.now() + 2500;

  const poll = () => {
    promiseTimer = null;
    if (addInputFiles()) return;
    if (Date.now() < deadline) {
      promiseTimer = window.setTimeout(poll, 100);
      return;
    }
    receivingPromise = false;
    updateLabel();
    send({
      type: "drop-error",
      message:
        "Photoshop accepted that drop but did not provide its image data. Use Control–Shift–Command–4, then Paste.",
    });
  };

  promiseTimer = window.setTimeout(poll, 100);
}

async function addFiles(files: File[]) {
  stopPromiseWait();
  if (!files.length) return;

  const supported = files.filter(looksSupported);
  const accepted = supported.slice(0, Math.max(0, remaining));
  const batchId = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  send({
    type: "batch-start",
    batchId,
    expected: accepted.length,
    ignored: files.length - supported.length,
    overflow: supported.length - accepted.length,
  });

  for (let index = 0; index < accepted.length; index += 1) {
    const file = accepted[index];
    const fileId = `${batchId}-${index}`;
    try {
      const base64 = await readAsBase64(file);
      const totalChunks = chunkCount(base64);
      send({ type: "file-start", batchId, fileId, name: file.name, totalChunks });
      sendChunks(base64, (index, data) => send({ type: "file-chunk", batchId, fileId, index, data }));
      send({ type: "file-end", batchId, fileId });
    } catch (error) {
      send({
        type: "file-error",
        batchId,
        fileId,
        message: error instanceof Error ? error.message : "The image could not be read.",
      });
    }
  }

  send({ type: "batch-end", batchId });
}

function addInputFiles() {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return false;
  fileInput.value = "";
  void addFiles(files);
  return true;
}

fileInput.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  dropZone.classList.add("over");
  keepDragActive();
});

fileInput.addEventListener("dragover", (event) => {
  // Enable dropping here; the drop handler must still allow native file promises.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  keepDragActive();
});

fileInput.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    resetDragState();
    stopPromiseWait();
  }
});

fileInput.addEventListener("drop", (event) => {
  resetDragState();

  const files = filesFromTransfer(event.dataTransfer);
  if (files.length) {
    event.preventDefault();
    event.stopPropagation();
    fileInput.value = "";
    void addFiles(files);
    return;
  }

  // Leave the default action enabled so macOS can fulfill screenshot file promises.
  startPromiseWait();
});

fileInput.addEventListener("change", () => {
  addInputFiles();
});

// The panel supplies Photoshop's theme because WebView media queries follow the OS.
function applyTheme(theme: unknown, backgroundColor: unknown, surfaceColor: unknown) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  if (
    typeof backgroundColor === "string" &&
    backgroundColor.length > 0 &&
    backgroundColor.length <= 100
  ) {
    document.documentElement.style.setProperty("--host-background-color", backgroundColor);
  }
  if (typeof surfaceColor === "string" && surfaceColor.length > 0 && surfaceColor.length <= 100) {
    document.documentElement.style.setProperty("--drop-surface-color", surfaceColor);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== (window.uxpHost as unknown)) return;
  const message = bridgeMessage(event.data);
  if (!message) return;
  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  if (message.type === "resize-start") {
    const totalChunks = safeCount(message.totalChunks);
    const maxEdge = safeCount(message.maxEdge);
    if (
      !requestId ||
      requestId.length > 180 ||
      typeof message.mimeType !== "string" || !SUPPORTED_TYPES.includes(message.mimeType) ||
      !totalChunks ||
      totalChunks > MAX_TRANSFER_CHUNKS ||
      !maxEdge
    ) {
      sendResizeError(requestId, new Error("The resize request was invalid."));
      return;
    }
    pendingResizes.set(requestId, {
      mimeType: message.mimeType,
      maxEdge,
      forcePng: message.forcePng === true,
      normalizeSrgb: message.normalizeSrgb === true,
      compactStorage: message.compactStorage === true,
      chunks: new ChunkAssembler(totalChunks),
    });
  } else if (message.type === "resize-chunk") {
    const pending = pendingResizes.get(requestId);
    const index = Number(message.index);
    try {
      if (!pending) throw new Error("The resize request was invalid.");
      pending.chunks.add(index, message.data);
    } catch (error) {
      pendingResizes.delete(requestId);
      sendResizeError(requestId, error);
    }
  } else if (message.type === "resize-end") {
    void finishResize(requestId);
  } else if (message.type === "capacity") {
    remaining = Math.max(0, Number(message.remaining) || 0);
    updateLabel();
  } else if (message.type === "theme") {
    applyTheme(message.theme, message.backgroundColor, message.surfaceColor);
  }
});

updateLabel();
send({ type: "ready" });
