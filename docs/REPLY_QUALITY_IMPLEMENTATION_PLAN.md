# Reply Quality and Delivery Plan

## Objective

Restore dependable daily publishing, then improve reply quality through a
controlled `Reply Tournament` rollout. The primary success metric is meaningful
reply actions per 1,000 impressions, not raw engagement score, which is heavily
influenced by the reach of the account being replied to.

## Current Diagnosis

- Scheduled reply runs are firing, but reply generation has been failing before
  posting. The fallback configured in the environment previously referenced a
  Groq model that the account cannot use.
- Agentic generation also attempts to use the local Claude session when it is
  not authenticated, adding delay before the Groq fallback runs.
- A live account model check confirms that `openai/gpt-oss-120b` is available.
  The active `.env` now points to that model; `.env.example` still needs to
  match it.
- The workspace already contains in-progress quality work: Conversation Gravity,
  receipt-style responses, winner examples, and source-side conversation
  opportunity scoring. This plan extends that work instead of replacing it.

## Guardrails

- Preserve the existing user changes in the worktree, especially the
  Conversation Gravity and receipt-mode work.
- Do not expose or commit `.env` secrets.
- Keep sensitive-topic protections and the human-likeness gate intact.
- Keep the Tournament at a controlled 20% rollout until it has enough
  metric-synced observations.
- Do not change the live trend ratio based on a small or failed sample.

## Phase 1: Restore Generation Reliability

### Changes

1. Update `.env.example` to use `openai/gpt-oss-120b`, matching the verified
   live configuration and the existing config fallback.
2. Add a Groq model preflight that lists account-available models, records the
   latest health state, and exposes it in `/api/diagnostics`.
3. Add an in-process Claude authentication circuit breaker:
   - Detect `not logged in`, expired OAuth, and reauthentication failures.
   - Stop retrying agentic and Claude CLI generation for the rest of the process
     when authentication is known to be unavailable.
   - Continue directly to Groq, while leaving a clear diagnostics reason.
4. Start the provider health probe with the scheduler and refresh it on a
   bounded interval.

### Acceptance Criteria

- A cold start reports whether the configured Groq model is available.
- A known Claude authentication failure results in one attempted fallback, not
  repeated delays for every candidate.
- A working Groq call can generate a reply and an original post with the
  configured model.

## Phase 2: Make Delivery Failures Visible

### Changes

1. Persist generation errors to `posts.last_error`; the dashboard must show why
   a candidate entered `ERROR`, not merely that it did.
2. Expand `runReplyPipeline()` to report `posted` and `pendingApproval` counts
   in addition to its existing summary.
3. Track consecutive scheduled runs that produce neither a posted reply nor an
   approval candidate.
4. After two such runs, emit an activity-log event and send one ntfy alert.
   Reset the alert latch only after the pipeline produces a reply or candidate.

### Acceptance Criteria

- A provider failure is visible on the candidate row and in the activity log.
- Two empty scheduled runs produce one alert, never an alert storm.
- A successful later run resets the stalled-delivery state.

## Phase 3: Reply Tournament (20% Controlled Rollout)

### Product Behavior

For a selected 20% of new candidate tweets, generate three deliberately
different replies instead of choosing among near-duplicates:

1. `ONE_LINER`: a concise, quotable observation.
2. `SECOND_ORDER`: a concrete downstream consequence or respectful contrarian
   angle.
3. `SPECIFIC_RECEIPT`: a grounded, checkable detail plus its implication.

Conversation Gravity acts as the critic. It ranks the drafts for novelty versus
the parent, specificity, a natural invitation to respond, and anti-slop rules;
its optional LLM judge refines the selected winner. A single rewrite is allowed
when the winner is below the configured gravity threshold. Sensitive topics
retain their existing safety exclusions.

### Changes

1. Add `reply_tournament_enabled` and `reply_tournament_rollout_pct` settings
   with defaults of `true` and `20`.
2. Persist the chosen strategy, winning angle, critic score, and critic reasons
   on the candidate post so retries do not change experiment assignment.
3. Extend `generateReplyWithMeta()` to return the winning Tournament metadata.
4. Keep the existing Conversation Gravity work as the shared judge; do not add a
   competing second evaluator.
5. Surface the rollout controls in the dashboard settings and Tournament
   metadata on pending candidates where space permits.

### Acceptance Criteria

- A 0% rollout never generates Tournament angles; a 100% rollout always
  generates all three.
- A candidate retains its strategy and angle across regeneration/retry paths.
- The winning reply has a recorded critic score and rejection reasons are
  inspectable.
- Existing non-Tournament generation continues to work unchanged.

## Phase 4: Measure Quality, Not Account Reach

### Changes

1. Add `actions_per_1k_impressions` to reply analytics. Actions are likes,
   replies, and reposts; only metric-synced replies are eligible.
2. Add breakdowns for source, posting hour, topic, stance, content structure,
   Tournament strategy, and Tournament angle.
3. Add a compact Analytics view for Tournament quality, highlighting sample
   size, actions per 1,000 impressions, and the best-performing angle.
4. Keep the existing raw success score for reach monitoring, but never use it
   alone to decide copy quality.

### Acceptance Criteria

- Analytics exclude unsynced replies from quality-rate calculations.
- Every breakdown reports a sample size.
- The UI clearly labels the quality rate as actions per 1,000 impressions.

## Phase 5: Controlled Evaluation and Distribution Tuning

1. Run the 20% Tournament for seven days or until 50 metric-synced Tournament
   replies are available, whichever is later.
2. Promote the rollout to 50% only when the Tournament improves actions per
   1,000 impressions by at least 25% against the control and does not increase
   safety-gate skips materially.
3. Use source data deliberately:
   - Timeline replies are the conversation-quality control.
   - Trend replies are the reach/discovery treatment.
   - Revisit the trend ratio only after generation reliability and the quality
     experiment are stable.
4. Prefer stronger structures only after a minimum sample threshold; do not
   overfit to a small number of viral replies.

## Test and Verification Plan

- Unit: model health parsing, Claude auth circuit breaking, stalled-delivery
  alert latching, Tournament allocation, angle prompting, and metadata
  persistence.
- Unit: quality-rate analytics and all breakdowns, including unsynced-reply
  exclusion.
- Integration: scheduled pipeline results, generation failure persistence, and
  an end-to-end Tournament candidate through approval/publish metadata.
- Run `npm test` and `npm run build` after implementation.
- Restart the local development server once the provider configuration and
  health checks are in place, then verify `/api/diagnostics`, one manual
  pipeline run, and the Analytics dashboard.

## Delivery Order

1. Reliability and failure visibility.
2. Tournament storage and generation.
3. Analytics and settings UI.
4. Tests, build, restart, and live verification.
