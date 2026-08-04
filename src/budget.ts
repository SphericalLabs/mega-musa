import { loadSetting, saveSetting } from "./storage";

// A running estimate of what this panel has cost, kept in localStorage next to the
// other panel settings. It adds the same per-image figure the resolution menu
// shows — a midpoint for the OpenAI models — and counts nothing for input tokens
// (the prompt, the canvas crop, reference images), so it runs low by design.
// An order of magnitude to steer by, not an invoice.

export interface Budget {
  chf: number;
  images: number; // images it could price
  unpriced: number; // images generated at a tier with no published price
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
    since,
  };
}

export function resetBudget(): Budget {
  const fresh: Budget = { chf: 0, images: 0, unpriced: 0, since: new Date().toISOString() };
  save(fresh);
  return fresh;
}

// `chf` is null when the model/tier has no published price (GPT Image 2 above 1K).
// Those are counted separately rather than added as zero, so the total never
// implies images it could not price were free.
export function addToBudget(chf: number | null): Budget {
  const b = loadBudget();
  if (chf === null) b.unpriced += 1;
  else {
    b.chf += chf;
    b.images += 1;
  }
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

export function budgetText(b: Budget): string {
  const counts = b.unpriced ? `${b.images} images, ${b.unpriced} unpriced` : `${b.images} images`;
  return `Budget spent since ${formatDate(b.since)}: ~CHF ${b.chf.toFixed(2)} (${counts})`;
}
