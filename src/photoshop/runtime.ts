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
    const results = await action.batchPlay(commands, { propagateErrorToDefaultHandler: false, ...options });
    const failure = results.find((result: any) => result?._obj === "error");
    if (failure) throw failure;
    return results;
  } catch (error: any) {
    // Preserve Photoshop's numeric codes for retry decisions; format them for the UI later.
    throw Object.assign(new Error(typeof error?.message === "string" ? error.message : errorMessage(error)), {
      name: error?.name || "Error", number: error?.number, result: error?.result,
    });
  }
}

export function isPhotoshopCommandUnavailable(error: any): boolean {
  return Number(error?.number ?? error?.result) === -25920 || /not (?:currently )?available/i.test(String(error?.message || ""));
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

export async function activateDocumentById(docId: number): Promise<void> {
  if (!openDocumentById(docId)) throw new Error(`Photoshop document ${docId} is no longer open.`);
  if (app.activeDocument?.id === docId) return;
  await batchPlay([{
    _obj: "select", _target: [{ _ref: "document", _id: docId }],
    _options: { dialogOptions: "silent" },
  }], {});
  if (app.activeDocument?.id !== docId) throw new Error(`Photoshop could not activate document ${docId}.`);
}

const scratchDocumentIds = new Set<number>();

// Only documents verified as new may ever enter the cleanup path.
export async function createScratchDocument(options: any): Promise<any> {
  const existingIds = new Set(Array.from(app.documents || [], (doc: any) => doc.id));
  const scratch = await app.createDocument(options);
  if (!Number.isFinite(scratch?.id) || existingIds.has(scratch.id) || !openDocumentById(scratch.id)) {
    throw new Error("Photoshop did not return a new temporary document. Placement was stopped.");
  }
  scratchDocumentIds.add(scratch.id);
  return scratch;
}

export async function closeScratchDocument(docId: number): Promise<void> {
  if (!scratchDocumentIds.has(docId)) throw new Error("Refusing to close a document not created for temporary use.");
  if (openDocumentById(docId)) {
    // The DOM closeWithoutSaving helper selects, then closes the active document.
    // If selection is blocked, that can close the user's document. Target the ID directly.
    await batchPlay([{
      _obj: "close", _target: [{ _ref: "document", _id: docId }],
      saving: { _enum: "yesNo", _value: "no" },
      _options: { dialogOptions: "silent" },
    }], {});
    if (openDocumentById(docId)) throw new Error(`Photoshop could not close temporary document ${docId}.`);
  }
  scratchDocumentIds.delete(docId);
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
