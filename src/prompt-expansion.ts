/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

export const MAX_PROMPT_EXPANSIONS = 10;

export class PromptExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptExpansionError";
  }
}

interface TextNode {
  kind: "text";
  value: string;
}

interface GroupNode {
  kind: "group";
  alternatives: Sequence[];
  multiplier: number;
}

type PromptNode = TextNode | GroupNode;

interface Sequence {
  nodes: PromptNode[];
}

const ESCAPABLE = new Set(["{", "}", ",", "\\"]);

class PromptParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): Sequence {
    const sequence = this.parseSequence(false);
    if (this.index !== this.input.length) {
      throw this.error(`Unexpected “${this.input[this.index]}”`, this.index);
    }
    return sequence;
  }

  private parseSequence(inGroup: boolean): Sequence {
    const nodes: PromptNode[] = [];
    let text = "";
    const flushText = () => {
      if (!text) return;
      nodes.push({ kind: "text", value: text });
      text = "";
    };

    while (this.index < this.input.length) {
      const char = this.input[this.index];
      if (char === "\\") {
        const next = this.input[this.index + 1];
        if (next && ESCAPABLE.has(next)) {
          text += next;
          this.index += 2;
        } else {
          text += char;
          this.index += 1;
        }
        continue;
      }
      if (char === "{") {
        flushText();
        nodes.push(this.parseGroup());
        continue;
      }
      if (char === "}") {
        if (inGroup) break;
        throw this.error("Closing brace has no matching opening brace", this.index);
      }
      if (char === "," && inGroup) break;
      text += char;
      this.index += 1;
    }
    flushText();
    return { nodes };
  }

  private parseGroup(): GroupNode {
    const openingIndex = this.index;
    this.index += 1;
    const parts: Sequence[] = [];

    while (true) {
      if (this.index >= this.input.length) {
        throw this.error("Opening brace has no matching closing brace", openingIndex);
      }
      const part = trimSequence(this.parseSequence(true));
      if (sequenceIsBlank(part)) {
        throw this.error("Brace groups cannot contain an empty alternative", this.index);
      }
      parts.push(part);

      const delimiter = this.input[this.index];
      if (delimiter === ",") {
        this.index += 1;
        continue;
      }
      if (delimiter === "}") {
        this.index += 1;
        break;
      }
      throw this.error("Opening brace has no matching closing brace", openingIndex);
    }

    if (parts.length < 2) {
      throw this.error("A brace group needs alternatives or a multiplier separated by a comma", openingIndex);
    }

    const finalLiteral = sequenceLiteral(parts[parts.length - 1]);
    const finalToken = finalLiteral?.trim() ?? null;
    let multiplier = 1;
    let alternatives = parts;
    if (finalToken !== null && /^\d+$/.test(finalToken)) {
      multiplier = Number(finalToken);
      if (!Number.isSafeInteger(multiplier) || multiplier < 1) {
        throw this.error("A multiplier must be a positive integer", openingIndex);
      }
      alternatives = parts.slice(0, -1);
    } else if (finalToken !== null && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(finalToken)) {
      throw this.error("A multiplier must be a positive integer", openingIndex);
    }

    return { kind: "group", alternatives, multiplier };
  }

  private error(message: string, index: number): PromptExpansionError {
    return new PromptExpansionError(`${message} at character ${index + 1}.`);
  }
}

function trimSequence(sequence: Sequence): Sequence {
  const nodes = sequence.nodes.slice();
  if (nodes[0]?.kind === "text") nodes[0] = { kind: "text", value: nodes[0].value.replace(/^\s+/, "") };
  const last = nodes.length - 1;
  if (nodes[last]?.kind === "text") {
    nodes[last] = { kind: "text", value: nodes[last].value.replace(/\s+$/, "") };
  }
  return { nodes: nodes.filter((node) => node.kind !== "text" || node.value.length > 0) };
}

function sequenceLiteral(sequence: Sequence): string | null {
  let value = "";
  for (const node of sequence.nodes) {
    if (node.kind !== "text") return null;
    value += node.value;
  }
  return value;
}

function sequenceIsBlank(sequence: Sequence): boolean {
  const literal = sequenceLiteral(sequence);
  return literal !== null && literal.trim().length === 0;
}

function expansionLimitError(limit: number): PromptExpansionError {
  return new PromptExpansionError(
    `This prompt expands to more than ${limit} images. Simplify the alternatives or reduce the multiplier.`
  );
}

function pushWithinLimit(target: string[], value: string, limit: number): void {
  if (target.length >= limit) throw expansionLimitError(limit);
  target.push(value);
}

function expandSequence(sequence: Sequence, limit: number): string[] {
  let results = [""];
  for (const node of sequence.nodes) {
    const variants = node.kind === "text" ? [node.value] : expandGroup(node, limit);
    const next: string[] = [];
    for (const prefix of results) {
      for (const variant of variants) pushWithinLimit(next, prefix + variant, limit);
    }
    results = next;
  }
  return results;
}

function expandGroup(group: GroupNode, limit: number): string[] {
  const results: string[] = [];
  for (const alternative of group.alternatives) {
    const expanded = expandSequence(alternative, limit);
    for (const prompt of expanded) {
      for (let repetition = 0; repetition < group.multiplier; repetition += 1) {
        pushWithinLimit(results, prompt, limit);
      }
    }
  }
  return results;
}

export function expandPromptTemplate(
  prompt: string,
  limit: number = MAX_PROMPT_EXPANSIONS
): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new PromptExpansionError("The prompt expansion limit must be a positive integer.");
  }
  return expandSequence(new PromptParser(prompt).parse(), limit);
}
