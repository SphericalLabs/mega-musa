// Lightweight persistence for panel settings. Keep ordinary UI preferences in
// localStorage, but keep the API key in UXP secureStorage.

const { storage } = require("uxp");

const PREFIX = "nbp.";
const KEY_API = PREFIX + "apiKey";
const KEY_OPENAI_API = PREFIX + "openaiApiKey";

function loadLegacyApiKey(): string {
  try {
    return localStorage.getItem(KEY_API) || "";
  } catch {
    return "";
  }
}

function clearLegacyApiKey(): void {
  try {
    localStorage.removeItem(KEY_API);
  } catch {
    /* ignore */
  }
}

function decodeSecureValue(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return new TextDecoder().decode(bytes);
}

export async function loadApiKey(): Promise<string> {
  try {
    const stored = await storage.secureStorage.getItem(KEY_API);
    const apiKey = decodeSecureValue(stored);
    if (apiKey) {
      clearLegacyApiKey();
      return apiKey;
    }
  } catch {
    /* missing secure item or unavailable storage */
  }

  const legacyKey = loadLegacyApiKey();
  if (!legacyKey) return "";

  await saveApiKey(legacyKey);
  return legacyKey;
}

export async function saveApiKey(value: string): Promise<void> {
  await saveSecureString(KEY_API, value);
  clearLegacyApiKey();
}

export async function loadOpenAIApiKey(): Promise<string> {
  return loadSecureString(KEY_OPENAI_API);
}

export async function saveOpenAIApiKey(value: string): Promise<void> {
  await saveSecureString(KEY_OPENAI_API, value);
}

async function loadSecureString(key: string): Promise<string> {
  try {
    const stored = await storage.secureStorage.getItem(key);
    return decodeSecureValue(stored);
  } catch {
    return "";
  }
}

async function saveSecureString(key: string, value: string): Promise<void> {
  if (!storage.secureStorage) {
    throw new Error("UXP secureStorage is not available in this Photoshop runtime.");
  }

  if (value) {
    await storage.secureStorage.setItem(key, value);
  } else {
    try {
      await storage.secureStorage.removeItem(key);
    } catch {
      /* ignore missing item */
    }
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
