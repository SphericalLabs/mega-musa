/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
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

import { loadSetting, saveSetting } from "./storage";

// A running record of what this panel has cost, kept in localStorage next to the
// other panel settings. When GPT Image 2 returns usage, the caller supplies the
// token-based amount; otherwise it supplies the output-only estimate shown in the
// resolution menu. Models without compatible published token rates still use
// that estimate.

export interface Budget {
  chf: number;
  images: number; // images it could price
  unpriced: number; // images generated at a tier with no published price
  cancelled: number; // runs stopped after the request went out — billed, no image
  since: string; // ISO date of the last reset, or of first use
}

function num(name: string): number {
  const v = Number(loadSetting(name, "0"));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function save(b: Budget): void {
  saveSetting("budgetCHF", String(b.chf));
  saveSetting("budgetImages", String(b.images));
  saveSetting("budgetUnpriced", String(b.unpriced));
  saveSetting("budgetCancelled", String(b.cancelled));
  saveSetting("budgetSince", b.since);
}

export function loadBudget(): Budget {
  const since = loadSetting("budgetSince", "");
  // No stored start date means this is the first run — start the clock now.
  if (!since) return resetBudget();
  return {
    chf: num("budgetCHF"),
    images: num("budgetImages"),
    unpriced: num("budgetUnpriced"),
    cancelled: num("budgetCancelled"),
    since,
  };
}

export function resetBudget(): Budget {
  const fresh: Budget = {
    chf: 0,
    images: 0,
    unpriced: 0,
    cancelled: 0,
    since: new Date().toISOString(),
  };
  save(fresh);
  return fresh;
}

// `chf` is null when a model/tier has no usable price estimate. Those runs are
// counted separately rather than added as zero, so the total never implies an
// unpriced image was free.
//
// `cancelled` marks a run the user stopped after its request had already reached
// the provider: no image landed, but it is billed all the same, so the money goes
// into the same total. The three counters are disjoint — every run lands in
// exactly one of them — so they can be read as a breakdown of what was paid for.
export function addToBudget(chf: number | null, cancelled = false): Budget {
  const b = loadBudget();
  if (chf !== null) b.chf += chf;
  if (cancelled) b.cancelled += 1;
  else if (chf === null) b.unpriced += 1;
  else b.images += 1;
  save(b);
  return b;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// "4 Aug 2026". UXP ships only part of Intl, so toLocaleDateString can throw, or
// quietly ignore the options and hand back a numeric month — accept its answer
// only if a month name actually came out of it, else build the date here.
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

// Two halves rather than one string: the panel puts the breakdown on its own
// line, and a line it can lay out beats a newline the caller would have to talk
// UXP into honouring. `counts` keeps its brackets — it reads as an aside under
// the total either way, and nothing else has to know where the split was.
export function budgetText(b: Budget): { total: string; counts: string } {
  const counts = [`${b.images} images`];
  if (b.unpriced) counts.push(`${b.unpriced} unpriced`);
  if (b.cancelled) counts.push(`${b.cancelled} canceled but billed`);
  return {
    total: `Budget spent since ${formatDate(b.since)}: ca. CHF ${b.chf.toFixed(2)}`,
    counts: `(${counts.join(", ")})`,
  };
}
