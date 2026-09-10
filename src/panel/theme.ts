/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { $ } from "./controls";

// Read the CSS theme probe: black means light, otherwise dark. Polling must stay
// nonthrowing so theme failures cannot replace panel status.
export function panelTheme(): "dark" | "light" {
  try {
    const probe = $("themeProbe");
    const color = probe ? String(getComputedStyle(probe).color || "") : "";
    return /^(#000(000)?$|rgba?\(\s*0\s*,\s*0\s*,\s*0\b)/.test(color.trim().toLowerCase())
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

export function panelBackground(theme: "dark" | "light"): string {
  try {
    const probe = $("themeProbe");
    const color = probe ? String(getComputedStyle(probe).backgroundColor || "").trim() : "";
    const compact = color.replace(/\s+/g, "").toLowerCase();
    if (color && compact !== "transparent" && compact !== "rgba(0,0,0,0)") return color;
  } catch {
    /* Fall back to an opaque approximation for runtimes without host colors. */
  }
  return theme === "light" ? "rgb(239, 239, 239)" : "rgb(50, 50, 50)";
}

export function dropSurface(theme: "dark" | "light", backgroundColor: string): string {
  if (theme === "light") return "rgb(255, 255, 255)";
  // Approximate Spectrum's dark text-field contrast with an opaque surface.
  const rgb = backgroundColor.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i
  );
  const hex = backgroundColor.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1] || "";
  const channels = rgb
    ? rgb.slice(1, 4).map(Number)
    : hex.length === 3
      ? hex.split("").map((value) => parseInt(value + value, 16))
      : hex.length >= 6
        ? [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
        : null;
  if (!channels) return "rgb(8, 8, 8)";
  const fieldChannels = channels.map((value) => Math.max(8, Math.round(value) - 45));
  return `rgb(${fieldChannels.join(", ")})`;
}
