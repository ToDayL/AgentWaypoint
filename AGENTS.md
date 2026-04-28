# AGENTS.md

## Scope
Operational runbook for local development and test execution in this repository.

## Prerequisites
- `corepack` available for `pnpm`.
- Recommended Node version: `22.x` (repo engines: `>=22 <23`).
- Codex CLI installed on host when testing Codex-backed turns.
- Claude runtime dependencies installed on host when testing Claude-backed turns.

## Agent Safety Rules
- Do not use the live `~/.agentwaypoint` data directory for development or tests unless the user explicitly asks.
- Use an isolated home such as `/tmp/agentwaypoint-test` or `./.agentwaypoint-dev` for local runs.
- Do not use ports `4242` or `3443` for tests; these may belong to a real service.

## Agent Commit Policy

When an agent creates or updates commits in this repository, follow these rules:

- Always use DCO sign-off on every commit (`Signed-off-by` trailer), e.g. via:
  ```bash
  git commit -s -m "..."
  ```
- If amending a commit, preserve/add DCO sign-off:
  ```bash
  git commit --amend -s --no-edit
  ```
- Do not add agent co-author metadata to commits:
  - No `Co-authored-by:` trailers.
  - Keep only the primary author/committer plus required `Signed-off-by` trailer(s).
- Use Conventional Commit style for commit messages:
  - Format: `<type>(<scope>): <subject>`
  - Allowed `type`: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `build`, `perf`, `revert`
  - Keep subject imperative and concise (prefer <= 72 chars), no trailing period.

If a user explicitly requests a different commit message format, follow the user request.

## Development Workflow

### Start Lightweight Dev Stack
```bash
./scripts/dev-up.sh
```

This uses `./.agentwaypoint-dev` by default, runs SQLite, and starts API + Web with the embedded runner. Override the data directory when needed:
```bash
AGENTWAYPOINT_DEV_HOME=/tmp/agentwaypoint-dev ./scripts/dev-up.sh
```

### Check Status
```bash
./scripts/dev-status.sh
```

### Stop
```bash
./scripts/dev-down.sh
```

### Production Wrapper
```bash
./scripts/prod-up.sh
./scripts/prod-status.sh
./scripts/prod-down.sh
```

Production wrappers default to `~/.agentwaypoint`. Agents should not run these against the default home during development.

## Test Procedure

### Fast Checks
```bash
corepack pnpm --filter @agentwaypoint/api typecheck
corepack pnpm --filter @agentwaypoint/web typecheck
```

### API E2E
```bash
./scripts/test-api-e2e.sh
```

The script creates a temporary `AGENTWAYPOINT_HOME`, uses a temporary SQLite database, and does not require Docker, Redis, or Postgres.

### Package Tests
```bash
corepack pnpm --filter @agentwaypoint/api test
corepack pnpm --filter @agentwaypoint/web test
```

The web package currently may report "No test files found".

## Troubleshooting

### Prisma Client Missing
Run:
```bash
corepack pnpm --filter @agentwaypoint/api prisma:generate
```

### Need A Throwaway Manual Run
Use a temp home and non-reserved ports:
```bash
AGENTWAYPOINT_HOME=/tmp/agentwaypoint-manual ./agent-waypoint start --home /tmp/agentwaypoint-manual
```

## Codex App Server Schema Rule

When developing Codex-related features, always:
- Check `doc/Codex-App-Server-Documentation.md` first.
- Validate request/event fields against generated schema artifacts, using:
  - `codex app-server generate-ts --out ./schemas`
  - `codex app-server generate-json-schema --out ./schemas`

Do not rely on inferred or guessed fields when schema-generated definitions are available.
