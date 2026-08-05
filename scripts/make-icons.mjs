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

import { existsSync } from "fs";

const requiredIcons = [
  "public/icons/icon.png",
  "public/icons/icon@2x.png",
  "public/icons/dark.png",
  "public/icons/dark@2x.png",
  "public/icons/light.png",
  "public/icons/light@2x.png",
];

if (requiredIcons.some((path) => !existsSync(path))) {
  throw new Error("Missing checked-in icon assets under public/icons/");
}

console.log("icons -> public/icons/ (checked-in assets)");
