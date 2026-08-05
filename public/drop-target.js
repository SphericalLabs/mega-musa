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
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const label = document.getElementById("label");
  let remaining = 10;
  let dragDepth = 0;
  let dragIdleTimer = null;
  let promiseTimer = null;
  let receivingPromise = false;

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

  window.addEventListener("message", (event) => {
    if (event.source !== window.uxpHost) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== "capacity") return;
    remaining = Math.max(0, Number(message.remaining) || 0);
    updateLabel();
  });

  updateLabel();
  send({ type: "ready" });
})();
