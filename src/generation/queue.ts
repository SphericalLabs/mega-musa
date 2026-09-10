/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { MAX_CONCURRENT_GENERATIONS, MAX_MANUAL_GENERATION_JOBS } from "../generation-limits";
import { cancelledError, throwIfCancelled } from "./cancellation";
import { type GenerationJob, type GenerationJobState } from "./types";

export function generationJobIsActive(job: GenerationJob): boolean {
  return job.state !== "failed" && job.state !== "placement-failed";
}

interface SlotWaiter {
  job: GenerationJob;
  resolve(): void;
  reject(error: Error): void;
}

// Owns admission, FIFO request slots and cancellation. Photoshop has its own modal gate.
export class GenerationQueue {
  private readonly jobs: GenerationJob[] = [];
  private readonly pendingIds = new Set<number>();
  private readonly waiters: SlotWaiter[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private activeRequests = 0;

  get items(): readonly GenerationJob[] { return this.jobs; }
  get latestId(): number { return this.sequence; }
  get hasActive(): boolean { return this.jobs.some(generationJobIsActive); }
  get count(): number { return this.jobs.filter(generationJobIsActive).length + this.pendingIds.size; }
  get full(): boolean { return this.count >= MAX_MANUAL_GENERATION_JOBS; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  reserve(count: number): number[] {
    const ids = Array.from({ length: count }, () => ++this.sequence);
    for (const id of ids) this.pendingIds.add(id);
    this.changed();
    return ids;
  }

  abandon(ids: readonly number[]): void {
    for (const id of ids) this.pendingIds.delete(id);
    this.pump();
    this.changed();
  }

  add(jobs: GenerationJob[]): void {
    for (const job of jobs) this.pendingIds.delete(job.id);
    this.jobs.push(...jobs);
    this.changed();
  }

  update(job: GenerationJob, state: GenerationJobState, status: string): void {
    job.state = state;
    job.status = status;
    this.changed();
  }

  remove(job: GenerationJob): void {
    job.pendingPlacement = null;
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
    this.changed();
  }

  pump(): void {
    let changed = false;
    this.waiters.sort((a, b) => a.job.id - b.job.id);
    while (this.activeRequests < MAX_CONCURRENT_GENERATIONS && this.waiters.length) {
      const { job, resolve, reject } = this.waiters[0];
      const earlierSnapshot = Array.from(this.pendingIds).some((id) => id < job.id);
      const earlierPreparation = this.jobs.some((candidate) => candidate.id < job.id &&
        (candidate.state === "preparing" || (candidate.state === "cancelling" && !candidate.requestSent)));
      if (earlierSnapshot || earlierPreparation) break;
      this.waiters.shift();
      job.cancelSlotWait = null;
      if (job.cancelRequested) {
        reject(cancelledError());
        continue;
      }
      this.activeRequests += 1;
      job.slotAcquired = true;
      job.state = "generating";
      job.status = "Starting provider request…";
      changed = true;
      resolve();
    }
    if (changed) this.changed();
  }

  waitForSlot(job: GenerationJob): Promise<void> {
    throwIfCancelled(job);
    this.update(job, "waiting", this.activeRequests >= MAX_CONCURRENT_GENERATIONS
      ? `Waiting for a generation slot (${MAX_CONCURRENT_GENERATIONS} in use)…`
      : "Waiting for a generation slot…");
    return new Promise<void>((resolve, reject) => {
      const waiter = { job, resolve, reject };
      this.waiters.push(waiter);
      job.cancelSlotWait = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(cancelledError());
      };
      this.pump();
    });
  }

  releaseSlot(job: GenerationJob): void {
    if (!job.slotAcquired) return;
    job.slotAcquired = false;
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.pump();
  }

  cancel(job: GenerationJob): void {
    if (["failed", "placement-failed", "placing", "cancelling"].includes(job.state)) return;
    job.cancelRequested = true;
    this.update(job, "cancelling", "Canceling…");
    const stopWaiting = job.cancelSlotWait;
    job.cancelSlotWait = null;
    stopWaiting?.();
    const stopRequest = job.cancelInFlight;
    job.cancelInFlight = null;
    stopRequest?.();
  }

  cancelAll(): void {
    for (const job of this.jobs.slice()) this.cancel(job);
  }
}
