/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export interface PromptSnapshot {
  text: string;
  selectionStart?: number;
  selectionEnd?: number;
  selectionDirection?: string;
  scrollTop?: number;
  scrollLeft?: number;
}

export interface PromptEdit {
  label: string;
  group?: string;
  time?: number;
}

// Text history belongs to the panel session, independently of Photoshop and the
// native editor's undo buffer. A state is a complete, unmodified prompt.
export class PromptHistory {
  private states: PromptSnapshot[];
  private labels: string[] = [];
  private position = 0;
  private group: string | undefined;
  private lastEditTime = 0;

  constructor(initial: PromptSnapshot, private readonly limit = 200, private readonly maxCharacters = 4 * 1024 * 1024) {
    this.states = [{ ...initial }];
  }

  get current(): PromptSnapshot { return { ...this.states[this.position] }; }
  get canUndo(): boolean { return this.position > 0; }
  get canRedo(): boolean { return this.position < this.labels.length; }
  get undoLabel(): string { return this.labels[this.position - 1] || ""; }
  get redoLabel(): string { return this.labels[this.position] || ""; }

  breakGroup(): void { this.group = undefined; }

  updateSelection(snapshot: PromptSnapshot): void {
    const current = this.states[this.position];
    if (snapshot.text !== current.text) return;
    if (snapshot.selectionStart !== current.selectionStart || snapshot.selectionEnd !== current.selectionEnd) {
      this.breakGroup();
    }
    this.states[this.position] = { ...snapshot };
  }

  record(snapshot: PromptSnapshot, edit: PromptEdit): boolean {
    if (snapshot.text === this.states[this.position].text) {
      this.updateSelection(snapshot);
      return false;
    }
    const time = edit.time ?? Date.now();
    const merge = !!edit.group && edit.group === this.group && this.canUndo && !this.canRedo &&
      time >= this.lastEditTime && time - this.lastEditTime <= 750;
    // Branch immediately, including when the new edit is still being typed.
    this.states.length = this.position + 1;
    this.labels.length = this.position;
    if (merge) {
      this.states[this.position] = { ...snapshot };
    } else {
      this.states.push({ ...snapshot });
      this.labels.push(edit.label);
      this.position++;
    }
    this.group = edit.group;
    this.lastEditTime = time;

    let characters = this.states.reduce((sum, state) => sum + state.text.length, 0);
    // Keep at least the latest undo even when a single pasted prompt is huge.
    while (this.states.length > 2 && (this.labels.length > this.limit || characters > this.maxCharacters)) {
      characters -= this.states.shift()!.text.length;
      this.labels.shift();
      this.position--;
    }
    return true;
  }

  undo(apply: (snapshot: PromptSnapshot) => boolean): boolean { return this.move(-1, apply); }
  redo(apply: (snapshot: PromptSnapshot) => boolean): boolean { return this.move(1, apply); }

  private move(direction: number, apply: (snapshot: PromptSnapshot) => boolean): boolean {
    this.breakGroup();
    const next = this.position + direction;
    if (next < 0 || next >= this.states.length) return false;
    // A UXP setter can fail. Only move the history cursor after a verified write.
    if (!apply({ ...this.states[next] })) return false;
    this.position = next;
    return true;
  }
}
