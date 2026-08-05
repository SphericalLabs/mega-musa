/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
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
import { cpSync, mkdirSync, rmSync } from "fs";

const watch = process.argv.includes("--watch");

// Assemble the loadable plugin in dist/: static files from public/, plus the
// bundled index.js. Point the UXP Developer Tool at dist/manifest.json.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  // Provided by the UXP runtime at load time — must not be bundled.
  external: ["photoshop", "uxp"],
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching src/ — rebuilding dist/ on change…");
} else {
  await esbuild.build(options);
  console.log("built -> dist/");
}
