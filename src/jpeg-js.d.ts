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

declare module "jpeg-js" {
  export function decode(
    data: Uint8Array | ArrayBuffer,
    opts?: {
      useTArray?: boolean;
      formatAsRGBA?: boolean;
      tolerantDecoding?: boolean;
      maxResolutionInMP?: number;
      maxMemoryUsageInMB?: number;
    }
  ): { width: number; height: number; data: Uint8Array };
  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number
  ): { data: Uint8Array; width: number; height: number };
}
