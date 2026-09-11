/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export async function withHistory<T>(
  context: PhotoshopExecutionContext,
  documentID: number,
  name: string,
  run: () => Promise<T>
): Promise<T> {
  const suspension = await context.hostControl.suspendHistory({ documentID, name });
  let failed = false;
  try {
    return await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      // Roll back incomplete placement before offering Retry Placement.
      await context.hostControl.resumeHistory(suspension, !failed);
    } catch (error) {
      if (!failed) throw error;
      // Cleanup failure must not replace the original placement error.
      console.log("[Mega Musa] could not resume placement history:", error);
    }
  }
}
