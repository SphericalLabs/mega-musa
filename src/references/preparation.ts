/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { base64ToBytes, bytesToBase64 } from "../images/base64";
import { tagJpegAsSrgb, tagPngAsSrgb } from "../images/color-tags";
import { type RefImage } from "../references";
import { ReferenceImageProcessor } from "./processor";

// Use a high finite cap to preserve archive resolution for normal inputs; failed canvas
// conversions retain the original bytes.
const REFERENCE_ARCHIVE_MAX_EDGE = 100000;

export async function prepareReferenceArchiveImages(
  processor: Pick<ReferenceImageProcessor, "resize">,
  references: RefImage[],
  reduceDocumentSize: boolean
): Promise<RefImage[]> {
  if (!reduceDocumentSize) return references;
  const prepared: RefImage[] = [];
  for (const reference of references) {
    // Reuse restored assets even when the document-size preference has changed.
    if (reference.archivedHash) {
      prepared.push(reference);
      continue;
    }
    try {
      const compact = await processor.resize(reference, { maxEdge: REFERENCE_ARCHIVE_MAX_EDGE, forcePng: false, logDimensions: false, normalizeSrgb: true, compactStorage: true });
      let bytes = base64ToBytes(compact.base64);
      const storageMode = compact.mimeType === "image/jpeg" ? "jpeg-90" : "png-srgb";
      bytes = compact.mimeType === "image/jpeg" ? tagJpegAsSrgb(bytes) : tagPngAsSrgb(bytes);
      // JPEG re-encoding can increase size; keep the original bytes when it does.
      if (reference.mimeType === "image/jpeg" && bytes.length >= base64ToBytes(reference.base64).length) {
        prepared.push(reference);
        continue;
      }
      prepared.push({
        ...reference,
        archiveAsset: {
          mimeType: compact.mimeType as "image/png" | "image/jpeg",
          base64: bytesToBase64(bytes),
          storageMode,
          lossy: storageMode === "jpeg-90",
        },
      });
    } catch (error: any) {
      console.log(
        `[Mega Musa] kept original reference “${reference.name}” because compact storage failed:`,
        error?.message || error
      );
      prepared.push(reference);
    }
  }
  return prepared;
}
