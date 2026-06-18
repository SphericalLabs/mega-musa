import { bytesToBase64 } from "./image-codec";

const { storage } = require("uxp");

export interface RefImage {
  name: string;
  mimeType: string;
  base64: string;
  dataUrl: string; // for the thumbnail <img>
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Opens a file picker (multi-select), reads each chosen image, and returns
// up to `maxCount` reference entries with inline base64 + a data URL preview.
export async function pickReferenceImages(maxCount: number): Promise<RefImage[]> {
  const fs = storage.localFileSystem;
  const picked = await fs.getFileForOpening({
    allowMultiple: true,
    types: ["png", "jpg", "jpeg", "webp"],
  });
  if (!picked) return [];
  const files = Array.isArray(picked) ? picked : [picked];

  const out: RefImage[] = [];
  for (const file of files.slice(0, maxCount)) {
    const buffer: ArrayBuffer = await file.read({ format: storage.formats.binary });
    const bytes = new Uint8Array(buffer);
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mimeType = EXT_MIME[ext] || "image/png";
    const base64 = bytesToBase64(bytes);
    out.push({
      name: file.name,
      mimeType,
      base64,
      dataUrl: `data:${mimeType};base64,${base64}`,
    });
  }
  return out;
}
