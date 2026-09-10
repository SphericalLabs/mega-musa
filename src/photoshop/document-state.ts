/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export const SRGB_PROFILE = "sRGB IEC61966-2.1";

export interface DocumentState {
  mode: string;
  profile: string;
  bitsPerChannel: number | null;
  quickMaskMode: boolean;
  fingerprint: string;
}

export interface DocumentBlocker {
  title: string;
  message: string;
  instruction: string;
}

export function documentModeLabel(mode: any): string {
  const raw = String(mode || "");
  const token = raw.replace(/[\s_-]/g, "").toUpperCase();
  if (token.includes("INDEXED")) return "Indexed Color";
  if (token.includes("MULTICHANNEL")) return "Multichannel";
  if (token.includes("GRAYSCALE") || token === "GRAY") return "Grayscale";
  if (token.includes("DUOTONE")) return "Duotone";
  if (token.includes("BITMAP")) return "Bitmap";
  if (token.includes("CMYK")) return "CMYK";
  if (token.includes("LAB")) return "Lab";
  if (token.includes("RGB")) return "RGB";
  return raw || "Unknown mode";
}

export function documentBitsPerChannel(value: any): number | null {
  const numeric = Number(value);
  if (numeric === 1 || numeric === 8 || numeric === 16 || numeric === 32) return numeric;

  const depth = /^bitDepth(1|8|16|32)$/i.exec(String(value ?? ""));
  if (depth) return Number(depth[1]);

  // Normalize defensively in case a host includes the enum name in the string.
  const token = String(value ?? "").replace(/[\s_.-]/g, "").toUpperCase();
  if (token.includes("THIRTYTWO")) return 32;
  if (token.includes("SIXTEEN")) return 16;
  if (token.includes("EIGHT")) return 8;
  if (token.endsWith("ONE")) return 1;
  return null;
}

export function readDocumentProfile(doc: any): string {
  try {
    return String(doc?.colorProfileName || "None").trim() || "None";
  } catch {
    return "None";
  }
}

export function getDocumentState(doc: any): DocumentState {
  const mode = documentModeLabel(doc?.mode);
  const profile = readDocumentProfile(doc);
  let bitsPerChannel: number | null = null;
  let quickMaskMode = false;
  try {
    bitsPerChannel = documentBitsPerChannel(doc?.bitsPerChannel);
  } catch {
    /* An older host may not expose the DOM property. */
  }
  try {
    quickMaskMode = Boolean(doc?.quickMaskMode);
  } catch {
    /* Older hosts may not expose quickMaskMode. */
  }
  return {
    mode,
    profile,
    bitsPerChannel,
    quickMaskMode,
    fingerprint: [Number(doc?.id), mode, profile.toLowerCase(), bitsPerChannel ?? "unknown"].join("|"),
  };
}

export function unsupportedModeInstruction(mode: string): string {
  if (mode === "Bitmap" || mode === "Duotone") {
    return (
      "Save a copy, then choose Image > Mode > Grayscale followed by Image > Mode > RGB Color. " +
      `Finally choose Edit > Convert to Profile… and select ${SRGB_PROFILE}.`
    );
  }
  if (mode === "Multichannel") {
    return (
      "Save a copy, then choose Image > Mode > RGB Color. If RGB Color is unavailable, create a new RGB " +
      `document and copy the artwork into it. Finally convert that document to ${SRGB_PROFILE}.`
    );
  }
  return (
    "Save a copy, then choose Image > Mode > RGB Color. " +
    `Finally choose Edit > Convert to Profile… and select ${SRGB_PROFILE}.`
  );
}

export function documentBlocker(state: DocumentState): DocumentBlocker | null {
  if (state.quickMaskMode) {
    return {
      title: "Quick Mask is active",
      message: "Mega Musa needs a normal selection to capture and restore the result mask safely.",
      instruction: "Press Q or click Standard Mode at the bottom of the Tools panel, then try again.",
    };
  }
  if (state.bitsPerChannel === 32) {
    return {
      title: "32-bit documents are not supported",
      message:
        "Mega Musa generates 8-bit sRGB images. Placing them in a 32-bit/HDR document can change " +
        "exposure, brightness and color and may cause visible seams.",
      instruction:
        "Choose Image > Mode > 16 Bits/Channel or 8 Bits/Channel, review Photoshop’s HDR conversion, " +
        "then try again.",
    };
  }
  if (["Bitmap", "Indexed Color", "Duotone", "Multichannel"].includes(state.mode)) {
    return {
      title: `${state.mode} documents are not supported`,
      message: `Mega Musa cannot safely place a generated RGB result in a ${state.mode} document.`,
      instruction: unsupportedModeInstruction(state.mode),
    };
  }
  return null;
}
