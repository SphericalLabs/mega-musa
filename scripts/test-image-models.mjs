import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInThisContext } from "node:vm";

const bundle = await build({
  stdin: {
    contents: 'export * from "./src/models"; export { generateOpenAIImage } from "./src/openai";',
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", write: false, external: ["uxp"],
});
const module = { exports: {} };
runInThisContext(`(function(module,exports,require){${bundle.outputFiles[0].text}\n})`)(module, module.exports, (name) => {
  if (name === "uxp") return { storage: {} };
  throw new Error(`Unexpected module: ${name}`);
});
const { modelSpec, estimatedUSD, actualUsageUSD, outputFrame, generateOpenAIImage } = module.exports;
const expected = { low: 0.00588, medium: 0.01317, high: 0.05268, xhigh: 0.09366, max: 0.21072 };
for (const name of ["sunburst", "flare"]) {
  const spec = modelSpec(`openai:gpt-image-2.5-${name}`);
  assert.equal(outputFrame(spec, "2K", 1000, 1000).openaiSize, "2048x2048");
  assert.equal(outputFrame(spec, "4K", 1600, 900).openaiSize, "3840x2160");
  for (const [quality, usd] of Object.entries(expected)) {
    assert.ok(Math.abs(estimatedUSD(spec, "1K", "1024x1024", quality) - usd) < 1e-10);
  }
  assert.ok(Math.abs(actualUsageUSD(spec, {
    inputTextTokens: 1000, inputImageTokens: 2000, outputTokens: 3000,
  }) - 0.111) < 1e-10);

  for (const editing of [false, true]) {
    globalThis.fetch = async (url, init) => {
      assert.ok(url.endsWith(editing ? "/edits" : "/generations"));
      if (editing) {
        const body = new TextDecoder().decode(init.body);
        assert.ok(body.includes(`gpt-image-2.5-${name}`));
        assert.ok(body.includes('\r\n\r\nmax\r\n'));
        assert.ok(body.includes('name="image[]"'));
      } else {
        const body = JSON.parse(init.body);
        assert.equal(body.model, `gpt-image-2.5-${name}`);
        assert.equal(body.quality, "max");
        assert.equal(body.size, "2048x2048");
      }
      return { ok: true, json: async () => ({
        data: [{ b64_json: "AQID" }], quality: "max",
        usage: { input_tokens: 1, output_tokens: 2 },
      }) };
    };
    const result = await generateOpenAIImage({
      apiKey: "test", model: spec.id, prompt: "test", references: [],
      size: "2048x2048", quality: "max",
      ...(editing ? { baseImagePng: new Uint8Array([1, 2, 3]) } : {}),
    });
    assert.equal(result.usage.quality, "max");
    assert.deepEqual([...result.bytes], [1, 2, 3]);
  }
}
const legacy = modelSpec("openai:gpt-image-2");
assert.equal(legacy.outputQualityFactors.max, undefined);
assert.ok(Math.abs(estimatedUSD(legacy, "1K", "1024x1024", "high") - 0.21072) < 1e-10);
console.log("Image models: pricing, sizes, generation and edit requests passed.");

const { estimatedTotalUSD, resolutionMenuLabel } = module.exports;
const sunburst = modelSpec("openai:gpt-image-2.5-sunburst");
const output = estimatedUSD(sunburst, "2K", "2048x2048", "low");
assert.ok(Math.abs(estimatedTotalUSD(sunburst, "2K", "2048x2048", "low") - output - 0.01) < 1e-10);
// The estimate has one fixed overhead; input image count is not a pricing argument.
assert.equal(resolutionMenuLabel("2K", sunburst, "1:1", "low"), "2K / USD 0.02");
assert.equal(estimatedTotalUSD({ id: "unknown", imageSizes: [], aspectRatios: [] }, "auto", undefined, "auto"), null);
console.log("Input allowance and estimated total tests passed.");

// Removing pricing data must not change a model's output geometry or controls.
const withoutPrices = { ...sunburst, outputQualityFactors: undefined };
assert.equal(outputFrame(withoutPrices, "2K", 1000, 1000).openaiSize, "2048x2048");
assert.ok(withoutPrices.qualities.includes("max"));
