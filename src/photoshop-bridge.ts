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

import { applyAlphaMask, resampleGray } from "./image-codec";

const { app, action, core, imaging } = require("photoshop");

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ActiveArtboard {
  id: number;
  name: string;
  bounds: Bounds;
}

export interface ImageBuffer {
  data: Uint8Array;
  width: number;
  height: number;
  components: number;
}

export interface RegionRead {
  image: ImageBuffer;
  // Selection coverage (0..255) sized to the crop, present for region edits.
  mask?: Uint8Array;
  // Human-readable diagnostics about what was actually read (dims, sel bounds).
  debug: string;
}

export interface SelectionSnapshot {
  bounds: Bounds;
  // Region-sized selection coverage, 0..255, including feathering.
  data: Uint8Array;
}

export function getActiveDoc(): any {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document in Photoshop first.");
  return doc;
}

function boundVal(u: any): number {
  return typeof u === "number" ? u : u?._value ?? 0;
}

function boundsFrom(value: any): Bounds | null {
  if (!value) return null;
  const bounds = {
    left: Math.round(boundVal(value.left)),
    top: Math.round(boundVal(value.top)),
    right: Math.round(boundVal(value.right)),
    bottom: Math.round(boundVal(value.bottom)),
  };
  return bounds.right - bounds.left > 1 && bounds.bottom - bounds.top > 1 ? bounds : null;
}

async function exactArtboardBounds(docId: number, artboard: any): Promise<Bounds | null> {
  try {
    const result = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _ref: "layer", _id: artboard.id },
            { _ref: "document", _id: docId },
          ],
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
    const exact = boundsFrom(result?.[0]?.artboard?.artboardRect);
    if (exact) return exact;
  } catch (e: any) {
    console.log("[Mega Musa] could not read exact artboard bounds:", e?.message || e);
  }

  // Older Photoshop descriptors may omit artboardRect. For an artboard layer,
  // its DOM bounds are the best available fallback.
  return boundsFrom(artboard.boundsNoEffects) || boundsFrom(artboard.bounds);
}

// Resolve Photoshop's active artboard from the selected layer and its parents.
// Returns null for ordinary, non-artboard documents. In a multi-artboard
// document, refusing to guess prevents an accidental full-spread generation.
export async function getActiveArtboard(doc: any): Promise<ActiveArtboard | null> {
  const artboards: any[] = Array.from(doc.artboards || []);
  if (!artboards.length) return null;

  const byId = new Map<number, any>(artboards.map((artboard) => [artboard.id, artboard]));
  let active: any | null = null;
  const activeLayers: any[] = Array.from(doc.activeLayers || []);
  for (const selected of activeLayers) {
    let layer: any | null = selected;
    while (layer) {
      const artboard = byId.get(layer.id);
      if (artboard) {
        active = artboard;
        break;
      }
      layer = layer.parent;
    }
    if (active) break;
  }

  if (!active && artboards.length === 1) active = artboards[0];
  if (!active) {
    throw new Error("Select an artboard, or a layer inside one, then try again.");
  }

  const bounds = await exactArtboardBounds(doc.id, active);
  if (!bounds) throw new Error(`Could not read the bounds of artboard “${active.name || "Artboard"}”.`);
  return { id: active.id, name: active.name || "Artboard", bounds };
}

// Replace the current selection with an exact rectangle (document pixels).
// Used to snap a freely-drawn selection to a chosen aspect ratio.
export async function setRectSelection(b: Bounds): Promise<void> {
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
              _obj: "rectangle",
              top: { _unit: "pixelsUnit", _value: b.top },
              left: { _unit: "pixelsUnit", _value: b.left },
              bottom: { _unit: "pixelsUnit", _value: b.bottom },
              right: { _unit: "pixelsUnit", _value: b.right },
            },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
    },
    { commandName: "Mega Musa: snap selection" }
  );
}

export async function getSelectionBounds(): Promise<Bounds | null> {
  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
  const sel = result?.[0]?.selection;
  if (!sel) return null;
  const v = (u: any) => (typeof u === "number" ? u : u?._value ?? 0);
  return {
    left: Math.round(v(sel.left)),
    top: Math.round(v(sel.top)),
    right: Math.round(v(sel.right)),
    bottom: Math.round(v(sel.bottom)),
  };
}

// Read selection coverage into a buffer covering all of `bounds`. Photoshop may
// return only the non-empty part, so align its source bounds back into the full
// region and leave everything outside it unselected.
async function readSelectionMask(docId: number, bounds: Bounds): Promise<Uint8Array> {
  const selection = await imaging.getSelection({
    documentID: docId,
    sourceBounds: bounds,
    componentSize: 8,
  });
  const imageData = selection.imageData;
  try {
    const sourceW = imageData.width;
    const sourceH = imageData.height;
    const components = imageData.components || 1;
    if (sourceW < 1 || sourceH < 1) throw new Error("Photoshop returned an empty selection snapshot.");

    const raw = await imageData.getData({ chunky: true });
    let gray: Uint8Array;
    if (components === 1) {
      gray = raw;
    } else {
      gray = new Uint8Array(sourceW * sourceH);
      for (let i = 0; i < gray.length; i++) gray[i] = raw[i * components];
    }

    const sourceBounds = boundsFrom(selection.sourceBounds) || bounds;
    const regionW = sourceBounds.right - sourceBounds.left;
    const regionH = sourceBounds.bottom - sourceBounds.top;
    const regionMask =
      sourceW === regionW && sourceH === regionH
        ? gray
        : resampleGray(gray, sourceW, sourceH, regionW, regionH);
    if (
      sourceBounds.left === bounds.left &&
      sourceBounds.top === bounds.top &&
      regionW === bounds.right - bounds.left &&
      regionH === bounds.bottom - bounds.top
    ) {
      return regionMask;
    }

    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const mask = new Uint8Array(width * height);
    const offsetX = sourceBounds.left - bounds.left;
    const offsetY = sourceBounds.top - bounds.top;
    for (let y = 0; y < regionH; y++) {
      const targetY = y + offsetY;
      if (targetY < 0 || targetY >= height) continue;
      for (let x = 0; x < regionW; x++) {
        const targetX = x + offsetX;
        if (targetX < 0 || targetX >= width) continue;
        mask[targetY * width + targetX] = regionMask[y * regionW + x];
      }
    }
    return mask;
  } finally {
    imageData.dispose();
  }
}

// Capture the final placement region before the provider request. Failure is
// intentionally propagated so no request is billed without a usable fallback.
export async function captureSelection(docId: number, bounds: Bounds): Promise<SelectionSnapshot> {
  return await core.executeAsModal(
    async () => {
      const data = await readSelectionMask(docId, bounds);
      if (!data.some((coverage) => coverage > 0)) {
        throw new Error("Photoshop returned an empty selection snapshot.");
      }
      return { bounds, data };
    },
    { commandName: "Mega Musa: capture selection" }
  );
}

export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const intersection = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return intersection.right - intersection.left > 1 && intersection.bottom - intersection.top > 1
    ? intersection
    : null;
}

// Reshape `b` to exactly `targetRatio` (width / height), expanding within the
// document when possible (so the whole selection stays covered) and shrinking
// only if expansion would overflow the canvas. Stays centred on `b`. Used so the
// crop's ratio equals the model's output ratio — then cover-fit adds no trim.
export function fitRegionToRatio(b: Bounds, targetRatio: number, limit: Bounds): Bounds {
  let w = b.right - b.left;
  let h = b.bottom - b.top;
  if (w < 1 || h < 1) return b;
  const limitW = limit.right - limit.left;
  const limitH = limit.bottom - limit.top;
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  if (w / h < targetRatio) {
    const newW = Math.round(h * targetRatio);
    if (newW <= limitW) w = newW;
    else {
      w = limitW;
      h = Math.round(limitW / targetRatio);
    }
  } else {
    const newH = Math.round(w / targetRatio);
    if (newH <= limitH) h = newH;
    else {
      h = limitH;
      w = Math.round(limitH * targetRatio);
    }
  }
  let left = Math.round(cx - w / 2);
  let top = Math.round(cy - h / 2);
  left = Math.max(limit.left, Math.min(left, limit.right - w));
  top = Math.max(limit.top, Math.min(top, limit.bottom - h));
  return { left, top, right: left + w, bottom: top + h };
}

// Modal step 1: read the flattened pixels inside `bounds`, plus (for region
// edits) the selection coverage mask, resampled and positioned to line up with
// the crop exactly — using getSelection's own returned sourceBounds.
export async function readRegion(
  docId: number,
  bounds: Bounds,
  withMask: boolean,
  maxEdge?: number
): Promise<RegionRead> {
  const cropW = bounds.right - bounds.left;
  const cropH = bounds.bottom - bounds.top;
  const longest = Math.max(cropW, cropH);
  // Request inputs never need a selection mask. Keeping capped reads to that
  // path avoids making the mask-placement math below operate in two scales.
  const targetSize =
    !withMask && maxEdge && longest > maxEdge
      ? cropW >= cropH
        ? { width: maxEdge }
        : { height: maxEdge }
      : undefined;
  return await core.executeAsModal(
    async () => {
      const { imageData } = await imaging.getPixels({
        documentID: docId,
        sourceBounds: bounds,
        targetSize,
        componentSize: 8,
        applyAlpha: false,
      });
      const raw = await imageData.getData({ chunky: true });
      const data = new Uint8Array(raw);
      const components = imageData.components || 4;
      const imageW = imageData.width;
      const imageH = imageData.height;
      imageData.dispose();

      let debug = `crop ${cropW}x${cropH}`;
      if (imageW !== cropW || imageH !== cropH) debug += ` -> request ${imageW}x${imageH}`;
      debug += ` c${components}`;
      let mask: Uint8Array | undefined;

      if (withMask) {
        try {
          mask = await readSelectionMask(docId, bounds);
          let covered = 0;
          for (let i = 0; i < mask.length; i++) if (mask[i] > 127) covered++;
          const pct = Math.round((100 * covered) / mask.length);
          debug += ` | selection cover ${pct}%`;
        } catch (e: any) {
          mask = undefined;
          debug += ` | getSelection FAILED: ${e?.message || e}`;
        }
      }

      return { image: { data, width: imageW, height: imageH, components }, mask, debug };
    },
    { commandName: "Mega Musa: read region" }
  );
}

// Is this layer already the topmost one inside whatever holds it — a group, an
// artboard, or the document itself? `parent` is the containing group or artboard,
// or the document for a top-level layer, and each exposes the sibling list with
// the topmost layer first.
//
// Answers false when the stack cannot be read, so an unreadable document leaves
// the caller's move to decide rather than silently skipping it.
function isFrontOfContainer(layer: any, layerId: number): boolean {
  try {
    const siblings: any[] = Array.from(layer?.parent?.layers || app.activeDocument.layers || []);
    return siblings.length > 0 && siblings[0].id === layerId;
  } catch (e: any) {
    console.log("[Mega Musa] could not read the layer stack:", e?.message || e);
    return false;
  }
}

export type PlacementClip = "none" | "mask" | "alpha";

function openDocumentById(docId: number): any | null {
  return Array.from(app.documents || []).find((doc: any) => doc.id === docId) || null;
}

async function withActiveDocument(docId: number, run: () => Promise<PlacementClip>): Promise<PlacementClip> {
  const previousDocument = app.activeDocument;
  const targetDocument = openDocumentById(docId);
  if (!targetDocument) {
    throw new Error("The original Photoshop document was closed, so the billed result was not placed.");
  }

  const switched = previousDocument?.id !== docId;
  try {
    if (switched) app.activeDocument = targetDocument;
    if (app.activeDocument?.id !== docId) {
      throw new Error("Photoshop could not reactivate the original document, so the billed result was not placed.");
    }
    return await run();
  } finally {
    if (switched && previousDocument && openDocumentById(previousDocument.id)) {
      try {
        app.activeDocument = previousDocument;
      } catch (e: any) {
        console.log("[Mega Musa] could not restore the previously active document:", e?.message || e);
      }
    }
  }
}

async function liveSelectionMatches(docId: number, snapshot: SelectionSnapshot): Promise<boolean> {
  try {
    const current = await readSelectionMask(docId, snapshot.bounds);
    if (current.length !== snapshot.data.length) return false;
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== snapshot.data[i]) return false;
    }
    return true;
  } catch (e: any) {
    console.log("[Mega Musa] live selection is unavailable or changed:", e?.message || e);
    return false;
  }
}

// Modal step 2: create a new layer and write the result once. An unchanged live
// selection becomes an editable layer mask; otherwise the captured coverage is
// baked into alpha without modifying Photoshop's current selection.
export async function placeResult(
  docId: number,
  bounds: Bounds,
  rgba: Uint8Array,
  width: number,
  height: number,
  layerName: string,
  selection: SelectionSnapshot | null
): Promise<PlacementClip> {
  return await core.executeAsModal(
    () => withActiveDocument(docId, async () => {
      const selectionStillMatches = selection ? await liveSelectionMatches(docId, selection) : false;
      await action.batchPlay(
        [{ _obj: "make", _target: [{ _ref: "layer" }], _options: { dialogOptions: "dontDisplay" } }],
        {}
      );
      const newLayer = app.activeDocument.activeLayers[0];
      const layerId = newLayer.id;

      await action.batchPlay(
        [
          {
            _obj: "set",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            to: { _obj: "layer", name: layerName },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );

      // A new layer lands directly above whichever layer was active, so a result
      // could bury itself mid-stack. Layer > Arrange > Bring to Front lifts it to
      // the top *of its own container*: a layer made inside an artboard or group
      // stays there. That matters — getActiveArtboard resolves the target artboard
      // by walking up from the active layer, and this layer is the active one when
      // the next Generate runs, so hoisting it out of the artboard would break the
      // following run in a multi-artboard document.
      //
      // Photoshop refuses the command outright when the layer is already at the
      // top, and raises that as its own plugin alert — "The command “Move” is not
      // currently available." — which a catch on this side cannot suppress. It is
      // also the common case, because the layer this one was created above is
      // usually the topmost one already. So check the stack and only move when
      // there is somewhere to move to.
      if (!isFrontOfContainer(newLayer, layerId)) {
        try {
          await action.batchPlay(
            [
              {
                _obj: "move",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                to: { _ref: "layer", _enum: "ordinal", _value: "front" },
                _options: { dialogOptions: "dontDisplay" },
              },
            ],
            {}
          );
        } catch (e: any) {
          // The result is already placed; a stack position is not worth failing on.
          console.log("[Mega Musa] could not bring the result layer to the front:", e?.message || e);
        }
      }

      let clip: PlacementClip = "none";
      let masked = false;
      if (selectionStillMatches) {
        try {
          await action.batchPlay(
            [
              {
                _obj: "make",
                new: { _class: "channel" },
                at: { _ref: "channel", _enum: "channel", _value: "mask" },
                using: { _enum: "userMaskEnabled", _value: "revealSelection" },
                _options: { dialogOptions: "dontDisplay" },
              },
            ],
            {}
          );
          masked = true;
          clip = "mask";
        } catch (e: any) {
          console.log("[Mega Musa] could not create the selection mask; using layer alpha:", e?.message || e);
        }
      }

      if (selection && !masked) {
        if (
          selection.bounds.left !== bounds.left ||
          selection.bounds.top !== bounds.top ||
          selection.bounds.right !== bounds.right ||
          selection.bounds.bottom !== bounds.bottom ||
          selection.data.length !== width * height
        ) {
          throw new Error("The captured selection does not match the result region.");
        }
        applyAlphaMask(rgba, selection.data);
        clip = "alpha";
      }

      const imageData = await imaging.createImageDataFromBuffer(rgba, {
        width,
        height,
        components: 4,
        componentSize: 8,
        colorSpace: "RGB",
        chunky: true,
      });
      try {
        await imaging.putPixels({
          documentID: docId,
          layerID: layerId,
          targetBounds: bounds,
          imageData,
        });
      } finally {
        imageData.dispose();
      }

      if (masked) {
        // Adding a mask consumes the selection — Photoshop drops the marching
        // ants. Load the mask we just made straight back as the selection so it
        // survives the run: without this the next Generate sees nothing selected,
        // falls back to the whole image, and the mask appears only every other
        // time. The mask holds the exact shape, feather included, so this
        // restores the original selection rather than an approximation of it.
        try {
          await action.batchPlay(
            [
              {
                _obj: "set",
                _target: [{ _ref: "channel", _property: "selection" }],
                to: { _ref: "channel", _enum: "channel", _value: "mask" },
                _options: { dialogOptions: "dontDisplay" },
              },
            ],
            {}
          );
        } catch (e: any) {
          // Not fatal — the result is already placed and masked.
          console.log("[Mega Musa] could not restore the selection after masking:", e?.message || e);
        }
      }
      return clip;
    }),
    { commandName: "Mega Musa: place result" }
  );
}

// Longest edge kept for a pasted reference. A 6000px screenshot is slow to
// PNG-encode in the UXP JS engine and inflates the request body far past what the
// models actually consume, so oversized pastes are resampled down by Photoshop.
const PASTE_MAX_EDGE = 2048;

export interface PastedImage extends ImageBuffer {
  // Size of what was on the clipboard, before any downscale to PASTE_MAX_EDGE.
  originalWidth: number;
  originalHeight: number;
}

// Read the system clipboard as pixels by having Photoshop paste it. UXP's own
// clipboard API is text-only — no version of it documents image support — but
// Photoshop pastes anything the OS clipboard holds.
//
// It pastes into an empty document that is then grown to the pasted layer and
// trimmed back to it. Success is judged on the pixels that come out, not on a
// side effect like layer count — a paste can quietly do nothing. Whatever
// happened along the way is attached to the error, so a failure names the step
// that failed instead of a generic "nothing on the clipboard".
export async function readClipboardImage(): Promise<PastedImage> {
  // Creating, modifying and closing documents all need modal scope.
  return await core.executeAsModal(
    async () => {
      const trace: string[] = [];
      // The user's own document: never closed, never read from. Guards the
      // closeWithoutSaving below against ever touching their artwork.
      const userDocId: number | undefined = app.activeDocument?.id;

      const scratch = await app.createDocument({
        width: 64,
        height: 64,
        resolution: 72,
        fill: "transparent",
        name: "mm-paste",
      });
      if (!scratch) throw new Error("Could not create a scratch document for the paste.");
      // paste follows the active document, so make sure that is the scratch and
      // not the user's artwork. This is what makes the paste land where we can
      // read it — without it, the pixels go into whatever the user had open.
      try {
        app.activeDocument = scratch;
      } catch (e: any) {
        trace.push(`activate: ${e?.message || e}`);
      }
      try {
        await action.batchPlay(
          [
            {
              _obj: "paste",
              antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" },
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          {}
        );
        trace.push("paste ok");
      } catch (e: any) {
        trace.push(`paste: ${e?.message || e}`);
      }
      // Grow the canvas to wherever the layer landed, then shave the transparent
      // surround off. Either can fail harmlessly on an empty document.
      for (const cmd of [
        { _obj: "revealAll", _options: { dialogOptions: "dontDisplay" } },
        {
          _obj: "trim",
          trimBasedOn: { _enum: "trimBasedOn", _value: "transparency" },
          top: true,
          bottom: true,
          left: true,
          right: true,
          _options: { dialogOptions: "dontDisplay" },
        },
      ]) {
        try {
          await action.batchPlay([cmd], {});
        } catch (e: any) {
          trace.push(`${cmd._obj}: ${e?.message || e}`);
        }
      }
      trace.push(`after trim ${Math.round(scratch.width)}x${Math.round(scratch.height)}`);

      try {
        const originalWidth = Math.round(scratch.width);
        const originalHeight = Math.round(scratch.height);
        const longest = Math.max(originalWidth, originalHeight);
        if (longest > PASTE_MAX_EDGE) {
          const k = PASTE_MAX_EDGE / longest;
          await action.batchPlay(
            [
              {
                _obj: "imageSize",
                width: { _unit: "pixelsUnit", _value: Math.max(1, Math.round(originalWidth * k)) },
                height: { _unit: "pixelsUnit", _value: Math.max(1, Math.round(originalHeight * k)) },
                constrainProportions: true,
                interpolation: { _enum: "interpolationType", _value: "bicubicSharper" },
                _options: { dialogOptions: "dontDisplay" },
              },
            ],
            {}
          );
        }
        const width = Math.round(scratch.width);
        const height = Math.round(scratch.height);

        const { imageData } = await imaging.getPixels({
          documentID: scratch.id,
          sourceBounds: { left: 0, top: 0, right: width, bottom: height },
          componentSize: 8,
          applyAlpha: false,
        });
        const raw = await imageData.getData({ chunky: true });
        const data = new Uint8Array(raw);
        const components = imageData.components || 4;
        imageData.dispose();

        // The real test: did any opaque pixel actually arrive? A paste that
        // silently did nothing leaves a fully transparent document behind.
        if (components === 4) {
          let opaque = false;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) {
              opaque = true;
              break;
            }
          }
          if (!opaque) {
            throw new Error(
              `Photoshop pasted nothing — the clipboard has no image it can read. [${trace.join(" | ")}]`
            );
          }
        }

        return { data, width, height, components, originalWidth, originalHeight };
      } finally {
        // Only ever close a document this function created.
        if (scratch && scratch.id !== userDocId) {
          try {
            await scratch.closeWithoutSaving();
          } catch {
            /* ignore close failures */
          }
        }
      }
    },
    { commandName: "Mega Musa: paste reference" }
  );
}

// Cover-fit `rgba` (srcW x srcH, RGBA) to dstW x dstH with Photoshop's Image Size
// engine, then read the centered destination crop. Proportions stay constrained,
// so an unexpected provider ratio can never stretch. The scratch doc is always
// closed without saving. Throws on failure so the caller can use the JS fallback.
export async function scaleViaPhotoshop(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Promise<Uint8Array> {
  // Creating and closing the scratch document both modify Photoshop's state, so
  // they belong inside modal scope alongside the pixel work — outside it,
  // createDocument is rejected with "make may modify the state of Photoshop".
  return await core.executeAsModal(
    async () => {
      const scratch = await app.createDocument({
        width: srcW,
        height: srcH,
        resolution: 72,
        fill: "transparent",
        name: "mm-scale",
      });
      if (!scratch) throw new Error("Could not create scratch document for scaling.");
      try {
        const layerId = scratch.layers[0].id;
        const srcData = await imaging.createImageDataFromBuffer(rgba, {
          width: srcW,
          height: srcH,
          components: 4,
          componentSize: 8,
          colorSpace: "RGB",
          chunky: true,
        });
        await imaging.putPixels({
          documentID: scratch.id,
          layerID: layerId,
          targetBounds: { left: 0, top: 0, right: srcW, bottom: srcH },
          imageData: srcData,
        });
        srcData.dispose();

        const scale = Math.max(dstW / srcW, dstH / srcH);
        const targetW = Math.max(dstW, Math.ceil(srcW * scale));
        const targetH = Math.max(dstH, Math.ceil(srcH * scale));
        if (targetW !== srcW || targetH !== srcH) {
          const method = scale < 1 ? "bicubicSharper" : scale > 1 ? "bicubicSmoother" : "bicubic";
          await action.batchPlay(
            [
              {
                _obj: "imageSize",
                width: { _unit: "pixelsUnit", _value: targetW },
                height: { _unit: "pixelsUnit", _value: targetH },
                constrainProportions: true,
                interpolation: { _enum: "interpolationType", _value: method },
                _options: { dialogOptions: "dontDisplay" },
              },
            ],
            {}
          );
        }

        const resizedW = Math.round(scratch.width);
        const resizedH = Math.round(scratch.height);
        if (resizedW < dstW || resizedH < dstH) {
          throw new Error("Photoshop's constrained resize did not cover the destination.");
        }
        const left = Math.floor((resizedW - dstW) / 2);
        const top = Math.floor((resizedH - dstH) / 2);

        const { imageData } = await imaging.getPixels({
          documentID: scratch.id,
          sourceBounds: { left, top, right: left + dstW, bottom: top + dstH },
          componentSize: 8,
          applyAlpha: false,
        });
        const outputW = imageData.width;
        const outputH = imageData.height;
        const raw = await imageData.getData({ chunky: true });
        const comps = imageData.components || 4;
        imageData.dispose();
        if (outputW !== dstW || outputH !== dstH) {
          throw new Error("Photoshop returned the wrong cover-fit dimensions.");
        }

        if (comps === 4) return new Uint8Array(raw);
        // Expand to RGBA with opaque alpha (alpha is reapplied by the mask step).
        const px = dstW * dstH;
        const rgbaOut = new Uint8Array(px * 4);
        for (let i = 0; i < px; i++) {
          rgbaOut[i * 4] = raw[i * comps];
          rgbaOut[i * 4 + 1] = raw[i * comps + 1];
          rgbaOut[i * 4 + 2] = raw[i * comps + 2];
          rgbaOut[i * 4 + 3] = 255;
        }
        return rgbaOut;
      } finally {
        try {
          await scratch.closeWithoutSaving();
        } catch {
          /* ignore close failures */
        }
      }
    },
    { commandName: "Mega Musa: scale result" }
  );
}
