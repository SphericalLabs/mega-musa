import { resampleGray } from "./image-codec";

const { app, action, core, imaging } = require("photoshop");

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ImageBuffer {
  data: Uint8Array;
  width: number;
  height: number;
  components: number;
}

export interface RegionRead {
  image: ImageBuffer;
  // Selection coverage (0..255) sized to the crop, present for region edits.
  mask?: Uint8Array;
  // Human-readable diagnostics about what was actually read (dims, sel bounds).
  debug: string;
}

export function getActiveDoc(): any {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document in Photoshop first.");
  return doc;
}

export async function getSelectionBounds(): Promise<Bounds | null> {
  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
  const sel = result?.[0]?.selection;
  if (!sel) return null;
  const v = (u: any) => (typeof u === "number" ? u : u?._value ?? 0);
  return {
    left: Math.round(v(sel.left)),
    top: Math.round(v(sel.top)),
    right: Math.round(v(sel.right)),
    bottom: Math.round(v(sel.bottom)),
  };
}

export function padBounds(b: Bounds, padFrac: number, docW: number, docH: number): Bounds {
  const px = Math.round((b.right - b.left) * padFrac);
  const py = Math.round((b.bottom - b.top) * padFrac);
  return {
    left: Math.max(0, b.left - px),
    top: Math.max(0, b.top - py),
    right: Math.min(docW, b.right + px),
    bottom: Math.min(docH, b.bottom + py),
  };
}

function boundVal(u: any): number {
  return typeof u === "number" ? u : u?._value ?? 0;
}

// Modal step 1: read the flattened pixels inside `bounds`, plus (for region
// edits) the selection coverage mask, resampled and positioned to line up with
// the crop exactly — using getSelection's own returned sourceBounds.
export async function readRegion(
  docId: number,
  bounds: Bounds,
  withMask: boolean
): Promise<RegionRead> {
  const cropW = bounds.right - bounds.left;
  const cropH = bounds.bottom - bounds.top;
  return await core.executeAsModal(
    async () => {
      const { imageData } = await imaging.getPixels({
        documentID: docId,
        sourceBounds: bounds,
        componentSize: 8,
        applyAlpha: false,
      });
      const raw = await imageData.getData({ chunky: true });
      const data = new Uint8Array(raw);
      const components = imageData.components || 4;
      imageData.dispose();

      let debug = `crop ${cropW}x${cropH} c${components}`;
      let mask: Uint8Array | undefined;

      if (withMask) {
        try {
          const sel = await imaging.getSelection({ documentID: docId, sourceBounds: bounds });
          const mw = sel.imageData.width;
          const mh = sel.imageData.height;
          const mc = sel.imageData.components || 1;
          const mraw = await sel.imageData.getData({ chunky: true });
          let gray: Uint8Array;
          if (mc === 1) {
            gray = new Uint8Array(mraw);
          } else {
            gray = new Uint8Array(mw * mh);
            for (let i = 0; i < mw * mh; i++) gray[i] = mraw[i * mc];
          }
          sel.imageData.dispose();

          // Region the returned mask actually covers, in document pixels.
          const sb = (sel as any).sourceBounds;
          const sbL = sb ? boundVal(sb.left) : bounds.left;
          const sbT = sb ? boundVal(sb.top) : bounds.top;
          const sbR = sb ? boundVal(sb.right) : bounds.right;
          const sbB = sb ? boundVal(sb.bottom) : bounds.bottom;
          const regW = Math.max(1, sbR - sbL);
          const regH = Math.max(1, sbB - sbT);

          // Resample the mask to its region's pixel size, then drop it into a
          // crop-sized buffer at the right offset (unselected stays 0).
          const regMask = mw === regW && mh === regH ? gray : resampleGray(gray, mw, mh, regW, regH);
          mask = new Uint8Array(cropW * cropH);
          const offX = sbL - bounds.left;
          const offY = sbT - bounds.top;
          for (let y = 0; y < regH; y++) {
            const ty = y + offY;
            if (ty < 0 || ty >= cropH) continue;
            for (let x = 0; x < regW; x++) {
              const tx = x + offX;
              if (tx < 0 || tx >= cropW) continue;
              mask[ty * cropW + tx] = regMask[y * regW + x];
            }
          }

          let covered = 0;
          for (let i = 0; i < mask.length; i++) if (mask[i] > 127) covered++;
          const pct = Math.round((100 * covered) / mask.length);
          debug += ` | sel raw ${mw}x${mh} sb[${sbL},${sbT},${sbR},${sbB}] cover ${pct}%`;
        } catch (e: any) {
          mask = undefined;
          debug += ` | getSelection FAILED: ${e?.message || e}`;
        }
      }

      return { image: { data, width: cropW, height: cropH, components }, mask, debug };
    },
    { commandName: "Nano Banana Pro: read region" }
  );
}

// Modal step 2: create a new layer and write the edited RGBA into `bounds`.
// Alpha already encodes the selection, so no layer mask is needed.
export async function placeResult(
  docId: number,
  bounds: Bounds,
  rgba: Uint8Array,
  width: number,
  height: number,
  layerName: string
): Promise<void> {
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [{ _obj: "make", _target: [{ _ref: "layer" }], _options: { dialogOptions: "dontDisplay" } }],
        {}
      );
      const layerId = app.activeDocument.activeLayers[0].id;

      await action.batchPlay(
        [
          {
            _obj: "set",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            to: { _obj: "layer", name: layerName },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );

      const imageData = await imaging.createImageDataFromBuffer(rgba, {
        width,
        height,
        components: 4,
        componentSize: 8,
        colorSpace: "RGB",
        chunky: true,
      });
      await imaging.putPixels({
        documentID: docId,
        layerID: layerId,
        targetBounds: bounds,
        imageData,
      });
      imageData.dispose();
    },
    { commandName: "Nano Banana Pro: place result" }
  );
}
