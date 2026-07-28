import { logEvent } from '../storage/queries.js';
import { shouldLogPrompts } from '../config.js';

export function logPromptToConsole(kind: string, id: string, system: string, user: string): void {
  if (!shouldLogPrompts()) return;

  const line = '-'.repeat(72);
  process.stdout.write(
    `\n${line}\nGROQ ${kind} PROMPT id=${id}\n${line}\n` +
    `-- SYSTEM --\n${system}\n` +
    `-- USER --\n${user}\n${line}\n\n`,
  );
  logEvent('GROQ_PROMPT', `[${kind}] ${id} | ${user.slice(0, 500)}`);
}
