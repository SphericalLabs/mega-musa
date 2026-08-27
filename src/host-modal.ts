/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 */

export const DEFAULT_HOST_MODAL_TIMEOUT_SECONDS = 5;
export const PAID_PLACEMENT_MODAL_TIMEOUT_SECONDS = 30;

export interface HostModalLease {
  readonly id: number;
}

export interface HostModalReservation {
  lease: HostModalLease;
  release: () => void;
}

interface ExecuteAsModalOptions {
  commandName: string;
  timeOut?: number;
}

interface PhotoshopCore {
  executeAsModal<T>(
    target: (executionContext: any, descriptor?: any) => Promise<T> | T,
    options: ExecuteAsModalOptions
  ): Promise<T>;
}

let queueTail: Promise<void> = Promise.resolve();
let activeLease: HostModalLease | null = null;
let leaseSequence = 0;

export async function acquireHostModalTask(): Promise<HostModalReservation> {
  const previous = queueTail;
  let releaseTail!: () => void;
  queueTail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  await previous;

  const lease: HostModalLease = { id: ++leaseSequence };
  activeLease = lease;
  let released = false;
  return {
    lease,
    release: () => {
      if (released) return;
      released = true;
      if (activeLease === lease) activeLease = null;
      releaseTail();
    },
  };
}

// One FIFO gate covers every Mega Musa workflow that can put Photoshop or a
// plugin dialog into a modal state. Passing the active lease lets a workflow
// call several modal bridge helpers atomically without reacquiring its own lock.
export async function runHostModalTask<T>(
  task: (lease: HostModalLease) => Promise<T>,
  lease?: HostModalLease
): Promise<T> {
  if (lease && lease === activeLease) return await task(lease);
  const reservation = await acquireHostModalTask();
  try {
    return await task(reservation.lease);
  } finally {
    reservation.release();
  }
}

export function isHostModalBusyError(error: any): boolean {
  if (Number(error?.number) === 9) return true;
  const message = String(error?.message || error || "");
  return /host is in a modal state|inside a modal scope|running a modal command/i.test(message);
}

export class HostModalTimeoutError extends Error {
  readonly commandName: string;
  readonly timeoutSeconds: number;

  constructor(commandName: string, timeoutSeconds: number) {
    super(
      `Photoshop stayed busy for ${timeoutSeconds} seconds while Mega Musa tried to ${commandName}. ` +
        "Finish the active Photoshop tool, dialog or other plugin operation, then retry."
    );
    this.name = "HostModalTimeoutError";
    this.commandName = commandName;
    this.timeoutSeconds = timeoutSeconds;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Photoshop 25.10+ honors timeOut itself. The short retry loop preserves the
// same behavior on older supported hosts, where an unknown timeOut option is
// ignored and modal contention is rejected immediately with error number 9.
export async function executeHostModal<T>(
  core: PhotoshopCore,
  target: (executionContext: any, descriptor?: any) => Promise<T> | T,
  commandName: string,
  timeoutSeconds: number = DEFAULT_HOST_MODAL_TIMEOUT_SECONDS
): Promise<T> {
  const safeTimeout = Math.max(0.1, timeoutSeconds);
  const deadline = Date.now() + safeTimeout * 1000;

  while (true) {
    const remainingSeconds = Math.max(0.1, (deadline - Date.now()) / 1000);
    let targetStarted = false;
    try {
      return await core.executeAsModal(
        (executionContext, descriptor) => {
          targetStarted = true;
          return target(executionContext, descriptor);
        },
        {
          commandName: `Mega Musa: ${commandName}`,
          timeOut: remainingSeconds,
        }
      );
    } catch (error: any) {
      // Retrying an operation that already entered its modal callback could
      // duplicate partial document changes. Only acquisition failures are safe.
      if (targetStarted || !isHostModalBusyError(error)) throw error;
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) {
        throw new HostModalTimeoutError(commandName, timeoutSeconds);
      }
      await wait(Math.min(100, remainingMilliseconds));
    }
  }
}
