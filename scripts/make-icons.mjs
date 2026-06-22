import { encode } from "fast-png";
import { mkdirSync, writeFileSync } from "fs";

// Generates simple placeholder panel icons so the plugin loads with a complete
// manifest. Replace public/icons/*.png with real artwork any time.
function makeIcon(size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = 0xf2;     // banana yellow
      data[i + 1] = 0xc4;
      data[i + 2] = 0x3d;
      data[i + 3] = 255;
    }
  }
  // A darker diagonal sweep so the icon reads as a shape, not a flat square.
  const thickness = Math.max(1, Math.round(size * 0.1));
  for (let y = 0; y < size; y++) {
    const base = Math.round(y * 0.55);
    for (let k = 0; k < thickness; k++) {
      const x = Math.min(size - 1, base + k);
      const i = (y * size + x) * 4;
      data[i] = 0x6b;
      data[i + 1] = 0x4a;
      data[i + 2] = 0x12;
    }
  }
  return encode({ width: size, height: size, data, channels: 4, depth: 8 });
}

mkdirSync("public/icons", { recursive: true });
// UXP scale convention: base name = 1x, "@2x" suffix = 2x.
writeFileSync("public/icons/icon.png", makeIcon(24));
writeFileSync("public/icons/icon@2x.png", makeIcon(48));
writeFileSync("public/icons/dark.png", makeIcon(32));
writeFileSync("public/icons/dark@2x.png", makeIcon(64));
writeFileSync("public/icons/light.png", makeIcon(32));
writeFileSync("public/icons/light@2x.png", makeIcon(64));
console.log("icons -> public/icons/");
