/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
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

(() => {
  "use strict";

  const CHANNEL = "nbp-reference-drop-v1";
  const CHUNK_SIZE = 192 * 1024;
  const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const MAX_HOST_CHUNK_LENGTH = 256 * 1024;
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const label = document.getElementById("label");
  let remaining = 10;
  let dragDepth = 0;
  let dragIdleTimer = null;
  let promiseTimer = null;
  let receivingPromise = false;
  const pendingResizes = new Map();

  function send(message) {
    window.uxpHost.postMessage({ channel: CHANNEL, ...message });
  }

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

  function looksSupported(file) {
    const type = String(file.type || "").toLowerCase();
    return SUPPORTED_TYPES.includes(type) || /\.(png|jpe?g|webp)$/i.test(String(file.name || ""));
  }

  function readAsBase64(file) {
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

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The reference image could not be decoded."));
      image.src = dataUrl;
    });
  }

  function sendResizeError(requestId, error) {
    send({
      type: "resize-error",
      requestId,
      message: error && error.message ? error.message : "The reference image could not be resized.",
    });
  }

  async function finishResize(requestId) {
    const pending = pendingResizes.get(requestId);
    if (!pending) return;
    pendingResizes.delete(requestId);
    for (let index = 0; index < pending.chunks.length; index += 1) {
      if (typeof pending.chunks[index] !== "string") {
        sendResizeError(requestId, new Error("The reference image arrived incomplete."));
        return;
      }
    }

    try {
      const base64 = pending.chunks.join("");
      const image = await loadImage(`data:${pending.mimeType};base64,${base64}`);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) throw new Error("The reference image has no readable dimensions.");

      let resultBase64 = base64;
      let resultWidth = width;
      let resultHeight = height;
      if (
        Math.max(width, height) > pending.maxEdge ||
        pending.forcePng ||
        pending.normalizeSrgb ||
        pending.compactStorage
      ) {
        const scale = Math.min(1, pending.maxEdge / Math.max(width, height));
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));
        resultWidth = targetWidth;
        resultHeight = targetHeight;
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        // Canvas pixels use sRGB. Ask for it explicitly where the WebView
        // supports color-space options, then fall back for older runtimes.
        let context = null;
        try {
          context = canvas.getContext("2d", { colorSpace: "srgb" });
        } catch {
          /* Older WebViews reject the options object. */
        }
        if (!context) context = canvas.getContext("2d");
        if (!context) throw new Error("The image processor could not create a canvas.");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        let outputType = pending.forcePng ? "image/png" : pending.mimeType;
        let outputQuality = 0.95;
        if (pending.compactStorage) {
          const pixels = context.getImageData(0, 0, targetWidth, targetHeight).data;
          let opaque = true;
          for (let pixel = 3; pixel < pixels.length; pixel += 4) {
            if (pixels[pixel] !== 255) {
              opaque = false;
              break;
            }
          }
          outputType = opaque ? "image/jpeg" : "image/png";
          outputQuality = 0.9;
        }
        // PNG ignores quality and preserves transparency. Compact opaque
        // archive assets use the user-visible JPEG 90 policy.
        const dataUrl = canvas.toDataURL(outputType, outputQuality);
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("The resized image could not be encoded.");
        resultBase64 = dataUrl.slice(comma + 1);
      }

      const totalChunks = Math.ceil(resultBase64.length / CHUNK_SIZE);
      send({
        type: "resize-result-start",
        requestId,
        totalChunks,
        sourceWidth: width,
        sourceHeight: height,
        width: resultWidth,
        height: resultHeight,
      });
      for (let index = 0; index < totalChunks; index += 1) {
        send({
          type: "resize-result-chunk",
          requestId,
          index,
          data: resultBase64.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        });
      }
      send({ type: "resize-result-end", requestId });
    } catch (error) {
      sendResizeError(requestId, error);
    }
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
      // Some macOS file promises are accepted by the native WebView without a
      // DOM drop event. Check whether the real file input was populated anyway.
      dragIdleTimer = null;
      dragDepth = 0;
      dropZone.classList.remove("over");
      startPromiseWait();
    }, 600);
  }

  function filesFromTransfer(transfer) {
    const files = Array.from((transfer && transfer.files) || []);
    if (files.length) return files;

    const itemFiles = [];
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

  async function addFiles(files) {
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
        const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
        send({ type: "file-start", batchId, fileId, name: file.name, totalChunks });
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
          send({
            type: "file-chunk",
            batchId,
            fileId,
            index: chunkIndex,
            data: base64.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE),
          });
        }
        send({ type: "file-end", batchId, fileId });
      } catch (error) {
        send({
          type: "file-error",
          batchId,
          fileId,
          message: error && error.message ? error.message : "The image could not be read.",
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
    // Canceling dragover tells the browser this is an active drop target. The
    // drop handler still leaves an empty file-promise drop uncanceled so the
    // native file input can fulfill it.
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

    // Do not prevent the default here. A real file input gives macOS's WebView
    // a destination where it can fulfill an unsaved screenshot file promise.
    startPromiseWait();
  });

  fileInput.addEventListener("change", () => {
    addInputFiles();
  });

  // Photoshop's Interface theme, as reported by the panel. This WebView cannot
  // see it — its own prefers-color-scheme follows the macOS appearance — so the
  // panel measures the theme and sends it here (see syncDropTheme in main.ts).
  function applyTheme(theme, backgroundColor, surfaceColor) {
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
    if (event.source !== window.uxpHost) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (message.type === "resize-start") {
      const totalChunks = Math.floor(Number(message.totalChunks));
      const maxEdge = Math.floor(Number(message.maxEdge));
      if (
        !requestId ||
        requestId.length > 180 ||
        !SUPPORTED_TYPES.includes(message.mimeType) ||
        !totalChunks ||
        totalChunks > 100000 ||
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
        chunks: new Array(totalChunks),
      });
    } else if (message.type === "resize-chunk") {
      const pending = pendingResizes.get(requestId);
      const index = Number(message.index);
      if (
        !pending ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= pending.chunks.length ||
        typeof message.data !== "string" ||
        message.data.length > MAX_HOST_CHUNK_LENGTH
      ) {
        pendingResizes.delete(requestId);
        sendResizeError(requestId, new Error("The resize request was invalid."));
        return;
      }
      pending.chunks[index] = message.data;
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
})();
