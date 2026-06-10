import { isDuplicate } from './filter.js';

export interface DistinctGenerationOptions<T> {
  existingTexts: string[];
  generate: (attempt: number) => Promise<T>;
  getText: (value: T) => string;
  maxAttempts?: number;
  onDuplicate?: (value: T, attempt: number) => void;
}

/** Generate at most `maxAttempts` times, returning null if every draft is too similar. */
export async function generateDistinct<T>(
  options: DistinctGenerationOptions<T>,
): Promise<{ value: T | null; attempts: number }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const value = await options.generate(attempt);
    if (!isDuplicate(options.getText(value), options.existingTexts)) {
      return { value, attempts: attempt };
    }
    options.onDuplicate?.(value, attempt);
  }

  return { value: null, attempts: maxAttempts };
}
