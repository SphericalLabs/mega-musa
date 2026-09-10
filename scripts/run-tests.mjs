/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tests = readdirSync("scripts")
  .filter((name) => name.startsWith("test-") && name.endsWith(".mjs") && name !== "test-support.mjs")
  .sort();
for (const test of tests) {
  const result = spawnSync(process.execPath, [join("scripts", test)], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`${tests.length} test suites passed.`);
