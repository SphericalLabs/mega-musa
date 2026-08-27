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

import { applyAlphaMask, coverResampleRGBA, resampleGray } from "./image-codec";
import { GenerationArchive, writeLayerGenerationArchive } from "./archive";
import { archiveReferenceAssetsInActiveDocument } from "./reference-assets";
import { RefImage } from "./references";

const { app, action, constants, core, imaging } = require("photoshop");
const SRGB_PROFILE = "sRGB IEC61966-2.1";

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
        colorSpace: "RGB",
        colorProfile: SRGB_PROFILE,
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

// Read a small, proportional preview of one layer. Supplying layerID keeps the
// thumbnail isolated from the rest of the document composite, while targetSize
// lets Photoshop use its optimized thumbnail path instead of returning the
// layer at full resolution.
export async function readLayerThumbnail(docId: number, layer: any, maxEdge: number): Promise<ImageBuffer> {
  const layerId = layer?.id;
  const bounds = boundsFrom(layer?.boundsNoEffects) || boundsFrom(layer?.bounds);
  if (!Number.isFinite(layerId) || !bounds) throw new Error("The selected layer has no previewable pixels.");

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const longest = Math.max(width, height);
  const safeMaxEdge = Math.max(1, Math.round(maxEdge));
  const targetSize =
    longest > safeMaxEdge
      ? width >= height
        ? { width: safeMaxEdge }
        : { height: safeMaxEdge }
      : undefined;

  return await core.executeAsModal(
    async () => {
      const { imageData } = await imaging.getPixels({
        documentID: docId,
        layerID: layerId,
        sourceBounds: bounds,
        targetSize,
        colorSpace: "RGB",
        colorProfile: SRGB_PROFILE,
        componentSize: 8,
        applyAlpha: false,
      });
      try {
        const raw = await imageData.getData({ chunky: true });
        return {
          data: new Uint8Array(raw),
          width: imageData.width,
          height: imageData.height,
          components: imageData.components || 4,
        };
      } finally {
        imageData.dispose();
      }
    },
    { commandName: "Mega Musa: preview generated layer" }
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

export interface PlacementResult {
  clip: PlacementClip;
  layerId: number;
  smartObject: boolean;
  archiveSaved: boolean;
  referenceArchiveFailures: number;
}

function openDocumentById(docId: number): any | null {
  return Array.from(app.documents || []).find((doc: any) => doc.id === docId) || null;
}

async function withActiveDocument<T>(docId: number, run: () => Promise<T>): Promise<T> {
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

function preciseBoundsFrom(value: any): Bounds | null {
  if (!value) return null;
  const bounds = {
    left: boundVal(value.left),
    top: boundVal(value.top),
    right: boundVal(value.right),
    bottom: boundVal(value.bottom),
  };
  return bounds.right - bounds.left > 0 && bounds.bottom - bounds.top > 0 ? bounds : null;
}

async function selectLayerById(layerId: number): Promise<void> {
  await action.batchPlay(
    [
      {
        _obj: "select",
        _target: [{ _ref: "layer", _id: layerId }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

async function renameActiveLayer(name: string): Promise<void> {
  await action.batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        to: { _obj: "layer", name },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

// A result belongs at the top of its current group, artboard or document. Avoid
// Photoshop's noisy unavailable-command alert when it is already there.
async function bringResultToFront(layer: any): Promise<void> {
  const layerId = layer.id;
  if (isFrontOfContainer(layer, layerId)) return;
  try {
    await selectLayerById(layerId);
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
    // Stack position is secondary to preserving an already returned paid image.
    console.log("[Mega Musa] could not bring the result layer to the front:", e?.message || e);
  }
}

async function makeSelectionMask(): Promise<void> {
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
  // Photoshop creates layer masks linked by default. Keeping that default makes
  // later Move/Free Transform operations scale the result and mask as one unit.
}

async function restoreSelectionFromMask(): Promise<void> {
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
    // The result and its mask are already safe; only the marching ants are lost.
    console.log("[Mega Musa] could not restore the selection after masking:", e?.message || e);
  }
}

async function deleteResultLayer(layerId: number): Promise<void> {
  await action.batchPlay(
    [
      {
        _obj: "delete",
        _target: [{ _ref: "layer", _id: layerId }],
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

function isLayerContainer(value: any): boolean {
  try {
    return !!value && value.layers != null && String(value.typename || "").toLowerCase() !== "document";
  } catch {
    return false;
  }
}

function descendantLayers(owner: any): any[] {
  let direct: any[];
  try {
    direct = Array.from(owner?.layers || []);
  } catch {
    return [];
  }

  const result: any[] = [];
  for (const layer of direct) {
    result.push(layer);
    if (isLayerContainer(layer)) result.push(...descendantLayers(layer));
  }
  return result;
}

function newDocumentLayers(document: any, existingLayerIds: Set<number>): any[] {
  return descendantLayers(document).filter((layer) => {
    const id = Number(layer?.id);
    return Number.isFinite(id) && !existingLayerIds.has(id);
  });
}

let smartObjectMarkerSequence = 0;

function nextSmartObjectMarker(): string {
  smartObjectMarkerSequence += 1;
  return `__mega_musa_result_${Date.now()}_${smartObjectMarkerSequence}`;
}

// Build the Smart Object from an explicit 8-bit sRGB document instead of a
// temporary PNG. That retains every returned source pixel, avoids missing-profile
// interpretation during Place Embedded and leaves no source file to manage.
async function createNativeSmartObject(
  targetDocument: any,
  anchorLayer: any,
  rgba: Uint8Array,
  width: number,
  height: number,
  layerName: string
): Promise<any> {
  const destinationParent = anchorLayer?.parent || null;
  const existingTargetLayerIds = new Set(
    descendantLayers(targetDocument).map((layer) => Number(layer.id)).filter(Number.isFinite)
  );
  const sourceMarker = nextSmartObjectMarker();
  let scratch: any | null = null;
  let placedLayer: any | null = null;
  try {
    scratch = await app.createDocument({
      width,
      height,
      resolution: 72,
      fill: "transparent",
      name: "mm-result-source",
      profile: SRGB_PROFILE,
    });
    if (!scratch) throw new Error("Photoshop could not create the Smart Object source document.");

    const sourceLayer = scratch.layers?.[0];
    if (!sourceLayer) throw new Error("The Smart Object source document has no pixel layer.");
    const imageData = await imaging.createImageDataFromBuffer(rgba, {
      width,
      height,
      components: 4,
      componentSize: 8,
      colorSpace: "RGB",
      colorProfile: SRGB_PROFILE,
      chunky: true,
    });
    try {
      await imaging.putPixels({
        documentID: scratch.id,
        layerID: sourceLayer.id,
        targetBounds: { left: 0, top: 0, right: width, bottom: height },
        imageData,
      });
    } finally {
      imageData.dispose();
    }

    await selectLayerById(sourceLayer.id);
    await action.batchPlay(
      [{ _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }],
      {}
    );
    const embeddedSource = scratch.activeLayers?.[0];
    if (!embeddedSource) throw new Error("Photoshop did not create the embedded Smart Object.");
    await renameActiveLayer(sourceMarker);

    await scratch.duplicateLayers([embeddedSource], targetDocument);

    app.activeDocument = targetDocument;
    const createdLayers = newDocumentLayers(targetDocument, existingTargetLayerIds);
    placedLayer = createdLayers.find((layer) => layer.name === sourceMarker) || null;
    if (!placedLayer && createdLayers.length === 1) placedLayer = createdLayers[0];
    if (!placedLayer) {
      throw new Error("Photoshop copied the Smart Object but did not expose its destination layer.");
    }

    if (isLayerContainer(destinationParent)) {
      placedLayer.move(destinationParent, constants.ElementPlacement.PLACEINSIDE);
    }
    await selectLayerById(placedLayer.id);
    await renameActiveLayer(layerName);
    return placedLayer;
  } catch (error) {
    if (openDocumentById(targetDocument.id)) {
      app.activeDocument = targetDocument;
      const incompleteLayers = newDocumentLayers(targetDocument, existingTargetLayerIds);
      if (
        placedLayer &&
        !incompleteLayers.some((layer) => Number(layer.id) === Number(placedLayer.id)) &&
        !existingTargetLayerIds.has(Number(placedLayer.id))
      ) {
        incompleteLayers.push(placedLayer);
      }
      for (const incompleteLayer of incompleteLayers) {
        try {
          await deleteResultLayer(incompleteLayer.id);
        } catch (cleanupError: any) {
          console.log(
            "[Mega Musa] could not remove an incomplete Smart Object:",
            cleanupError?.message || cleanupError
          );
          try {
            incompleteLayer.visible = false;
          } catch {
            /* the visible raster fallback remains the best available recovery */
          }
        }
      }
    }
    throw error;
  } finally {
    if (scratch && openDocumentById(scratch.id)) {
      try {
        await scratch.closeWithoutSaving();
      } catch {
        /* only the plugin-created scratch document is eligible for closing */
      }
    }
    if (openDocumentById(targetDocument.id)) app.activeDocument = targetDocument;
  }
}

async function smartObjectBounds(layer: any): Promise<Bounds | null> {
  // smartObjectMore.transform describes the four transformed source corners and
  // remains accurate when the source has transparent pixels at an outside edge.
  try {
    const result = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [{ _ref: "layer", _id: layer.id }],
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
    const transform = result?.[0]?.smartObjectMore?.transform;
    if (Array.isArray(transform) && transform.length >= 8) {
      const xs = [
        boundVal(transform[0]),
        boundVal(transform[2]),
        boundVal(transform[4]),
        boundVal(transform[6]),
      ];
      const ys = [
        boundVal(transform[1]),
        boundVal(transform[3]),
        boundVal(transform[5]),
        boundVal(transform[7]),
      ];
      if ([...xs, ...ys].every(Number.isFinite)) {
        const transformed = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };
        if (transformed.right > transformed.left && transformed.bottom > transformed.top) return transformed;
      }
    }
  } catch {
    /* boundsNoEffects is the compatible fallback on older hosts */
  }
  return preciseBoundsFrom(layer.boundsNoEffects) || preciseBoundsFrom(layer.bounds);
}

// Uniformly cover the target without rasterizing. Any excess source area stays
// inside the Smart Object and can be revealed later by moving or rescaling it.
async function coverTransformSmartObject(layer: any, target: Bounds): Promise<Bounds> {
  const initial = await smartObjectBounds(layer);
  if (!initial) throw new Error("Photoshop did not report the Smart Object bounds.");
  const initialW = initial.right - initial.left;
  const initialH = initial.bottom - initial.top;
  const targetW = target.right - target.left;
  const targetH = target.bottom - target.top;
  const scale = Math.max(targetW / initialW, targetH / initialH);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("The Smart Object transform is invalid.");

  if (Math.abs(scale - 1) > 0.000001) await layer.scale(scale * 100, scale * 100);
  const scaled = await smartObjectBounds(layer);
  if (!scaled) throw new Error("Photoshop did not report the scaled Smart Object bounds.");
  const dx = (target.left + target.right - scaled.left - scaled.right) / 2;
  const dy = (target.top + target.bottom - scaled.top - scaled.bottom) / 2;
  if (Math.abs(dx) > 0.000001 || Math.abs(dy) > 0.000001) await layer.translate(dx, dy);

  const transformed = await smartObjectBounds(layer);
  if (!transformed) throw new Error("Photoshop did not report the positioned Smart Object bounds.");
  const tolerance = 0.75;
  if (
    transformed.left > target.left + tolerance ||
    transformed.top > target.top + tolerance ||
    transformed.right < target.right - tolerance ||
    transformed.bottom < target.bottom - tolerance
  ) {
    throw new Error("The Smart Object transform did not cover the result region.");
  }
  return transformed;
}

function extendsPastTarget(layerBounds: Bounds, target: Bounds): boolean {
  const tolerance = 0.75;
  return (
    layerBounds.left < target.left - tolerance ||
    layerBounds.top < target.top - tolerance ||
    layerBounds.right > target.right + tolerance ||
    layerBounds.bottom > target.bottom + tolerance
  );
}

async function placeRasterFallback(
  docId: number,
  bounds: Bounds,
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  layerName: string,
  selection: SelectionSnapshot | null,
  selectionStillMatches: boolean
): Promise<{ layer: any; clip: PlacementClip }> {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  let rgba: Uint8Array;
  if (sourceWidth === width && sourceHeight === height) {
    rgba = sourceRgba.slice();
  } else {
    try {
      rgba = await scaleViaPhotoshopInModal(sourceRgba, sourceWidth, sourceHeight, width, height);
    } catch (e: any) {
      console.log("[Mega Musa] Photoshop raster fallback scaling failed; using JS resample:", e?.message || e);
      rgba = coverResampleRGBA(sourceRgba, sourceWidth, sourceHeight, width, height);
    }
  }

  await action.batchPlay(
    [{ _obj: "make", _target: [{ _ref: "layer" }], _options: { dialogOptions: "dontDisplay" } }],
    {}
  );
  const layer = app.activeDocument.activeLayers[0];
  await renameActiveLayer(layerName);
  await bringResultToFront(layer);

  let clip: PlacementClip = "none";
  let masked = false;
  if (selection && selectionStillMatches) {
    try {
      await makeSelectionMask();
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
    colorProfile: SRGB_PROFILE,
    chunky: true,
  });
  try {
    await imaging.putPixels({
      documentID: docId,
      layerID: layer.id,
      targetBounds: bounds,
      imageData,
    });
  } finally {
    imageData.dispose();
  }
  if (masked) await restoreSelectionFromMask();
  return { layer, clip };
}

// Modal step 2: preserve the complete native provider image inside an embedded
// Smart Object, cover-transform it into `bounds` and attach a linked layer mask
// when the target shape needs clipping. Any Smart Object failure falls back to
// the previous raster placement so a paid result is never discarded.
export async function placeResult(
  docId: number,
  bounds: Bounds,
  rgba: Uint8Array,
  width: number,
  height: number,
  layerName: string,
  selection: SelectionSnapshot | null,
  maskOnlyWhenOverflow: boolean,
  archive: GenerationArchive,
  references: RefImage[]
): Promise<PlacementResult> {
  return await core.executeAsModal(
    () => withActiveDocument(docId, async () => {
      const document = app.activeDocument;
      const anchorLayer = document.activeLayers?.[0] || null;
      const anchorLayerId = anchorLayer?.id;
      let resultLayer: any;
      let clip: PlacementClip = "none";
      let smartObject = true;
      let incompleteSmartObject: any | null = null;

      try {
        incompleteSmartObject = await createNativeSmartObject(
          document,
          anchorLayer,
          rgba,
          width,
          height,
          layerName
        );
        const transformedBounds = await coverTransformSmartObject(incompleteSmartObject, bounds);
        await bringResultToFront(incompleteSmartObject);

        const maskRequired =
          !!selection && (!maskOnlyWhenOverflow || extendsPastTarget(transformedBounds, bounds));
        if (maskRequired) {
          if (!(await liveSelectionMatches(docId, selection))) {
            throw new Error("The selection changed before the linked Smart Object mask could be created.");
          }
          await selectLayerById(incompleteSmartObject.id);
          await makeSelectionMask();
          clip = "mask";
          await restoreSelectionFromMask();
        }
        resultLayer = incompleteSmartObject;
      } catch (error: any) {
        smartObject = false;
        console.log("[Mega Musa] Smart Object placement failed; using raster fallback:", error?.message || error);
        if (incompleteSmartObject) {
          try {
            await deleteResultLayer(incompleteSmartObject.id);
          } catch (cleanupError: any) {
            console.log("[Mega Musa] could not remove the incomplete Smart Object:", cleanupError?.message || cleanupError);
            try {
              incompleteSmartObject.visible = false;
            } catch {
              /* the raster fallback remains the visible paid result */
            }
          }
        }
        if (anchorLayerId) await selectLayerById(anchorLayerId);
        // A raster layer is already exactly `bounds`, so a rectangular overflow
        // mask is unnecessary. Irregular/feathered original selections still use
        // the normal editable-mask-or-alpha fallback.
        const rasterSelection = maskOnlyWhenOverflow ? null : selection;
        const selectionStillMatches = rasterSelection
          ? await liveSelectionMatches(docId, rasterSelection)
          : false;
        const fallback = await placeRasterFallback(
          docId,
          bounds,
          rgba,
          width,
          height,
          layerName,
          rasterSelection,
          selectionStillMatches
        );
        resultLayer = fallback.layer;
        clip = fallback.clip;
      }

      const layerId = resultLayer.id;

      let referenceArchiveFailures = 0;
      try {
        const assets = await archiveReferenceAssetsInActiveDocument(docId, references, layerId);
        archive.references = assets.references;
        referenceArchiveFailures = assets.failures.length;
      } catch (e: any) {
        // Asset storage is provenance, not the paid output. Preserve the result
        // and still mark this as a Stage 2 record with no reusable pointers.
        archive.references = [];
        referenceArchiveFailures = references.length;
        console.log("[Mega Musa] could not archive reference assets:", e?.message || e);
      }

      let archiveSaved = true;
      try {
        await writeLayerGenerationArchive(docId, layerId, archive);
      } catch (e: any) {
        // The generated pixels are already placed. A metadata failure should be
        // visible to the caller, but must not discard a paid result.
        archiveSaved = false;
        console.log("[Mega Musa] could not save the layer generation archive:", e?.message || e);
      }
      return { clip, layerId, smartObject, archiveSaved, referenceArchiveFailures };
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
        profile: SRGB_PROFILE,
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
          colorSpace: "RGB",
          colorProfile: SRGB_PROFILE,
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
async function scaleViaPhotoshopInModal(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Promise<Uint8Array> {
  const scratch = await app.createDocument({
    width: srcW,
    height: srcH,
    resolution: 72,
    fill: "transparent",
    name: "mm-scale",
    profile: SRGB_PROFILE,
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
      colorProfile: SRGB_PROFILE,
      chunky: true,
    });
    try {
      await imaging.putPixels({
        documentID: scratch.id,
        layerID: layerId,
        targetBounds: { left: 0, top: 0, right: srcW, bottom: srcH },
        imageData: srcData,
      });
    } finally {
      srcData.dispose();
    }

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
      colorSpace: "RGB",
      colorProfile: SRGB_PROFILE,
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
}

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
    () => scaleViaPhotoshopInModal(rgba, srcW, srcH, dstW, dstH),
    { commandName: "Mega Musa: scale result" }
  );
}
