# AgentWaypoint Authentication and Authorization Design

Last updated: 2026-03-12

## 1. Goals

This design defines a first-party authentication model for AgentWaypoint that:

- Allows access only for explicitly approved users.
- Avoids third-party OAuth as a required dependency.
- Supports strong human authentication with WebAuthn/passkeys.
- Supports future bot and automation integrations such as a Discord bot.
- Fits the current hybrid runtime:
  - `web` in Docker
  - `api` in Docker
  - `runner` on host

## 2. Non-Goals

- Public self-service signup.
- Third-party identity as the primary login method.
- Using the same auth mechanism for humans and bots.
- Full multi-tenant organization model in the first auth iteration.

## 3. Recommended Model

AgentWaypoint should use a unified internal principal model with two principal types:

1. `user`
   - Human account used by the web UI.
   - Authenticated primarily with WebAuthn.
   - Receives a secure browser session cookie.

2. `service`
   - Non-human account used by bots and automations.
   - Authenticated with API keys or service tokens.
   - Scoped and independently revocable.

This split is the preferred design because human browser auth and bot auth have different requirements and failure modes.

## 4. Policy Summary

### 4.1 Access Control Policy

- No public registration.
- New human accounts must be created or invited by an admin.
- Only active users may authenticate.
- Only active service accounts may use API keys.

### 4.2 Human Authentication Policy

- Primary method: WebAuthn/passkeys.
- Optional fallback: password.
- Optional recovery: one-time recovery codes.
- Default long-term policy for normal users: `webauthn_only`.
- Passwords are allowed only for bootstrap, controlled fallback, or recovery.

### 4.3 Bot Authentication Policy

- Bots never use passwords.
- Bots authenticate as `service` principals.
- Service accounts use API keys initially.
- Signed service JWTs may be added later if needed.

## 5. Principal and Authorization Model

Every authenticated request must resolve to one principal:

- `user`
- `service`

Authorization must then be enforced based on:

- principal type
- role
- scopes
- resource ownership

Recommended roles:

- `admin`
- `user`
- `service`

Recommended high-level rules:

- Human users can access only their own projects and sessions unless they are admins.
- Service accounts can access only routes allowed by their scopes.
- Admin routes require `admin` explicitly.
- Runner control and stream auth remain separate from end-user auth.

## 6. Authentication Flows

### 6.1 User Bootstrap and Enrollment

Recommended initial flow:

1. Admin creates a user record.
2. User is marked active and eligible to enroll.
3. User completes first-time setup:
   - enroll WebAuthn credential
   - optionally set password if policy allows
   - generate recovery codes
4. User receives a browser session after successful enrollment.

No anonymous signup route should exist.

### 6.2 User Login with WebAuthn

Recommended browser flow:

1. User enters email or username.
2. API checks:
   - user exists
   - user is active
   - user has WebAuthn credential
3. API returns WebAuthn assertion options.
4. Browser performs assertion.
5. API verifies signature, counter, RP ID, and challenge.
6. API creates server-side session and returns secure cookie.

Passkey-style discoverable login may be added later, but email-first login is the simpler MVP.

### 6.3 User Login with Password

Password login should be optional and policy-gated.

Flow:

1. User submits email/username and password.
2. API verifies:
   - user exists
   - user is active
   - auth policy allows password
   - password hash matches
3. API creates secure browser session.

Recommended hash algorithm:

- Argon2id

### 6.4 Recovery

Recommended recovery options:

- admin reset
- one-time recovery codes

Recovery codes should be:

- generated in batches
- shown once
- stored hashed
- invalidated on use

### 6.5 Service Account Authentication

Recommended flow:

1. Admin creates a `service_account`.
2. Admin creates an API key with scopes and optional expiration.
3. Bot sends the key using `Authorization: Bearer <token>`.
4. API identifies the key by prefix, verifies hashed secret, resolves service principal, and applies scope checks.

Service accounts should not share keys with human sessions.

## 7. Session Model for Web

The web UI should use secure, server-managed cookie sessions.

Recommended session properties:

- `HttpOnly`
- `Secure`
- `SameSite=Lax` by default
- opaque session ID
- server-side session storage in PostgreSQL
- rolling expiration

Recommended cookie/session behavior:

- login creates a session
- logout deletes current session
- admin may revoke all sessions for a user
- sensitive actions may require recent reauthentication later

Do not store long-lived bearer tokens in browser local storage.

## 8. Service/Bot Model

### 8.1 Why Services Need Separate Auth

Bots cannot use WebAuthn and should not use human passwords. They need:

- non-interactive credentials
- revocation
- scopes
- auditability

### 8.2 Recommended Service Account Fields

- `id`
- `name`
- `description`
- `isActive`
- `ownerUserId` optional
- `createdAt`
- `updatedAt`

### 8.3 Recommended API Key Fields

- `id`
- `serviceAccountId`
- `name`
- `keyPrefix`
- `secretHash`
- `scopes`
- `expiresAt`
- `lastUsedAt`
- `lastUsedIp`
- `revokedAt`
- `createdAt`

### 8.4 Recommended Initial Scopes

- `projects:read`
- `projects:write`
- `sessions:read`
- `sessions:write`
- `turns:read`
- `turns:execute`
- `turns:cancel`
- `admin:read`
- `admin:write`

## 9. Discord Bot Integration

The Discord bot should authenticate as a `service_account`, not as a browser user.

Recommended model:

- Discord bot owns one or more service API keys.
- The bot receives Discord events and maps them to AgentWaypoint actions.
- AgentWaypoint authorizes the bot using service scopes.
- Discord identities remain separate from AgentWaypoint identities.

Later, if needed, AgentWaypoint may support optional linking between:

- a Discord user
- an internal AgentWaypoint user

But Discord should not be the primary identity provider for the system.

This separation keeps the auth model stable even if multiple bot types are added later.

## 10. Data Model Changes

The current schema has only:

- `User`
- project/session/message/turn/event models

It should be expanded to support first-party auth and service principals.

### 10.1 User Model Changes

Recommended additions to `User`:

- `displayName String?`
- `isActive Boolean @default(true)`
- `role String @default("user")`
- `authPolicy String @default("webauthn_only")`
- `passwordHash String?`
- `lastLoginAt DateTime?`
- `updatedAt DateTime @updatedAt`

Notes:

- `passwordHash` remains nullable because many users may be WebAuthn-only.
- `email` may remain the primary unique login identifier for the first implementation.

### 10.2 New Models

Recommended new models:

#### `WebAuthnCredential`

- `id String @id`
- `userId String`
- `credentialId String @unique`
- `publicKey Bytes` or `String`
- `counter Int`
- `transports Json?`
- `deviceType String?`
- `backedUp Boolean?`
- `createdAt DateTime`
- `lastUsedAt DateTime?`

#### `AuthSession`

- `id String @id`
- `userId String`
- `expiresAt DateTime`
- `createdAt DateTime`
- `lastSeenAt DateTime`
- `ip String?`
- `userAgent String?`
- `revokedAt DateTime?`

#### `RecoveryCode`

- `id String @id`
- `userId String`
- `codeHash String`
- `usedAt DateTime?`
- `createdAt DateTime`

#### `ServiceAccount`

- `id String @id`
- `name String`
- `description String?`
- `isActive Boolean @default(true)`
- `ownerUserId String?`
- `createdAt DateTime`
- `updatedAt DateTime @updatedAt`

#### `ApiKey`

- `id String @id`
- `serviceAccountId String`
- `name String`
- `keyPrefix String`
- `secretHash String`
- `scopes Json`
- `expiresAt DateTime?`
- `lastUsedAt DateTime?`
- `lastUsedIp String?`
- `revokedAt DateTime?`
- `createdAt DateTime`

#### `AuditLog`

- `id String @id`
- `principalType String`
- `principalId String`
- `action String`
- `resourceType String?`
- `resourceId String?`
- `ip String?`
- `userAgent String?`
- `metadata Json?`
- `createdAt DateTime`

## 11. API Surface

### 11.1 Human Auth Endpoints

Recommended endpoints:

- `POST /api/auth/login/password`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `POST /api/auth/webauthn/register/options`
- `POST /api/auth/webauthn/register/verify`
- `POST /api/auth/webauthn/login/options`
- `POST /api/auth/webauthn/login/verify`
- `POST /api/auth/recovery/use`

### 11.2 Admin Auth Management Endpoints

Recommended endpoints:

- `POST /api/admin/users`
- `POST /api/admin/users/:id/activate`
- `POST /api/admin/users/:id/deactivate`
- `POST /api/admin/users/:id/reset-password`
- `POST /api/admin/users/:id/recovery-codes/regenerate`
- `GET /api/admin/users/:id/sessions`
- `POST /api/admin/users/:id/sessions/revoke-all`

### 11.3 Service Account Endpoints

Recommended endpoints:

- `GET /api/admin/service-accounts`
- `POST /api/admin/service-accounts`
- `POST /api/admin/service-accounts/:id/keys`
- `POST /api/admin/api-keys/:id/revoke`

### 11.4 Transitional Dev-Only Auth

The existing `x-user-email` header auth should be retained only temporarily behind an explicit dev mode flag, then removed.

Recommended env flag:

- `AUTH_DEV_EMAIL_HEADER=1`

Default:

- disabled

This prevents the current stub auth from surviving into real deployments.

## 12. NestJS Module and Guard Design

### 12.1 Target Modules

Recommended server modules:

- `AuthModule`
- `SessionsModule` for browser auth sessions
- `WebAuthnModule` or WebAuthn providers inside `AuthModule`
- `ServiceAccountsModule`
- `AdminModule`
- `AuditModule`

### 12.2 Request Principal Type

Replace the current `CurrentUser` request context with a principal shape like:

```ts
type RequestPrincipal =
  | {
      type: 'user';
      userId: string;
      email: string;
      role: 'admin' | 'user';
      authMethod: 'session' | 'password' | 'webauthn' | 'recovery';
    }
  | {
      type: 'service';
      serviceAccountId: string;
      role: 'service';
      scopes: string[];
      authMethod: 'api_key';
    };
```

Recommended request type:

```ts
type AuthenticatedRequest = FastifyRequest & {
  principal?: RequestPrincipal;
};
```

### 12.3 Guards

Recommended guards:

- `SessionAuthGuard`
- `ApiKeyAuthGuard`
- `PrincipalAuthGuard`
- `RoleGuard`
- `ScopeGuard`

Suggested behavior:

- browser routes use session auth
- service routes use API key auth
- shared routes may accept either and then apply role/scope logic

## 13. Web Application Changes

Current web behavior:

- manually collects `x-user-email`
- forwards that header through `/api/*`

Target behavior:

- web login/logout pages talk to `/api/auth/*`
- browser stores only secure session cookie
- Next.js route handlers forward cookies automatically
- `/api/*` no longer forwards `x-user-email`

Recommended web changes:

- add login page
- add logged-in session bootstrap request
- remove manual email input from the main page
- add admin UI later for user and service-account management

## 14. Migration Plan

### Phase 0: Keep Current System Working

- Keep current header-based auth during development only.
- Add an auth abstraction layer so business modules stop depending on `x-user-email`.

Deliverables:

- principal request type
- auth mode env switch
- shared principal decorator

### Phase 1: Password + Session MVP

Implement first-party local auth first, without WebAuthn.

Deliverables:

- `User` schema expansion
- password hashing with Argon2id
- `AuthSession` model
- login/logout/session endpoints
- session cookie support
- admin bootstrap path
- deactivate current `x-user-email` in production mode

Reason:

- This phase is operationally simpler and gives a stable foundation for web auth and service/bot auth.

### Phase 2: Service Accounts + API Keys

Deliverables:

- `ServiceAccount`
- `ApiKey`
- API key verification guard
- scoped authorization
- admin key management endpoints

Reason:

- Enables Discord and other automation without waiting for WebAuthn.

### Phase 3: WebAuthn / Passkeys

Deliverables:

- `WebAuthnCredential`
- registration and login endpoints
- per-user auth policy
- recovery codes
- migration path for password users to WebAuthn-first

Reason:

- Strong human auth layered on top of a working session system.

### Phase 4: Hardening and UX

Deliverables:

- audit logging
- session revocation UI
- admin management UI
- passkey-only policy controls
- optional Discord-to-user linking

## 15. Bootstrap Plan

An initial admin account must be created without public signup.

Recommended bootstrap options:

1. one-time CLI bootstrap command
2. env-configured bootstrap admin on empty database only

Preferred option:

- CLI bootstrap command

Example:

- `pnpm --filter @agentwaypoint/api auth:bootstrap-admin`

Behavior:

- create admin user
- set temporary password or invite token
- require immediate passkey enrollment later

## 16. Security Requirements

### 16.1 Human Auth

- Passwords hashed with Argon2id.
- Sessions stored server-side.
- Cookies must be `HttpOnly` and `Secure`.
- Rate-limit login endpoints.
- CSRF protection for cookie-authenticated state-changing routes.
- Recovery codes hashed at rest.

### 16.2 Service Auth

- API keys shown only once at creation.
- Only hashed secrets stored in DB.
- Keys support revocation and expiration.
- Scope checks required for privileged routes.
- Key usage should update `lastUsedAt` and optionally `lastUsedIp`.

### 16.3 WebAuthn

- Production must run on HTTPS with a stable RP ID.
- Registration/login challenges must be short-lived and single-use.
- Signature counter must be checked and persisted.

## 17. Environment and Deployment Notes

WebAuthn requires stable origin handling.

Recommended future envs:

- `AUTH_SESSION_COOKIE_NAME`
- `AUTH_SESSION_TTL_HOURS`
- `AUTH_DEV_EMAIL_HEADER`
- `WEBAUTHN_RP_ID`
- `WEBAUTHN_RP_NAME`
- `WEBAUTHN_ORIGIN`

For local development:

- current HTTPS nginx setup is a good prerequisite
- local hostname/cert strategy should be kept stable for WebAuthn testing

## 18. Immediate Codebase Recommendations

Concrete next steps for this repo:

1. Introduce a principal abstraction in `apps/api/src/modules/auth`.
2. Move current `x-user-email` behavior behind a dev-only auth adapter.
3. Expand Prisma schema for user state and session storage.
4. Implement password login + session cookie endpoints first.
5. Add service account and API key support.
6. Remove manual email entry from `apps/web`.
7. Add WebAuthn after password/session and service auth are stable.

## 19. Recommended Decision

Preferred final design:

- Humans use first-party accounts.
- WebAuthn is the primary human authentication method.
- Passwords remain optional fallback/bootstrap only.
- Bots authenticate as service accounts with API keys.
- Authorization is principal-based and scoped.
- No third-party OAuth dependency is required.

This is the best fit for AgentWaypoint’s current requirements and future Discord bot integration.
