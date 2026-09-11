/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ExchangeRateSource } from "./types";

export const frankfurter: ExchangeRateSource = {
  id: "ecb", label: "ECB rate via Frankfurter", domains: ["https://api.frankfurter.dev"],
  async fetchRates(quotes, signal) {
    const url = `https://api.frankfurter.dev/v2/rates?base=USD&quotes=${quotes.join(",")}&providers=ecb`;
    const init: RequestInit = { method: "GET" };
    if (signal) init.signal = signal;
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`Exchange rate lookup failed (HTTP ${response.status})`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid exchange rate response.");
    return rows.filter((row) => row?.base === "USD" && quotes.includes(row.quote))
      .map((row) => ({ currency: row.quote, rate: row.rate, date: row.date }));
  },
};
