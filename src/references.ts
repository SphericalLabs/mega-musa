/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
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

import { base64ToBytes, bytesToBase64 } from "./image-codec";

const { storage } = require("uxp");

export interface RefImage {
  name: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
  thumbnailDataUrl?: string; // PNG fallback for UXP, which cannot preview WebP reliably
  // Prepared for document storage only; preview and request source bytes stay unchanged.
  archiveAsset?: {
    mimeType: "image/png" | "image/jpeg";
    base64: string;
    storageMode: "png-srgb" | "jpeg-90";
    lossy: boolean;
  };
  // Keep restored asset identity so it can be reused without recompression.
  archivedHash?: string;
  archivedStorageMode?: "original" | "png-srgb" | "jpeg-90";
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const REF_FORMATS = "PNG, JPEG or WebP";

function mimeForName(name: string): string | null {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_MIME[ext] || null;
}

function mimeForBytes(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

async function readBytes(entry: any): Promise<Uint8Array> {
  let buffer: ArrayBuffer;
  if (entry && typeof entry.read === "function") {
    buffer = await entry.read({ format: storage.formats.binary });
  } else if (entry && typeof entry.arrayBuffer === "function") {
    buffer = await entry.arrayBuffer();
  } else {
    throw new Error("the dropped file has no binary read method");
  }
  return new Uint8Array(buffer);
}

async function entryToRef(entry: any, name: string, mimeType: string): Promise<RefImage> {
  const base64 = bytesToBase64(await readBytes(entry));
  return { name, mimeType, base64, dataUrl: `data:${mimeType};base64,${base64}` };
}

export async function pickReferenceImages(maxCount: number): Promise<RefImage[]> {
  const fs = storage.localFileSystem;
  const picked = await fs.getFileForOpening({
    allowMultiple: true,
    types: ["png", "jpg", "jpeg", "webp"],
  });
  if (!picked) return [];
  const files = Array.isArray(picked) ? picked : [picked];

  const out: RefImage[] = [];
  for (const file of files.slice(0, maxCount)) {
    out.push(await entryToRef(file, file.name, mimeForName(file.name) || "image/png"));
  }
  return out;
}

// Check bytes because the WebView's filename and reported MIME may be wrong.
export function referenceImageFromBase64(name: string, base64: string): RefImage | null {
  const mimeType = mimeForBytes(base64ToBytes(base64));
  if (!mimeType) return null;
  return {
    name: name || "dropped image",
    mimeType,
    base64,
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}
