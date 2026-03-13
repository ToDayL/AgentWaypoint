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
- Project list and session list.
- New project/session actions.
- Search/filter support for larger lists.
- User account menu and sign-out.

2. Main Chat Pane (fluid center, always visible)
- Session header (project/session title, status, effective model/sandbox/cwd).
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

Sections:
- `Projects`
  - list item: name, optional workspace path hint, active indicator
- `Sessions` (for selected project)
  - list item: title, status, updated timestamp
- Quick actions:
  - `New Project`
  - `New Session`
  - `Refresh`

Interactions:
- Selecting project refreshes session list and current context.
- Selecting session hydrates chat history and turn state.
- Inline workspace and session override forms should remain, but not dominate layout.

## 3.2 Center Pane (Primary Workflow)

Sections:
- Header:
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
- Move existing controls into correct pane without changing API behavior.

### Phase B: Insights Consolidation
- Move tool/reasoning/plan/diff/event sections into right sidebar tabs.
- Add toggle + default visibility behavior.

### Phase C: Navigation Hardening
- Improve project/session list ergonomics (search, empty states, loading states).
- Add better selection persistence and skeleton loading.

### Phase D: UX Polish
- Keyboard shortcuts.
- Better status transitions and inline turn markers.
- Visual consistency pass with production-grade spacing/typography.

## 8. Acceptance Criteria

- Desktop renders as left nav + center chat + toggleable right insights.
- User can complete full workflow (select session, send turn, inspect diff/tool output) without leaving shell.
- Right sidebar can be opened/closed without losing content state.
- Mobile/tablet remain functional with drawer-based side panels.
- Existing auth/session and turn APIs continue to work unchanged.
