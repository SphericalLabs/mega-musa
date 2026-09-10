import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const bundle = await build({
  stdin: {
    contents: 'export * from "./src/currency"; export * from "./src/budget";',
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", external: ["uxp"], write: false,
});
const today = "2026-09-10";
const quotes = ["EUR", "CHF", "JPY", "KRW", "CNY", "GBP", "CAD", "AUD", "INR", "BRL"];
const rows = quotes.map((quote, i) => ({ base: "USD", quote, rate: i + 0.5, date: "2026-09-09" }));
const response = (body = rows) => ({ ok: true, json: async () => body });

function setup(settings = new Map(), fetcher = async () => response(), timeout = false, Controller = AbortController) {
  const requests = [];
  const module = { exports: {} };
  let date = today;
  let timedOut;
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({ storage: {} }),
    localStorage: {
      getItem: (key) => settings.get(key) ?? null,
      setItem: (key, value) => settings.set(key, value),
    },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [`${date}T10:00:00Z`])); }
    },
    AbortController: Controller,
    fetch: (...args) => { requests.push(args); return fetcher(...args); },
    setTimeout: timeout ? (callback) => { timedOut = callback; return 1; } : setTimeout,
    clearTimeout: timeout ? () => {} : clearTimeout,
  });
  return { ...module.exports, requests, settings, nextDay() { date = "2026-09-11"; }, timeout() { timedOut(); } };
}

// Show USD until the first rate lookup succeeds; preserve the chosen display currency.
const usd = setup();
assert.equal(usd.displayCurrency(), "USD");
await usd.refreshExchangeRates();
assert.equal(usd.requests.length, 0);
assert.equal(usd.formatMoney(2), "USD 2.00");
usd.setDisplayCurrency("CHF");
assert.equal(usd.formatMoney(2), "USD 2.00");
assert.match(usd.currencyNote(), /Showing USD/);
await Promise.all([usd.refreshExchangeRates(), usd.refreshExchangeRates()]);
assert.equal(usd.requests.length, 1);
assert.equal(usd.displayCurrency(), "CHF");
assert.equal(usd.formatMoney(2), "CHF 3.00");
assert.equal(usd.formatMoneyRange(1, 2), "CHF 1.50–3.00");
assert.match(usd.currencyNote(), /2026-09-09/);
const url = new URL(usd.requests[0][0]);
assert.equal(url.hostname, "api.frankfurter.dev");
assert.equal(url.searchParams.get("providers"), "ecb");
assert.equal(url.searchParams.get("base"), "USD");
assert.deepEqual(url.searchParams.get("quotes").split(","), quotes);
assert.equal(usd.requests[0][1].headers, undefined);

// Refresh daily even when the provider's publication date has not advanced.
for (const quote of quotes) {
  usd.setDisplayCurrency(quote);
  await usd.refreshExchangeRates();
  assert.ok(usd.formatMoney(1).startsWith(`${quote} `));
}
assert.equal(usd.requests.length, 1);
const reloaded = setup(usd.settings);
assert.equal(reloaded.displayCurrency(), "BRL", "saved preferences override the USD default");
await reloaded.refreshExchangeRates();
assert.equal(reloaded.requests.length, 0);
reloaded.nextDay();
await reloaded.refreshExchangeRates();
assert.equal(reloaded.requests.length, 1);

// Failed or invalid refreshes must preserve the complete cache.
const savedCache = JSON.stringify({
  checkedDate: "2026-09-09",
  rates: Object.fromEntries(rows.map((row) => [row.quote, { rate: row.rate, date: row.date }])),
});
for (const fetcher of [
  async () => { throw new Error("offline"); },
  async () => ({ ok: false }),
  async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } }),
  async () => response({ rates: {} }),
  async () => response(rows.slice(1)),
  ...[0, -1, Infinity, "1.5"].map((rate) => async () => response([{ ...rows[0], rate }, ...rows.slice(1)])),
  async () => response([{ ...rows[0], date: "2026-02-30" }, ...rows.slice(1)]),
  async () => response([{ ...rows[0], date: "2027-01-01" }, ...rows.slice(1)]),
  async () => response([{ ...rows[0], base: "EUR" }, ...rows.slice(1)]),
]) {
  const settings = new Map([["nbp.exchangeRates.ecb", savedCache]]);
  const test = setup(settings, fetcher);
  test.setDisplayCurrency("CHF");
  await test.refreshExchangeRates();
  await test.refreshExchangeRates();
  assert.equal(test.requests.length, 2, "failures must allow another attempt in the same session");
  assert.equal(test.formatMoney(2), "CHF 3.00");
  assert.equal(settings.get("nbp.exchangeRates.ecb"), savedCache);
}

// A stalled request must release the refresh lock; late data cannot replace the cache.
let resolveLate;
const stalled = setup(new Map(), () => new Promise((resolve) => { resolveLate = resolve; }), true);
stalled.setDisplayCurrency("CHF");
const pending = stalled.refreshExchangeRates();
stalled.timeout();
await pending;
assert.equal(stalled.requests[0][1].signal.aborted, true);
resolveLate(response());
await new Promise((resolve) => setImmediate(resolve));
assert.equal(stalled.formatMoney(2), "USD 2.00");
assert.equal(stalled.settings.has("nbp.exchangeRates.ecb"), false);
const retry = setup(stalled.settings);
await retry.refreshExchangeRates();
assert.equal(retry.formatMoney(2), "CHF 3.00");

// Missing or broken AbortController must not prevent requests or later retries.
for (const Controller of [null, class { constructor() { throw new Error("unsupported"); } }]) {
  const test = setup(new Map(), async (_url, init) => {
    assert.equal(init.method, "GET");
    assert.equal("signal" in init, false);
    return response();
  }, false, Controller);
  test.setDisplayCurrency("CHF");
  await test.refreshExchangeRates();
  assert.equal(test.formatMoney(2), "CHF 3.00");
}
let online = false;
const reconnect = setup(new Map(), async () => {
  if (!online) throw new Error("offline");
  return response();
});
reconnect.setDisplayCurrency("CHF");
await reconnect.refreshExchangeRates();
assert.equal(reconnect.formatMoney(2), "USD 2.00");
online = true;
reconnect.setDisplayCurrency("JPY");
await reconnect.refreshExchangeRates();
assert.equal(reconnect.formatMoney(2), "JPY 5.00");

// Display rates must never rewrite spend or repeat the historical CHF migration.
const corrupt = setup(new Map([["nbp.exchangeRates.ecb", "broken"], ["nbp.displayCurrency", "unknown"]]));
assert.equal(corrupt.displayCurrency(), "USD");
assert.equal(corrupt.formatMoney(1), "USD 1.00");
const budget = setup(new Map([
  ["nbp.budgetCHF", "8.103"], ["nbp.budgetSince", "2026-08-01T00:00:00Z"],
]));
budget.setDisplayCurrency("CHF");
assert.equal(budget.loadBudget().usd, 10);
await budget.refreshExchangeRates();
assert.ok(budget.budgetText(budget.loadBudget()).total.endsWith("CHF 15.00"));
budget.setDisplayCurrency("USD");
assert.ok(budget.budgetText(budget.loadBudget()).total.endsWith("USD 10.00"));
assert.equal(budget.settings.get("nbp.budgetUSD"), "10");
assert.equal(budget.settings.get("nbp.budgetCHF"), "8.103");
console.log("Currency: daily caching, switching, offline fallback, validation, timeout and budget preservation passed.");
