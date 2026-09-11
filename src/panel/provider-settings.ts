/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { providerRegistry } from "../providers/registry";
import { loadProviderCredential, saveProviderCredential } from "../storage";
import { errorMessage } from "../errors";
import { $, setValueSafe } from "./controls";
import { setStatus } from "./status";

const fields = new Map<string, any>();
function key(provider: string, id: string) { return `${provider}.${id}`; }

export function providerCredentials(id: string): Readonly<Record<string, string>> {
  const provider = providerRegistry.provider(id);
  return Object.freeze(Object.fromEntries(provider.credentials.map((field) => [field.id,
    String((fields.get(key(id, field.id)) || $(field.fieldId || ""))?.value || "").trim(),
  ])));
}

export function missingCredential(id: string, values = providerCredentials(id)): string | null {
  return providerRegistry.provider(id).credentials.find((field) => field.required && !values[field.id])?.label || null;
}

export async function restoreProviderSettings(onSaved: () => void): Promise<void> {
  for (const provider of providerRegistry.providers) {
    for (const field of provider.credentials) {
      let input = fields.get(key(provider.id, field.id)) || $(field.fieldId || "");
      let button = $(field.buttonId || "");
      if (!input) {
        const container = $("providerCredentials");
        if (!container) continue;
        const wrapper = document.createElement("div");
        wrapper.className = "field";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = field.label;
        input = document.createElement("sp-textfield");
        input.setAttribute("type", field.secret ? "password" : "text");
        input.setAttribute("aria-label", field.label);
        button = document.createElement("sp-button");
        button.textContent = "Save";
        button.setAttribute("size", "s");
        wrapper.appendChild(label); wrapper.appendChild(input); wrapper.appendChild(button);
        container.appendChild(wrapper);
      }
      if (!fields.has(key(provider.id, field.id))) {
        fields.set(key(provider.id, field.id), input);
        button?.addEventListener("click", async () => {
          try {
            await saveProviderCredential(provider.id, field.id, field.secret, String(input.value || "").trim());
            onSaved();
            setStatus(`${field.label} saved${field.secret ? " securely" : ""}.`, "ok");
          } catch (error) { setStatus(`Could not save ${field.label}: ${errorMessage(error)}`, "error"); }
        });
      }
      setValueSafe(input, await loadProviderCredential(provider.id, field.id, field.secret));
    }
  }
}
