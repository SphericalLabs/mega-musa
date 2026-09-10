/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */

import { loadSetting, saveSetting } from "./storage";

// Display conversion only. All pricing and budget amounts remain USD.
export const CURRENCIES = [
  { value: "EUR", label: "EUR — Euro" },
  { value: "CHF", label: "CHF — Swiss franc" },
  { value: "USD", label: "USD — US dollar" },
  { value: "JPY", label: "JPY — Japanese yen" },
  { value: "KRW", label: "KRW — South Korean won" },
  { value: "CNY", label: "CNY — Chinese yuan" },
  { value: "GBP", label: "GBP — British pound" },
  { value: "CAD", label: "CAD — Canadian dollar" },
  { value: "AUD", label: "AUD — Australian dollar" },
  { value: "INR", label: "INR — Indian rupee" },
  { value: "BRL", label: "BRL — Brazilian real" },
];
const QUOTES = CURRENCIES.map(({ value }) => value).filter((value) => value !== "USD");
const RATE_URL = `https://api.frankfurter.dev/v2/rates?base=USD&quotes=${QUOTES.join(",")}&providers=ecb`;
interface Rate { rate: number; date: string }
interface RateCache { checkedDate: string; rates: Record<string, Rate> }

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function readCache(): RateCache | null {
  try {
    const saved = JSON.parse(loadSetting("exchangeRates.ecb", "null"));
    if (!saved || !validDate(saved.checkedDate)) return null;
    if (!QUOTES.every((quote) => {
      const entry = saved.rates?.[quote];
      return entry && Number.isFinite(entry.rate) && entry.rate > 0 && validDate(entry.date);
    })) return null;
    return saved;
  } catch {
    return null;
  }
}

let cache = readCache();
let pending: Promise<void> | null = null;

export function displayCurrency(): string {
  const saved = loadSetting("displayCurrency", "USD");
  return CURRENCIES.some(({ value }) => value === saved) ? saved : "USD";
}

export function setDisplayCurrency(value: string): void {
  if (CURRENCIES.some((currency) => currency.value === value)) saveSetting("displayCurrency", value);
}

function conversion(): { currency: string; rate: number } {
  const currency = displayCurrency();
  const entry = cache?.rates[currency];
  return currency !== "USD" && entry ? { currency, rate: entry.rate } : { currency: "USD", rate: 1 };
}

export function currencyNote(): string {
  const currency = displayCurrency();
  if (currency === "USD") return "API prices are in USD. No exchange rate needed.";
  const entry = cache?.rates[currency];
  return entry
    ? `ECB rate via Frankfurter · ${entry.date}. Display estimates only.`
    : "Showing USD until an exchange rate is available.";
}

// Startup and picker changes share one request. Keep cached rates on every
// failure, including timeouts and malformed responses, without surfacing errors.
export async function refreshExchangeRates(): Promise<void> {
  if (displayCurrency() === "USD") return;
  if (pending) return pending;
  const today = new Date().toISOString().slice(0, 10);
  if (cache?.checkedDate === today) return;
  pending = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    try {
      // Some UXP builds expose a controller that cannot be constructed.
      // The independent timeout still works without request cancellation.
      try {
        if (typeof AbortController === "function") controller = new AbortController();
      } catch { /* use the timeout alone */ }
      const rows = await Promise.race([
        (async () => {
          const init: RequestInit = { method: "GET" };
          if (controller?.signal) init.signal = controller.signal;
          const response = await fetch(RATE_URL, init);
          if (!response.ok) throw new Error(`Exchange rate lookup failed (HTTP ${response.status})`);
          return response.json();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Exchange rate lookup timed out"));
            try { controller?.abort(); } catch { /* timeout already settled */ }
          }, 5000);
        }),
      ]);
      if (!Array.isArray(rows)) return;
      const rates: Record<string, Rate> = {};
      for (const row of rows) {
        if (row?.base !== "USD" || !QUOTES.includes(row.quote) ||
          !Number.isFinite(row.rate) || row.rate <= 0 || !validDate(row.date) || row.date > today) return;
        rates[row.quote] = { rate: row.rate, date: row.date };
      }
      if (!QUOTES.every((quote) => rates[quote])) return;
      cache = { checkedDate: today, rates };
      saveSetting("exchangeRates.ecb", JSON.stringify(cache));
    } catch (error) {
      // Diagnostic only: no popup or panel error for offline connections.
      console.warn("[Mega Musa] Exchange rates unavailable; keeping cached rates or USD:", error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  try {
    await pending;
  } finally {
    pending = null;
  }
}

export function formatMoney(usd: number, decimals?: number): string {
  const { currency, rate } = conversion();
  const amount = usd * rate;
  return `${currency} ${amount.toFixed(decimals ?? (amount < 0.01 ? 3 : 2))}`;
}

export function formatMoneyRange(lowUSD: number, highUSD: number): string {
  if (lowUSD === highUSD) return formatMoney(lowUSD);
  const high = highUSD * conversion().rate;
  return `${formatMoney(lowUSD)}–${high.toFixed(high < 0.01 ? 3 : 2)}`;
}
