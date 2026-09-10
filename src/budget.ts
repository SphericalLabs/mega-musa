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

import { formatMoney } from "./currency";
import { loadSetting, saveSetting } from "./storage";

// Frozen historical rate: never use a future display rate to migrate old totals.
const LEGACY_USD_CHF = 0.8103;

// USD totals combine generation and description charges. Callers supply usage costs or
// estimates; description counters track input images.

export interface Budget {
  usd: number;
  images: number; // Priced generation results.
  unpriced: number; // Generation results without a usable price.
  cancelled: number; // Requests canceled after sending, budgeted as potentially billed.
  imagesAnalyzed: number; // Input images in budgeted Describe requests.
  analysisCancelled: number;
  analysisEstimates: number;
  since: string; // ISO date of the last reset or first use.
}

function num(name: string): number {
  const v = Number(loadSetting(name, "0"));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function save(b: Budget): void {
  saveSetting("budgetUSD", String(b.usd));
  saveSetting("budgetImages", String(b.images));
  saveSetting("budgetUnpriced", String(b.unpriced));
  saveSetting("budgetCancelled", String(b.cancelled));
  saveSetting("budgetImagesAnalyzed", String(b.imagesAnalyzed));
  saveSetting("budgetAnalysisCancelled", String(b.analysisCancelled));
  saveSetting("budgetAnalysisEstimates", String(b.analysisEstimates));
  saveSetting("budgetSince", b.since);
}

export function loadBudget(): Budget {
  const since = loadSetting("budgetSince", "");
  if (!since) return resetBudget();
  // A stored zero is already migrated. Keep the old key as a historical backup.
  if (loadSetting("budgetUSD", "") === "") {
    saveSetting("budgetUSD", String(num("budgetCHF") / LEGACY_USD_CHF));
  }
  return {
    usd: num("budgetUSD"),
    images: num("budgetImages"),
    unpriced: num("budgetUnpriced"),
    cancelled: num("budgetCancelled"),
    // Legacy request counts cannot recover image counts; new counters start at zero.
    imagesAnalyzed: num("budgetImagesAnalyzed"),
    analysisCancelled: num("budgetAnalysisCancelled"),
    analysisEstimates: num("budgetAnalysisEstimates"),
    since,
  };
}

export function resetBudget(): Budget {
  const fresh: Budget = {
    usd: 0,
    images: 0,
    unpriced: 0,
    cancelled: 0,
    imagesAnalyzed: 0,
    analysisCancelled: 0,
    analysisEstimates: 0,
    since: new Date().toISOString(),
  };
  save(fresh);
  return fresh;
}

// Generation counters are disjoint. Null prices count as unpriced; cancellations after
// sending retain any supplied estimate.
export function addToBudget(usd: number | null, cancelled = false): Budget {
  const b = loadBudget();
  if (usd !== null) b.usd += usd;
  if (cancelled) b.cancelled += 1;
  else if (usd === null) b.unpriced += 1;
  else b.images += 1;
  save(b);
  return b;
}

export function addDescriptionToBudget(usd: number, imageCount: number, cancelled = false, estimated = false): Budget {
  const b = loadBudget();
  b.usd += usd;
  b.imagesAnalyzed += imageCount;
  if (cancelled) b.analysisCancelled += imageCount;
  if (estimated) b.analysisEstimates += imageCount;
  save(b);
  return b;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// UXP Intl may throw or ignore month formatting; fall back to an English date.
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  try {
    const s = d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    if (s && /[A-Za-z]{3}/.test(s)) return s;
  } catch {
    /* fall through to the fixed format below */
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Separate fields let UXP lay out the total and breakdown on their own lines.
export function budgetText(b: Budget): { total: string; counts: string } {
  const analysisDetails: string[] = [];
  if (b.analysisCancelled) analysisDetails.push(`${b.analysisCancelled} canceled`);
  if (b.analysisEstimates) analysisDetails.push(`${b.analysisEstimates} estimated`);
  const analyzed = `${b.imagesAnalyzed} image${b.imagesAnalyzed === 1 ? "" : "s"} described` +
    (analysisDetails.length ? ` (${analysisDetails.join(", ")})` : "");
  const counts = [`${b.images} images`, analyzed];
  if (b.unpriced) counts.push(`${b.unpriced} unpriced`);
  if (b.cancelled) counts.push(`${b.cancelled} image requests canceled but billed`);
  return {
    // Round only the display; small description charges retain full precision.
    total: `Budget spent since ${formatDate(b.since)}: ca. ${formatMoney(b.usd, 2)}`,
    counts: `(${counts.join(", ")})`,
  };
}
