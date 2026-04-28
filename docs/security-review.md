# Security Review

Date: 2026-04-27

## Scope

Reviewed the local Express API, ntfy callback flow, browser automation boundaries, Git hygiene, scheduler defaults, dependency audit output, and runtime configuration.

## Findings And Fixes

| Area | Risk | Fix |
|---|---|---|
| ntfy action links | Full `API_KEY` was previously usable in callback URLs when using iOS-friendly view actions. URLs can leak through browser history, screenshots, or logs. | Replaced URL API keys with scoped HMAC action tokens tied to `action + postId + expiry`. |
| HTTP logs | Query-string credentials could appear in request logs. | Added log URL redaction for `key`, `token`, and `api_key`. |
| Mutation endpoints | LAN-accessible mutation routes could be called without authentication in some paths. | Added API-key middleware to manual run, test notification, settings update, reply edit, regenerate, and toggle routes. |
| iPhone dashboard auth | Protecting mutation routes could otherwise break same-origin dashboard actions from a phone. | Added dashboard-origin trust for configured LAN/Tailscale origins plus browser-local API-key fallback. |
| Request body size | JSON body parser had the default unlimited-ish ergonomics for this app. | Added `express.json({ limit: '64kb' })`. |
| CORS | CORS allowed every origin. | Restricted CORS to localhost and configured local callback/browser URLs. |
| Dependency audit | `node-cron` and Vitest dependency trees had moderate advisories. | Upgraded `node-cron` to v4.2.1 and Vitest/coverage to v4.1.5. `npm audit` now reports zero vulnerabilities. |
| Git hygiene | Runtime artifacts and secrets must never be uploaded. | `.gitignore` excludes `.env`, `browser-profile/`, `data/`, `logs/`, `dist/`, and `node_modules/`. |
| Secret placeholders | Example config had key-like placeholder strings that could trigger scanners. | Replaced with neutral placeholder values. |

## Residual Risks

- This is still a local automation tool controlling a logged-in browser session. Protect the Mac account and the ignored `browser-profile/` directory.
- If `API_KEY` is left unset or set to the placeholder, mutation auth intentionally drops to single-user development mode.
- If `TRUST_DASHBOARD_ORIGIN=true`, devices that can load the Xposter dashboard from its LAN/Tailscale URL can perform dashboard actions. Keep Tailscale access limited to your devices.
- iPhone callbacks require network reachability to the Mac LAN or Tailscale URL.
- X/Twitter DOM changes may break browser automation selectors; failures are logged and should not bypass approval.

## Verification

- `npm audit` passes with zero vulnerabilities.
- TypeScript build passes.
- Unit and integration tests pass.
