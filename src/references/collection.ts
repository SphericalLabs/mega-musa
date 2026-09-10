/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type RefImage } from "../references";

export const MAX_REFS = 10;

export class ReferenceCollection {
  private images: RefImage[] = [];

  get length(): number { return this.images.length; }
  snapshot(): RefImage[] { return this.images.slice(); }
  replace(images: RefImage[]): void { this.images = images.slice(0, MAX_REFS); }
  add(...images: RefImage[]): void { this.replace(this.images.concat(images)); }
  remove(index: number): void { this.images.splice(index, 1); }
  clear(): void { this.images = []; }
}
