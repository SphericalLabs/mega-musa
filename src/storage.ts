// Lightweight persistence via the panel's localStorage (per-plugin, persistent).
// The API key is the student's own key on their own machine, so local storage
// is acceptable here; do not reuse this pattern for a shared/server key.

const PREFIX = "nbp.";
const KEY_API = PREFIX + "apiKey";

export function loadApiKey(): string {
  try {
    return localStorage.getItem(KEY_API) || "";
  } catch {
    return "";
  }
}

export function saveApiKey(value: string): void {
  try {
    localStorage.setItem(KEY_API, value);
  } catch {
    /* ignore */
  }
}

export function loadSetting(name: string, fallback: string): string {
  try {
    const v = localStorage.getItem(PREFIX + name);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function saveSetting(name: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + name, value);
  } catch {
    /* ignore */
  }
}
