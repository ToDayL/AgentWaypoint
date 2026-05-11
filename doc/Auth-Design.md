# AgentWaypoint Authentication and Authorization

Last aligned with implementation: 2026-05-11

## 1. Current Implementation

AgentWaypoint uses first-party user accounts with server-side sessions:

- Users are stored in `User`.
- Login uses `POST /api/auth/login/password`.
- Sessions are stored in `AuthSession`.
- The browser receives an HTTP-only cookie named by `AUTH_SESSION_COOKIE_NAME` (default `aw_session`).
- `AuthGuard` resolves a user principal and attaches `request.currentUser`.
- Admin-only APIs check `CurrentUser.role === "admin"`.

There is also a development fallback:

- `AUTH_DEV_EMAIL_HEADER=1` enables `x-user-email`.
- When enabled, a request with a valid `x-user-email` auto-creates or resolves that user.
- The fallback is for local development and tests, not production hardening.

## 2. Bootstrap

`./agent-waypoint start` calls the API bootstrap path. On first run, it prompts for:

- data directory
- admin email
- admin password
- display name
- API port
- Web port

It writes `AGENTWAYPOINT_HOME/config.json`, creates the SQLite schema with Prisma, and upserts an admin user with `role=admin`.

Manual admin bootstrap still exists:

```bash
corepack pnpm --filter @agentwaypoint/api auth:bootstrap-admin
```

## 3. Data Model

Active auth-related schema:

```prisma
model User {
  id                   String
  email                String @unique
  displayName          String?
  isActive             Boolean
  role                 String
  authPolicy           String
  passwordHash         String?
  lastLoginAt          DateTime?
  turnSteerEnabled     Boolean
  defaultWorkspaceRoot String?
  authSessions         AuthSession[]
}

model AuthSession {
  id               String
  userId           String
  sessionTokenHash String @unique
  expiresAt        DateTime
  createdAt        DateTime
  lastSeenAt       DateTime
  revokedAt        DateTime?
  ip               String?
  userAgent        String?
}
```

Password hashes use Node `crypto.scryptSync` with format:

```text
scryptv1$<salt>$<base64url-key>
```

Argon2, WebAuthn credentials, recovery codes, API keys, service accounts, and audit logs are not implemented.

## 4. API Surface

### Human Auth

- `POST /api/auth/login/password`
  - body: `{ email, password }`
  - sets the session cookie
  - returns `{ user: { id, email, role } }`

- `POST /api/auth/logout`
  - revokes the current session token
  - clears the session cookie

- `POST /api/auth/password/change`
  - requires an authenticated cookie session
  - body: `{ currentPassword, newPassword }`

- `GET /api/auth/session`
  - returns `{ authenticated: false }` or `{ authenticated: true, principal }`

### User/Admin Settings

- `GET /api/settings`
- `POST /api/settings`
- `GET /api/settings/users` (admin)
- `POST /api/settings/users` (admin)
- `PATCH /api/settings/users/:id` (admin)

Admin-created users require a password and can be assigned `admin` or `user` role.

## 5. Authorization Rules

- All business routes use `AuthGuard` unless explicitly unguarded.
- Project/session/turn/message operations are owner-scoped.
- Cross-user access returns not found or forbidden depending on the route.
- Admin user management requires role `admin`.
- Channel integration and bot message APIs are owner-scoped.

There is no service-account principal type in the active guard.

## 6. Session Behavior

- Cookie: HTTP-only, `SameSite=Lax`, path `/`.
- Secure flag is not currently added by the API cookie helper.
- TTL defaults to `AUTH_SESSION_TTL_HOURS=168`.
- `AuthSession.lastSeenAt` is updated when a session token resolves successfully.
- Logout sets `revokedAt`.

## 7. Configuration

Relevant environment variables:

- `AUTH_SESSION_COOKIE_NAME`
- `AUTH_SESSION_TTL_HOURS`
- `AUTH_DEV_EMAIL_HEADER`

`JWT_SECRET` is still part of the generated `config.json` shape for compatibility with earlier bootstrap code, but active request auth uses opaque session tokens stored in `AuthSession`.

## 8. Not Implemented Yet

These are design goals only unless code is added later:

- WebAuthn/passkeys.
- Recovery codes.
- Service accounts and API keys.
- Scoped service/bot principals.
- Session revocation UI beyond logout and admin user edits.
- Audit log table.
- CSRF protection layer.
- Login rate limiting.
- Envelope encryption for channel credentials.

## 9. Recommended Next Auth Work

1. Disable `AUTH_DEV_EMAIL_HEADER` by default in production wrappers/config.
2. Add `Secure` cookie handling when served behind HTTPS.
3. Add login rate limiting and CSRF protection for cookie-authenticated state changes.
4. Add service-account/API-key auth before exposing externalized channel gateway endpoints.
5. Add WebAuthn after password/session flows and service auth are stable.
