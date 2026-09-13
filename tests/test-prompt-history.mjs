/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 */
import assert from "node:assert/strict";
import { loadModule, panelDocument } from "./test-support.mjs";

const { PromptHistory } = await loadModule("src/prompt-history.ts");
const state = (text, position = text.length) => ({ text, selectionStart: position, selectionEnd: position });

// Pure history: immediate branching, exact whitespace, selection, bounded storage
// and failed writes, without any DOM or native undo buffer.
{
  const history = new PromptHistory(state(""));
  history.record(state("a"), { label: "typing", group: "typing", time: 0 });
  history.record(state("ab"), { label: "typing", group: "typing", time: 500 });
  history.record(state("abc"), { label: "typing", group: "typing", time: 1500 });
  assert.equal(history.undo(() => false), false);
  assert.equal(history.current.text, "abc", "failed write must not advance history");
  history.undo(() => true);
  assert.equal(history.current.text, "ab", "a pause starts a new step");
  history.undo(() => true);
  assert.equal(history.current.text, "", "continuous typing is one step");
  history.redo(() => true);
  history.record(state("ab"), { label: "unchanged" });
  assert.equal(history.canRedo, true, "a no-op preserves redo");
  history.record(state("ab \n🙂  "), { label: "paste" });
  assert.equal(history.canRedo, false, "a new edit immediately discards redo");
  assert.equal(history.current.text, "ab \n🙂  ");
  history.updateSelection({ ...state("ab \n🙂  ", 3), selectionEnd: 6, scrollTop: 90 });
  history.record(state("replacement"), { label: "Recall" });
  history.undo(() => true);
  assert.equal(history.current.selectionStart, 3);
  assert.equal(history.current.selectionEnd, 6);
  assert.equal(history.current.scrollTop, 90);
  const copy = history.current;
  copy.text = "must not mutate history";
  assert.equal(history.current.text, "ab \n🙂  ");
}
{
  const history = new PromptHistory(state("0"), 3);
  for (let i = 1; i <= 10; i++) history.record(state(String(i)), { label: "Recall" });
  for (const text of ["9", "8", "7"]) { assert.equal(history.undo(() => true), true); assert.equal(history.current.text, text); }
  assert.equal(history.canUndo, false);
  for (const text of ["8", "9", "10"]) { history.redo(() => true); assert.equal(history.current.text, text); }
  const bounded = new PromptHistory(state("1111"), 200, 12);
  for (const text of ["2222", "3333", "4444"]) bounded.record(state(text), { label: "Recall" });
  bounded.undo(() => true); bounded.undo(() => true);
  assert.equal(bounded.current.text, "2222");
  assert.equal(bounded.canUndo, false);
  const huge = new PromptHistory(state("before"), 200, 10);
  huge.record(state("x".repeat(100)), { label: "paste" });
  huge.undo(() => true);
  assert.equal(huge.current.text, "before", "an oversized paste remains undoable");
}

function event(type, properties = {}) {
  const result = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(result, properties);
  return result;
}

async function editor(text = "") {
  const { document, elements } = panelDocument(["prompt", "undoPrompt", "redoPrompt", "promptHistoryActions", "status", "otherField"]);
  const field = elements.prompt;
  field.value = text;
  field.selectionStart = field.selectionEnd = text.length;
  let now = 0;
  const timers = new Map();
  const api = await loadModule("src/panel/prompt.ts", { globals: {
    document,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  } });
  const prompt = api.createPromptController();
  prompt.init();
  const tick = (milliseconds = 1) => {
    now += milliseconds;
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  };
  const select = (start, end = start) => {
    field.selectionStart = start; field.selectionEnd = end;
    field.dispatchEvent(event("select"));
  };
  const change = (text, start = text.length, inputType = "insertText", before = true) => {
    if (before && !field.dispatchEvent(event("beforeinput", { inputType }))) return;
    field.value = text;
    field.selectionStart = field.selectionEnd = start;
    field.dispatchEvent(event("input", { inputType }));
  };
  const key = (key, properties = {}) => {
    const down = event("keydown", { key, ...properties });
    field.dispatchEvent(down);
    return down;
  };
  return { prompt, field, document, elements, tick, select, change, key, timers };
}

// Mixed edits retain only the latest undo step and its redo.
{
  const t = await editor();
  assert.equal(t.elements.promptHistoryActions.style.display, "none");
  t.change("a"); t.tick(100); t.change("ab");
  assert.equal(t.elements.undoPrompt.style.display, "block");
  assert.equal(t.elements.redoPrompt.style.display, "none");
  t.field.dispatchEvent(event("paste"));
  t.change("ab pasted\n", 10, "insertFromPaste");
  assert.equal(t.prompt.replace("Description", "Describe"), true);
  t.select(11); t.change("Description!");
  assert.equal(t.prompt.replace("Recalled", "Recall"), true);
  assert.equal(t.elements.undoPrompt.getAttribute("title"), "Undo Recall");
  for (const text of ["Description!", "Description!"]) {
    t.elements.undoPrompt.dispatchEvent(event("click"));
    assert.equal(t.field.value, text);
  }
  assert.equal(t.elements.undoPrompt.style.display, "none");
  for (const text of ["Recalled", "Recalled"]) {
    t.elements.redoPrompt.dispatchEvent(event("click"));
    assert.equal(t.field.value, text);
  }
  t.prompt.dispose();
}

// Selection replacement, cut, delete, newline, cursor moves and pauses split edits.
{
  const t = await editor("hello world");
  t.select(6, 11); t.field.scrollTop = 50;
  t.change("hello earth", 11);
  t.prompt.undo();
  assert.equal(t.field.value, "hello world");
  assert.equal(t.field.selectionStart, 11); assert.equal(t.field.selectionEnd, 11);
  assert.equal(t.field.scrollTop, 50);
  t.prompt.redo();
  t.select(5, 11);
  t.field.dispatchEvent(event("cut")); t.change("hello", 5, "deleteByCut");
  t.change("hell", 4, "deleteContentBackward"); t.change("hel", 3, "deleteContentBackward");
  t.prompt.undo(); assert.equal(t.field.value, "hello");
  t.prompt.undo(); assert.equal(t.field.value, "hello");
  t.prompt.redo(); t.prompt.redo();
  t.change("hel!", 4); t.tick(800); t.change("hel!!", 5);
  t.prompt.undo(); assert.equal(t.field.value, "hel!");
  assert.equal(t.prompt.canRedo, true);
  t.change("hel!?", 5);
  assert.equal(t.prompt.canRedo, false);
  t.select(0); t.change("Xhel!?", 1);
  t.change("X\nhel!?", 2, "insertLineBreak");
  t.prompt.undo(); assert.equal(t.field.value, "Xhel!?");
  t.prompt.undo(); assert.equal(t.field.value, "Xhel!?");
  t.prompt.dispose();
}

// Button navigation keeps focus on the button and never restores selected text.
// Focus/change notifications between clicks must preserve the redo timeline.
{
  const t = await editor("original");
  t.select(0, 8);
  t.prompt.replace("one", "Recall");
  t.select(0, 3);
  t.prompt.replace("two", "Recall");
  t.select(0, 3);
  t.prompt.replace("three", "Recall");
  for (const [button, texts] of [
    [t.elements.undoPrompt, ["two", "two"]],
    [t.elements.redoPrompt, ["three", "three"]],
  ]) {
    for (const text of texts) {
      button.focus();
      button.dispatchEvent(event("click"));
      assert.equal(t.document.activeElement, button, "navigation must not refocus the prompt");
      assert.equal(t.field.value, text);
      assert.equal(t.field.selectionStart, t.field.selectionEnd, "navigation must collapse selections");
      for (const type of ["focus", "blur", "change"]) t.field.dispatchEvent(event(type));
      t.tick();
      assert.equal(t.elements.redoPrompt.style.display, text === "three" ? "none" : "block");
    }
  }
  t.prompt.dispose();
}

// Missing InputEvent metadata must not merge a one-character paste into typing.
{
  const t = await editor();
  t.change("a");
  t.field.dispatchEvent(event("paste"));
  t.field.dispatchEvent(event("beforeinput"));
  t.field.value = "aB"; t.field.selectionStart = t.field.selectionEnd = 2;
  t.field.dispatchEvent(event("input"));
  t.change("aBc");
  t.prompt.undo(); assert.equal(t.field.value, "aB");
  t.prompt.undo(); assert.equal(t.field.value, "aB");
  t.prompt.redo(); assert.equal(t.field.value, "aBc");
  t.prompt.dispose();
}

// Shortcuts are scoped to the prompt and consumed even at the history boundary.
// Other listeners (such as Generate) still receive unrelated key combinations.
{
  const t = await editor("original");
  let hostKeys = 0, generateKeys = 0;
  t.document.addEventListener("keydown", () => { hostKeys++; });
  t.field.addEventListener("keydown", (e) => { if (e.key === "Enter") generateKeys++; });
  t.prompt.replace("one", "Recall"); t.prompt.replace("two", "Describe");
  assert.equal(t.key("z", { metaKey: true }).defaultPrevented, true);
  assert.equal(t.field.value, "one");
  t.key("z", { metaKey: true }); assert.equal(t.field.value, "one");
  t.key("z", { metaKey: true }); assert.equal(t.field.value, "one");
  assert.equal(hostKeys, 0);
  t.tick(); t.key("Z", { metaKey: true, shiftKey: true }); assert.equal(t.field.value, "two");
  t.tick(); t.key("y", { ctrlKey: true }); assert.equal(t.field.value, "two");
  t.tick(); t.key("z", { ctrlKey: true }); assert.equal(t.field.value, "one");
  t.tick(); t.key("z", { ctrlKey: true, shiftKey: true }); assert.equal(t.field.value, "two");
  assert.equal(t.key("z", { metaKey: true, altKey: true }).defaultPrevented, false);
  t.key("Enter", { metaKey: true }); assert.equal(generateKeys, 1);
  const outside = event("keydown", { key: "z", metaKey: true });
  t.elements.otherField.dispatchEvent(outside);
  assert.equal(outside.defaultPrevented, false);
  t.prompt.dispose();
}

// Native menu history and a leaked native input following a shortcut must never
// produce an extra step, double-undo or replace the custom redo branch.
{
  const t = await editor("original");
  t.prompt.replace("one", "Recall"); t.prompt.replace("two", "Recall");
  t.key("z", { metaKey: true });
  t.field.dispatchEvent(event("beforeinput", { inputType: "historyUndo" }));
  t.field.value = "native buffer result";
  t.field.dispatchEvent(event("input", { inputType: "historyUndo" }));
  assert.equal(t.field.value, "one");
  t.tick();
  t.field.dispatchEvent(event("beforeinput", { inputType: "historyRedo" }));
  t.field.value = "another native result";
  t.field.dispatchEvent(event("input", { inputType: "historyRedo" }));
  assert.equal(t.field.value, "two");
  t.tick();
  t.field.value = "input without beforeinput";
  t.field.dispatchEvent(event("input", { inputType: "historyUndo" }));
  assert.equal(t.field.value, "one");
  t.tick(); t.prompt.redo(); assert.equal(t.field.value, "two");
  t.key("z", { metaKey: true });
  t.field.value = "native input without inputType";
  t.field.dispatchEvent(event("input"));
  assert.equal(t.field.value, "one");
  t.tick(); t.prompt.redo(); assert.equal(t.field.value, "two");
  // Repeated menu undo stops at the single retained history boundary.
  t.tick();
  t.field.dispatchEvent(event("beforeinput", { inputType: "historyUndo" }));
  t.field.dispatchEvent(event("beforeinput", { inputType: "historyUndo" }));
  assert.equal(t.field.value, "one");
  t.prompt.dispose();
}

// IME commits only the final composition, even when its final input follows end.
{
  const t = await editor("start ");
  t.field.dispatchEvent(event("compositionstart"));
  for (const text of ["start n", "start ni"]) {
    t.field.value = text;
    t.field.dispatchEvent(event("input", { isComposing: true, inputType: "insertCompositionText" }));
  }
  assert.equal(t.prompt.canUndo, false);
  assert.equal(t.key("z", { metaKey: true, isComposing: true }).defaultPrevented, false);
  const imeUndo = event("beforeinput", { inputType: "historyUndo", isComposing: true });
  t.field.dispatchEvent(imeUndo);
  assert.equal(imeUndo.defaultPrevented, false, "IME undo must stay with the active composition");
  t.field.dispatchEvent(event("compositionend"));
  t.change("start 你", 7, "insertText", false);
  t.tick();
  t.prompt.undo(); assert.equal(t.field.value, "start ");
  t.prompt.redo(); assert.equal(t.field.value, "start 你");
  // Some controls expose composition only on InputEvent.
  t.field.value = "start 你h";
  t.field.dispatchEvent(event("input", { isComposing: true }));
  t.field.value = "start 你好";
  t.field.dispatchEvent(event("input", { isComposing: false }));
  assert.equal(t.prompt.isComposing, false);
  t.prompt.undo(); assert.equal(t.field.value, "start 你");
  t.prompt.dispose();
}

// Programmatic writes need no synthetic events. Setters may themselves dispatch
// input, refuse a write or expose no selection APIs; none should corrupt history.
{
  const t = await editor("before");
  let value = t.field.value, fail = false;
  Object.defineProperty(t.field, "value", {
    get() { return value; },
    set(next) { if (fail) throw new Error("Native setter failed"); value = next; this.dispatchEvent(event("input")); },
  });
  t.prompt.replace("after", "Describe");
  fail = true;
  t.prompt.undo(); assert.equal(t.field.value, "after"); assert.equal(t.prompt.canRedo, false);
  assert.match(t.elements.status.textContent, /undo history has been kept/);
  fail = false;
  t.prompt.undo(); assert.equal(t.field.value, "before");
  t.prompt.redo(); assert.equal(t.field.value, "after");
  t.prompt.dispose();
  const unsupported = await editor("plain");
  for (const property of ["selectionStart", "selectionEnd", "selectionDirection", "scrollTop", "scrollLeft"]) {
    Object.defineProperty(unsupported.field, property, { get() { throw new Error("Unsupported"); }, set() { throw new Error("Unsupported"); } });
  }
  unsupported.prompt.replace("replacement", "Recall");
  unsupported.prompt.undo(); assert.equal(unsupported.field.value, "plain");
  unsupported.prompt.redo(); assert.equal(unsupported.field.value, "replacement");
  for (const text of ["replacement a", "replacement ab", "replacement abc"]) {
    unsupported.field.dispatchEvent(event("beforeinput", { inputType: "insertText" }));
    unsupported.field.value = text;
    unsupported.field.dispatchEvent(event("input", { inputType: "insertText" }));
    unsupported.field.dispatchEvent(event("keyup"));
  }
  unsupported.prompt.undo(); assert.equal(unsupported.field.value, "replacement", "typing groups without native caret APIs");
  unsupported.prompt.dispose();
}

// Describe's lock covers all prompt-changing routes and preserves redo on Cancel.
{
  const t = await editor("start");
  t.prompt.replace("recalled", "Recall"); t.prompt.undo();
  t.prompt.setLocked(true);
  assert.equal(t.field.disabled, true);
  assert.equal(t.elements.redoPrompt.disabled, true);
  assert.equal(t.prompt.replace("blocked", "Recall"), false);
  t.prompt.redo(); assert.equal(t.field.value, "start");
  t.change("blocked typing"); assert.equal(t.field.value, "start");
  t.prompt.setLocked(false); t.prompt.redo(); assert.equal(t.field.value, "recalled");
  t.prompt.setLocked(true);
  t.prompt.replace("description", "Describe");
  assert.equal(t.elements.undoPrompt.disabled, true);
  t.prompt.setLocked(false); t.prompt.undo(); assert.equal(t.field.value, "recalled");
  t.prompt.dispose();
}

// Input is the primary observation path; keyup/change/blur catch host omissions.
// Disposal removes only our handlers and cancels composition/history timers.
{
  const t = await editor();
  t.key("a"); t.field.value = "a"; t.field.selectionStart = t.field.selectionEnd = 1;
  t.field.dispatchEvent(event("keyup", { key: "a" }));
  t.field.value = "a pasted"; t.field.selectionStart = t.field.selectionEnd = 8;
  t.field.dispatchEvent(event("change"));
  t.prompt.undo(); assert.equal(t.field.value, "a");
  t.prompt.undo(); assert.equal(t.field.value, "a");
  let otherInputs = 0;
  t.field.addEventListener("input", () => otherInputs++);
  t.prompt.init(); // Idempotent initialization must not duplicate handlers.
  t.key("z", { metaKey: true });
  assert.ok(t.timers.size > 0);
  t.prompt.dispose();
  assert.equal(t.timers.size, 0);
  t.field.dispatchEvent(event("input"));
  assert.equal(otherInputs, 1);
  assert.equal(t.prompt.replace("late response", "Describe"), false);
  const shortcut = t.key("z", { metaKey: true });
  assert.equal(shortcut.defaultPrevented, false);
}

console.log("Prompt history: mixed edits, grouping, selection, branching, shortcuts, native history, IME, write failures, locking and disposal passed.");
