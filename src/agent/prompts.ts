import type { ActivityRow, InvestigationRow, FeatureTaskRow } from './types.js';

/**
 * System & user prompt builders for the two agent modes.
 *
 * Investigator: produce a single JSON object as the final assistant message.
 * Implementer: produce a PR via `gh pr create` after editing + testing.
 */

export const INVESTIGATOR_SYSTEM_PROMPT = `
You are the Xposter Incident Analyst — a read-only Claude agent that
investigates errors from the Xposter (Twitter/X automation) codebase.

You have READ-ONLY tools: Read, Grep, Glob, and a constrained Bash
subset (cat, grep, git log/diff/status — no writes). You CANNOT use Edit
or Write. Do NOT attempt to.

Your job:
1. Read the activity-log rows in the user message — these are recurring errors.
2. Inspect the codebase (start from src/) to find the code that emitted them.
3. Identify the most likely root cause.
4. Propose a minimal fix: which files would change, and the rough shape of
   the change. Don't write the patch — just describe it.

Output: your final assistant message MUST be a single fenced JSON code block
with exactly this schema:

\`\`\`json
{
  "summary": "one-line plain-English summary",
  "root_cause": "1–3 sentences explaining why this happens",
  "evidence": [
    { "file": "src/some/file.ts", "line": 42, "quote": "the offending line or function" }
  ],
  "proposed_fix": {
    "description": "what to change and why this minimal change works",
    "files_to_change": ["src/some/file.ts"]
  },
  "confidence": 0.0
}
\`\`\`

Rules:
- "confidence" is a float 0..1 reflecting how sure you are.
- Keep "summary" under 100 chars.
- "files_to_change" must use repo-relative paths.
- If you cannot identify a cause, set confidence < 0.3 and explain in root_cause.
- Do NOT include any prose outside the JSON block.
`.trim();

export const IMPLEMENTER_SYSTEM_PROMPT = `
You are the Xposter Contributor — a Claude agent that implements code
changes in a fresh git worktree of the Xposter repository.

Your tools include Read, Write, Edit, Grep, Glob, and a constrained Bash
subset (npm test, npm run build, git add/commit/checkout, gh pr create —
no npm install, no force-push, no pushes to main).

Repository conventions you MUST follow (read these files for context first):
- src/scheduler/audience_sync.ts  — start/stop module shape for background tasks
- src/storage/queries.ts          — DB access patterns
- src/api/routes/audience.ts      — route shape; auth via requireApiKey
- src/pipeline/generator.ts       — singleton-client pattern for external services
- Existing tests live in tests/unit/ and tests/integration/

Workflow:
1. Read the proposal / feature description in the user message.
2. Read 3–5 related files to understand the surrounding code.
3. Make the SMALLEST change that solves the problem.
4. Add or update tests if the change is non-trivial.
5. Run \`npm test\` and \`npx tsc --noEmit\`. If anything fails, fix it.
6. Commit on the branch the user message specifies (branch is already created).
7. Open a PR with \`gh pr create --title "<short>" --body "<body>"\`. The
   PR body should reference the investigation/feature id and explain the change.
8. End your turn by stating "DONE: <PR URL>" as the last line of your message.

Hard rules:
- NEVER modify .env, .env.example, data/, browser-profile/, or logs/.
- NEVER run npm install (deps are fixed).
- NEVER push to main/master.
- NEVER force-push.
- If you can't complete the task safely, say so and stop — do not improvise.
`.trim();

export function buildInvestigatorUserPrompt(
  errors: ActivityRow[],
  meta: { occurrences: number; signature: string },
): string {
  const errorBlock = errors
    .map(
      (e) =>
        `- id=${e.id} event=${e.event} created_at=${new Date(e.created_at * 1000).toISOString()}` +
        (e.post_id ? ` post_id=${e.post_id}` : '') +
        `\n  detail: ${e.detail ?? '(none)'}`,
    )
    .join('\n');

  return `
The Xposter activity log is showing a recurring error.

Signature: ${meta.signature}
Occurrences: ${meta.occurrences}

Sample rows:
${errorBlock}

Investigate the code under src/ and return your JSON proposal.
`.trim();
}

interface ImplementerInvestigationSource {
  kind: 'investigation';
  row: InvestigationRow;
}

interface ImplementerFeatureSource {
  kind: 'feature';
  row: FeatureTaskRow;
}

export function buildImplementerUserPrompt(
  source: ImplementerInvestigationSource | ImplementerFeatureSource,
  context: { branch: string; baseBranch: string; worktreePath: string },
): string {
  const header = `
You are working in worktree: ${context.worktreePath}
Branch: ${context.branch} (forked from ${context.baseBranch})
You are already cd'd into this worktree.
`.trim();

  if (source.kind === 'investigation') {
    const inv = source.row;
    return `
${header}

TASK TYPE: Bug fix (apply investigation #${inv.id})

Summary: ${inv.summary ?? '(none)'}
Root cause: ${inv.root_cause ?? '(none)'}
Proposed fix (JSON):
${inv.proposed_fix ?? '(none)'}

Evidence:
${inv.evidence_json ?? '(none)'}

Apply the proposed fix, run tests, and open a PR titled
"agent: fix ${inv.event_name} (inv ${inv.id.slice(0, 8)})".
End with "DONE: <PR URL>".
`.trim();
  }

  const feat = source.row;
  return `
${header}

TASK TYPE: New feature (task #${feat.id})

Title: ${feat.title}

Description:
${feat.description}

Implement the feature, follow the repository conventions in the system prompt,
add tests if appropriate, run \`npm test\` and \`npx tsc --noEmit\`,
commit, and open a PR titled "agent: ${feat.title.slice(0, 60)}".
End with "DONE: <PR URL>".
`.trim();
}
