# AgentWaypoint Production UI Design

Last updated: 2026-03-13

## 1. Purpose

Define the production UI structure for AgentWaypoint with:
- left sidebar for workspace navigation (projects/sessions),
- center pane for primary chat workflow,
- right sidebar for optional engineering insights (diff/tool output/events).

This replaces the current MVP simulation-style stacked cards.

## 2. Layout Model

## 2.1 Desktop (primary)

Three-column application shell:

1. Left Sidebar (fixed width, always visible)
- Tabbed navigation surface for multiple app functions.
- Default tab: workspace tree (projects/sessions).
- Additional tabs: user config, admin config (role-gated).
- Search/filter support where relevant.
- User account menu and sign-out.

2. Main Chat Pane (fluid center, always visible)
- Session header (project/session title, status, effective model/sandbox/cwd).
- Top-center global action trigger for create/confirm flows.
- Scrollable message timeline.
- Composer at bottom (prompt input + actions).
- Turn status + approval prompts inline in conversation context.

3. Right Sidebar (toggleable)
- Tabbed insights:
  - Diff
  - Tool Output
  - Reasoning/Plan
  - Event Timeline
- Hidden by default on narrow desktop; persisted open/closed preference per user.

## 2.2 Tablet/Mobile

- Left sidebar becomes slide-over drawer.
- Right insights panel becomes slide-over drawer or bottom sheet.
- Center pane remains the default visible surface.

## 3. Information Architecture

## 3.1 Left Sidebar

The left sidebar is a tab container, not a single-purpose tree.

Default tabs:
1. `Explorer`
2. `User Config`
3. `Admin Config` (visible only for admin principal)

### 3.1.1 Explorer Tab

Sections:
- `Projects`
  - list item: name, optional workspace path hint, active indicator
  - per-project action icons:
    - create session
    - project config
    - remove project
- `Sessions` (for selected project)
  - list item: title, status, updated timestamp
  - per-session action icon:
    - remove session
- Quick actions:
  - `Refresh`

Interactions:
- Selecting project refreshes session list and current context.
- Selecting session hydrates chat history and turn state.
- Inline workspace and session override forms should remain, but not dominate layout.
- Create and confirm flows are not inline in tree rows; they use the top-center action panel.

### 3.1.2 User Config Tab

Purpose:
- Self-service settings and preferences for the signed-in user.

Initial scope:
- turn steering preference
- UI preferences (insights sidebar open/closed default, last selected tab)
- optional profile metadata (display name)

Behavior:
- Settings are saved per user.
- Tab is always visible for authenticated users.

### 3.1.3 Admin Config Tab

Purpose:
- Operational/admin controls for system and user/service management.

Visibility:
- Only shown when `principal.role === admin`.

Initial scope:
- user activation/deactivation
- session revocation controls
- service account and API key management (future auth phases)
- system/runtime switches suitable for admin UI

Behavior:
- Non-admin users never see this tab.
- Direct deep links to admin tab should still enforce server-side authorization.

## 3.2 Center Pane (Primary Workflow)

Sections:
- Header:
  - top-center action button (`+`) that opens action panel dropdown
  - session title
  - active turn status pill
  - effective execution context summary
- Message thread:
  - user/assistant messages
  - incremental assistant streaming
  - approval cards inline when pending
- Composer:
  - prompt textarea
  - `Start Turn` / `Steer Current Turn`
  - `Cancel Turn`

Design rules:
- Center pane is optimized for reading/writing, not settings.
- Technical metadata should move out of center whenever possible.

## 3.4 Top-Center Action Panel (Dropdown)

Purpose:
- Single place for create flows and destructive confirmations.

Trigger:
- `+` button centered in header area.

Modes:
1. Action Menu
- `Create Project`
- `Create Session` (enabled only when a project is selected)

2. Create Project Form
- project name
- workspace path (with suggestions)
- defaults (model/sandbox/approval policy)
- actions: `Cancel`, `Create`

3. Create Session Form
- title
- optional cwd/model/sandbox/approval overrides
- actions: `Cancel`, `Create`

4. Confirm Delete
- resource title (`project` or `session`)
- impact summary text
- actions: `Cancel`, `Delete`

Behavior:
- Anchored to top-center; closes on outside click or `Esc`.
- Keeps previous input while panel stays open.
- On success, panel closes and tree refreshes/selects new resource.
- For delete, require explicit confirmation button (danger style).

## 3.3 Right Sidebar (Insights)

Tabbed panel:
- `Diff`: current unified diff or diff summary.
- `Tools`: tool calls and output stream.
- `Plan/Reasoning`: plan updates + reasoning deltas.
- `Events`: normalized event timeline.

Controls:
- global toggle button in top bar (`Show Insights` / `Hide Insights`)
- tab selection persisted per session.

## 4. Core Interaction Flows

## 4.1 Login and Session Bootstrap

1. User lands on sign-in screen.
2. Password login sets secure session cookie.
3. App shell loads after `GET /api/sim/auth/session` confirms authenticated state.

## 4.2 Standard Chat Turn

1. User selects project + session in left sidebar.
2. User submits prompt in center pane.
3. Stream starts and updates:
  - assistant text in center,
  - tool/diff/reasoning/events in right sidebar.
4. On completion/failure/cancel:
  - status updates in header,
  - history remains visible.

## 4.4 Create Project/Session

1. User clicks top-center `+`.
2. User selects `Create Project` or `Create Session`.
3. User submits form in dropdown panel.
4. Tree updates:
- new project appears and can become selected.
- new session appears under selected project and can become active.

## 4.5 Delete Project/Session

1. User clicks delete icon on project or session row.
2. Top-center panel opens in `Confirm Delete` mode.
3. User confirms deletion.
4. Tree and center pane reconcile selection state (fallback to nearest valid item).

## 4.3 Approval Handling

1. Approval request appears inline in center pane.
2. User picks decision action.
3. Result state reflected both inline and in events tab.

## 5. Visual and UX Principles

- Chat-first hierarchy: center pane gets most space.
- Stable navigation: left sidebar never reflows the chat layout on desktop.
- Optional complexity: right panel is discoverable but not mandatory.
- High signal over noise: avoid dumping all runtime metadata above composer.
- Preserve keyboard-centric flow:
  - Enter/shortcut submit prompt,
  - quick focus to composer,
  - navigation without mouse where feasible.

## 6. Component Boundaries (Implementation Guidance)

Target React components:
- `AppShell`
- `LeftWorkspaceSidebar`
- `LeftSidebarTabs`
- `UserConfigPanel`
- `AdminConfigPanel`
- `ChatWorkspacePane`
- `InsightsSidebar`
- `AuthGate` (sign-in + session bootstrap)

State ownership:
- Global page state:
  - auth session
  - selected project/session
  - active turn ID/status
  - right-sidebar open/selected tab
- Pane-local state:
  - form inputs
  - local UI preferences

## 7. Phased Implementation Plan

### Phase A: Structural Refactor
- Introduce 3-pane shell layout and responsive breakpoints.
- Introduce left-sidebar tab framework (`Explorer`, `User Config`, role-gated `Admin Config`).
- Move existing controls into correct pane without changing API behavior.
- Introduce top-center action trigger and dropdown shell.

### Phase B: Insights Consolidation
- Move tool/reasoning/plan/diff/event sections into right sidebar tabs.
- Add toggle + default visibility behavior.

### Phase C: Navigation Hardening
- Improve project/session tree ergonomics (search, empty states, loading states).
- Add per-row action icons and top-center create/confirm panel integrations.
- Add better selection persistence and skeleton loading.

### Phase D: UX Polish
- Keyboard shortcuts.
- Better status transitions and inline turn markers.
- Visual consistency pass with production-grade spacing/typography.

## 8. Acceptance Criteria

- Desktop renders as left nav + center chat + toggleable right insights.
- Left sidebar supports tab navigation and preserves selected tab state.
- `Admin Config` tab is visible only to admin users.
- Top-center dropdown panel supports create project/session and delete confirmations.
- User can complete full workflow (select session, send turn, inspect diff/tool output) without leaving shell.
- Right sidebar can be opened/closed without losing content state.
- Mobile/tablet remain functional with drawer-based side panels.
- Existing auth/session and turn APIs continue to work unchanged.
