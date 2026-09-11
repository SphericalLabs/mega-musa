/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
    entryPoints: ["src/host-modal.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const {
    executeHostModal,
    HostModalPreflightBusyError,
    HostModalTimeoutError,
    isHostModalBusyError,
    runHostModalTask,
  } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = runHostModalTask(async (lease) => {
    events.push("first:start");
    await firstGate;
    await runHostModalTask(async (nestedLease) => {
      assert.equal(nestedLease, lease);
      events.push("first:nested");
    }, lease);
    events.push("first:end");
  });
  const second = runHostModalTask(async () => {
    events.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:nested", "first:end", "second"]);

  await assert.rejects(runHostModalTask(async () => {
    throw new Error("expected failure");
  }), /expected failure/);
  await runHostModalTask(async () => {
    events.push("after-error");
  });
  assert.equal(events.at(-1), "after-error");

  assert.equal(isHostModalBusyError({ number: 9 }), true);
  assert.equal(isHostModalBusyError({ result: 9 }), true);
  assert.equal(isHostModalBusyError(new Error("host is in a modal state")), true);
  assert.equal(isHostModalBusyError(new Error("unrelated")), false);

  let options;
  const result = await executeHostModal(
    {
      executeAsModal: async (target, receivedOptions) => {
        options = receivedOptions;
        return await target({});
      },
    },
    async () => "placed",
    "place result",
    30
  );
  assert.equal(result, "placed");
  assert.equal(options.commandName, "Mega Musa: place result");
  assert.ok(options.timeOut > 0 && options.timeOut <= 30);

  let startedAttempts = 0;
  const startedBusyError = new Error("host is in a modal state");
  startedBusyError.number = 9;
  await assert.rejects(
    executeHostModal(
      {
        executeAsModal: async (target) => {
          startedAttempts += 1;
          return await target({});
        },
      },
      async () => {
        throw startedBusyError;
      },
      "place result",
      0.1
    ),
    (error) => error === startedBusyError
  );
  assert.equal(startedAttempts, 1);

  // Only the explicit read-only preparation error allows a started callback to retry.
  let preflightAttempts = 0;
  const recovered = await executeHostModal(
    { executeAsModal: async target => target({}) },
    async () => {
      if (++preflightAttempts < 3) throw new HostModalPreflightBusyError("blocked read");
      return "placed after menu closed";
    },
    "place result", 1
  );
  assert.equal(recovered, "placed after menu closed");
  assert.equal(preflightAttempts, 3);
  await assert.rejects(executeHostModal(
    { executeAsModal: async target => target({}) },
    async () => { throw new HostModalPreflightBusyError("menu stays open"); },
    "place result", 0.1
  ), error => error instanceof HostModalTimeoutError);

  let attempts = 0;
  await assert.rejects(
    executeHostModal(
      {
        executeAsModal: async () => {
          attempts += 1;
          const error = new Error("host is in a modal state");
          error.number = 9;
          throw error;
        },
      },
      async () => undefined,
      "place result",
      0.1
    ),
    (error) => error instanceof HostModalTimeoutError && error.timeoutSeconds === 0.1
  );
  assert.ok(attempts >= 1);

  console.log("host modal tests passed (FIFO, reentrancy, recovery and timeout)");
