/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export function $(id: string): any {
  return document.getElementById(id);
}

export function clearChildren(el: any): void {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

// Some Spectrum value setters throw; fall back to the attribute during restore.
export function setValueSafe(el: any, v: string): void {
  if (!el) return;
  try {
    el.value = v;
    return;
  } catch {
    /* getter-only property */
  }
  try {
    el.setAttribute("value", v);
  } catch {
  }
}

// Fall back to the checked attribute; missing or unreadable controls default to on.
export function isChecked(el: any): boolean {
  if (!el) return true;
  if (typeof el.checked === "boolean") return el.checked;
  try {
    return el.hasAttribute("checked");
  } catch {
    return true;
  }
}

export function setCheckedSafe(el: any, on: boolean): void {
  if (!el) return;
  try {
    el.checked = on;
  } catch {
    /* getter-only property */
  }
  try {
    if (on) el.setAttribute("checked", "");
    else el.removeAttribute("checked");
  } catch {
  }
}

export function buildMenu(pickerId: string, options: { value: string; label: string }[], selected: string): void {
  const picker = $(pickerId);
  const menu = picker?.querySelector("sp-menu");
  if (!menu) return;
  clearChildren(menu);
  for (const opt of options) {
    const item = document.createElement("sp-menu-item");
    item.setAttribute("value", opt.value);
    item.textContent = opt.label;
    if (opt.value === selected) item.setAttribute("selected", "");
    menu.appendChild(item);
  }
  setValueSafe(picker, selected);
}

export function hasOption(picker: any, v: string): boolean {
  if (!picker) return false;
  try {
    const items: any[] = Array.from(picker.querySelectorAll("sp-menu-item"));
    return items.some((item) => item.getAttribute("value") === v);
  } catch {
    return false;
  }
}

export function setPickerSafe(picker: any, v: string): void {
  if (!picker) return;
  setValueSafe(picker, v);
  try {
    picker.querySelectorAll("sp-menu-item").forEach((item: any) => {
      if (item.getAttribute("value") === v) item.setAttribute("selected", "");
      else item.removeAttribute("selected");
    });
  } catch {
  }
}
