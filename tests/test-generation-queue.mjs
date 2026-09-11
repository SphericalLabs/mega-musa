/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, flush } from "./test-support.mjs";
const { GenerationQueue } = await loadModule("src/generation/queue.ts");
const job = (id) => ({ id, state: "preparing", cancelRequested: false, requestSent: false, slotAcquired: false, cancelSlotWait: null, cancelInFlight: null, pendingPlacement: null });

const queue = new GenerationQueue();
const jobs = [...queue.reserve(4)].map(job);
queue.add(jobs);
assert.equal(queue.full, true);
const started = [];
const waits = jobs.map((item) => queue.waitForSlot(item).then(() => started.push(item.id), (error) => { assert.equal(error.nbpCancelled, true); }));
await flush();
assert.deepEqual(started, [1, 2]);
queue.cancel(jobs[2]);
queue.remove(jobs[2]);
queue.releaseSlot(jobs[0]);
await flush();
assert.deepEqual(started, [1, 2, 4], "waiting cancellation must not consume a provider slot");
queue.releaseSlot(jobs[0]);
assert.equal(jobs[3].slotAcquired, true, "duplicate release must not corrupt another job's slot");
await Promise.all(waits);
queue.update(jobs[1], "placing", "placing");
queue.cancel(jobs[1]);
assert.equal(jobs[1].cancelRequested, false, "a paid image must finish placing");
queue.update(jobs[3], "placement-failed", "retry");
assert.equal(queue.count, 2, "retained failed rows must not fill the active queue");

const fifo = new GenerationQueue();
const [firstId] = fifo.reserve(1);
const [secondId] = fifo.reserve(1);
const later = job(secondId);
fifo.add([later]);
let admitted = false;
const laterWait = fifo.waitForSlot(later).then(() => { admitted = true; });
await flush();
assert.equal(admitted, false, "a later job waits while earlier input is freezing");
fifo.abandon([firstId]);
await laterWait;
assert.equal(admitted, true, "a failed snapshot releases the admission gate");

const expanded = new GenerationQueue();
expanded.add([...expanded.reserve(10)].map(job));
assert.equal(expanded.count, 10);
assert.equal(expanded.full, true, "an expanded batch blocks further manual submissions");
expanded.cancelAll();
assert.ok(expanded.items.every((item) => item.cancelRequested));
console.log("Generation queue: concurrency, FIFO, cancellation, reservations and expanded batches passed.");
