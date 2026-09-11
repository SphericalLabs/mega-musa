/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */

import { loadSetting, saveSetting } from "./storage";
import { EXCHANGE_RATE_SOURCES } from "./exchange-rates/registry";

// Display conversion only. All pricing and budget amounts remain USD.
export const CURRENCIES: { value: string; label: string; source?: string }[] = [
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
function quotesFor(source: string): string[] {
  return CURRENCIES.filter((currency) => currency.value !== "USD" && (currency.source || "ecb") === source).map((currency) => currency.value);
}
interface Rate { rate: number; date: string; checkedDate: string }
interface RateCache { rates: Record<string, Rate> }

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function readCache(source: string): RateCache {
  const rates: Record<string, Rate> = {};
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(loadSetting(`exchangeRates.${source}`, "null"));
    for (const quote of quotesFor(source)) {
      const entry = saved?.rates?.[quote];
      const checkedDate = entry?.checkedDate || saved?.checkedDate;
      if (entry && Number.isFinite(entry.rate) && entry.rate > 0 && validDate(entry.date) && entry.date <= today) {
        rates[quote] = { rate: entry.rate, date: entry.date, checkedDate: validDate(checkedDate) && checkedDate <= today ? checkedDate : "" };
      }
    }
  } catch { /* keep any independently valid cached rates */ }
  return { rates };
}
const caches = new Map(EXCHANGE_RATE_SOURCES.map((source) => [source.id, readCache(source.id)]));
const pending = new Map<string, Promise<void>>();
function selectedSource() {
  const id = CURRENCIES.find((currency) => currency.value === displayCurrency())?.source || "ecb";
  return EXCHANGE_RATE_SOURCES.find((source) => source.id === id);
}
function selectedRate() { return caches.get(selectedSource()?.id || "")?.rates[displayCurrency()]; }

export function displayCurrency(): string {
  const saved = loadSetting("displayCurrency", "USD");
  return CURRENCIES.some(({ value }) => value === saved) ? saved : "USD";
}

export function setDisplayCurrency(value: string): void {
  if (CURRENCIES.some((currency) => currency.value === value)) saveSetting("displayCurrency", value);
}

function conversion(): { currency: string; rate: number } {
  const currency = displayCurrency();
  const entry = selectedRate();
  return currency !== "USD" && entry ? { currency, rate: entry.rate } : { currency: "USD", rate: 1 };
}

export function currencyNote(): string {
  const currency = displayCurrency();
  if (currency === "USD") return "API prices are in USD. No exchange rate needed.";
  const entry = selectedRate();
  return entry
    ? `${selectedSource()?.label} · ${entry.date}. Display estimates only.`
    : "Showing USD until an exchange rate is available.";
}

// Startup and picker changes share one request. Keep cached rates on every
// failure, including timeouts and malformed responses, without surfacing errors.
export async function refreshExchangeRates(): Promise<void> {
  if (displayCurrency() === "USD") return;
  const source = selectedSource();
  if (!source) return;
  if (pending.has(source.id)) return pending.get(source.id);
  const today = new Date().toISOString().slice(0, 10);
  const cache = caches.get(source.id) || { rates: {} };
  const quotes = quotesFor(source.id);
  if (quotes.every((quote) => cache.rates[quote]?.checkedDate === today)) return;
  const request = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    try {
      try { if (typeof AbortController === "function") controller = new AbortController(); } catch { /* timeout alone */ }
      const rows = await Promise.race([
        source.fetchRates(quotes, controller?.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Exchange rate lookup timed out"));
            try { controller?.abort(); } catch { /* timeout already settled */ }
          }, 5000);
        }),
      ]);
      const rates = { ...cache.rates };
      let updated = false;
      for (const row of rows) {
        if (!quotes.includes(row.currency) || !Number.isFinite(row.rate) || row.rate <= 0 ||
            !validDate(row.date) || row.date > today || (rates[row.currency] && row.date < rates[row.currency].date)) continue;
        rates[row.currency] = { rate: row.rate, date: row.date, checkedDate: today };
        updated = true;
      }
      if (updated) {
        caches.set(source.id, { rates });
        saveSetting(`exchangeRates.${source.id}`, JSON.stringify({ rates }));
      }
    } catch (error) {
      console.warn("[Mega Musa] Exchange rates unavailable; keeping cached rates or USD:", error);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  })();
  pending.set(source.id, request);
  try { await request; } finally { pending.delete(source.id); }
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
