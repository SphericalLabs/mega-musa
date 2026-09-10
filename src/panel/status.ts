/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type Budget, budgetText, loadBudget } from "../budget";
import { $ } from "./controls";

export function setStatus(message: string, kind: "info" | "error" | "ok" = "info"): void {
  const el = $("status");
  if (!el) return;
  el.textContent = message;
  el.className = kind === "info" ? "" : kind;
}

// Keep framing notes visible while transient status messages change.
export function setNote(message: string): void {
  const el = $("note");
  if (!el) return;
  el.textContent = message;
}

export function renderBudget(b?: Budget): void {
  const { total, counts } = budgetText(b || loadBudget());
  const totalEl = $("budgetTotal");
  const countsEl = $("budgetCounts");
  if (totalEl) totalEl.textContent = total;
  if (countsEl) countsEl.textContent = counts;
}
