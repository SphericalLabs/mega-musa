declare module "jpeg-js" {
  export function decode(
    data: Uint8Array | ArrayBuffer,
    opts?: {
      useTArray?: boolean;
      formatAsRGBA?: boolean;
      tolerantDecoding?: boolean;
      maxResolutionInMP?: number;
      maxMemoryUsageInMB?: number;
    }
  ): { width: number; height: number; data: Uint8Array };
  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number
  ): { data: Uint8Array; width: number; height: number };
}
