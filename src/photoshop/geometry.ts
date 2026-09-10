/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type Bounds, type SelectionSnapshot } from "./types";

export function boundVal(u: any): number {
  return typeof u === "number" ? u : u?._value ?? 0;
}

export function boundsFrom(value: any): Bounds | null {
  if (!value) return null;
  const bounds = {
    left: Math.round(boundVal(value.left)),
    top: Math.round(boundVal(value.top)),
    right: Math.round(boundVal(value.right)),
    bottom: Math.round(boundVal(value.bottom)),
  };
  return bounds.right - bounds.left > 1 && bounds.bottom - bounds.top > 1 ? bounds : null;
}

export function preciseBoundsFrom(value: any): Bounds | null {
  if (!value) return null;
  const bounds = {
    left: boundVal(value.left),
    top: boundVal(value.top),
    right: boundVal(value.right),
    bottom: boundVal(value.bottom),
  };
  return bounds.right - bounds.left > 0 && bounds.bottom - bounds.top > 0 ? bounds : null;
}

export function selectionNeedsMask(selection: SelectionSnapshot | null): selection is SelectionSnapshot {
  if (!selection) return false;
  const width = selection.bounds.right - selection.bounds.left;
  const height = selection.bounds.bottom - selection.bounds.top;
  // Let mask creation reject malformed snapshots instead of treating them as opaque.
  if (width < 1 || height < 1 || selection.data.length !== width * height) return true;
  for (let i = 0; i < selection.data.length; i++) {
    if (selection.data[i] !== 255) return true;
  }
  return false;
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

// Prefer expansion to preserve selection coverage; shrink and reposition to fit the
// limits. Pixel rounding can slightly change the target ratio.
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
