/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { REF_FORMATS, referenceImageFromBase64 } from "../references";
import { MAX_REFS, ReferenceCollection } from "../references/collection";
import { ReferenceImageProcessor } from "../references/processor";
import { bridgeMessage, ChunkAssembler, MAX_TRANSFER_CHUNKS, safeCount } from "../webview/protocol";
import { $ } from "./controls";
import { setNote, setStatus } from "./status";
import { dropSurface, panelBackground, panelTheme } from "./theme";

export function createDropController({ references, processor, onReferencesChanged }: {
  references: ReferenceCollection;
  processor: ReferenceImageProcessor;
  onReferencesChanged: () => void;
}) {
  interface DropBatchState {
    expected: number;
    completed: number;
    added: number;
    ignored: number;
    invalid: number;
    overflow: number;
    failed: number;
  }

  interface PendingDropFile {
    batchId: string;
    name: string;
    chunks: ChunkAssembler;
  }

  const dropBatches = new Map<string, DropBatchState>();

  const pendingDropFiles = new Map<string, PendingDropFile>();

  let dropTheme = "";

  let dropBackgroundColor = "";

  // Poll the CSS theme so the separate WebView follows Photoshop theme changes.
  const THEME_POLL_MS = 300;

  function syncDropCapacity(): void {
    processor.post({ type: "capacity", remaining: MAX_REFS - references.length });
  }

  // Send Photoshop theme colors to the OS WebView; keep its surface opaque during reflow.
  function syncDropTheme(force = false): void {
    const theme = panelTheme();
    const backgroundColor = panelBackground(theme);
    const surfaceColor = dropSurface(theme, backgroundColor);
    if (theme === dropTheme && backgroundColor === dropBackgroundColor && !force) return;
    dropTheme = theme;
    dropBackgroundColor = backgroundColor;
    processor.post({ type: "theme", theme, backgroundColor, surfaceColor });
  }

  function failPendingDropFile(fileId: string): void {
    const file = pendingDropFiles.get(fileId);
    if (!file) return;
    pendingDropFiles.delete(fileId);
    const batch = dropBatches.get(file.batchId);
    if (batch) {
      batch.failed += 1;
      batch.completed += 1;
    }
  }

  function finishDropBatch(batchId: string): void {
    const batch = dropBatches.get(batchId);
    if (!batch) return;
    for (const [fileId, file] of pendingDropFiles) {
      if (file.batchId === batchId) {
        pendingDropFiles.delete(fileId);
        batch.failed += 1;
        batch.completed += 1;
      }
    }
    batch.failed += Math.max(0, batch.expected - batch.completed);
    dropBatches.delete(batchId);

    const skipped: string[] = [];
    const unsupported = batch.ignored + batch.invalid;
    if (unsupported) skipped.push(`${unsupported} not ${REF_FORMATS}`);
    if (batch.overflow) skipped.push(`${batch.overflow} over the ${MAX_REFS}-image limit`);
    if (batch.failed) skipped.push(`${batch.failed} unreadable`);
    const tail = skipped.length ? ` Skipped ${skipped.join(", ")}.` : "";
    setStatus(
      batch.added
        ? `Added ${batch.added} reference image${batch.added === 1 ? "" : "s"}.${tail}`
        : `Nothing added.${tail}`,
      batch.added ? "ok" : "error"
    );
    syncDropCapacity();
  }

  function onDropWebviewMessage(event: MessageEvent): void {
    const webview = $("dropWebview");
    // Accept bridge messages only from this panel's drop WebView.
    if (!webview || event.source !== webview) return;
    const message = bridgeMessage(event.data);
    if (!message) return;

    // WebView wheel events arrive by message because they cannot bubble into the panel.
    if (message.type === "scroll") {
      const scroll = $("scroll");
      if (scroll && typeof message.deltaY === "number" && Number.isFinite(message.deltaY)) {
        // Wheel deltas can be pixels, lines or pages; use the panel's page height.
        const scale = message.deltaMode === 1 ? 16 : message.deltaMode === 2 ? scroll.clientHeight : 1;
        scroll.scrollTop += message.deltaY * scale;
      }
      return;
    }

    if (message.type === "ready") {
      processor.setReady(true);
      syncDropCapacity();
      // A reloaded page needs the theme even if the panel colors have not changed.
      syncDropTheme(true);
      if (references.snapshot().some((ref) => ref.mimeType === "image/webp" && !ref.thumbnailDataUrl)) onReferencesChanged();
      return;
    }
    if (message.type === "drop-error") {
      setStatus(typeof message.message === "string" ? message.message : "That drop did not contain readable files.", "error");
      return;
    }
    if (processor.handleMessage(message)) return;

    const batchId = typeof message.batchId === "string" ? message.batchId : "";
    if (!batchId || batchId.length > 120) return;

    if (message.type === "batch-start") {
      dropBatches.set(batchId, {
        expected: safeCount(message.expected),
        completed: 0,
        added: 0,
        ignored: safeCount(message.ignored),
        invalid: 0,
        overflow: safeCount(message.overflow),
        failed: 0,
      });
      setNote("");
      if (message.expected) {
        setStatus(`Reading ${message.expected} dropped image${message.expected === 1 ? "" : "s"}…`);
      }
      return;
    }

    const batch = dropBatches.get(batchId);
    if (!batch) return;

    if (message.type === "file-error") {
      batch.failed += 1;
      batch.completed += 1;
      return;
    }

    const fileId = typeof message.fileId === "string" ? message.fileId : "";
    if (message.type === "file-start") {
      const totalChunks = safeCount(message.totalChunks);
      if (!fileId || fileId.length > 180 || !totalChunks || totalChunks > MAX_TRANSFER_CHUNKS) {
        batch.failed += 1;
        batch.completed += 1;
        return;
      }
      pendingDropFiles.set(fileId, {
        batchId,
        name: String(message.name || "dropped image").slice(0, 512),
        chunks: new ChunkAssembler(totalChunks),
      });
      return;
    }

    if (message.type === "file-chunk") {
      const file = pendingDropFiles.get(fileId);
      const index = Number(message.index);
      try {
        if (!file || file.batchId !== batchId) throw new Error("Invalid image transfer.");
        file.chunks.add(index, message.data);
      } catch {
        failPendingDropFile(fileId);
      }
      return;
    }

    if (message.type === "file-end") {
      const file = pendingDropFiles.get(fileId);
      if (!file || file.batchId !== batchId) return;
      pendingDropFiles.delete(fileId);
      batch.completed += 1;
      if (references.length >= MAX_REFS) {
        batch.overflow += 1;
        return;
      }
      try {
        const image = referenceImageFromBase64(file.name, file.chunks.join());
        if (!image) {
          batch.invalid += 1;
          return;
        }
        references.add(image);
        batch.added += 1;
        onReferencesChanged();
      } catch {
        batch.failed += 1;
      }
      return;
    }

    if (message.type === "batch-end") finishDropBatch(batchId);
  }

  let themeTimer: ReturnType<typeof setInterval> | null = null;
  function onLoad(): void {
    processor.setReady(true);
    syncDropCapacity();
    syncDropTheme(true);
    if (references.snapshot().some((ref) => ref.mimeType === "image/webp" && !ref.thumbnailDataUrl)) onReferencesChanged();
  }
  function onLoadError(): void {
    processor.setReady(false);
    pendingDropFiles.clear();
    dropBatches.clear();
    setStatus("Drag-and-drop could not load. Add Files and Paste still work.", "error");
  }
  function setupDropWebview(): void {
    const webview = $("dropWebview");
    if (!webview || themeTimer !== null) return;
    window.addEventListener("message", onDropWebviewMessage);
    webview.addEventListener("loadstop", onLoad);
    webview.addEventListener("loaderror", onLoadError);
    themeTimer = setInterval(() => syncDropTheme(), THEME_POLL_MS);
  }
  function dispose(): void {
    if (themeTimer !== null) clearInterval(themeTimer);
    themeTimer = null;
    window.removeEventListener("message", onDropWebviewMessage);
    const webview = $("dropWebview");
    webview?.removeEventListener("loadstop", onLoad);
    webview?.removeEventListener("loaderror", onLoadError);
    pendingDropFiles.clear();
    dropBatches.clear();
  }
  return { setupDropWebview, syncDropCapacity, onDropWebviewMessage, dispose };
}
