/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export interface ExchangeRate { currency: string; rate: number; date: string }
export interface ExchangeRateSource {
  id: string;
  label: string;
  domains: string[];
  // Every rate means units of the quote currency per one USD.
  fetchRates(quotes: string[], signal?: AbortSignal): Promise<ExchangeRate[]>;
}
