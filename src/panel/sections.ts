/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { loadSetting, saveSetting } from "../storage";
import { $ } from "./controls";

const PROMPT_MIN_HEIGHT = 48;

const PROMPT_MAX_HEIGHT = 2000;

const PROMPT_RESIZE_KEY_STEP = 24;

const COLLAPSIBLE_SECTIONS = [
  "apiKeys",
  "modelSelection",
  "prompt",
  "referenceImages",
  "describeWith",
  "recall",
  "aspectRatio",
] as const;

function setSectionExpanded(sectionId: (typeof COLLAPSIBLE_SECTIONS)[number], expanded: boolean): void {
  const section = $(`${sectionId}Section`);
  const toggle = $(`${sectionId}SectionToggle`);
  const content = $(`${sectionId}SectionContent`);
  if (!section || !toggle || !content) return;

  if (expanded) section.classList.remove("collapsed");
  else section.classList.add("collapsed");
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  content.setAttribute("aria-hidden", expanded ? "false" : "true");
}

export function setupCollapsibleSections(): void {
  for (const sectionId of COLLAPSIBLE_SECTIONS) {
    const toggle = $(`${sectionId}SectionToggle`);
    if (!toggle) continue;

    const settingName = `section.${sectionId}.expanded`;
    const defaultValue = sectionId === "recall" ? loadSetting("section.archive.expanded", "1") : "1";
    setSectionExpanded(sectionId, loadSetting(settingName, defaultValue) !== "0");
    const toggleSection = () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      setSectionExpanded(sectionId, expanded);
      saveSetting(settingName, expanded ? "1" : "0");
    };
    toggle.addEventListener("click", toggleSection);
    toggle.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.repeat || !["Enter", " ", "Spacebar"].includes(event.key)) return;
      event.preventDefault();
      toggleSection();
    });
  }
}

export function setupPromptResize(): void {
  const prompt = $("prompt");
  const handle = $("promptResizeHandle");
  if (!prompt || !handle) return;

  const applyHeight = (height: number, persist: boolean) => {
    const nextHeight = Math.min(PROMPT_MAX_HEIGHT, Math.max(PROMPT_MIN_HEIGHT, Math.round(height)));
    prompt.style.height = `${nextHeight}px`;
    handle.setAttribute("aria-valuenow", String(nextHeight));
    handle.setAttribute("aria-valuemin", String(PROMPT_MIN_HEIGHT));
    handle.setAttribute("aria-valuemax", String(PROMPT_MAX_HEIGHT));
    handle.setAttribute("aria-valuetext", `${nextHeight} pixels high`);
    if (persist) saveSetting("prompt.height", String(nextHeight));
  };

  const storedHeight = Number(loadSetting("prompt.height", String(PROMPT_MIN_HEIGHT)));
  applyHeight(Number.isFinite(storedHeight) ? storedHeight : PROMPT_MIN_HEIGHT, false);

  handle.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = prompt.getBoundingClientRect().height || PROMPT_MIN_HEIGHT;
    handle.classList.add("dragging");

    const onMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      applyHeight(startHeight + moveEvent.clientY - startY, false);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      const height = prompt.getBoundingClientRect().height || PROMPT_MIN_HEIGHT;
      applyHeight(height, true);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  handle.addEventListener("keydown", (event: KeyboardEvent) => {
    let delta = 0;
    if (event.key === "ArrowDown") delta = PROMPT_RESIZE_KEY_STEP;
    else if (event.key === "ArrowUp") delta = -PROMPT_RESIZE_KEY_STEP;
    else if (event.key !== "Home") return;
    event.preventDefault();
    const height = prompt.getBoundingClientRect().height || PROMPT_MIN_HEIGHT;
    applyHeight(event.key === "Home" ? PROMPT_MIN_HEIGHT : height + delta, true);
  });
}
