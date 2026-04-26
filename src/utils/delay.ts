/**
 * Human-like random delays to avoid bot detection patterns.
 * All values in milliseconds.
 */

export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Short pause — between keystrokes or micro-interactions */
export async function shortDelay(): Promise<void> {
  await delay(randomBetween(80, 250));
}

/** Medium pause — between UI actions (click → type) */
export async function mediumDelay(): Promise<void> {
  await delay(randomBetween(600, 1800));
}

/** Long pause — between major actions (open reply box → submit) */
export async function longDelay(): Promise<void> {
  await delay(randomBetween(2000, 4500));
}

/** Base delay primitive */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Type text with per-character random delays to mimic human typing */
export async function humanType(
  typeFn: (char: string) => Promise<void>,
  text: string,
): Promise<void> {
  for (const char of text) {
    await typeFn(char);
    await delay(randomBetween(40, 140));
  }
}
