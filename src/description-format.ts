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

export function formatDescriptionParagraphs(description: string): string {
  return description
    .replace(/\r\n?/g, "\n")
    // Models can leave escaped newlines after JSON parsing. Decode only section
    // separators before aspect labels, preserving backslashes elsewhere.
    .replace(/(?:[ \t]*(?:\\+[rn]|\n))+[ \t]*(?=[A-Z][A-Z0-9 &/-]{2,}:)/g, "\n\n")
    .replace(/(^|[.!?]["')\]]?)\s+([A-Z][A-Z0-9 &/-]{2,}:)/g, (_match: string, boundary: string, label: string) =>
      boundary ? `${boundary}\n\n${label}` : label
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatDescriptions(inputs: { source: string }[], descriptions: string[]): string {
  const formatted = descriptions.map(formatDescriptionParagraphs);
  if (formatted.length === 1) return formatted[0];
  return formatted
    .map((description, index) => `Image ${index + 1} — ${inputs[index].source}\n${description}`)
    .join("\n\n");
}
