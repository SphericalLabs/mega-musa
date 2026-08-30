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

const { storage } = require("uxp");

const TEMP_FILE_PREFIXES = ["__mega_musa_result_", "mega-musa-restore-", "mega-musa-"];
const TEMP_IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i;

export function isMegaMusaTemporaryFileName(name: unknown): boolean {
  if (typeof name !== "string" || !TEMP_IMAGE_EXTENSION.test(name)) return false;
  return TEMP_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Cleanup must never turn a successful Photoshop operation into a failure.
// A later startup sweep can retry any file the OS still has open.
export async function deleteMegaMusaTemporaryFile(file: any): Promise<boolean> {
  if (!file?.isFile || !isMegaMusaTemporaryFileName(file.name) || typeof file.delete !== "function") {
    return false;
  }
  try {
    await file.delete();
    return true;
  } catch (error: any) {
    console.log(
      `[Mega Musa] could not remove temporary file “${file.name}”:`,
      error?.message || error
    );
    return false;
  }
}

export async function clearMegaMusaTemporaryFiles(): Promise<number> {
  try {
    const folder = await storage.localFileSystem.getTemporaryFolder();
    const entries = await folder.getEntries();
    let removed = 0;
    for (const entry of entries) {
      if (await deleteMegaMusaTemporaryFile(entry)) removed += 1;
    }
    return removed;
  } catch (error: any) {
    console.log("[Mega Musa] could not scan temporary files:", error?.message || error);
    return 0;
  }
}
