/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import { base64ToBytes } from "../images/base64";
import { readImageDimensions } from "../images/dimensions";
import { type RefImage } from "../references";
import { type ReferenceImageProcessor } from "../references/processor";
import { $ } from "./controls";
import { ReferencePreviewGeometry } from "./reference-preview-geometry";
import { setStatus } from "./status";

export function createReferencePreview(processor: Pick<ReferenceImageProcessor, "resize">) {
  let cleanup: (() => void) | null = null;
  let disposed = false;

  async function open(reference: RefImage): Promise<void> {
    if (cleanup || disposed) return;
    const dialog = $("referencePreviewDialog");
    const viewport = $("referencePreviewViewport");
    const message = $("referencePreviewMessage");
    const zoomOut = $("referencePreviewZoomOut");
    const zoomIn = $("referencePreviewZoomIn");
    const fit = $("referencePreviewFit");
    const percent = $("referencePreviewPercent");
    const close = $("referencePreviewClose");
    const image = document.createElement("img");
    const previousFocus = document.activeElement as HTMLElement | null;
    let active = true;
    let failed = false;
    let geometry: ReferencePreviewGeometry | null = null;
    let viewportWidth = 0, viewportHeight = 0;
    let drag: { x: number; y: number } | null = null;
    let imageTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSize: { width: number; height: number } | null = null;
    const removers: (() => void)[] = [];
    const listen = (element: any, type: string, handler: (event: any) => void, capture = false) => {
      element.addEventListener(type, handler, capture);
      removers.push(() => element.removeEventListener(type, handler, capture));
    };

    function render(): void {
      if (!active || !geometry) return;
      const width = geometry.imageWidth * geometry.zoom;
      const height = geometry.imageHeight * geometry.zoom;
      // Panning and resizing at a fixed zoom should not reassign image dimensions.
      const styles = {
        width: `${width}px`, height: `${height}px`,
        left: `${(geometry.width - width) / 2 + geometry.x}px`,
        top: `${(geometry.height - height) / 2 + geometry.y}px`
      };
      for (const key of ["width", "height", "left", "top"] as const) {
        if (image.style[key] !== styles[key]) image.style[key] = styles[key];
      }
      const label = `${Math.round(geometry.zoom * 100)}%`;
      if (percent.textContent !== label) percent.textContent = label;
      zoomOut.disabled = geometry.zoom <= geometry.minZoom;
      zoomIn.disabled = geometry.zoom >= geometry.maxZoom;
      fit.disabled = false;
      viewport.style.cursor = drag ? "grabbing" : width > geometry.width || height > geometry.height ? "grab" : "default";
    }

    function layout(width: number, height: number): void {
      if (!active || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      if (width === viewportWidth && height === viewportHeight) return;
      viewportWidth = width;
      viewportHeight = height;
      geometry?.resize(viewportWidth, viewportHeight);
      render();
    }

    function queueLayout(width: number, height: number): void {
      if (!active || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      pendingSize = { width, height };
      if (resizeTimer !== undefined) return;
      // Coalesce live-resize notifications without rebuilding or reloading <img>.
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        if (pendingSize) layout(pendingSize.width, pendingSize.height);
        pendingSize = null;
      }, 16);
    }

    function stopDrag(): void {
      if (!drag) return;
      drag = null;
      render();
    }

    function fail(error: unknown): void {
      if (!active) return;
      failed = true;
      clearTimeout(imageTimer);
      geometry = null;
      image.style.visibility = "hidden";
      message.textContent = `Could not preview this image: ${errorMessage(error)}`;
      message.style.display = "block";
      percent.textContent = "";
      zoomOut.disabled = zoomIn.disabled = fit.disabled = true;
    }

    const observer = new ResizeObserver(entries => {
      const bounds = entries.find(entry => entry.target === viewport)?.contentRect;
      if (bounds) queueLayout(bounds.width, bounds.height);
    });
    const finish = () => {
      if (!active) return;
      active = false;
      stopDrag();
      clearTimeout(imageTimer);
      clearTimeout(resizeTimer);
      pendingSize = null;
      observer.disconnect();
      removers.forEach(remove => remove());
      image.removeAttribute("src");
      viewport.removeChild(image);
      geometry = null;
      cleanup = null;
      previousFocus?.focus();
    };
    cleanup = () => { dialog.close(); finish(); };

    $("referencePreviewName").textContent = reference.name;
    message.textContent = "Loading preview…";
    message.style.display = "block";
    percent.textContent = "";
    zoomOut.disabled = zoomIn.disabled = fit.disabled = true;
    image.className = "reference-preview-image";
    image.alt = reference.name;
    image.style.visibility = "hidden";
    viewport.appendChild(image);

    listen(close, "click", () => dialog.close());
    listen(dialog, "close", finish);
    listen(dialog, "cancel", finish);
    // Capture before a focused Spectrum control can swallow the shortcut.
    listen(dialog, "keydown", (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "w") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) dialog.close();
    }, true);
    // Keep panel-level paste and generation shortcuts out of this dialog.
    listen(dialog, "keydown", (event: KeyboardEvent) => event.stopPropagation());
    listen(zoomIn, "click", () => { geometry?.zoomTo(geometry.zoom * 1.25); render(); });
    listen(zoomOut, "click", () => { geometry?.zoomTo(geometry.zoom / 1.25); render(); });
    listen(fit, "click", () => { geometry?.fit(); render(); });
    // Use mouse events like the panel's resize handle: native UXP trackpad
    // dragging must not depend on pointer events or pointer capture.
    listen(viewport, "mousedown", (event: MouseEvent) => {
      if (!geometry || event.button !== 0) return;
      event.preventDefault();
      viewport.focus();
      drag = { x: event.clientX, y: event.clientY };
      render();
    });
    listen(document, "mousemove", (event: MouseEvent) => {
      if (!geometry || !drag) return;
      // Recover if the button was released outside the native dialog.
      if (event.buttons === 0) { stopDrag(); return; }
      event.preventDefault();
      geometry.pan(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX;
      drag.y = event.clientY;
      render();
    }, true);
    // Capture release even over a toolbar control that stops propagation.
    listen(document, "mouseup", stopDrag, true);
    listen(viewport, "keydown", (event: KeyboardEvent) => {
      if (!geometry) return;
      const directions: Record<string, [number, number]> = {
        ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40]
      };
      const delta = directions[event.key];
      if (!delta) return;
      event.preventDefault();
      geometry.pan(...delta);
      render();
    });

    async function load(): Promise<void> {
      try {
        // Convert WebP at full resolution only when opened, never use its tiny
        // thumbnail or mutate the original generation/archive source.
        const source = reference.mimeType === "image/webp"
          ? await processor.resize(reference, { maxEdge: 100000, forcePng: true, logDimensions: false })
          : reference;
        if (!active) return;
        const dimensions = readImageDimensions(base64ToBytes(source.base64));
        listen(image, "load", () => {
          if (!active || failed) return;
          clearTimeout(imageTimer);
          geometry = new ReferencePreviewGeometry(dimensions.width, dimensions.height);
          geometry.resize(viewportWidth, viewportHeight);
          message.style.display = "none";
          image.style.visibility = "visible";
          render();
        });
        listen(image, "error", () => fail(new Error("The image could not be decoded.")));
        imageTimer = setTimeout(() => fail(new Error("Image loading timed out. Close the preview and retry.")), 15000);
        image.src = `data:${source.mimeType};base64,${source.base64}`;
      } catch (error) { fail(error); }
    }

    try {
      // screen is not exposed by every UXP host; retain a conservative default.
      const screen = window.screen;
      const width = Math.min(800, Math.max(360, (screen?.availWidth || 1024) - 80));
      const height = Math.min(600, Math.max(300, (screen?.availHeight || 768) - 100));
      // Seed geometry before the first host layout; CSS owns the live sizes.
      // Match the CSS: 12px inset, 28px filename row and 42px toolbar + gap.
      layout(width - 24, height - 94);
      const closed = dialog.showModal({
        title: "Reference preview", resize: "both", lockDocumentFocus: true,
        size: { width, height }, minSize: { width: 360, height: 300 }
      });
      observer.observe(viewport);
      void load();
      await closed;
    } catch (error) {
      // Escape/window-close can reject showModal; actual open failures still report.
      if (active && !dialog.open) setStatus(`Reference preview closed: ${errorMessage(error)}`);
    } finally { finish(); }
  }

  return { open, dispose: () => { disposed = true; cleanup?.(); } };
}
