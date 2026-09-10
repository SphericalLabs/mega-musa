/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
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

import esbuild from "esbuild";
import { cpSync, mkdirSync } from "fs";
import { join } from "path";

const watch = process.argv.includes("--watch");
const outdir = process.argv.find((argument) => argument.startsWith("--outdir="))?.slice(9) || "dist";

// Load dist/manifest.json in the UXP Developer Tool.
mkdirSync(outdir, { recursive: true });
cpSync("public", outdir, { recursive: true });
cpSync("LICENSE", join(outdir, "LICENSE"));
cpSync("LICENSE-EXCEPTION", join(outdir, "LICENSE-EXCEPTION"));

const options = {
  entryPoints: { index: "src/main.ts", "drop-target": "src/webview/drop-target.ts" },
  bundle: true,
  outdir,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  // Photoshop supplies these modules at runtime.
  external: ["photoshop", "uxp"],
  legalComments: "none",
  banner: {
    js: "/*! Mega Musa — Copyright (C) 2026 Sphericals. SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception. See LICENSE and LICENSE-EXCEPTION. */",
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching src/ — rebuilding dist/ on change…");
} else {
  await esbuild.build(options);
  console.log(`built -> ${outdir}/`);
}
