/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import {
  DEFAULT_HOST_MODAL_TIMEOUT_SECONDS,
  type HostModalLease,
  executeHostModal,
  runHostModalTask,
} from "../host-modal";

export const { app, action, constants, core, imaging } = require("photoshop");

export const { storage } = require("uxp");

export { SRGB_PROFILE } from "./document-state";

// Photoshop can resolve a batch successfully while individual commands fail.
export async function batchPlay(commands: any[], options: any): Promise<any[]> {
  try {
    const results = await action.batchPlay(commands, options);
    const failure = results.find((result: any) => result?._obj === "error");
    if (failure) throw new Error(errorMessage(failure));
    return results;
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

export function runModal<T>(
  commandName: string,
  target: (executionContext: any) => Promise<T> | T,
  lease?: HostModalLease,
  timeoutSeconds: number = DEFAULT_HOST_MODAL_TIMEOUT_SECONDS
): Promise<T> {
  return runHostModalTask(
    () => executeHostModal(core, target, commandName, timeoutSeconds),
    lease
  );
}

export function getActiveDoc(): any {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document in Photoshop first.");
  return doc;
}

export function openDocumentById(docId: number): any | null {
  return Array.from(app.documents || []).find((doc: any) => doc.id === docId) || null;
}

export async function withActiveDocument<T>(docId: number, run: () => Promise<T>): Promise<T> {
  const previousDocument = app.activeDocument;
  const targetDocument = openDocumentById(docId);
  if (!targetDocument) {
    throw new Error("The original Photoshop document was closed, so the billed result was not placed.");
  }

  const switched = previousDocument?.id !== docId;
  try {
    if (switched) app.activeDocument = targetDocument;
    if (app.activeDocument?.id !== docId) {
      throw new Error("Photoshop could not reactivate the original document, so the billed result was not placed.");
    }
    return await run();
  } finally {
    if (switched && previousDocument && openDocumentById(previousDocument.id)) {
      try {
        app.activeDocument = previousDocument;
      } catch (e: any) {
        console.log("[Mega Musa] could not restore the previously active document:", e?.message || e);
      }
    }
  }
}
