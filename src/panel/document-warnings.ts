/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type DocumentBlocker, type DocumentState } from "../photoshop/document-state";
import { showModalNotice } from "./notices";

import { SRGB_PROFILE } from "../photoshop/document-state";

// Scope accepted warnings to each document/mode/profile/depth state for this session.
const acceptedDocumentWarnings = new Set<string>();

export async function showDocumentBlocker(blocker: DocumentBlocker): Promise<void> {
  await showModalNotice({
    kind: "blocker",
    title: blocker.title,
    message: blocker.message,
    instruction: blocker.instruction,
    primaryLabel: "Close",
  });
}

async function confirmDocumentWarning(
  title: string,
  message: string,
  instruction: string
): Promise<boolean> {
  const action = await showModalNotice({
    kind: "warning",
    title,
    message,
    instruction,
    primaryLabel: "Generate Anyway",
    cancelLabel: "Cancel",
  });
  return action === "primary";
}

async function confirm16BitDocument(state: DocumentState): Promise<boolean> {
  if (state.bitsPerChannel !== 16) return true;
  const key = `16-bit|${state.fingerprint}`;
  if (acceptedDocumentWarnings.has(key)) return true;
  const confirmed = await confirmDocumentWarning(
    "16-bit document may lose tonal precision",
    "Mega Musa processes canvas input and generated results at 8 bits per channel. This document uses 16 bits per channel, so the generated area is limited to 8-bit tonal precision and may show banding in smooth gradients.",
    "To avoid this, choose Image > Mode > 8 Bits/Channel."
  );
  if (!confirmed) return false;
  acceptedDocumentWarnings.add(key);
  return true;
}

async function confirmDocumentColorSpace(state: DocumentState): Promise<boolean> {
  const isSrgb = state.mode === "RGB" && state.profile.toLowerCase() === SRGB_PROFILE.toLowerCase();
  if (isSrgb) return true;
  const key = `color|${state.fingerprint}`;
  if (acceptedDocumentWarnings.has(key)) return true;

  const confirmed = await confirmDocumentWarning(
    "Color conversion may cause visible seams",
    `Mega Musa generates images in sRGB. This document uses ${state.mode} / ${state.profile}, so converting only the generated area may change colors along its edges.`,
    `For the best match, choose Edit > Convert to Profile… and select ${SRGB_PROFILE}.`
  );
  if (!confirmed) return false;
  acceptedDocumentWarnings.add(key);
  return true;
}

export async function confirmDocumentWarnings(state: DocumentState, coversEntireTarget: boolean): Promise<boolean> {
  if (!(await confirm16BitDocument(state))) return false;
  // Skip seam warnings for full opaque coverage; color conversion still applies.
  if (!coversEntireTarget && !(await confirmDocumentColorSpace(state))) return false;
  return true;
}
