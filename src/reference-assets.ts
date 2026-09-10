/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Compatibility exports for existing plugin modules and integrations.
export { archiveReferenceAssetsInActiveDocument } from "./references/archive";
export type { ArchivedReferenceResult } from "./references/archive";
export { REFERENCE_ASSET_GROUP_NAME } from "./references/asset-pool";
export { hashReferenceBytes } from "./references/hash";
export { restoreReferenceAssets } from "./references/restore";
export type { RestoredReferenceResult } from "./references/restore";
