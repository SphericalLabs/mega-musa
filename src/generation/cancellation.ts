/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export interface CancellableJob {
  cancelRequested: boolean;
  cancelInFlight: (() => void) | null;
}

export function cancelledError(): Error {
  const err: any = new Error("Cancelled.");
  err.nbpCancelled = true;
  return err;
}

export function isCancelledError(err: any): boolean {
  return !!err?.nbpCancelled || err?.name === "AbortError";
}

export function throwIfCancelled(job: CancellableJob): void {
  if (job.cancelRequested) throw cancelledError();
}

// awaitCancellable releases the panel even when UXP lacks a usable AbortController.
export function newAbortController(): { signal?: any; abort(): void } {
  const Ctor: any = (globalThis as any).AbortController;
  if (typeof Ctor === "function") {
    try {
      return new Ctor();
    } catch {
      /* fall through to the no-op controller */
    }
  }
  return { abort() { } };
}

// Cancel releases the panel immediately. Handle late rejections here so they cannot
// overwrite status through the global error handler.
export function awaitCancellable<T>(
  job: CancellableJob,
  request: Promise<T>,
  controller: { abort(): void }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    job.cancelInFlight = () => {
      if (settled) return;
      settled = true;
      try {
        controller.abort();
      } catch {
        /* nothing to abort in this runtime, or already past it */
      }
      reject(cancelledError());
    };
    request.then(
      (value) => {
        if (settled) return;
        settled = true;
        job.cancelInFlight = null;
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        job.cancelInFlight = null;
        reject(error);
      }
    );
  });
}
