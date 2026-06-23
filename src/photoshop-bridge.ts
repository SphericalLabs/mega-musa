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

// Activate the Rectangular Marquee tool and set its Style to Fixed Ratio at
// width:height (or Normal when null), so the user drags selections already
// matching a supported output ratio. NOTE: the marquee-style tokens below are
// best-effort; if Photoshop rejects them the panel surfaces the error and they
// can be corrected in one place.
// Replace the current selection with an exact rectangle (document pixels).
// Used to snap a freely-drawn selection to a chosen aspect ratio.
export async function setRectSelection(b: Bounds): Promise<void> {
  await core.executeAsModal(
    async () => {
      await action.batchPlay(
        [
          {
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
              _obj: "rectangle",
              top: { _unit: "pixelsUnit", _value: b.top },
              left: { _unit: "pixelsUnit", _value: b.left },
              bottom: { _unit: "pixelsUnit", _value: b.bottom },
              right: { _unit: "pixelsUnit", _value: b.right },
            },
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
    },
    { commandName: "Nano Banana Pro: snap selection" }
  );
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

// Reshape `b` to exactly `targetRatio` (width / height), expanding within the
// document when possible (so the whole selection stays covered) and shrinking
// only if expansion would overflow the canvas. Stays centred on `b`. Used so the
// crop's ratio equals the model's output ratio — then cover-fit adds no trim.
export function fitRegionToRatio(b: Bounds, targetRatio: number, docW: number, docH: number): Bounds {
  let w = b.right - b.left;
  let h = b.bottom - b.top;
  if (w < 1 || h < 1) return b;
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  if (w / h < targetRatio) {
    const newW = Math.round(h * targetRatio);
    if (newW <= docW) w = newW;
    else {
      w = docW;
      h = Math.round(docW / targetRatio);
    }
  } else {
    const newH = Math.round(w / targetRatio);
    if (newH <= docH) h = newH;
    else {
      h = docH;
      w = Math.round(docH * targetRatio);
    }
  }
  let left = Math.round(cx - w / 2);
  let top = Math.round(cy - h / 2);
  left = Math.max(0, Math.min(left, docW - w));
  top = Math.max(0, Math.min(top, docH - h));
  return { left, top, right: left + w, bottom: top + h };
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

// Modal step 2: create a new layer, write the edited RGBA into `bounds`, and (for
// region edits) add a layer mask that reveals the live selection — so Photoshop
// itself clips the result to the exact selection shape, feather and all.
export async function placeResult(
  docId: number,
  bounds: Bounds,
  rgba: Uint8Array,
  width: number,
  height: number,
  layerName: string,
  maskToSelection: boolean
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

      // Clip to the selection with a real layer mask. The user's selection is
      // still live (we never altered it), so "reveal selection" reproduces any
      // lasso / ellipse / feather exactly, rendered by Photoshop.
      if (maskToSelection) {
        await action.batchPlay(
          [
            {
              _obj: "make",
              new: { _class: "channel" },
              at: { _ref: "channel", _enum: "channel", _value: "mask" },
              using: { _enum: "userMaskEnabled", _value: "revealSelection" },
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          {}
        );
      }
    },
    { commandName: "Nano Banana Pro: place result" }
  );
}

// Resample `rgba` (srcW x srcH, RGBA) to dstW x dstH using Photoshop's own Image
// Size engine, via a throwaway document: Bicubic Sharper for reductions, Bicubic
// Smoother for enlargements — far better than a hand-rolled bilinear pass. The
// scratch doc is always closed without saving. Throws on any failure so the
// caller can fall back to a JS resampler.
export async function scaleViaPhotoshop(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Promise<Uint8Array> {
  const scratch = await app.createDocument({
    width: srcW,
    height: srcH,
    resolution: 72,
    fill: "transparent",
    name: "nbp-scale",
  });
  if (!scratch) throw new Error("Could not create scratch document for scaling.");
  try {
    let out: Uint8Array | undefined;
    await core.executeAsModal(
      async () => {
        const layerId = scratch.layers[0].id;
        const srcData = await imaging.createImageDataFromBuffer(rgba, {
          width: srcW,
          height: srcH,
          components: 4,
          componentSize: 8,
          colorSpace: "RGB",
          chunky: true,
        });
        await imaging.putPixels({
          documentID: scratch.id,
          layerID: layerId,
          targetBounds: { left: 0, top: 0, right: srcW, bottom: srcH },
          imageData: srcData,
        });
        srcData.dispose();

        // Reductions -> Bicubic Sharper, enlargements -> Bicubic Smoother.
        const method =
          dstW * dstH < srcW * srcH
            ? "bicubicSharper"
            : dstW * dstH > srcW * srcH
              ? "bicubicSmoother"
              : "bicubic";
        await action.batchPlay(
          [
            {
              _obj: "imageSize",
              width: { _unit: "pixelsUnit", _value: dstW },
              height: { _unit: "pixelsUnit", _value: dstH },
              constrainProportions: false,
              interpolation: { _enum: "interpolationType", _value: method },
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          {}
        );

        const { imageData } = await imaging.getPixels({
          documentID: scratch.id,
          sourceBounds: { left: 0, top: 0, right: dstW, bottom: dstH },
          componentSize: 8,
          applyAlpha: false,
        });
        const raw = await imageData.getData({ chunky: true });
        const comps = imageData.components || 4;
        imageData.dispose();

        if (comps === 4) {
          out = new Uint8Array(raw);
        } else {
          // Expand to RGBA with opaque alpha (alpha is reapplied by the mask step).
          const px = dstW * dstH;
          const rgbaOut = new Uint8Array(px * 4);
          for (let i = 0; i < px; i++) {
            rgbaOut[i * 4] = raw[i * comps];
            rgbaOut[i * 4 + 1] = raw[i * comps + 1];
            rgbaOut[i * 4 + 2] = raw[i * comps + 2];
            rgbaOut[i * 4 + 3] = 255;
          }
          out = rgbaOut;
        }
      },
      { commandName: "Nano Banana Pro: scale result" }
    );
    if (!out) throw new Error("Scaling produced no pixels.");
    return out;
  } finally {
    try {
      await scratch.closeWithoutSaving();
    } catch {
      /* ignore close failures */
    }
  }
}
