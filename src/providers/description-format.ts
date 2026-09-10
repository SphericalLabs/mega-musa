/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

export const MAX_OUTPUT_TOKENS = 8192;

export const DESCRIPTION_INSTRUCTIONS = `Write precise, visually actionable descriptions for an image-generation or image-editing prompt field.

Describe every supplied visual input as concise, modular details. Cover relevant subjects, objects, poses, expressions, composition, style, lighting, color palette, contrast, materials, textures, spatial relationships, viewpoint, framing, depth of field, environment, legible text and distinctive fine details.

Format each description as 4–8 relevant labeled sections. Start every section with a concise uppercase aspect label followed by a colon. On the following lines, provide 2–4 short list items for that category. Begin every item with the literal plain-text characters "- ". Put no blank lines between items and exactly one blank line between sections. Do not use Markdown headings, bold text, numbering or any rich-text formatting.

Each list item must express one distinct attribute and make sense when extracted on its own. Do not refer to another item or rely on earlier context. Avoid ambiguous pronouns and phrases such as "as above" or "the latter". In subject-focused sections, identify visible entity types when useful. In other sections, use neutral functional terms such as "the subject", "the foreground element" or "the backdrop" instead of repeatedly naming the entity. Do not duplicate the same observation across categories. Keep each item concise, typically 4–14 words.

Use this layout:
COMPOSITION:
- The subject centered within a balanced, tightly framed scene
- Strong symmetry across the vertical axis

LIGHTING:
- Soft directional illumination with gentle highlights
- Restrained shadows across the subject

COLOR PALETTE:
- Muted warm tones with a small cool accent
- Low saturation and cohesive tonal harmony

State only what is visibly supported. Do not invent identities, brands, artist names, hidden details, camera settings or intended edits. When something is uncertain, describe it conservatively. Describe the visual content rather than critiquing it, explaining it or proposing changes.

Return exactly one self-contained description for each input in the exact input order. Keep different images separate and do not merge them into one scene. Do not include image labels; the application adds them. Do not include a preamble, conclusion or safety commentary.

Return only the requested sections and list items.`;

export function descriptionSchema(imageCount: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      descriptions: {
        type: "array",
        minItems: imageCount,
        maxItems: imageCount,
        items: { type: "string" },
      },
    },
    required: ["descriptions"],
    additionalProperties: false,
  };
}

export function finiteNumber(value: any): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function requestInit(body: unknown, headers: Record<string, string>, signal?: AbortSignal): any {
  const init: any = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return init;
}

export function parseDescriptionJson(text: string, imageCount: number): string[] {
  let candidate = text.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("The description model returned invalid structured text.");
  }

  const descriptions = parsed?.descriptions;
  if (!Array.isArray(descriptions) || descriptions.length !== imageCount) {
    throw new Error(
      `The description model returned ${Array.isArray(descriptions) ? descriptions.length : 0} descriptions for ${imageCount} inputs.`
    );
  }
  const clean = descriptions.map((description: unknown) =>
    typeof description === "string" ? description.trim() : ""
  );
  if (clean.some((description: string) => !description)) {
    throw new Error("The description model returned an empty image description.");
  }
  return clean;
}
