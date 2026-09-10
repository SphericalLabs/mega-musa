/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { PromptHistory, type PromptEdit, type PromptSnapshot } from "../prompt-history";
import { $, setValueSafe } from "./controls";
import { setStatus } from "./status";

type Direction = "undo" | "redo";

// Every application-controlled replacement must use replace(). Normal typing is
// observed without rewriting .value, preserving the native caret and IME session.
export function createPromptController() {
  let field: any;
  let history: PromptHistory | null = null;
  let locked = false;
  let disposed = false;
  let applying = false;
  let composing = false;
  let compositionFromInput = false;
  let compositionTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  let handledNativeHistory: { direction: Direction; awaitingBeforeInput: boolean } | null = null;
  let pendingType = "";
  let inferredChange: { group: string; caret: number } | null = null;
  const listeners: Array<() => void> = [];

  function snapshot(): PromptSnapshot {
    const state: PromptSnapshot = { text: String(field.value ?? "") };
    for (const key of ["selectionStart", "selectionEnd", "scrollTop", "scrollLeft"] as const) {
      try {
        const value = field[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          state[key] = key.startsWith("selection") ? Math.max(0, Math.min(state.text.length, value)) : value;
        }
      } catch { /* Some native controls expose text without selection/scroll APIs. */ }
    }
    try {
      if (typeof field.selectionDirection === "string") state.selectionDirection = field.selectionDirection;
    } catch { /* Optional native selection API. */ }
    return state;
  }

  function render(): void {
    const undo = $("undoPrompt"), redo = $("redoPrompt"), actions = $("promptHistoryActions");
    for (const [button, available, label] of [
      [undo, history?.canUndo, history?.undoLabel], [redo, history?.canRedo, history?.redoLabel],
    ] as const) {
      if (!button) continue;
      button.style.display = available ? "block" : "none";
      button.disabled = locked || composing || compositionTimer !== null || !available;
      const title = `${button === undo ? "Undo" : "Redo"}${label ? " " + label : ""}`;
      button.setAttribute("title", title);
      button.setAttribute("aria-label", title);
    }
    if (actions) actions.style.display = history?.canUndo || history?.canRedo ? "flex" : "none";
  }

  function write(state: PromptSnapshot, focus = false): boolean {
    applying = true;
    try {
      setValueSafe(field, state.text);
      if (String(field.value ?? "") !== state.text) {
        setStatus("The prompt could not be updated. Its undo history has been kept.", "error");
        return false;
      }
      try { if (focus) field.focus?.(); } catch { /* Focus is optional for restoring text. */ }
      // Selection is optional in UXP. Failure here must not discard text history.
      try {
        if (typeof field.selectionStart === "number" && state.selectionStart !== undefined) {
          field.selectionStart = state.selectionStart;
          field.selectionEnd = state.selectionEnd ?? state.selectionStart;
          if (state.selectionDirection !== undefined) field.selectionDirection = state.selectionDirection;
        }
      } catch { /* Keep the restored text if this host cannot restore the caret. */ }
      for (const key of ["scrollTop", "scrollLeft"] as const) {
        try { if (state[key] !== undefined) field[key] = state[key]; } catch { /* Optional scroll API. */ }
      }
      return true;
    } finally {
      applying = false;
    }
  }

  function editKind(before: PromptSnapshot, after: PromptSnapshot, inputType: string): PromptEdit {
    if (inputType === "insertFromPaste") return { label: "paste" };
    if (inputType === "deleteByCut") return { label: "cut" };
    if (inputType === "insertFromDrop" || inputType === "deleteByDrag") return { label: "drag and drop" };
    if (inputType && !["insertText", "deleteContentBackward", "deleteContentForward"].includes(inputType)) {
      return { label: "edit" };
    }
    const start = before.selectionStart, end = before.selectionEnd;
    if (start === undefined || end === undefined) return inferEdit(before.text, after.text, inputType);
    inferredChange = null;
    if (start !== end || after.selectionStart !== after.selectionEnd) return { label: "edit" };
    const change = after.text.length - before.text.length;
    if (change > 0 && after.selectionStart === start + change &&
      after.text.slice(0, start) === before.text.slice(0, start) &&
      after.text.slice(start + change) === before.text.slice(start)) {
      const inserted = after.text.slice(start, start + change);
      if (!/[\r\n]/.test(inserted) && (inputType === "insertText" || Array.from(inserted).length === 1)) {
        return { label: "typing", group: "typing" };
      }
    }
    if (change < 0 && after.selectionStart === start + change &&
      after.text === before.text.slice(0, start + change) + before.text.slice(start)) {
      return { label: "deletion", group: "backspace" };
    }
    if (change < 0 && after.selectionStart === start &&
      after.text === before.text.slice(0, start) + before.text.slice(start - change)) {
      return { label: "deletion", group: "delete" };
    }
    return { label: "edit" };
  }

  // Text-only UXP controls still get grouped typing. Infer the changed range and
  // require adjacent edits; paste/cut and navigation already close the group.
  function inferEdit(before: string, after: string, inputType: string): PromptEdit {
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    const inserted = after.slice(start, newEnd);
    let group = "", join = start, caret = newEnd;
    if (oldEnd === start && !/[\r\n]/.test(inserted) &&
      (inputType === "insertText" || Array.from(inserted).length === 1)) group = "typing";
    else if (newEnd === start && inputType === "deleteContentBackward") { group = "backspace"; join = oldEnd; caret = start; }
    else if (newEnd === start && inputType === "deleteContentForward") { group = "delete"; caret = start; }
    if (!group) { inferredChange = null; return { label: "edit" }; }
    if (inferredChange?.group !== group || inferredChange.caret !== join) history?.breakGroup();
    inferredChange = { group, caret };
    return { label: group === "typing" ? "typing" : "deletion", group };
  }

  function capture(inputType = pendingType): void {
    if (!history || applying || disposed || composing || compositionTimer !== null) return;
    if (locked || handledNativeHistory) {
      if (snapshot().text !== history.current.text) write(history.current);
      return;
    }
    const next = snapshot();
    if (next.text === history.current.text) history.updateSelection(next);
    else history.record(next, editKind(history.current, next, inputType));
    pendingType = "";
    render();
  }

  function finishComposition(): void {
    if (compositionTimer !== null) clearTimeout(compositionTimer);
    compositionTimer = null;
    composing = false;
    compositionFromInput = false;
    pendingType = "";
    if (history && !disposed) {
      if (locked) write(history.current);
      else history.record(snapshot(), { label: "composition" });
      history.breakGroup();
      render();
    }
  }

  function navigate(direction: Direction, nativeInput = false): void {
    if (!history || disposed || locked || composing) return;
    if (compositionTimer !== null) finishComposition();
    // For native history input, .value may already contain the native buffer's
    // result. Never record that value as a new edit in our own history.
    if (!nativeInput) capture();
    const moved = history[direction]((state) => write(state, true));
    if (!moved && nativeInput) write(history.current);
    pendingType = "";
    render();
  }

  function consume(event: Event): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function nativeDirection(event: InputEvent): Direction | null {
    return event.inputType === "historyUndo" ? "undo" : event.inputType === "historyRedo" ? "redo" : null;
  }

  function markNativeHistory(direction: Direction, awaitingBeforeInput = false): void {
    handledNativeHistory = { direction, awaitingBeforeInput };
    if (nativeHistoryTimer !== null) clearTimeout(nativeHistoryTimer);
    nativeHistoryTimer = setTimeout(() => {
      nativeHistoryTimer = null;
      handledNativeHistory = null;
    }, 0);
  }

  function onNativeHistory(event: InputEvent, direction: Direction): void {
    if (composing || event.isComposing) return;
    consume(event);
    if (!history) return;
    if (event.type === "beforeinput") {
      if (!locked && !(handledNativeHistory?.direction === direction && handledNativeHistory.awaitingBeforeInput)) {
        navigate(direction);
      }
      markNativeHistory(direction);
    } else {
      if (handledNativeHistory?.direction === direction || locked) write(history.current);
      else navigate(direction, true);
      handledNativeHistory = null;
    }
  }

  function onInput(event: InputEvent): void {
    if (applying || disposed) return;
    const direction = nativeDirection(event);
    if (direction) { onNativeHistory(event, direction); return; }
    if (event.isComposing) {
      handledNativeHistory = null;
      if (!composing) { history?.breakGroup(); composing = true; compositionFromInput = true; render(); }
      return;
    }
    if (composing && compositionFromInput && event.isComposing === false) { finishComposition(); return; }
    capture(event.inputType || pendingType);
    handledNativeHistory = null;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || disposed) return;
    const key = String(event.key || "").toLowerCase();
    const modifier = event.metaKey || event.ctrlKey;
    const direction = modifier && !event.altKey && key === "z" ? (event.shiftKey ? "redo" : "undo") :
      event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === "y" ? "redo" : null;
    if (direction) {
      // IME owns its composition until it ends, including its own cancel/undo.
      if (event.isComposing || composing) return;
      consume(event); // Consume even an empty/locked history; do not undo Photoshop.
      navigate(direction);
      markNativeHistory(direction, true);
      return;
    }
    if (event.isComposing || composing) return;
    handledNativeHistory = null;
    capture();
    if (key === "backspace") pendingType = modifier || event.altKey ? "deleteWordBackward" : "deleteContentBackward";
    else if (key === "delete") pendingType = modifier || event.altKey ? "deleteWordForward" : "deleteContentForward";
    else if (!modifier && !event.altKey && Array.from(key).length === 1) pendingType = "insertText";
    else {
      pendingType = "";
      history?.breakGroup();
    }
  }

  function listen(target: any, type: string, handler: any, captureEvent = false): void {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, captureEvent);
    listeners.push(() => target.removeEventListener(type, handler, captureEvent));
  }

  function init(): void {
    if (history || disposed) return;
    field = $("prompt");
    if (!field) throw new Error("The prompt editor is unavailable.");
    history = new PromptHistory(snapshot());
    field.disabled = locked;
    listen(field, "input", onInput);
    listen(field, "change", () => { capture(); history?.breakGroup(); });
    listen(field, "beforeinput", (event: InputEvent) => {
      if (applying) return;
      const direction = nativeDirection(event);
      if (direction) { onNativeHistory(event, direction); return; }
      if (handledNativeHistory) { consume(event); return; }
      if (locked) { consume(event); return; }
      const inputType = event.inputType || pendingType;
      capture();
      pendingType = inputType;
    });
    listen(field, "keydown", onKeyDown, true);
    listen(document, "keydown", (event: KeyboardEvent) => {
      const target = event.target;
      if (target === field || (target && field.contains?.(target))) onKeyDown(event);
    }, true);
    listen(field, "keyup", () => capture());
    for (const [type, inputType] of [["paste", "insertFromPaste"], ["cut", "deleteByCut"], ["drop", "insertFromDrop"]]) {
      listen(field, type, (event: Event) => {
        if (locked) { consume(event); return; }
        handledNativeHistory = null;
        capture();
        history?.breakGroup();
        pendingType = inputType;
      });
    }
    listen(field, "compositionstart", () => {
      handledNativeHistory = null;
      capture();
      history?.breakGroup();
      composing = true;
      compositionFromInput = false;
      render();
    });
    listen(field, "compositionend", () => {
      composing = false;
      if (compositionTimer !== null) clearTimeout(compositionTimer);
      // The final input may follow compositionend. Commit both as a single edit.
      compositionTimer = setTimeout(finishComposition, 0);
    });
    for (const type of ["mousedown", "focus", "blur"]) {
      listen(field, type, () => { capture(); history?.breakGroup(); });
    }
    for (const type of ["select", "mouseup", "scroll"]) {
      listen(field, type, () => { if (!applying && !composing) history?.updateSelection(snapshot()); });
    }
    listen($("undoPrompt"), "click", () => navigate("undo"));
    listen($("redoPrompt"), "click", () => navigate("redo"));
    render();
  }

  function replace(text: string, source: string): boolean {
    if (!history || disposed || (locked && source !== "Describe") || composing) return false;
    if (compositionTimer !== null) finishComposition();
    capture();
    history.breakGroup();
    if (text === history.current.text) return true;
    const next: PromptSnapshot = { text, selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0 };
    if (!write(next)) return false;
    history.record(snapshot(), { label: source });
    render();
    return true;
  }

  function setLocked(value: boolean): void {
    if (disposed) return;
    if (history && value && !locked) {
      if (composing || compositionTimer !== null) finishComposition();
      capture();
      history.breakGroup();
    }
    locked = value;
    if (field) field.disabled = value;
    render();
  }

  function dispose(): void {
    disposed = true;
    for (const remove of listeners) remove();
    listeners.length = 0;
    if (compositionTimer !== null) clearTimeout(compositionTimer);
    if (nativeHistoryTimer !== null) clearTimeout(nativeHistoryTimer);
    history = null;
  }

  return { init, replace, setLocked, dispose, undo: () => navigate("undo"), redo: () => navigate("redo"),
    get locked() { return locked; }, get isComposing() { return composing; },
    get canUndo() { return !!history?.canUndo; }, get canRedo() { return !!history?.canRedo; } };
}

export type PromptController = ReturnType<typeof createPromptController>;
