/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */
import { errorMessage } from "../errors";
import { DEFAULT_MODEL, modelSpec } from "../models/catalog";
import { nearestImageSize, outputFrame } from "../models/geometry";
import { getActiveArtboard } from "../photoshop/artboards";
import { fitRegionToRatio, intersectBounds } from "../photoshop/geometry";
import { getActiveDoc } from "../photoshop/runtime";
import { getSelectionBounds, setRectSelection } from "../photoshop/selection";
import { saveSetting } from "../storage";
import { $, setPickerSafe } from "./controls";
import { setStatus } from "./status";
export function createSelectionControls(refreshResolutionLabels: () => void) {
  async function onFitSelection(): Promise<void> {
    const v = $("selRatio").value || "1:1";
    try {
      const doc = getActiveDoc();
      const sel = await getSelectionBounds();
      if (!sel || sel.right - sel.left < 2 || sel.bottom - sel.top < 2) {
        setStatus("Draw a selection first, then click Fit selection.", "error");
        return;
      }
      const activeArtboard = await getActiveArtboard(doc);
      const limit = activeArtboard?.bounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
      const targetSelection = intersectBounds(sel, limit);
      if (!targetSelection) {
        setStatus("The selection does not overlap the active artboard.", "error");
        return;
      }
      const [rw, rh] = v.split(":").map(Number);
      await setRectSelection(fitRegionToRatio(targetSelection, rw / rh, limit));
      setStatus(`Selection fitted to ${v} — preview the shape, then Generate.`, "ok");
    } catch (err: any) {
      setStatus("Couldn't fit selection: " + errorMessage(err), "error");
    }
  }

  async function onFitNearest(): Promise<void> {
    try {
      const doc = getActiveDoc();
      const sel = await getSelectionBounds();
      if (!sel || sel.right - sel.left < 2 || sel.bottom - sel.top < 2) {
        setStatus("Draw a selection first, then click Fit to nearest.", "error");
        return;
      }
      const activeArtboard = await getActiveArtboard(doc);
      const limit = activeArtboard?.bounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
      const targetSelection = intersectBounds(sel, limit);
      if (!targetSelection) {
        setStatus("The selection does not overlap the active artboard.", "error");
        return;
      }
      const spec = modelSpec($("model")?.value || DEFAULT_MODEL);
      const resolution = nearestImageSize($("resolution")?.value || "auto", spec);
      const frame = outputFrame(
        spec,
        resolution,
        targetSelection.right - targetSelection.left,
        targetSelection.bottom - targetSelection.top
      );
      setPickerSafe($("selRatio"), frame.label);
      saveSetting("selRatio", frame.label);
      refreshResolutionLabels();
      await setRectSelection(fitRegionToRatio(targetSelection, frame.ratio, limit));
      setStatus(`Fitted to nearest ratio: ${frame.label}.`, "ok");
    } catch (err: any) {
      setStatus("Couldn't fit selection: " + errorMessage(err), "error");
    }
  }

  return { onFitSelection, onFitNearest };
}
