const { app, action, core, imaging } = require("photoshop");

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PixelRegion {
  data: Uint8Array;
  width: number;
  height: number;
  components: number;
}

// Temporary alpha channel used to carry the (possibly non-rectangular, feathered)
// selection from the read step to the masking step.
const TMP_CHANNEL = "nbp_tmp_sel";

export function getActiveDoc(): any {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document in Photoshop first.");
  return doc;
}

// Returns the bounding box of the current selection, or null if nothing is
// selected. Works for any selection shape (returns its bounds).
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
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  const px = Math.round(w * padFrac);
  const py = Math.round(h * padFrac);
  return {
    left: Math.max(0, b.left - px),
    top: Math.max(0, b.top - py),
    right: Math.min(docW, b.right + px),
    bottom: Math.min(docH, b.bottom + py),
  };
}

// Modal step 1: optionally save the selection to a temp channel, then read the
// pixels inside `bounds` (flattened composite). Kept short so Photoshop's UI is
// only blocked briefly — the long network call happens outside this scope.
export async function readRegion(
  docId: number,
  bounds: Bounds,
  saveSelection: boolean
): Promise<PixelRegion> {
  return await core.executeAsModal(
    async () => {
      if (saveSelection) {
        await action.batchPlay(
          [
            {
              _obj: "duplicate",
              _target: [{ _ref: "channel", _property: "selection" }],
              name: TMP_CHANNEL,
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          {}
        );
      }
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
      return {
        data,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
        components,
      };
    },
    { commandName: "Nano Banana Pro: read region" }
  );
}

// Modal step 2: create a new layer, write the edited RGBA into `bounds`, and —
// for region edits — mask it to the saved selection so only the selected area
// changes (with the selection's feather giving a soft composite).
export async function placeResult(
  docId: number,
  bounds: Bounds,
  rgba: Uint8Array,
  width: number,
  height: number,
  layerName: string,
  useSelectionMask: boolean
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

      if (useSelectionMask) {
        await action.batchPlay(
          [
            {
              _obj: "set",
              _target: [{ _ref: "channel", _property: "selection" }],
              to: { _ref: "channel", _name: TMP_CHANNEL },
              _options: { dialogOptions: "dontDisplay" },
            },
            {
              _obj: "make",
              _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
              using: { _enum: "userMaskEnabled", _value: "revealSelection" },
              _options: { dialogOptions: "dontDisplay" },
            },
            {
              _obj: "delete",
              _target: [{ _ref: "channel", _name: TMP_CHANNEL }],
              _options: { dialogOptions: "dontDisplay" },
            },
            {
              _obj: "set",
              _target: [{ _ref: "channel", _property: "selection" }],
              to: { _enum: "ordinal", _value: "none" },
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
