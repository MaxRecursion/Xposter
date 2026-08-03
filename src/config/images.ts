import { parseIntValue } from './parse.js';

const DEFAULT_IMAGE_WIDTH = 640;
const DEFAULT_IMAGE_HEIGHT = 800;
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_GEMINI_IMAGE_SIZE = '1K';
const DEFAULT_FAL_MODEL = 'fal-ai/nano-banana-2';
const DEFAULT_FAL_RESOLUTION = '1K';

export function getImageWidth(): number {
  const width = parseIntValue(process.env.IMAGE_WIDTH, DEFAULT_IMAGE_WIDTH, 1);
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_IMAGE_WIDTH;
}

export function getImageHeight(): number {
  const height = parseIntValue(process.env.IMAGE_HEIGHT, DEFAULT_IMAGE_HEIGHT, 1);
  return Number.isFinite(height) && height > 0 ? height : DEFAULT_IMAGE_HEIGHT;
}

export function getImageCharacterPrompt(): string | null {
  return process.env.IMAGE_CHARACTER_PROMPT?.trim() || null;
}

export function getImageProviderOverride(): string | null {
  return process.env.IMAGE_PROVIDER?.trim() || null;
}

export function getGeminiImageModel(): string {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export function getGeminiImageSize(): string {
  return process.env.GEMINI_IMAGE_SIZE?.trim() || DEFAULT_GEMINI_IMAGE_SIZE;
}

export function getGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function getHfApiKey(): string | null {
  return process.env.HF_API_KEY?.trim() || null;
}

export function getFalKey(): string | null {
  return process.env.FAL_KEY?.trim() || null;
}

export function getFalImageModel(): string {
  return process.env.FAL_IMAGE_MODEL?.trim() || DEFAULT_FAL_MODEL;
}

/** Blank means "derive `${model}/edit` when that model is known to have one". */
export function getFalImageEditModel(): string | null {
  return process.env.FAL_IMAGE_EDIT_MODEL?.trim() || null;
}

export function getFalImageResolution(): string {
  return process.env.FAL_IMAGE_RESOLUTION?.trim() || DEFAULT_FAL_RESOLUTION;
}

/** upload | datauri | off — see .env.example. */
export function getFalReferenceMode(): 'upload' | 'datauri' | 'off' {
  const mode = process.env.FAL_REFERENCE_MODE?.trim().toLowerCase();
  return mode === 'datauri' || mode === 'off' ? mode : 'upload';
}

export function getFalUploadTtlDays(): number {
  return parseIntValue(process.env.FAL_UPLOAD_TTL_DAYS, 30, 1);
}
