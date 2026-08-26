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

// Minimal ambient typings for the UXP runtime modules we use. These are
// provided by Photoshop at load time (kept `external` in the bundle), so we
// only declare the surface this plugin touches. Loosely typed on purpose.

interface PhotoshopImageData {
  components: number;
  width: number;
  height: number;
  getData(options?: { chunky?: boolean }): Promise<Uint8Array>;
  dispose(): void;
}

interface PhotoshopSelectionData {
  imageData: PhotoshopImageData;
  sourceBounds?: any;
}

interface PhotoshopModule {
  app: any;
  action: {
    batchPlay(commands: any[], options?: any): Promise<any[]>;
    addNotificationListener(events: string[], callback: (eventName: string, descriptor: any) => void): Promise<void>;
  };
  core: {
    executeAsModal(
      fn: (executionContext: any) => Promise<any>,
      options?: { commandName?: string; interactive?: boolean }
    ): Promise<any>;
  };
  imaging: {
    getPixels(options: any): Promise<{ imageData: PhotoshopImageData }>;
    getSelection(options: any): Promise<PhotoshopSelectionData>;
    putPixels(options: any): Promise<void>;
    createImageDataFromBuffer(buffer: Uint8Array, options: any): Promise<PhotoshopImageData>;
  };
}

interface UxpModule {
  storage: {
    localFileSystem: {
      getFileForOpening(options?: {
        allowMultiple?: boolean;
        types?: string[];
      }): Promise<any>;
    };
    secureStorage: {
      getItem(key: string): Promise<Uint8Array>;
      setItem(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void>;
      removeItem(key: string): Promise<void>;
    };
    formats: { binary: any; utf8: any };
  };
  entrypoints: {
    setup(definition: any): void;
  };
}

declare function require(module: "photoshop"): PhotoshopModule;
declare function require(module: "uxp"): UxpModule;
