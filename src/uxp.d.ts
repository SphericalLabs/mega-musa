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

interface PhotoshopModule {
  app: any;
  action: {
    batchPlay(commands: any[], options?: any): Promise<any[]>;
  };
  core: {
    executeAsModal(
      fn: (executionContext: any) => Promise<any>,
      options?: { commandName?: string; interactive?: boolean }
    ): Promise<any>;
  };
  imaging: {
    getPixels(options: any): Promise<{ imageData: PhotoshopImageData }>;
    getSelection(options: any): Promise<{ imageData: PhotoshopImageData }>;
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
