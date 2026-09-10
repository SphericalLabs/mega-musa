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

import "./polyfills"; // Must precede codec imports in the panel.

import { createPanel } from "./panel/app";
import { setStatus } from "./panel/status";

const panel = createPanel();
globalThis.addEventListener?.("unload", () => panel.dispose());

try {
  const g: any = globalThis as any;
  g.addEventListener?.("unhandledrejection", (e: any) =>
    setStatus("Async error: " + (e?.reason?.message || e?.reason || "unknown"), "error")
  );
  g.addEventListener?.("error", (e: any) =>
    setStatus("Script error: " + (e?.message || "unknown"), "error")
  );
} catch {
  /* Global error hooks may be unavailable in this runtime. */
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void panel.init());
} else {
  void panel.init();
}
