/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of Mega Musa.
 *
 * Mega Musa is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * Mega Musa is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Mega Musa. If not, see <https://www.gnu.org/licenses/>.
 */

// UXP's panel runtime does not define TextEncoder / TextDecoder, but fast-png
// (via iobuffer) constructs them at module load. Provide minimal UTF-8
// implementations before any consumer runs. This file is imported FIRST in
// main.ts so the globals exist before fast-png initializes.

const g: any = globalThis as any;

if (typeof g.TextEncoder === "undefined") {
  g.TextEncoder = class {
    readonly encoding = "utf-8";
    encode(input = ""): Uint8Array {
      const bytes: number[] = [];
      for (let i = 0; i < input.length; i++) {
        let code = input.charCodeAt(i);
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code >= 0xd800 && code <= 0xdbff) {
          const lo = input.charCodeAt(++i);
          code = 0x10000 + ((code & 0x3ff) << 10) + (lo & 0x3ff);
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f)
          );
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      return new Uint8Array(bytes);
    }
  };
}

if (typeof g.TextDecoder === "undefined") {
  g.TextDecoder = class {
    readonly encoding: string;
    constructor(label = "utf-8") {
      this.encoding = label;
    }
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const bytes =
        input instanceof Uint8Array
          ? input
          : new Uint8Array((input as ArrayBufferView).buffer ?? (input as ArrayBuffer));
      let out = "";
      for (let i = 0; i < bytes.length; ) {
        const c = bytes[i++];
        if (c < 0x80) {
          out += String.fromCharCode(c);
        } else if (c < 0xe0) {
          out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
        } else if (c < 0xf0) {
          out += String.fromCharCode(
            ((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
          );
        } else {
          const cp =
            ((c & 0x07) << 18) |
            ((bytes[i++] & 0x3f) << 12) |
            ((bytes[i++] & 0x3f) << 6) |
            (bytes[i++] & 0x3f);
          const off = cp - 0x10000;
          out += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
        }
      }
      return out;
    }
  };
}

export {};
