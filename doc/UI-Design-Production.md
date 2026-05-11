# AgentWaypoint UI Design

Last aligned with implementation: 2026-05-11

## 1. Current UI Model

The web UI is implemented primarily in `apps/web/src/app/page.tsx`. It is a single-page application with:

- password sign-in and session bootstrap,
- left sidebar navigation,
- center chat/workflow pane,
- optional right insights pane,
- top action panel for create/config/delete flows,
- file browser and preview,
- user/admin/config controls,
- bot integration controls for Discord.

The main product workflow calls `/api/channels/plugins/web/app/*`, not the older direct `/api/projects` and `/api/turns` paths.

## 2. Layout

### Desktop

- Header with sidebar controls, project/session context, status, context remaining, and insights controls.
- Left sidebar with icon rail and resizable/pinned/popover modes.
- Center pane for chat timeline, composer, approval cards, and workflow status.
- Right insights pane with resizable/pinned/popover modes.

### Mobile / Narrow Viewports

- Left sidebar and insights pane become mobile overlays.
- Center chat remains the primary surface.

## 3. Left Sidebar

Implemented tabs:

- `Explorer`
- `File Browser`
- `Config`

### Explorer

Implemented:

- project list,
- session list for selected project,
- create project/session action buttons,
- project/session config entry points,
- delete project/session confirmations.

### File Browser

Implemented:

- workspace tree,
- text preview,
- binary/image file-content route support,
- upload to workspace.

### Config

Implemented user controls:

- turn steering preference,
- password change,
- Codex rate limit panel,
- Discord integration creation/configuration/removal.

Implemented admin controls:

- user list,
- create user,
- update user role/status/password/default workspace root.

The UI does not currently expose a separate `Admin Config` tab; admin controls are shown inside Config when the authenticated principal is admin.

## 4. Center Pane

Implemented:

- selected project/session header context,
- message timeline,
- assistant streaming,
- reasoning display through `<think>` blocks,
- inline pending approval cards,
- approval decision actions,
- auto-approve pause/resume countdown control,
- prompt composer,
- start turn,
- steer current turn when enabled,
- cancel active turn,
- session fork and compact flows through action/config panels.

## 5. Right Insights Pane

Implemented tabs:

- `Preview`
- `Diff`
- `Events`

The current UI does not have separate `Tools` or `Plan/Reasoning` tabs. Tool, reasoning, and plan information is surfaced through event rendering and chat/timeline presentation.

## 6. Top Action Panel

Implemented modes include:

- create project,
- create session,
- project config,
- session config,
- delete confirmation,
- Discord integration create/config.

Project/session forms support backend, model, execution mode, and workspace path options where applicable.

## 7. Auth Flow

Implemented:

1. Web calls `GET /api/auth/session`.
2. If unauthenticated, sign-in form posts to `POST /api/auth/login/password`.
3. API sets session cookie.
4. Web loads projects/settings/integrations.
5. Logout posts to `POST /api/auth/logout`.

Dev `x-user-email` fallback is still supported by the proxy and API when `AUTH_DEV_EMAIL_HEADER=1`.

## 8. Current Gaps

- UI is still concentrated in a large page component rather than split into reusable feature components.
- Layout preferences are stored in browser local storage, not server-side settings.
- There is no separate admin navigation surface.
- No service-account/API-key management UI exists.
- No WebAuthn/passkey UI exists.
- Channel message retry/dead-letter UI is not implemented.

## 9. Practical Refactor Targets

1. Split `page.tsx` into auth, layout, explorer, file browser, chat, insights, settings, admin, and integrations components.
2. Move API client helpers out of the page component.
3. Keep the current route contracts stable while refactoring.
4. Add focused component/state tests around approval, streaming, and integration config flows.
