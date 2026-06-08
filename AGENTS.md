# AGENTS.md

This repository is the production management frontend for the CPA / CLIProxyAPI fork. The project owner prefers Simplified Chinese replies and should be addressed as “晓宇”.

## Project Memory Docs

Read these before changing frontend behavior:

- `docs/claude-account-pool-maintenance.md` — production account-pool page map. It explains that the current production dashboard lives in `src/pages/DashboardPage.tsx`, not the legacy `AuthFilesPage`.
- Backend handoff docs in the sibling backend repository:
  - `../CLIProxyAPI/docs/codex-handoff.md`
  - `../CLIProxyAPI/docs/project-file-map.md`
  - `../CLIProxyAPI/docs/production-deployment-23.153.36.12.md`
  - `../CLIProxyAPI/docs/local-development-macos.md`
  - `../CLIProxyAPI/docs/agent-start-prompt.md`

Keep docs current when frontend routes, production entry points, account-pool UI behavior, deployment artifacts, or sensitive-word build requirements change.

## Production Frontend Guardrail

The production management panel is public behind `admin.openstaryu.com`. Do not add user-visible provider brand words back into the management UI. The production single-file build must not contain static `claude` or `anthropic` matches.

After frontend changes, run:

```bash
npm run type-check
npm run lint
npm run build
rg -n -i "claude|anthropic" dist
```

`rg` must return no matches in `dist` before deployment.

## Important Files

- `src/pages/DashboardPage.tsx` — production account-pool dashboard.
- `src/pages/DashboardPage.module.scss` — account-pool dashboard styles.
- `src/services/api/authFiles.ts` — account-pool management API wrapper.
- `src/services/api/claudeSessionImport.ts` — batch sessionKey import API wrapper.
- `scripts/sanitize-management-html.mjs` — post-build sanitizer run by `npm run build`.
- `dist/index.html` — generated artifact only; do not edit by hand.

## Deployment Artifact

Production uploads only the built single HTML file:

```text
dist/index.html -> /opt/cpa-claude-proxy/static/management.html
```

Do not upload source files to the production server and do not build on the production server.

## Secrets

Never commit or document SSH passwords, management passwords, API keys, tokens, account JSON files, session keys, refresh tokens, or proxy passwords.
