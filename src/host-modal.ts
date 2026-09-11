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

// Serialize modal workflows through one FIFO gate. Pass the active lease to nested
// helpers to avoid reacquiring the same lock.
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
  if (Number(error?.number ?? error?.result) === 9) return true;
  const message = String(error?.message || error || "");
  return /host is in a modal state|inside a modal scope|running a modal command/i.test(message);
}

// Only read-only placement preparation may raise this after a modal callback starts.
// It is safe to release Photoshop and try again because no edits have begun.
export class HostModalPreflightBusyError extends Error {}

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

// Photoshop 25.10+ handles timeOut; retry modal acquisition on older hosts that reject
// immediately with error 9.
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
      // Never replay started edits. A blocked read-only preflight is safe to retry.
      if (!(error instanceof HostModalPreflightBusyError) && (targetStarted || !isHostModalBusyError(error))) throw error;
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) {
        throw new HostModalTimeoutError(commandName, timeoutSeconds);
      }
      await wait(Math.min(100, remainingMilliseconds));
    }
  }
}
