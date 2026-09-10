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
export async function readClipboardImage(lease?: HostModalLease): Promise<PastedImage> {
  return await runModal(
    "paste reference",
    async () => {
      const trace: string[] = [];
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
      // Paste targets the active document, so activate the scratch document first.
      try {
        app.activeDocument = scratch;
      } catch (e: any) {
        trace.push(`activate: ${e?.message || e}`);
      }
      try {
        await batchPlay(
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
      // Reveal and trim the paste; empty documents may reject either operation.
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
          await batchPlay([cmd], {});
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
          await batchPlay(
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
            throw new Error(
              `Photoshop pasted nothing — the clipboard has no image it can read. [${trace.join(" | ")}]`
            );
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
