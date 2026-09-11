/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type HostModalLease } from "../host-modal";
import { SRGB_PROFILE } from "./document-state";
import { copyPixels } from "./pixel-data";
import { app, batchPlay, runModal } from "./runtime";
import { type PastedImage } from "./types";

// Cap pasted references to limit PNG encoding time and request size.
export const PASTE_MAX_EDGE = 2048;

// Paste through Photoshop into a scratch document to read clipboard images. Validate
// returned pixels because a paste can silently do nothing.
export async function readClipboardImage(lease?: HostModalLease): Promise<PastedImage | null> {
  return await runModal(
    "paste reference",
    async () => {
      // Guard scratch cleanup against closing the user's document.
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
      try {
        // Never paste unless the scratch document is active.
        app.activeDocument = scratch;
        if (app.activeDocument?.id !== scratch.id) {
          throw new Error("Could not activate the scratch document for the paste.");
        }
        // dontDisplay still opens Photoshop error dialogs; silent returns errors to us.
        try {
          await batchPlay(
            [
              {
                _obj: "paste",
                antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" },
                _options: { dialogOptions: "silent" },
              },
            ],
            {}
          );
        } catch (e: any) {
          // An empty or text-only clipboard makes Photoshop's Paste unavailable.
          if (/not (?:currently )?available|clipboard.*(?:empty|no image)/i.test(String(e?.message || e))) {
            return null;
          }
          throw e;
        }
        // Reveal and trim the paste; empty documents may reject either operation.
        for (const cmd of [
          { _obj: "revealAll", _options: { dialogOptions: "silent" } },
          {
            _obj: "trim",
            trimBasedOn: { _enum: "trimBasedOn", _value: "transparency" },
            top: true,
            bottom: true,
            left: true,
            right: true,
            _options: { dialogOptions: "silent" },
          },
        ]) {
          try {
            await batchPlay([cmd], {});
          } catch (e: any) {
            console.log(`[Mega Musa] paste ${cmd._obj}:`, e?.message || e);
          }
        }

        const originalWidth = Math.round(scratch.width);
        const originalHeight = Math.round(scratch.height);
        const longest = Math.max(originalWidth, originalHeight);
        if (longest > PASTE_MAX_EDGE) {
          const k = PASTE_MAX_EDGE / longest;
          await batchPlay(
            [
              {
                _obj: "imageSize",
                width: { _unit: "pixelsUnit", _value: Math.max(1, Math.round(originalWidth * k)) },
                height: { _unit: "pixelsUnit", _value: Math.max(1, Math.round(originalHeight * k)) },
                constrainProportions: true,
                interpolation: { _enum: "interpolationType", _value: "bicubicSharper" },
                _options: { dialogOptions: "silent" },
              },
            ],
            {}
          );
        }
        const width = Math.round(scratch.width);
        const height = Math.round(scratch.height);

        const { data, components } = await copyPixels({
          documentID: scratch.id, sourceBounds: { left: 0, top: 0, right: width, bottom: height },
        });

        // A silent no-op paste leaves every pixel transparent.
        if (components === 4) {
          let opaque = false;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) {
              opaque = true;
              break;
            }
          }
          if (!opaque) {
            return null;
          }
        }

        return { data, width, height, components, originalWidth, originalHeight };
      } finally {
        if (scratch && scratch.id !== userDocId) {
          try {
            await scratch.closeWithoutSaving();
          } catch {
            /* Scratch cleanup must not discard successfully read pixels. */
          }
        }
      }
    },
    lease
  );
}
