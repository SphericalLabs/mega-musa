/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { createProviderRegistry } from "./registry-core";
import { openai } from "./openai";
import { gemini } from "./gemini";

// New bundled providers need one import and one entry here.
export const providerRegistry = createProviderRegistry([gemini, openai]);
