/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { type ModelOptions, type ModelSpec } from "../models/types";
import { $, clearChildren, isChecked, setCheckedSafe, setValueSafe } from "./controls";

// Each controller owns its fields. Values are serializable primitives only.
export function createModelOptions() {
  const controls = new Map<string, any>();
  let current: ModelSpec | undefined;
  function read(): ModelOptions {
    return Object.fromEntries((current?.settings || []).map((field) => {
      const input = controls.get(field.key);
      const value = field.type === "boolean" ? isChecked(input)
        : field.type === "number" ? (String(input?.value).trim() ? Number(input.value) : NaN)
        : String(input?.value ?? field.default);
      return [field.key, value];
    }));
  }
  function render(spec: ModelSpec, options: ModelOptions, onChange: () => void) {
    current = spec;
    controls.clear();
    const container = $("modelOptions");
    if (!container) return;
    clearChildren(container);
    for (const field of spec.settings || []) {
      const wrapper = document.createElement("div");
      wrapper.className = "field";
      const label = document.createElement("span");
      label.className = "label"; label.textContent = field.label;
      const input: any = document.createElement(field.type === "boolean" ? "sp-checkbox" : field.type === "select" ? "sp-picker" : "sp-textfield");
      input.setAttribute("aria-label", field.label);
      if (field.type === "select") {
        const menu = document.createElement("sp-menu");
        menu.setAttribute("slot", "options");
        for (const option of field.options) {
          const item = document.createElement("sp-menu-item");
          item.setAttribute("value", option.value); item.textContent = option.label;
          if (option.value === options[field.key]) item.setAttribute("selected", "");
          menu.appendChild(item);
        }
        input.appendChild(menu);
      }
      if (field.type === "boolean") setCheckedSafe(input, Boolean(options[field.key]));
      else setValueSafe(input, String(options[field.key] ?? field.default));
      input.addEventListener("change", onChange);
      wrapper.appendChild(label); wrapper.appendChild(input); container.appendChild(wrapper);
      controls.set(field.key, input);
    }
  }
  return { read, render };
}
