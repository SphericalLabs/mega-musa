/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

import { isOpenAIModel } from "../models/provider";
import { type OutputFrame } from "../models/types";
import { generateEdit } from "./gemini-images";
import { generateOpenAIImage } from "./openai-images";
import { type GenerateResult, type ImageQuality, type RefImage } from "./types";

export interface ImageRequest {
  apiKey: string;
  model: string;
  prompt: string;
  baseImagePng?: Uint8Array;
  references: RefImage[];
  frame: OutputFrame;
  resolution: string;
  quality: ImageQuality;
  signal?: AbortSignal;
}

export interface ImageProvider {
  generate(request: ImageRequest): Promise<GenerateResult>;
}

const providers: Record<"openai" | "gemini", ImageProvider> = {
  openai: {
    generate: ({ frame, ...request }) => {
      if (!frame.openaiSize) return Promise.reject(new Error("The OpenAI output size is missing."));
      return generateOpenAIImage({ ...request, size: frame.openaiSize });
    }
  },
  gemini: {
    generate: ({ frame, resolution, ...request }) => generateEdit({
      ...request, aspectRatio: frame.geminiAspect, imageSize: resolution === "auto" ? undefined : resolution,
    })
  },
};

export function generateImage(request: ImageRequest): Promise<GenerateResult> {
  return providers[isOpenAIModel(request.model) ? "openai" : "gemini"].generate(request);
}
