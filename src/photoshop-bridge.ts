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

export interface DocumentRead {
  image: ImageBuffer;
  // Whole-document selection coverage (0..255), docW×docH, present for region
  // edits. Used to set the result layer's alpha so the edit clips to the selection.
  mask?: Uint8Array;
}

export function getActiveDoc(): any {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document in Photoshop first.");
  return doc;
}

// Returns the bounding box of the current selection, or null if nothing is
// selected. Used only to decide whether this is a region (masked) edit.
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

// Modal step 1: read the whole flattened document, and (for region edits) the
// whole-document selection mask. Both are docW×docH so they align exactly.
export async function readDocument(
  docId: number,
  docW: number,
  docH: number,
  withMask: boolean
): Promise<DocumentRead> {
  const bounds: Bounds = { left: 0, top: 0, right: docW, bottom: docH };
  return await core.executeAsModal(
    async () => {
      const { imageData } = await imaging.getPixels({
        documentID: docId,
        sourceBounds: bounds,
        componentSize: 8,
        applyAlpha: false,
      });
      const raw = await imageData.getData({ chunky: true });
      const data = new Uint8Array(raw); // copy out before disposing the source
      const components = imageData.components || 4;
      imageData.dispose();

      let mask: Uint8Array | undefined;
      if (withMask) {
        try {
          const sel = await imaging.getSelection({ documentID: docId, sourceBounds: bounds });
          const sw = sel.imageData.width;
          const sh = sel.imageData.height;
          const sc = sel.imageData.components || 1;
          const mraw = await sel.imageData.getData({ chunky: true });
          let gray: Uint8Array;
          if (sc === 1) {
            gray = new Uint8Array(mraw);
          } else {
            gray = new Uint8Array(sw * sh);
            for (let i = 0; i < sw * sh; i++) gray[i] = mraw[i * sc];
          }
          sel.imageData.dispose();
          // Normalize to document dimensions (safety net if dims ever differ).
          mask = sw === docW && sh === docH ? gray : resampleGray(gray, sw, sh, docW, docH);
        } catch {
          // If the selection can't be read, fall back to an unmasked full-image edit.
          mask = undefined;
        }
      }

      return { image: { data, width: docW, height: docH, components }, mask };
    },
    { commandName: "Nano Banana Pro: read" }
  );
}

// Modal step 2: create a new layer and write the edited RGBA over the whole
// document. The alpha of `rgba` already encodes the selection (applyAlphaMask),
// so the layer is simply transparent where unselected — no layer mask needed.
export async function placeResult(
  docId: number,
  docW: number,
  docH: number,
  rgba: Uint8Array,
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
        width: docW,
        height: docH,
        components: 4,
        componentSize: 8,
        colorSpace: "RGB",
        chunky: true,
      });
      await imaging.putPixels({
        documentID: docId,
        layerID: layerId,
        targetBounds: { left: 0, top: 0, right: docW, bottom: docH },
        imageData,
      });
      imageData.dispose();
    },
    { commandName: "Nano Banana Pro: place result" }
  );
}
