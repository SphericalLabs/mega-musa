/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { GenerationQueue, generationJobIsActive } from "../generation/queue";
import { type GenerationJob } from "../generation/types";
import { modelSpec } from "../models/catalog";
import { isOpenAIModel } from "../models/provider";
import { imageQualityLabel } from "../models/quality";
import { $, clearChildren } from "./controls";

export function generationJobMeta(job: GenerationJob): string {
  const quality = isOpenAIModel(job.model) ? imageQualityLabel(job.quality) : "Auto";
  const referenceCount = `${job.references.length} reference image${job.references.length === 1 ? "" : "s"}`;
  return `${modelSpec(job.model).label} · ${quality} quality · ${referenceCount}`;
}

export function renderGenerationQueue(queue: GenerationQueue, retryGenerationPlacement: (job: GenerationJob) => Promise<void>): void {
  const section = $("generationQueue");
  const list = $("generationQueueList");
  const summary = $("generationQueueSummary");
  const cancelAll = $("cancelAllGenerations");
  const cancelBillingNote = $("generationCancelBillingNote");
  if (!section || !list || !summary || !cancelAll || !cancelBillingNote) return;

  section.style.display = queue.items.length ? "block" : "none";
  clearChildren(list);

  const active = queue.items.filter(generationJobIsActive);
  $("generationActivity").style.display = active.length ? "block" : "none";
  const waiting = active.filter((job) => job.state === "waiting").length;
  const failed = queue.items.length - active.length;
  const summaryParts = [`${active.length} active`];
  if (waiting) summaryParts.push(`${waiting} waiting`);
  if (failed) summaryParts.push(`${failed} failed`);
  summary.textContent = `Generation Queue · ${summaryParts.join(" · ")}`;

  const cancelable = active.filter((job) => job.state !== "placing" && job.state !== "cancelling");
  cancelAll.style.display = cancelable.length ? "inline-flex" : "none";
  cancelAll.disabled = cancelable.length === 0;
  cancelBillingNote.style.display = cancelable.some((job) => job.state === "generating")
    ? "block"
    : "none";

  for (const job of queue.items) {
    const row = document.createElement("div");
    row.className = `generation-job${generationJobIsActive(job) ? "" : " failed"}`;

    const body = document.createElement("div");
    body.className = "generation-job-body";

    const prompt = document.createElement("div");
    prompt.className = "generation-job-prompt";
    prompt.textContent = job.prompt;
    prompt.title = job.prompt;

    const meta = document.createElement("div");
    meta.className = "generation-job-meta";
    meta.textContent = generationJobMeta(job);

    const status = document.createElement("div");
    status.className = "generation-job-status";
    status.textContent = job.status;

    const actions = document.createElement("div");
    actions.className = "generation-job-actions";
    const addAction = (label: string, variant: string, disabled: boolean, onClick: () => void) => {
      const action: any = document.createElement("sp-button");
      action.className = "generation-job-action";
      action.setAttribute("size", "s");
      action.setAttribute("variant", variant);
      action.textContent = label;
      action.disabled = disabled;
      action.addEventListener("click", onClick);
      actions.appendChild(action);
    };

    if (job.state === "placement-failed") {
      addAction("Retry Placement", "primary", false, () => void retryGenerationPlacement(job));
      addAction("Dismiss", "secondary", false, () => queue.remove(job));
    } else if (job.state === "failed") {
      addAction("Dismiss", "secondary", false, () => queue.remove(job));
    } else if (job.state === "placing") {
      addAction("Finishing…", "secondary", true, () => { });
    } else if (job.state === "cancelling") {
      addAction("Canceling…", "secondary", true, () => { });
    } else {
      addAction("Cancel", "warning", false, () => queue.cancel(job));
    }

    body.appendChild(prompt);
    body.appendChild(meta);
    body.appendChild(status);
    row.appendChild(body);
    row.appendChild(actions);
    list.appendChild(row);
  }

}
