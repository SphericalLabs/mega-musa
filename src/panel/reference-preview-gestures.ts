/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Trackpads report pixels; mouse wheels may report lines or pages. Bound each
// step so a coarse wheel event cannot jump straight to a zoom limit.
export function previewScrollZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1;
  const pixels = Math.max(-100, Math.min(100, deltaY * unit));
  return Math.exp(-pixels * 0.002);
}
