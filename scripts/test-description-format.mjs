/*
 * Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only
 */

import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/description-format.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { formatDescriptionParagraphs, formatDescriptions } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

// The reported six-section description, kept verbatim to catch this regression.
const reportedDescription = String.raw`COMPOSITION: Two handcrafted ceramic pitchers are positioned centrally against a solid, muted teal-grey background. The taller, more voluminous pitcher stands slightly forward on the left, while the smaller, globe-bellied pitcher with a pedestal base is situated to the right. Both objects are captured from a straight-on eye-level viewpoint, creating a balanced yet dynamic product display.\n\nSUBJECTS: The left pitcher features an ovoid body, a prominent curved handle attached from the shoulder to the upper neck, and a flared spout rim. The right pitcher has a globular body resting on a flared circular foot, a tall cylindrical neck with horizontal ridging, a wide pouring spout, and a delicate handle arching from the rim to the shoulder. Both vessels serve as decorative earthenware containers with distinct traditional craft aesthetics.\n\nMATERIALS AND TEXTURES: Both pitchers are fashioned from earthenware clay, exhibiting a matte, porous texture characteristic of handmade pottery. Their surfaces are extensively decorated using sgraffito and relief techniques, featuring carved geometric lines, raised cord-like rope bands, and impressed dots that create a highly tactile, deeply grooved topography across the clay bodies.\n\nCOLOR PALETTE: The dominant color palette consists of earthy terracotta browns and warm off-white or cream tones. Accents of soft sage green fill specific geometric motifs, such as the central diamond on the left pitcher and the radiating petals of the starburst pattern on the right pitcher. The solid backdrop provides a cool teal-grey contrast that makes the warm ceramic tones stand out.\n\nLIGHTING: Diffused studio lighting illuminates the scene evenly from the front, casting soft, gentle shadows that trace the contours of the carved grooves and relief work. This lighting strategy emphasizes the three-dimensional depth of the surface incisions without creating distracting specular highlights or harsh contrasts.\n\nDETAILS: The left pitcher showcases a complex arrangement of nested triangles and diamond patterns framing a pale green central diamond, bordered by zigzag bands and rows of tiny dotted indentations. The right pitcher features a prominent, eight-petaled geometric starburst or floral rosette spreading symmetrically across its bulbous front, with each alternating petal glazed in green and terracotta over a cream background.`;
const reportedParagraphs = reportedDescription.split(String.raw`\n\n`);
const expectedReportedDescription = reportedParagraphs.join("\n\n");
const composition = "COMPOSITION: Two ceramic pitchers.";
const lighting = "LIGHTING: Soft studio light.";
const expectedPair = `${composition}\n\n${lighting}`;
const bulletComposition = "COMPOSITION:\n- Centered framing\n- Strong vertical symmetry";
const bulletLighting = "LIGHTING:\n- Soft diffused studio illumination\n- Restrained shadows across the subject";
const expectedBulletPair = `${bulletComposition}\n\n${bulletLighting}`;
const printedBackslashes = String.raw`DETAILS: The label reads "C:\new\renders\pitcher.png", "\n", "\r\n", "\t" and "\\".`;

const cases = [
  ["reported ceramic-pitcher description", reportedDescription, expectedReportedDescription],
  ["correct paragraphs", expectedReportedDescription, expectedReportedDescription],
  ["plain spaces between labels", `${composition} ${lighting}`, expectedPair],
  ["single real newline", `${composition}\n${lighting}`, expectedPair],
  ["real CRLF", `${composition}\r\n\r\n${lighting}`, expectedPair],
  ["real carriage returns", `${composition}\r\r${lighting}`, expectedPair],
  ["escaped newline", `${composition}${String.raw`\n`}${lighting}`, expectedPair],
  ["escaped CRLF", `${composition}${String.raw`\r\n\r\n`}${lighting}`, expectedPair],
  ["escaped carriage returns", `${composition}${String.raw`\r\r`}${lighting}`, expectedPair],
  ["repeated escaping", `${composition}${String.raw`\\n\\n`}${lighting}`, expectedPair],
  ["repeated CRLF escaping", `${composition}${String.raw`\\r\\n\\r\\n`}${lighting}`, expectedPair],
  ["mixed real and escaped newlines", `${composition}\n${String.raw`\n`}\r\n${lighting}`, expectedPair],
  ["whitespace around escapes", `${composition} \t${String.raw`\n`} \t${String.raw`\n`} \t${lighting}`, expectedPair],
  ["extra blank lines", `${composition}\n\n\n\n${lighting}`, expectedPair],
  ["spaces on blank lines", `${composition}\n \t\n \n${lighting}`, expectedPair],
  ["escaped break without final punctuation", String.raw`COMPOSITION: Two pitchers\n\nLIGHTING: Soft light`, "COMPOSITION: Two pitchers\n\nLIGHTING: Soft light"],
  ["real break without final punctuation", "COMPOSITION: Two pitchers\nLIGHTING: Soft light", "COMPOSITION: Two pitchers\n\nLIGHTING: Soft light"],
  ["quoted sentence boundary", 'COMPOSITION: A sign reads "Hello!" LIGHTING: Soft light.', 'COMPOSITION: A sign reads "Hello!"\n\nLIGHTING: Soft light.'],
  ["ampersand label", String.raw`COMPOSITION: Two pitchers.\n\nMATERIALS & TEXTURES: Matte clay.`, "COMPOSITION: Two pitchers.\n\nMATERIALS & TEXTURES: Matte clay."],
  ["slash and hyphen label", String.raw`COMPOSITION: Two pitchers.\n\nSTYLE/MEDIUM: Photo.\n\nFINE-DETAILS: Carvings.`, "COMPOSITION: Two pitchers.\n\nSTYLE/MEDIUM: Photo.\n\nFINE-DETAILS: Carvings."],
  ["correct bullet sections", expectedBulletPair, expectedBulletPair],
  [
    "escaped bullet and section newlines",
    String.raw`COMPOSITION:\n- Centered framing\n- Strong vertical symmetry\n\nLIGHTING:\n- Soft diffused studio illumination\n- Restrained shadows across the subject`,
    expectedBulletPair,
  ],
  [
    "blank lines between bullet items",
    `COMPOSITION:\n\n- Centered framing\n\n\n- Strong vertical symmetry\n\n\n${bulletLighting}`,
    expectedBulletPair,
  ],
  [
    "indented bullets and irregular prefix spacing",
    `COMPOSITION:\n  -   Centered framing\n\t-\tStrong vertical symmetry\n\n${bulletLighting}`,
    expectedBulletPair,
  ],
  ["unrelated backslashes", printedBackslashes, printedBackslashes],
  ["backslashes alongside a section separator", `${printedBackslashes}${String.raw`\n\n`}${lighting}`, `${printedBackslashes}\n\n${lighting}`],
  ["escapes within prose", String.raw`DETAILS: The sign shows \n and \r\n as text.`, String.raw`DETAILS: The sign shows \n and \r\n as text.`],
  ["unlabeled escaped text", String.raw`The sign says first\nsecond.`, String.raw`The sign says first\nsecond.`],
  ["unlabeled real line break", "The sign says first\nsecond.", "The sign says first\nsecond."],
  ["outer whitespace", ` \n${composition}\n\n${lighting}\n `, expectedPair],
  ["leading escaped separator", `${String.raw`\n\n`}${composition}`, composition],
  ["empty text", "", ""],
];

for (const [name, input, expected] of cases) {
  assert.equal(formatDescriptionParagraphs(input), expected, name);
  assert.equal(formatDescriptionParagraphs(expected), expected, `${name}: idempotent`);
}

assert.equal(reportedParagraphs.length, 6);
const parsed = JSON.parse(JSON.stringify({ descriptions: [reportedDescription] }));
assert.equal(
  formatDescriptions([{ source: "Photoshop selection" }], parsed.descriptions),
  expectedReportedDescription,
  "double-escaped JSON description is formatted without adding an image heading"
);
assert.equal(
  formatDescriptions(
    [{ source: "Photoshop selection" }, { source: String.raw`Reference 1: C:\new\pitcher.png` }],
    [reportedDescription, `${printedBackslashes}\n${String.raw`\n`}${lighting}`]
  ),
  `Image 1 — Photoshop selection\n${expectedReportedDescription}\n\nImage 2 — Reference 1: C:\\new\\pitcher.png\n${printedBackslashes}\n\n${lighting}`,
  "multiple images keep their source headings and receive real paragraph breaks"
);

console.log(`description formatting tests passed (${cases.length} cases, idempotency and single-/multi-image formatting)`);
