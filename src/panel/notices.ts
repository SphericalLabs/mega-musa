/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { errorMessage } from "../errors";
import { $ } from "./controls";

export type ModalNoticeKind = "blocker" | "warning";

export type ModalNoticeAction = "primary" | "cancel";

export interface ModalNotice {
  kind: ModalNoticeKind;
  title: string;
  message: string;
  instruction?: string;
  primaryLabel: string;
  cancelLabel?: string;
}

let modalNoticeOpen = false;

let modalNoticeAction: ModalNoticeAction = "cancel";

let modalNoticeListenersReady = false;

function setupModalNoticeListeners(): void {
  if (modalNoticeListenersReady) return;
  const dialog = $("noticeDialog");
  const cancel = $("noticeDialogCancel");
  const primary = $("noticeDialogPrimary");
  if (!dialog || !cancel || !primary) {
    throw new Error("The Mega Musa message dialog is unavailable.");
  }
  cancel.addEventListener("click", () => {
    modalNoticeAction = "cancel";
    dialog.close();
  });
  primary.addEventListener("click", () => {
    modalNoticeAction = "primary";
    dialog.close();
  });
  modalNoticeListenersReady = true;
}

export async function showModalNotice(notice: ModalNotice): Promise<ModalNoticeAction> {
  const dialog = $("noticeDialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    throw new Error("The Mega Musa message dialog could not be opened.");
  }

  if (modalNoticeOpen) {
    throw new Error("Another Mega Musa message is already open.");
  }

  setupModalNoticeListeners();
  $("noticeDialogTitle").textContent = notice.title;
  $("noticeDialogMessage").textContent = notice.message;
  $("noticeDialogInstruction").textContent = notice.instruction || "";
  const cancel = $("noticeDialogCancel");
  cancel.textContent = notice.cancelLabel || "";
  cancel.style.display = notice.cancelLabel ? "" : "none";
  const primary = $("noticeDialogPrimary");
  primary.textContent = notice.primaryLabel;
  primary.setAttribute("variant", notice.kind === "warning" ? "warning" : "primary");
  primary.style.marginLeft = notice.cancelLabel ? "8px" : "0";

  modalNoticeOpen = true;
  modalNoticeAction = "cancel";
  try {
    await dialog.showModal({ lockDocumentFocus: true });
    return modalNoticeAction;
  } catch (err: any) {
    // Dismissal closes blockers and cancels warnings without reporting an error.
    console.log(`[Mega Musa] ${notice.kind} dialog closed:`, errorMessage(err));
    return "cancel";
  } finally {
    modalNoticeOpen = false;
  }
}
