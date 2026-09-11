/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import { bytesToBase64 } from "../images/base64";
import { encodePng } from "../images/codec";
import { readClipboardImage } from "../photoshop/clipboard";
import { pickReferenceImages } from "../references";
import { MAX_REFS, ReferenceCollection } from "../references/collection";
import { ReferenceImageProcessor } from "../references/processor";
import { $, clearChildren } from "./controls";
import { showModalNotice } from "./notices";
import { setStatus } from "./status";

export function createReferencePanel({ references, processor, onChange }: {
  references: ReferenceCollection;
  processor: ReferenceImageProcessor;
  onChange: () => void;
}) {
  function renderThumbs(): void {
    const wrap = $("thumbs");
    clearChildren(wrap);
    references.snapshot().forEach((ref, index) => {
      const cell = document.createElement("div");
      cell.className = "thumb";
      const img = document.createElement("img");
      img.src = ref.thumbnailDataUrl || ref.dataUrl;
      img.title = ref.name;
      if (processor.ready && ref.mimeType === "image/webp" && !ref.thumbnailDataUrl) {
        void processor.thumbnail(ref)
          .then((dataUrl) => {
            img.src = dataUrl;
          })
          .catch((err: any) => {
            console.log("[Mega Musa] WebP thumbnail failed:", errorMessage(err));
          });
      }
      // Use a plain badge so its contrast stays independent of the panel theme.
      const remove = document.createElement("div");
      remove.className = "remove";
      remove.title = `Remove ${ref.name}`;
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        references.remove(index);
        renderThumbs();
      });
      cell.appendChild(img);
      cell.appendChild(remove);
      wrap.appendChild(cell);
    });
    $("refCount").textContent = `${references.length}/${MAX_REFS}`;
    onChange();
  }

  async function onAddRefs(): Promise<void> {
    try {
      const remaining = MAX_REFS - references.length;
      if (remaining <= 0) {
        setStatus(`Maximum ${MAX_REFS} reference images.`, "error");
        return;
      }
      const picked = await pickReferenceImages(remaining);
      if (picked.length) {
        references.add(...picked);
        renderThumbs();
      }
    } catch (err: any) {
      setStatus("Could not load references: " + errorMessage(err), "error");
    }
  }

  async function onPasteRef(): Promise<void> {
    if (references.length >= MAX_REFS) {
      setStatus(`Maximum ${MAX_REFS} reference images.`, "error");
      return;
    }
    setStatus("Pasting from the clipboard…");
    try {
      const img = await readClipboardImage();
      if (!img) {
        setStatus("No image on the clipboard. Copy an image first.");
        await showModalNotice({
          kind: "warning",
          title: "Mega Musa — No image on the clipboard",
          message: "Copy an image to the clipboard first, then click Paste.",
          primaryLabel: "OK",
        });
        return;
      }
      const base64 = bytesToBase64(encodePng(img.data, img.width, img.height, img.components));
      references.add({
        name: `Pasted ${img.width}×${img.height}`,
        mimeType: "image/png",
        base64,
        dataUrl: `data:image/png;base64,${base64}`,
      });
      renderThumbs();
      const shrunk = img.width !== img.originalWidth || img.height !== img.originalHeight;
      setStatus(
        shrunk
          ? `Pasted reference added — ${img.originalWidth}×${img.originalHeight} scaled down to ${img.width}×${img.height}.`
          : `Pasted reference added (${img.width}×${img.height}).`,
        "ok"
      );
    } catch (err: any) {
      // Preserve unexpected host failures for diagnostics.
      console.log("[Mega Musa] paste failed:", errorMessage(err));
      setStatus("Could not paste: " + errorMessage(err), "error");
    }
  }
  return { renderThumbs, onAddRefs, onPasteRef };
}
