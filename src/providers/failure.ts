/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Adapters can report a confirmed remote cancellation or a known charge even
// when no usable image was returned. Unknown cost must remain undefined.
export class ProviderFailure extends Error {
  constructor(message: string, readonly outcome: { canceled?: boolean; costUSD?: number } = {}) {
    super(message);
    this.name = "ProviderFailure";
  }
}
