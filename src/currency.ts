/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */

// Display conversion only. All pricing and budget amounts are USD.
// Reference rate from 2026-08-04; a future currency picker can select this here.
const DISPLAY_CURRENCY = "CHF";
const DISPLAY_RATE = 0.8103;

export function formatMoney(usd: number, decimals?: number): string {
  const amount = usd * DISPLAY_RATE;
  return `${DISPLAY_CURRENCY} ${amount.toFixed(decimals ?? (amount < 0.01 ? 3 : 2))}`;
}

export function formatMoneyRange(lowUSD: number, highUSD: number): string {
  if (lowUSD === highUSD) return formatMoney(lowUSD);
  const high = highUSD * DISPLAY_RATE;
  return `${formatMoney(lowUSD)}–${high.toFixed(high < 0.01 ? 3 : 2)}`;
}
