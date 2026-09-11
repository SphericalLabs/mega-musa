/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadModule, memoryStorage } from "./test-support.mjs";

const api = await loadModule(["src/providers/registry.ts", "src/exchange-rates/registry.ts", "src/currency.ts"]);
const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
const domains = manifest.requiredPermissions.network.domains;
for (const extension of [...api.providerRegistry.providers, ...api.EXCHANGE_RATE_SOURCES]) {
  for (const domain of extension.domains) assert.ok(domains.includes(domain), `${extension.id}: add ${domain} to the UXP manifest`);
}
assert.equal(new Set(api.EXCHANGE_RATE_SOURCES.map(source => source.id)).size, api.EXCHANGE_RATE_SOURCES.length);
assert.equal(new Set(api.CURRENCIES.map(currency => currency.value)).size, api.CURRENCIES.length);
for (const currency of api.CURRENCIES) {
  assert.match(currency.value, /^[A-Z]{3}$/);
  if (currency.value !== "USD") assert.ok(api.EXCHANGE_RATE_SOURCES.some(source => source.id === (currency.source || "ecb")));
}

// A second source uses its own cache, attribution and pending request.
const values = new Map();
const test = await loadModule(["src/currency.ts", "src/exchange-rates/registry.ts"], {
  globals: { localStorage: memoryStorage(values), fetch: async () => { throw new Error("offline"); } },
  plugins: [{ name: "example-rates", setup(build) {
    build.onLoad({ filter: /\/exchange-rates\/registry\.ts$/ }, ({ path }) => ({ loader: "ts", resolveDir: dirname(path), contents: `
      import { frankfurter } from "./frankfurter";
      export let calls = 0;
      export const EXCHANGE_RATE_SOURCES = [frankfurter, {
        id: "example", label: "Example reference rate", domains: [],
        async fetchRates(quotes) { calls++; return quotes.map(currency => ({ currency, rate: 2, date: new Date().toISOString().slice(0, 10) })); }
      }];`,
    }));
  } }],
});
test.CURRENCIES.push({ value: "XYZ", label: "Test currency", source: "example" });
test.setDisplayCurrency("XYZ");
await Promise.all([test.refreshExchangeRates(), test.refreshExchangeRates()]);
assert.equal(test.formatMoney(1), "XYZ 2.00");
assert.match(test.currencyNote(), /Example reference rate/);
assert.equal(test.calls, 1);
assert.ok(values.has("nbp.exchangeRates.example"));
assert.equal(values.has("nbp.exchangeRates.ecb"), false);
test.setDisplayCurrency("CHF");
await test.refreshExchangeRates();
assert.equal(test.formatMoney(1), "USD 1.00");
test.setDisplayCurrency("XYZ");
assert.equal(test.formatMoney(1), "XYZ 2.00");
await test.refreshExchangeRates();
assert.equal(test.calls, 1);
console.log("Extension configuration: manifest domains, currency sources, isolated caches and attribution passed.");
