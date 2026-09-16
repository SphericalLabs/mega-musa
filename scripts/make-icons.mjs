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

import { existsSync } from "fs";
import { execFileSync } from "node:child_process";

// ImageMagick is only needed when changing the vector master, not for builds.
if (process.argv.includes("--regenerate")) {
  for (const [name, size, color] of [
    ["dark", 23, "#d6d6d6"],
    ["light", 23, "#424242"],
    ["icon-dark", 24, "#d6d6d6"],
    ["icon", 24, "#424242"],
  ]) {
    for (const [suffix, scale] of [["", 1], ["@1x", 1], ["@2x", 2]]) {
      execFileSync("magick", [
        "-background", "none", "-density", "1152", "public/icons/banana.svg",
        "-fill", color, "-colorize", "100",
        "-resize", `${size * scale}x${size * scale}`,
        "-depth", "8", "-strip", `PNG32:public/icons/${name}${suffix}.png`,
      ], { stdio: "inherit" });
    }
  }
}

const requiredIcons = [
  "public/icons/icon.png",
  "public/icons/icon@2x.png",
  "public/icons/icon-dark.png",
  "public/icons/icon-dark@2x.png",
  "public/icons/dark.png",
  "public/icons/dark@2x.png",
  "public/icons/light.png",
  "public/icons/light@2x.png",
];

if (requiredIcons.some((path) => !existsSync(path))) {
  throw new Error("Missing checked-in icon assets under public/icons/");
}

console.log("icons -> public/icons/ (checked-in assets)");
