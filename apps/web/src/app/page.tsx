'use client';

import {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderPlus,
  FolderTree,
  GitFork,
  Info,
  Menu,
  Paperclip,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Settings,
  SlidersHorizontal,
  Trash2,
  UserCog,
} from 'lucide-react';
import { oneDark as codeMirrorOneDark } from '@codemirror/theme-one-dark';
import CodeMirror from '@uiw/react-codemirror';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Project = {
  id: string;
  name: string;
  backend?: string;
  backendConfig?: Record<string, unknown> | null;
  repoPath?: string | null;
  createdAt: string;
};

type Session = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

type AvailableModel = {
  id: string;
  backend: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};

type TurnSummary = {
  id: string;
  backend: string | null;
  status: string;
  requestedBackendConfig: Record<string, unknown> | null;
  effectiveBackendConfig: Record<string, unknown> | null;
  effectiveRuntimeConfig: Record<string, unknown> | null;
  failureCode: string | null;
  failureMessage: string | null;
  contextRemainingRatio: number | null;
  contextRemainingTokens: number | null;
  contextWindowTokens: number | null;
  contextUpdatedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
};

type SessionHistory = {
  session: Session;
  messages: ChatMessage[];
  turns: TurnSummary[];
  activeTurnId: string | null;
  activeTurnStatus: string | null;
};

type StreamEnvelope = {
  turnId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
type PanelLayoutPersistence = {
  left: {
    mode: SidebarMode;
    width: number;
    open: boolean;
    pinned: boolean;
  };
  right: {
    mode: SidebarMode;
    width: number;
    open: boolean;
    pinned: boolean;
  };
};
type TimelineEvent = {
  id: string;
  kind: 'tool' | 'reasoning' | 'plan' | 'diff' | 'approval' | 'token' | 'assistant' | 'event' | 'system';
  title: string;
  seqStart: number;
  seqEnd: number;
  createdAt: string;
  details: string[];
  diffFiles?: string[];
  status?: 'running' | 'completed';
  toolKey?: string;
};
type ParsedDiffFile = ReturnType<typeof parseDiff>[number];

type TurnStatusResponse = {
  id: string;
  sessionId: string;
  backend: string | null;
  status: string;
  requestedBackendConfig: Record<string, unknown> | null;
  effectiveBackendConfig: Record<string, unknown> | null;
  effectiveRuntimeConfig: Record<string, unknown> | null;
  failureCode: string | null;
  failureMessage: string | null;
  contextRemainingRatio: number | null;
  contextRemainingTokens: number | null;
  contextWindowTokens: number | null;
  contextUpdatedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  pendingApproval: PendingApproval | null;
};

type PendingApproval = {
  id: string;
  kind: string;
  status: string;
  decision: string | null;
  createdAt: string;
  resolvedAt: string | null;
  payload: Record<string, unknown>;
};

type AppSettings = {
  turnSteerEnabled: boolean;
  defaultWorkspaceRoot: string | null;
};

type WorkspaceTreeEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type WorkspaceFileResponse = {
  path: string;
  content: string;
  truncated: boolean;
};

type WorkspaceUploadResponse = {
  path: string;
  relativePath: string;
  size: number;
  mimeType: string;
};
type SkillOption = {
  name: string;
  description: string;
};

const DEFAULT_CODEX_MODEL = 'gpt-5-codex';
const DEFAULT_CODEX_EXECUTION_MODE = 'safe-write';

function buildCodexBackendConfig(input: {
  model: string;
  executionMode: string;
}): Record<string, string> | null {
  const config: Record<string, string> = {};
  if (input.model.trim()) {
    config.model = input.model.trim();
  }
  if (input.executionMode.trim()) {
    config.executionMode = input.executionMode.trim();
  }
  return Object.keys(config).length > 0 ? config : null;
}

function readCodexBackendConfig(config: Record<string, unknown> | null | undefined): {
  model: string;
  executionMode: string;
} {
  if (!config) {
    return {
      model: DEFAULT_CODEX_MODEL,
      executionMode: DEFAULT_CODEX_EXECUTION_MODE,
    };
  }
  return {
    model: typeof config.model === 'string' && config.model.trim() ? config.model : DEFAULT_CODEX_MODEL,
    executionMode:
      typeof config.executionMode === 'string' && config.executionMode.trim()
        ? config.executionMode
        : DEFAULT_CODEX_EXECUTION_MODE,
  };
}

function resolveModelDefault(models: AvailableModel[]): string {
  return models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? DEFAULT_CODEX_MODEL;
}

function mapExecutionModeToRuntime(executionMode: string): { sandbox: string; approvalPolicy: string } {
  if (executionMode === 'read-only') {
    return { sandbox: 'read-only', approvalPolicy: 'on-request' };
  }
  if (executionMode === 'yolo') {
    return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
}

function readTurnRuntimeConfig(config: Record<string, unknown> | null | undefined): {
  cwd: string | null;
  model: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
} {
  if (!config) {
    return { cwd: null, model: null, sandbox: null, approvalPolicy: null };
  }
  const cwd = typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd.trim() : null;
  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null;
  const sandbox = typeof config.sandbox === 'string' && config.sandbox.trim() ? config.sandbox.trim() : null;
  const approvalPolicy =
    typeof config.approvalPolicy === 'string' && config.approvalPolicy.trim() ? config.approvalPolicy.trim() : null;
  return { cwd, model, sandbox, approvalPolicy };
}

type RateLimitWindow = {
  usedPercent: number | null;
  resetsAt: number | null;
  windowDurationMins: number | null;
};

type CodexRateLimitsResponse = {
  rateLimits: {
    primary: RateLimitWindow | null;
    secondary: RateLimitWindow | null;
  } | null;
  rateLimitsByLimitId: Record<
    string,
    {
      primary: RateLimitWindow | null;
      secondary: RateLimitWindow | null;
    }
  > | null;
};

type AdminManagedUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
  authPolicy: string;
  defaultWorkspaceRoot: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AuthSessionResponse =
  | {
      authenticated: true;
      principal: {
        type: 'user';
        userId: string;
        email: string;
        role: 'admin' | 'user';
        authMethod: string;
      };
    }
  | {
      authenticated: false;
    };

type ApprovalDecisionInput =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: string[];
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          action: 'allow' | 'deny';
          host: string;
        };
      };
    };

type ApprovalActionOption = {
  key: string;
  label: string;
  decision: ApprovalDecisionInput;
  secondary?: boolean;
};

const EXECUTION_MODE_OPTIONS = [
  { value: 'read-only', label: 'read-only' },
  { value: 'safe-write', label: 'safe-write' },
  { value: 'yolo', label: 'yolo' },
];

const PROJECT_BACKEND_OPTIONS = [
  { value: 'codex', label: 'codex' },
  { value: 'claude', label: 'claude' },
];

const STREAM_EVENTS = [
  'turn.started',
  'assistant.delta',
  'turn.approval.requested',
  'turn.approval.resolved',
  'thread.token_usage.updated',
  'plan.updated',
  'reasoning.delta',
  'diff.updated',
  'tool.started',
  'tool.output',
  'tool.completed',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
];
const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const CHAT_MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const WORKSPACE_SUGGESTIONS_LIST_ID = 'workspace-path-suggestions';
const LAST_PROJECT_STORAGE_KEY_PREFIX = 'agentwaypoint:last-project:';
const LAST_SESSION_STORAGE_KEY_PREFIX = 'agentwaypoint:last-session:';
const PANEL_LAYOUT_STORAGE_KEY_PREFIX = 'agentwaypoint:panel-layout:';
const CHAT_VISIBLE_MESSAGE_STEP = 10;
const CHAT_SCROLL_IDLE_MS = 220;
const MAX_VISIBLE_DIFF_LINES = 20;
const LEFT_PANE_DEFAULT_WIDTH = 280;
const LEFT_PANE_MIN_WIDTH = 220;
const LEFT_PANE_MAX_RATIO = 0.55;
const RIGHT_PANE_DEFAULT_WIDTH = 340;
const RIGHT_PANE_MIN_WIDTH = 280;
const RIGHT_PANE_MAX_PIN_RATIO = 0.75;
const RIGHT_PANE_POP_CHAT_CLEARANCE = 320;
const FILE_NODE_LONG_PRESS_MS = 500;
const SESSION_DEBUG_INFO_ENABLED = process.env.NODE_ENV === 'development';
type LeftSidebarTab = 'explorer' | 'fileBrowser' | 'config';
type InsightsTab = 'preview' | 'diff' | 'events';
type SidebarMode = 'closed' | 'pop' | 'pin';
type ActionPanelMode =
  | 'closed'
  | 'createProject'
  | 'createSession'
  | 'projectConfig'
  | 'createUser'
  | 'manageUser'
  | 'confirmCompactSession'
  | 'confirmDeleteProject'
  | 'confirmDeleteSession';

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [nextPasswordInput, setNextPasswordInput] = useState('');
  const [confirmNextPasswordInput, setConfirmNextPasswordInput] = useState('');
  const [passwordChangeNotice, setPasswordChangeNotice] = useState('');
  const [adminUsers, setAdminUsers] = useState<AdminManagedUser[]>([]);
  const [newManagedUserEmail, setNewManagedUserEmail] = useState('');
  const [newManagedUserDisplayName, setNewManagedUserDisplayName] = useState('');
  const [newManagedUserPassword, setNewManagedUserPassword] = useState('');
  const [newManagedUserRole, setNewManagedUserRole] = useState<'admin' | 'user'>('user');
  const [newManagedUserIsActive, setNewManagedUserIsActive] = useState(true);
  const [newManagedUserDefaultWorkspaceRoot, setNewManagedUserDefaultWorkspaceRoot] = useState('');
  const [managedUserTarget, setManagedUserTarget] = useState<AdminManagedUser | null>(null);
  const [managedUserRoleDraft, setManagedUserRoleDraft] = useState<'admin' | 'user'>('user');
  const [managedUserActiveDraft, setManagedUserActiveDraft] = useState(true);
  const [managedUserPasswordDraft, setManagedUserPasswordDraft] = useState('');
  const [managedUserDefaultWorkspaceRootDraft, setManagedUserDefaultWorkspaceRootDraft] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState('');
  const [currentUserRole, setCurrentUserRole] = useState<'admin' | 'user'>('user');
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>({
    turnSteerEnabled: false,
    defaultWorkspaceRoot: null,
  });
  const [accountRateLimits, setAccountRateLimits] = useState<{
    fiveHour: RateLimitWindow | null;
    weekly: RateLimitWindow | null;
  }>({
    fiveHour: null,
    weekly: null,
  });
  const [accountRateLimitsBusy, setAccountRateLimitsBusy] = useState(false);
  const [turnSteerDraft, setTurnSteerDraft] = useState(false);
  const [defaultWorkspaceRootInput, setDefaultWorkspaceRootInput] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [newProjectName, setNewProjectName] = useState('Simulation Workspace');
  const [newProjectRepoPath, setNewProjectRepoPath] = useState('');
  const [newProjectBackend, setNewProjectBackend] = useState('codex');
  const [workspaceSuggestions, setWorkspaceSuggestions] = useState<string[]>([]);
  const [workspaceSuggestionBusy, setWorkspaceSuggestionBusy] = useState(false);
  const [newProjectDefaultModel, setNewProjectDefaultModel] = useState('');
  const [newProjectExecutionMode, setNewProjectExecutionMode] = useState(DEFAULT_CODEX_EXECUTION_MODE);
  const [projectConfigName, setProjectConfigName] = useState('');
  const [projectConfigRepoPath, setProjectConfigRepoPath] = useState('');
  const [projectConfigBackend, setProjectConfigBackend] = useState('codex');
  const [projectConfigDefaultModel, setProjectConfigDefaultModel] = useState(DEFAULT_CODEX_MODEL);
  const [projectConfigExecutionMode, setProjectConfigExecutionMode] = useState(DEFAULT_CODEX_EXECUTION_MODE);
  const [newSessionTitle, setNewSessionTitle] = useState('First Simulation Session');
  const [availableSkills, setAvailableSkills] = useState<SkillOption[]>([]);
  const [prompt, setPrompt] = useState('');
  const [promptCursor, setPromptCursor] = useState(0);
  const [skillSuggestionIndex, setSkillSuggestionIndex] = useState(0);
  const [skillSuggestionSuppressedKey, setSkillSuggestionSuppressedKey] = useState('');
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [assistantText, setAssistantText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [latestPlan, setLatestPlan] = useState('');
  const [toolOutput, setToolOutput] = useState('');
  const [latestDiffSummary, setLatestDiffSummary] = useState('');
  const [activeTurnId, setActiveTurnId] = useState('');
  const [resumedTurnHint, setResumedTurnHint] = useState('');
  const [turnStatus, setTurnStatus] = useState('idle');
  const [contextRemainingRatio, setContextRemainingRatio] = useState<number | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [streamBubbleTurnId, setStreamBubbleTurnId] = useState('');
  const [streamActive, setStreamActive] = useState(false);
  const [leftSidebarTab, setLeftSidebarTab] = useState<LeftSidebarTab>('explorer');
  const [leftSidebarMode, setLeftSidebarMode] = useState<SidebarMode>('pin');
  const [leftPaneWidth, setLeftPaneWidth] = useState(LEFT_PANE_DEFAULT_WIDTH);
  const [rightSidebarMode, setRightSidebarMode] = useState<SidebarMode>('closed');
  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH);
  const [insightsTab, setInsightsTab] = useState<InsightsTab>('events');
  const [previewFilePath, setPreviewFilePath] = useState('');
  const [previewFileContent, setPreviewFileContent] = useState('');
  const [previewFileTruncated, setPreviewFileTruncated] = useState(false);
  const [previewFileBusy, setPreviewFileBusy] = useState(false);
  const [previewFileError, setPreviewFileError] = useState('');
  const [expandedToolDetailKeys, setExpandedToolDetailKeys] = useState<Record<string, boolean>>({});
  const [recentMentionedPath, setRecentMentionedPath] = useState('');
  const [visibleMessageCount, setVisibleMessageCount] = useState(CHAT_VISIBLE_MESSAGE_STEP);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(true);
  const [mobileLeftSidebarOpen, setMobileLeftSidebarOpen] = useState(false);
  const [mobileInsightsOpen, setMobileInsightsOpen] = useState(false);
  const [fileBrowserNodes, setFileBrowserNodes] = useState<Record<string, WorkspaceTreeEntry[]>>({});
  const [fileBrowserExpandedPaths, setFileBrowserExpandedPaths] = useState<string[]>([]);
  const [fileBrowserError, setFileBrowserError] = useState('');
  const [disableNativePathDatalist, setDisableNativePathDatalist] = useState(false);
  const [projectPathInputFocused, setProjectPathInputFocused] = useState(false);
  const [actionPanelMode, setActionPanelMode] = useState<ActionPanelMode>('closed');
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [compactingContext, setCompactingContext] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const turnPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTurnCreateAbortRef = useRef<AbortController | null>(null);
  const leftPaneRef = useRef<HTMLElement | null>(null);
  const leftPaneResizeStateRef = useRef<{ leftEdge: number } | null>(null);
  const rightPaneRef = useRef<HTMLElement | null>(null);
  const rightPaneResizeStateRef = useRef<{
    rightEdge: number;
    mode: SidebarMode;
    leftMode: SidebarMode;
    leftWidth: number;
  } | null>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const chatAtBottomRef = useRef(true);
  const chatScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatScrollSettleRafRef = useRef<number | null>(null);
  const suppressBottomAutoCollapseRef = useRef(false);
  const previousDisplayedMessageCountRef = useRef(0);
  const chatScrollTopRef = useRef(0);
  const wasConfigFullscreenActiveRef = useRef(false);
  const previewLoadSeqRef = useRef(0);
  const fileNodeLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileNodeLongPressTriggeredRef = useRef(false);
  const mentionBlinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelLayoutHydratedRef = useRef(false);

  const canStartTurn = !!selectedSessionId && prompt.trim().length > 0 && activeTurnId === '';
  const canSteerTurn =
    appSettings.turnSteerEnabled && !!activeTurnId && prompt.trim().length > 0 && pendingApproval === null;
  const canManualCompact = !!selectedSessionId && !activeTurnId && !busy && !compactingContext;
  const normalizedDefaultWorkspaceRootDraft = defaultWorkspaceRootInput.trim() || null;
  const appSettingsDirty =
    turnSteerDraft !== appSettings.turnSteerEnabled ||
    normalizedDefaultWorkspaceRootDraft !== (appSettings.defaultWorkspaceRoot ?? null);
  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId),
    [projects, selectedProjectId],
  );
  const selectedSession = useMemo(
    () => sessions.find((item) => item.id === selectedSessionId),
    [sessions, selectedSessionId],
  );
  const sessionInfoTurn = useMemo(
    () => turns.find((item) => item.id === activeTurnId) ?? turns[turns.length - 1] ?? null,
    [turns, activeTurnId],
  );
  const resolvedSessionInfo = useMemo(() => {
    const turnRuntime = readTurnRuntimeConfig(sessionInfoTurn?.effectiveBackendConfig);
    const effectiveBackendConfig = sessionInfoTurn?.effectiveBackendConfig ?? null;
    const effectiveRuntimeConfig = sessionInfoTurn?.effectiveRuntimeConfig ?? null;
    const workspace =
      turnRuntime.cwd ||
      selectedProject?.repoPath?.trim() ||
      'not set';
    const codexBackendConfig = readCodexBackendConfig(selectedProject?.backendConfig);
    const effectiveExecutionMode =
      typeof effectiveBackendConfig?.executionMode === 'string' && effectiveBackendConfig.executionMode.trim()
        ? effectiveBackendConfig.executionMode.trim()
        : codexBackendConfig.executionMode;
    const model =
      turnRuntime.model ||
      codexBackendConfig.model;
    const runtimeEntries = effectiveRuntimeConfig ? Object.entries(effectiveRuntimeConfig) : [];
    return { workspace, model, executionMode: effectiveExecutionMode, runtimeEntries };
  }, [sessionInfoTurn, selectedSession, selectedProject]);
  const currentSessionDebugInfo = useMemo(
    () =>
      [
        `sessionId=${selectedSessionId || '-'}`,
        `sessionStatus=${selectedSession?.status || '-'}`,
        `activeTurnId=${activeTurnId || '-'}`,
        `turnStatus=${turnStatus || '-'}`,
        `streamBubbleTurnId=${streamBubbleTurnId || '-'}`,
        `streamActive=${streamActive ? 'true' : 'false'}`,
        `pendingApprovalId=${pendingApproval?.id || '-'}`,
      ].join('\n'),
    [selectedSessionId, selectedSession?.status, activeTurnId, turnStatus, streamBubbleTurnId, streamActive, pendingApproval?.id],
  );
  const activeWorkspacePath = useMemo(
    () =>
      readTurnRuntimeConfig(sessionInfoTurn?.effectiveBackendConfig).cwd ||
      selectedProject?.repoPath?.trim() ||
      '',
    [sessionInfoTurn, selectedSession, selectedProject],
  );
  const activeWorkspaceDirName = useMemo(() => {
    if (!activeWorkspacePath) {
      return '';
    }
    const normalized = activeWorkspacePath.replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? normalized;
  }, [activeWorkspacePath]);
  const activeSkillToken = useMemo(() => findSkillTokenContext(prompt, promptCursor), [prompt, promptCursor]);
  const filteredSkillSuggestions = useMemo(() => {
    if (!activeSkillToken) {
      return [];
    }
    const loweredPrefix = activeSkillToken.prefix.toLowerCase();
    const startsWithMatches = availableSkills.filter((skill) => skill.name.toLowerCase().startsWith(loweredPrefix));
    const containsMatches = availableSkills.filter(
      (skill) => !skill.name.toLowerCase().startsWith(loweredPrefix) && skill.name.toLowerCase().includes(loweredPrefix),
    );
    return [...startsWithMatches, ...containsMatches];
  }, [availableSkills, activeSkillToken]);
  const activeSkillSuggestionKey = useMemo(() => {
    if (!activeSkillToken) {
      return '';
    }
    return `${activeSkillToken.start}:${activeSkillToken.end}:${activeSkillToken.prefix.toLowerCase()}`;
  }, [activeSkillToken]);
  const skillSuggestionVisible =
    !!activeSkillToken &&
    filteredSkillSuggestions.length > 0 &&
    skillSuggestionSuppressedKey !== activeSkillSuggestionKey;
  const selectedSkillSuggestion =
    skillSuggestionVisible && filteredSkillSuggestions.length > 0
      ? filteredSkillSuggestions[Math.min(skillSuggestionIndex, filteredSkillSuggestions.length - 1)] ?? null
      : null;
  const displayedMessages = useMemo(() => {
    const base = messages.map((message) => ({ ...message, streaming: false }));
    if (!streamBubbleTurnId) {
      return base;
    }

    return [
      ...base,
      {
        id: `stream-${streamBubbleTurnId}`,
        role: 'assistant' as const,
        content: assistantText.length > 0 ? assistantText : streamActive ? '_Thinking..._' : '',
        createdAt: new Date().toISOString(),
        streaming: streamActive,
      },
    ];
  }, [messages, assistantText, streamBubbleTurnId, streamActive]);
  const hiddenMessageCount = Math.max(0, displayedMessages.length - visibleMessageCount);
  const visibleMessages = useMemo(() => {
    if (hiddenMessageCount === 0) {
      return displayedMessages;
    }
    return displayedMessages.slice(hiddenMessageCount);
  }, [displayedMessages, hiddenMessageCount]);
  const isAdmin = currentUserRole === 'admin';
  const configFullscreenActive =
    leftSidebarTab === 'config' && (leftSidebarMode !== 'closed' || mobileLeftSidebarOpen);
  const shellGridClassName = [
    'shell-grid',
    `left-${leftSidebarMode}`,
    `right-${rightSidebarMode}`,
    configFullscreenActive ? 'config-open' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const shellGridStyle = useMemo(
    () =>
      ({
        '--left-pane-width': `${leftPaneWidth}px`,
        '--right-pane-width': `${rightPaneWidth}px`,
        '--right-pop-left-clearance': `${computeRightPopLeftClearance(leftSidebarMode, leftPaneWidth)}px`,
      }) as CSSProperties,
    [leftPaneWidth, rightPaneWidth, leftSidebarMode],
  );
  const parsedDiffFiles = useMemo(() => {
    if (insightsTab !== 'diff' || !latestDiffSummary) {
      return [] as ParsedDiffFile[];
    }
    try {
      return parseDiff(latestDiffSummary);
    } catch {
      return [] as ParsedDiffFile[];
    }
  }, [insightsTab, latestDiffSummary]);
  const renderedDiff = useMemo(() => {
    if (!latestDiffSummary) {
      return null;
    }
    return {
      id: `latest-${latestDiffSummary.length}`,
      files: parsedDiffFiles,
      rawDiff: latestDiffSummary,
    };
  }, [latestDiffSummary, parsedDiffFiles]);
  const rawDiffLineCount = useMemo(() => countDiffTextLines(latestDiffSummary), [latestDiffSummary]);
  const previewIsMarkdown = useMemo(() => detectCodeLanguage(previewFilePath) === 'markdown', [previewFilePath]);
  const previewIsPdf = useMemo(() => isPdfPreviewPath(previewFilePath), [previewFilePath]);
  const previewIsImage = useMemo(() => isImagePreviewPath(previewFilePath), [previewFilePath]);
  const previewBinaryUri = useMemo(() => {
    if (!previewFilePath) {
      return '';
    }
    return `/api/fs/file-content?${new URLSearchParams({ path: previewFilePath }).toString()}`;
  }, [previewFilePath]);
  const previewCodeMirrorExtensions = useMemo(() => resolveCodeMirrorExtensions(previewFilePath), [previewFilePath]);

  const previewPanelView = useMemo(
    () => (
      <article className="sim-output">
        <h3>File Preview</h3>
        {!previewFilePath ? <pre>Select a file in File Browser and double click to preview.</pre> : null}
        {previewFilePath ? (
          <>
            <div className="diff-block-head">{previewFilePath}</div>
            {previewFileBusy ? <pre>Loading preview…</pre> : null}
            {!previewFileBusy && previewFileError ? <pre>{previewFileError}</pre> : null}
            {!previewFileBusy && !previewFileError ? (
              previewIsPdf ? (
                <object className="preview-pdf-object" data={previewBinaryUri} type="application/pdf" aria-label={previewFilePath}>
                  <a href={previewBinaryUri} target="_blank" rel="noreferrer">
                    Open PDF
                  </a>
                </object>
              ) : previewIsImage ? (
                <div className="preview-image-shell">
                  <img className="preview-image-native" src={previewBinaryUri} alt={previewFilePath} />
                </div>
              ) : previewIsMarkdown ? (
                <div className="chat-markdown preview-markdown">
                  <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}>{previewFileContent}</ReactMarkdown>
                </div>
              ) : (
                <CodeMirror
                  className="preview-codemirror"
                  value={previewFileContent}
                  theme={codeMirrorOneDark}
                  height="100%"
                  editable={false}
                  extensions={previewCodeMirrorExtensions}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: false,
                    dropCursor: false,
                    allowMultipleSelections: false,
                    indentOnInput: false,
                    autocompletion: false,
                    bracketMatching: true,
                    closeBrackets: false,
                    highlightActiveLine: false,
                    highlightActiveLineGutter: false,
                  }}
                />
              )
            ) : null}
            {previewFileTruncated ? <p className="sim-input-hint">Preview truncated to 256 KB.</p> : null}
          </>
        ) : null}
      </article>
    ),
    [
      previewFilePath,
      previewFileBusy,
      previewFileError,
      previewFileContent,
      previewFileTruncated,
      previewIsPdf,
      previewIsImage,
      previewBinaryUri,
      previewIsMarkdown,
      previewCodeMirrorExtensions,
    ],
  );
  const diffPanelView = useMemo(
    () => (
      <article className="sim-output sim-output-diff">
        {!renderedDiff ? <pre>No diff updates yet.</pre> : null}
        {renderedDiff ? (
          <div className="diff-list">
            {renderedDiff.files.length === 0 ? (
              <section
                key={renderedDiff.id}
                className={`diff-block ${rawDiffLineCount > MAX_VISIBLE_DIFF_LINES ? 'diff-block-scrollable' : ''}`}
              >
                <div className="diff-block-head">Latest Diff</div>
                <pre>{renderedDiff.rawDiff}</pre>
              </section>
            ) : null}
            {renderedDiff.files.map((file, fileIndex) => {
              const diffLineCount = countDiffFileLines(file);
              return (
                <section
                  key={`diff-${renderedDiff.id}-file-${fileIndex}`}
                  className={`diff-block ${diffLineCount > MAX_VISIBLE_DIFF_LINES ? 'diff-block-scrollable' : ''}`}
                >
                  <div className="diff-block-head">{formatDiffFileLabel(file)}</div>
                  <div className="diff-rdv-shell">
                    <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                      {(hunks) => hunks.map((hunk, hunkIndex) => <Hunk key={hunkIndex} hunk={hunk} />)}
                    </Diff>
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}
      </article>
    ),
    [renderedDiff, rawDiffLineCount],
  );

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      stopTurnStatusPolling();
      pendingTurnCreateAbortRef.current?.abort();
      pendingTurnCreateAbortRef.current = null;
      if (chatScrollIdleTimerRef.current) {
        clearTimeout(chatScrollIdleTimerRef.current);
        chatScrollIdleTimerRef.current = null;
      }
      if (typeof window !== 'undefined' && chatScrollSettleRafRef.current !== null) {
        window.cancelAnimationFrame(chatScrollSettleRafRef.current);
        chatScrollSettleRafRef.current = null;
      }
      clearFileNodeLongPressTimer();
      clearMentionBlinkTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void loadAuthSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }
    const ua = navigator.userAgent || '';
    const isiOS =
      /iPad|iPhone|iPod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
    setDisableNativePathDatalist(isiOS);
  }, []);

  useEffect(() => {
    if (!mounted || !authenticated) {
      return;
    }

    const prefix =
      actionPanelMode === 'projectConfig' ? projectConfigRepoPath.trim() : newProjectRepoPath.trim();
    if (!prefix) {
      setWorkspaceSuggestions([]);
      setWorkspaceSuggestionBusy(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setWorkspaceSuggestionBusy(true);
      void apiRequest<{ data: string[] }>(
        `/api/fs/suggestions?${new URLSearchParams({ prefix, limit: '8' }).toString()}`,
        {
          method: 'GET',
          signal: controller.signal,
        },
      )
        .then((response) => {
          setWorkspaceSuggestions(response.data ?? []);
        })
        .catch((requestError) => {
          if (isAbortError(requestError)) {
            return;
          }
          setWorkspaceSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setWorkspaceSuggestionBusy(false);
          }
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mounted, newProjectRepoPath, projectConfigRepoPath, actionPanelMode, authenticated]);

  useEffect(() => {
    if (!mounted || !authenticated || leftSidebarTab !== 'config') {
      return;
    }
    void loadAccountRateLimits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authenticated, leftSidebarTab]);

  useEffect(() => {
    if (typeof window === 'undefined' || !authenticated || !currentUserEmail || !selectedProjectId) {
      return;
    }
    writeLastProjectId(currentUserEmail, selectedProjectId);
  }, [authenticated, currentUserEmail, selectedProjectId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !authenticated || !currentUserEmail || !selectedProjectId || !selectedSessionId) {
      return;
    }
    if (!sessions.some((session) => session.id === selectedSessionId)) {
      return;
    }
    writeLastSessionId(currentUserEmail, selectedProjectId, selectedSessionId);
  }, [authenticated, currentUserEmail, selectedProjectId, selectedSessionId, sessions]);

  useEffect(() => {
    if (!mounted || !authenticated || !currentUserEmail) {
      panelLayoutHydratedRef.current = false;
      return;
    }
    if (panelLayoutHydratedRef.current) {
      return;
    }
    const layout = readPanelLayout(currentUserEmail);
    if (layout) {
      setLeftSidebarMode(layout.left.mode);
      setRightSidebarMode(layout.right.mode);
      setLeftPaneWidth(clampLeftPaneWidth(layout.left.width));
      setRightPaneWidth(clampRightPaneWidth(layout.right.width, layout.right.mode, layout.left.mode, layout.left.width));
    }
    panelLayoutHydratedRef.current = true;
  }, [mounted, authenticated, currentUserEmail]);

  useEffect(() => {
    if (typeof window === 'undefined' || !mounted || !authenticated || !currentUserEmail) {
      return;
    }
    writePanelLayout(currentUserEmail, {
      left: {
        mode: leftSidebarMode,
        width: leftPaneWidth,
        open: leftSidebarMode !== 'closed',
        pinned: leftSidebarMode === 'pin',
      },
      right: {
        mode: rightSidebarMode,
        width: rightPaneWidth,
        open: rightSidebarMode !== 'closed',
        pinned: rightSidebarMode === 'pin',
      },
    });
  }, [mounted, authenticated, currentUserEmail, leftSidebarMode, rightSidebarMode, leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    if (!mounted || !authenticated) {
      return;
    }
    if (!activeWorkspacePath) {
      setFileBrowserNodes({});
      setFileBrowserExpandedPaths([]);
      setFileBrowserError('');
      return;
    }
    setFileBrowserNodes({});
    setFileBrowserExpandedPaths([activeWorkspacePath]);
    setFileBrowserError('');
    void loadWorkspaceTree(activeWorkspacePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authenticated, activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      setPreviewFilePath('');
      setPreviewFileContent('');
      setPreviewFileTruncated(false);
      setPreviewFileBusy(false);
      setPreviewFileError('');
    }
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!mounted || !authenticated || !activeWorkspacePath) {
      setAvailableSkills([]);
      return;
    }

    const controller = new AbortController();
    const backend = typeof selectedProject?.backend === 'string' && selectedProject.backend.trim()
      ? selectedProject.backend.trim()
      : 'codex';
    const query = new URLSearchParams({
      cwd: activeWorkspacePath,
      backend,
    });
    void apiRequest<{ data?: Array<{ name?: string; description?: string; enabled?: boolean }> }>(
      `/api/skills?${query.toString()}`,
      { method: 'GET', signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        const skills = Array.isArray(response.data)
          ? response.data
              .filter(
                (item): item is { name?: string; description?: string; enabled?: boolean } =>
                  !!item && typeof item === 'object',
              )
              .map((item) => ({
                name: typeof item.name === 'string' ? item.name : '',
                description: typeof item.description === 'string' ? item.description : '',
                enabled: item.enabled !== false,
              }))
              .filter((item) => item.name.length > 0 && item.enabled)
              .map(({ name, description }) => ({ name, description }))
          : [];
        setAvailableSkills(skills);
      })
      .catch((requestError) => {
        if (isAbortError(requestError)) {
          return;
        }
        setAvailableSkills([]);
      });

    return () => {
      controller.abort();
    };
  }, [mounted, authenticated, activeWorkspacePath, selectedProject?.backend]);

  useEffect(() => {
    setSkillSuggestionIndex(0);
  }, [activeSkillSuggestionKey]);

  useEffect(() => {
    if (!skillSuggestionVisible) {
      setSkillSuggestionIndex(0);
      return;
    }
    setSkillSuggestionIndex((current) => Math.max(0, Math.min(current, filteredSkillSuggestions.length - 1)));
  }, [skillSuggestionVisible, filteredSkillSuggestions.length]);

  useEffect(() => {
    if (!skillSuggestionSuppressedKey || !activeSkillSuggestionKey) {
      return;
    }
    if (skillSuggestionSuppressedKey !== activeSkillSuggestionKey) {
      setSkillSuggestionSuppressedKey('');
    }
  }, [skillSuggestionSuppressedKey, activeSkillSuggestionKey]);

  useEffect(() => {
    const container = chatThreadRef.current;
    if (!container || !chatAtBottomRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [visibleMessages]);

  useEffect(() => {
    const previousCount = previousDisplayedMessageCountRef.current;
    if (displayedMessages.length > previousCount && visibleMessageCount !== CHAT_VISIBLE_MESSAGE_STEP) {
      setVisibleMessageCount(CHAT_VISIBLE_MESSAGE_STEP);
    }
    if (displayedMessages.length > previousCount) {
      suppressBottomAutoCollapseRef.current = false;
    }
    previousDisplayedMessageCountRef.current = displayedMessages.length;
  }, [displayedMessages.length, visibleMessageCount]);

  useEffect(() => {
    setVisibleMessageCount(CHAT_VISIBLE_MESSAGE_STEP);
    suppressBottomAutoCollapseRef.current = false;
  }, [selectedSessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!chatAtBottomRef.current) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      const container = chatThreadRef.current;
      if (!container) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [leftSidebarMode, rightSidebarMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleResize = () => {
      const nextLeftWidth = clampLeftPaneWidth(leftPaneWidth);
      setLeftPaneWidth(nextLeftWidth);
      setRightPaneWidth((current) => clampRightPaneWidth(current, rightSidebarMode, leftSidebarMode, nextLeftWidth));
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [rightSidebarMode, leftSidebarMode, leftPaneWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const onPointerMove = (event: globalThis.PointerEvent): void => {
      const leftResizeState = leftPaneResizeStateRef.current;
      if (leftResizeState) {
        const nextWidth = event.clientX - leftResizeState.leftEdge;
        const clampedLeftWidth = clampLeftPaneWidth(nextWidth);
        setLeftPaneWidth(clampedLeftWidth);
        setRightPaneWidth((current) => clampRightPaneWidth(current, rightSidebarMode, leftSidebarMode, clampedLeftWidth));
      }
      const resizeState = rightPaneResizeStateRef.current;
      if (!resizeState) {
        return;
      }
      const targetMode: SidebarMode = resizeState.mode === 'pop' ? 'pop' : 'pin';
      const nextWidth = resizeState.rightEdge - event.clientX;
      setRightPaneWidth(clampRightPaneWidth(nextWidth, targetMode, resizeState.leftMode, resizeState.leftWidth));
    };
    const onPointerUp = (): void => {
      leftPaneResizeStateRef.current = null;
      rightPaneResizeStateRef.current = null;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  useEffect(() => {
    const wasConfigFullscreenActive = wasConfigFullscreenActiveRef.current;
    if (configFullscreenActive && !wasConfigFullscreenActive) {
      const container = chatThreadRef.current;
      if (container) {
        chatScrollTopRef.current = container.scrollTop;
      }
    }
    if (!configFullscreenActive && wasConfigFullscreenActive) {
      if (typeof window === 'undefined') {
        return;
      }
      const rafId = window.requestAnimationFrame(() => {
        const container = chatThreadRef.current;
        if (!container) {
          return;
        }
        if (chatAtBottomRef.current) {
          container.scrollTop = container.scrollHeight;
          return;
        }
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = Math.min(chatScrollTopRef.current, maxScrollTop);
      });
      wasConfigFullscreenActiveRef.current = configFullscreenActive;
      return () => window.cancelAnimationFrame(rafId);
    }
    wasConfigFullscreenActiveRef.current = configFullscreenActive;
  }, [configFullscreenActive]);

  function handleChatScroll(): void {
    const container = chatThreadRef.current;
    if (!container) {
      return;
    }
    chatScrollTopRef.current = container.scrollTop;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    chatAtBottomRef.current = distanceFromBottom <= 24;
    if (!chatAtBottomRef.current) {
      suppressBottomAutoCollapseRef.current = false;
    }
    if (chatScrollIdleTimerRef.current) {
      clearTimeout(chatScrollIdleTimerRef.current);
      chatScrollIdleTimerRef.current = null;
    }
    if (typeof window !== 'undefined' && chatScrollSettleRafRef.current !== null) {
      window.cancelAnimationFrame(chatScrollSettleRafRef.current);
      chatScrollSettleRafRef.current = null;
    }
    const scheduledTop = container.scrollTop;
    chatScrollIdleTimerRef.current = setTimeout(() => {
      chatScrollIdleTimerRef.current = null;
      const currentContainer = chatThreadRef.current;
      if (!currentContainer || !chatAtBottomRef.current) {
        return;
      }
      if (suppressBottomAutoCollapseRef.current) {
        return;
      }
      if (typeof window === 'undefined') {
        setVisibleMessageCount((current) => (current === CHAT_VISIBLE_MESSAGE_STEP ? current : CHAT_VISIBLE_MESSAGE_STEP));
        return;
      }
      chatScrollSettleRafRef.current = window.requestAnimationFrame(() => {
        chatScrollSettleRafRef.current = null;
        const latestContainer = chatThreadRef.current;
        if (!latestContainer || !chatAtBottomRef.current) {
          return;
        }
        const settled = Math.abs(latestContainer.scrollTop - scheduledTop) <= 1;
        if (!settled) {
          return;
        }
        setVisibleMessageCount((current) => (current === CHAT_VISIBLE_MESSAGE_STEP ? current : CHAT_VISIBLE_MESSAGE_STEP));
      });
    }, CHAT_SCROLL_IDLE_MS);
  }

  function snapshotChatScrollState(): void {
    const container = chatThreadRef.current;
    if (!container) {
      return;
    }
    chatScrollTopRef.current = container.scrollTop;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    chatAtBottomRef.current = distanceFromBottom <= 24;
  }

  async function loadAuthSession(): Promise<void> {
    try {
      const response = await apiRequest<AuthSessionResponse>('/api/auth/session', {
        method: 'GET',
      });
      if (response.authenticated) {
        const userEmail = response.principal.email;
        setAuthenticated(true);
        setCurrentUserEmail(userEmail);
        setCurrentUserRole(response.principal.role);
        await loadAppSettings();
        if (response.principal.role === 'admin') {
          await loadAdminUsers();
        } else {
          setAdminUsers([]);
        }
        await loadAvailableModels('codex', { target: 'both' });
        const preferredProjectId = readLastProjectId(userEmail) ?? undefined;
        await loadProjects({
          preferredProjectId,
          preferredSessionId: preferredProjectId ? readLastSessionId(userEmail, preferredProjectId) ?? undefined : undefined,
          hydrateAllSessions: true,
        });
        return;
      }
      setAuthenticated(false);
      setCurrentUserEmail('');
      setCurrentUserRole('user');
    } catch {
      setAuthenticated(false);
      setCurrentUserEmail('');
      setCurrentUserRole('user');
    }
  }

  async function handleLogin(): Promise<void> {
    if (!authEmail.trim() || !authPassword.trim()) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiRequest<{ user: { email: string } }>('/api/auth/login/password', {
        method: 'POST',
        body: {
          email: authEmail.trim(),
          password: authPassword,
        },
      });
      setAuthPassword('');
      await loadAuthSession();
    } catch (requestError) {
      setError(extractMessage(requestError));
      setAuthenticated(false);
      setCurrentUserEmail('');
      setCurrentUserRole('user');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiRequest<{ success: boolean }>('/api/auth/logout', {
        method: 'POST',
        body: {},
      });
      setAuthenticated(false);
      setCurrentUserEmail('');
      setProjects([]);
      setSessions([]);
      setSessionsByProject({});
      setExpandedProjectIds([]);
      setSelectedProjectId('');
      setSelectedSessionId('');
      setMessages([]);
      setTurns([]);
      setTimelineEvents([]);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setLatestDiffSummary('');
      setActiveTurnId('');
      setResumedTurnHint('');
      setTurnStatus('idle');
      setPendingApproval(null);
      setStreamBubbleTurnId('');
      setStreamActive(false);
      setAdminUsers([]);
      setManagedUserTarget(null);
      setManagedUserPasswordDraft('');
      setManagedUserDefaultWorkspaceRootDraft('');
      setNewManagedUserDefaultWorkspaceRoot('');
      setDefaultWorkspaceRootInput('');
      setTurnSteerDraft(false);
      setFileBrowserNodes({});
      setFileBrowserExpandedPaths([]);
      setFileBrowserError('');
      setPreviewFilePath('');
      setPreviewFileContent('');
      setPreviewFileTruncated(false);
      setPreviewFileBusy(false);
      setPreviewFileError('');
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleChangePassword(): Promise<void> {
    if (!currentPasswordInput || !nextPasswordInput || !confirmNextPasswordInput) {
      return;
    }
    if (nextPasswordInput !== confirmNextPasswordInput) {
      setError('New password and confirmation do not match');
      setPasswordChangeNotice('');
      return;
    }

    setBusy(true);
    setError('');
    setPasswordChangeNotice('');
    try {
      await apiRequest<{ success: boolean }>('/api/auth/password/change', {
        method: 'POST',
        body: {
          currentPassword: currentPasswordInput,
          newPassword: nextPasswordInput,
        },
      });
      setCurrentPasswordInput('');
      setNextPasswordInput('');
      setConfirmNextPasswordInput('');
      setPasswordChangeNotice('Password updated');
    } catch (requestError) {
      setError(extractMessage(requestError));
      setPasswordChangeNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function loadAdminUsers(): Promise<void> {
    try {
      const users = (await apiRequest<AdminManagedUser[]>('/api/settings/users', {
        method: 'GET',
      })) as AdminManagedUser[];
      setAdminUsers(users);
    } catch (requestError) {
      setError(extractMessage(requestError));
    }
  }

  async function handleCreateManagedUser(): Promise<boolean> {
    if (!newManagedUserEmail.trim() || !newManagedUserPassword) {
      return false;
    }

    setBusy(true);
    setError('');
    try {
      await apiRequest<AdminManagedUser>('/api/settings/users', {
        method: 'POST',
        body: {
          email: newManagedUserEmail.trim(),
          displayName: newManagedUserDisplayName.trim() || null,
          password: newManagedUserPassword,
          role: newManagedUserRole,
          isActive: newManagedUserIsActive,
          defaultWorkspaceRoot: newManagedUserDefaultWorkspaceRoot.trim() || null,
        },
      });
      setNewManagedUserEmail('');
      setNewManagedUserDisplayName('');
      setNewManagedUserPassword('');
      setNewManagedUserRole('user');
      setNewManagedUserIsActive(true);
      setNewManagedUserDefaultWorkspaceRoot('');
      await loadAdminUsers();
      return true;
    } catch (requestError) {
      setError(extractMessage(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateManagedUser(
    userId: string,
    patch: Partial<Pick<AdminManagedUser, 'role' | 'isActive' | 'defaultWorkspaceRoot'>> & { password?: string },
  ): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiRequest<AdminManagedUser>(`/api/settings/users/${userId}`, {
        method: 'PATCH',
        body: patch as Record<string, unknown>,
      });
      await loadAdminUsers();
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function loadAppSettings(): Promise<void> {
    try {
      const response = await apiRequest<AppSettings>('/api/settings', {
        method: 'GET',
      });
      const normalizedWorkspaceRoot = response.defaultWorkspaceRoot?.trim() || null;
      setAppSettings({
        turnSteerEnabled: !!response.turnSteerEnabled,
        defaultWorkspaceRoot: normalizedWorkspaceRoot,
      });
      setTurnSteerDraft(!!response.turnSteerEnabled);
      setDefaultWorkspaceRootInput(normalizedWorkspaceRoot ?? '');
    } catch (requestError) {
      setError(extractMessage(requestError));
    }
  }

  async function loadAccountRateLimits(): Promise<void> {
    setAccountRateLimitsBusy(true);
    try {
      const response = await apiRequest<CodexRateLimitsResponse>('/api/settings/codex/rate-limits', {
        method: 'GET',
      });
      setAccountRateLimits(extract5hAndWeeklyLimits(response));
    } catch (requestError) {
      setError(extractMessage(requestError));
      setAccountRateLimits({
        fiveHour: null,
        weekly: null,
      });
    } finally {
      setAccountRateLimitsBusy(false);
    }
  }

  async function loadAvailableModels(
    backend = 'codex',
    options?: { target?: 'new' | 'config' | 'both'; preferredModel?: string | null },
  ): Promise<void> {
    try {
      const query = new URLSearchParams();
      if (backend.trim()) {
        query.set('backend', backend.trim());
      }
      const response = await apiRequest<{ data: AvailableModel[] }>(
        query.size > 0 ? `/api/models?${query.toString()}` : '/api/models',
        {
        method: 'GET',
        },
      );
      const models = response.data ?? [];
      setAvailableModels(models);
      const modelDefault = resolveModelDefault(models);
      const target = options?.target ?? 'both';
      const preferredModel =
        typeof options?.preferredModel === 'string' && options.preferredModel.trim().length > 0
          ? options.preferredModel.trim()
          : null;
      const resolvePreferredModel = (current: string): string => {
        const preferred = preferredModel ?? current.trim();
        if (preferred && models.some((item) => item.model === preferred)) {
          return preferred;
        }
        return modelDefault;
      };
      if (target === 'both' || target === 'new') {
        setNewProjectDefaultModel((current) => resolvePreferredModel(current));
      }
      if (target === 'both' || target === 'config') {
        setProjectConfigDefaultModel((current) => resolvePreferredModel(current));
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    }
  }

  if (!mounted) {
    return (
      <main className="sim-shell">
        <section className="sim-panel">
          <header className="sim-header">
            <p className="sim-kicker">AgentWaypoint Simulation</p>
            <h1>Web Interface MVP</h1>
            <p className="sim-subtitle">Loading…</p>
          </header>
        </section>
      </main>
    );
  }

  async function loadProjects(options?: {
    forceSelectFirst?: boolean;
    preferredProjectId?: string;
    preferredSessionId?: string;
    hydrateAllSessions?: boolean;
  }): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const items = (await apiRequest<Project[]>('/api/projects', {
        method: 'GET',
      })) as Project[];
      setProjects(items);
      setSessionsByProject((current) => {
        const next: Record<string, Session[]> = {};
        items.forEach((project) => {
          const cachedSessions = current[project.id];
          if (cachedSessions !== undefined) {
            next[project.id] = cachedSessions;
          }
        });
        return next;
      });
      setExpandedProjectIds((current) => current.filter((projectId) => items.some((project) => project.id === projectId)));
      if (items.length === 0) {
        setSessions([]);
        setSelectedSessionId('');
        return;
      }

      const hasSelectedProject = items.some((item) => item.id === selectedProjectId);
      const preferredProjectId = options?.preferredProjectId?.trim() ?? '';
      const preferredProject = preferredProjectId.length > 0 ? items.find((item) => item.id === preferredProjectId) : undefined;
      const firstProjectId = items[0]?.id ?? '';
      const nextProjectId =
        options?.forceSelectFirst === true
          ? firstProjectId
          : preferredProject?.id ?? (hasSelectedProject ? selectedProjectId : firstProjectId);

      if (options?.hydrateAllSessions) {
        const allProjectSessions = await Promise.all(
          items.map(async (project) => {
            const projectSessions = (await apiRequest<Session[]>(`/api/projects/${project.id}/sessions`, {
              method: 'GET',
            })) as Session[];
            return { projectId: project.id, sessions: projectSessions };
          }),
        );
        const sessionsMap: Record<string, Session[]> = {};
        allProjectSessions.forEach((entry) => {
          sessionsMap[entry.projectId] = entry.sessions;
        });
        setSessionsByProject(sessionsMap);
        setExpandedProjectIds((current) => {
          const next = current.filter((projectId) => items.some((project) => project.id === projectId));
          return next.includes(nextProjectId) ? next : [...next, nextProjectId];
        });
        const selectedProjectSessions =
          sessionsMap[nextProjectId] ?? [];
        setSelectedProjectId(nextProjectId);
        setSessions(selectedProjectSessions);

        const preferredSessionId = options?.preferredSessionId?.trim() ?? '';
        const preferredSession =
          preferredSessionId.length > 0 ? selectedProjectSessions.find((item) => item.id === preferredSessionId) : undefined;
        const currentlySelectedSession = selectedProjectSessions.find((item) => item.id === selectedSessionId);
        const nextSession = preferredSession ?? currentlySelectedSession ?? selectedProjectSessions[0];
        if (nextSession) {
          setSelectedSessionId(nextSession.id);
          await loadSessionHistory(nextSession.id, {
            resumeStream: true,
            resetEventLog: true,
            resetInspectPanel: true,
          });
        } else {
          setSelectedSessionId('');
          setMessages([]);
          setAssistantText('');
          setReasoningText('');
          setLatestPlan('');
          setToolOutput('');
          setLatestDiffSummary('');
          setActiveTurnId('');
          setResumedTurnHint('');
          setTurnStatus('idle');
          setPendingApproval(null);
          setTimelineEvents([]);
          setStreamBubbleTurnId('');
          setStreamActive(false);
        }
        return;
      }

      if (nextProjectId !== selectedProjectId || options?.forceSelectFirst === true) {
        setSelectedProjectId(nextProjectId);
        await loadSessions(nextProjectId, {
          preferredSessionId: options?.preferredSessionId,
        });
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveAppSettings(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const response = await apiRequest<AppSettings>('/api/settings', {
        method: 'POST',
        body: {
          turnSteerEnabled: turnSteerDraft,
          defaultWorkspaceRoot: normalizedDefaultWorkspaceRootDraft,
        },
      });
      const normalizedWorkspaceRoot = response.defaultWorkspaceRoot?.trim() || null;
      setAppSettings({
        turnSteerEnabled: !!response.turnSteerEnabled,
        defaultWorkspaceRoot: normalizedWorkspaceRoot,
      });
      setTurnSteerDraft(!!response.turnSteerEnabled);
      setDefaultWorkspaceRootInput(normalizedWorkspaceRoot ?? '');
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function loadSessions(projectId: string, options?: { preferredSessionId?: string }): Promise<void> {
    if (!projectId) {
      setSessions([]);
      setSelectedSessionId('');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const items = (await apiRequest<Session[]>(`/api/projects/${projectId}/sessions`, {
        method: 'GET',
      })) as Session[];
      setSessions(items);
      setSessionsByProject((current) => ({ ...current, [projectId]: items }));
      setExpandedProjectIds((current) => (current.includes(projectId) ? current : [...current, projectId]));
      const preferredSessionId = options?.preferredSessionId?.trim() ?? '';
      const preferredSession = preferredSessionId.length > 0 ? items.find((item) => item.id === preferredSessionId) : undefined;
      const currentlySelectedSession = items.find((item) => item.id === selectedSessionId);
      const nextSession = preferredSession ?? currentlySelectedSession ?? items[0];
      if (nextSession) {
        setSelectedSessionId(nextSession.id);
        await loadSessionHistory(nextSession.id, {
          resumeStream: true,
          resetEventLog: true,
          resetInspectPanel: true,
        });
      } else {
        setSelectedSessionId('');
        setMessages([]);
        setAssistantText('');
        setReasoningText('');
        setLatestPlan('');
        setToolOutput('');
        setLatestDiffSummary('');
        setActiveTurnId('');
        setResumedTurnHint('');
        setTurnStatus('idle');
        setPendingApproval(null);
        setTimelineEvents([]);
        setStreamBubbleTurnId('');
        setStreamActive(false);
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function loadWorkspaceTree(path: string): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }
    try {
      const response = await apiRequest<{ data: WorkspaceTreeEntry[] }>(
        `/api/fs/tree?${new URLSearchParams({ path: normalizedPath, limit: '200' }).toString()}`,
        {
          method: 'GET',
        },
      );
      setFileBrowserNodes((current) => ({ ...current, [normalizedPath]: response.data ?? [] }));
      setFileBrowserError('');
    } catch (requestError) {
      setFileBrowserError(extractMessage(requestError));
    }
  }

  function toggleFileBrowserDirectory(path: string): void {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }
    const expanded = fileBrowserExpandedPaths.includes(normalizedPath);
    if (expanded) {
      setFileBrowserExpandedPaths((current) => current.filter((item) => item !== normalizedPath));
      return;
    }
    setFileBrowserExpandedPaths((current) => [...current, normalizedPath]);
    if (!fileBrowserNodes[normalizedPath]) {
      void loadWorkspaceTree(normalizedPath);
    }
  }

  async function openFilePreview(path: string): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }
    const loadSeq = previewLoadSeqRef.current + 1;
    previewLoadSeqRef.current = loadSeq;

    setPreviewFilePath(normalizedPath);
    setPreviewFileContent('');
    setPreviewFileTruncated(false);
    setPreviewFileError('');
    setPreviewFileBusy(true);
    setInsightsTab('preview');
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches) {
      setMobileInsightsOpen(true);
    } else {
      setRightSidebarMode((current) => (current === 'closed' ? 'pop' : current));
    }

    if (isBinaryPreviewPath(normalizedPath)) {
      setPreviewFileBusy(false);
      return;
    }

    try {
      const response = await apiRequest<WorkspaceFileResponse>(
        `/api/fs/file?${new URLSearchParams({ path: normalizedPath, maxBytes: String(256 * 1024) }).toString()}`,
        {
          method: 'GET',
        },
      );
      if (previewLoadSeqRef.current !== loadSeq) {
        return;
      }
      setPreviewFilePath(response.path);
      setPreviewFileContent(response.content ?? '');
      setPreviewFileTruncated(response.truncated === true);
      setPreviewFileError('');
    } catch (requestError) {
      if (previewLoadSeqRef.current !== loadSeq) {
        return;
      }
      setPreviewFileError(extractMessage(requestError));
      setPreviewFileContent('');
      setPreviewFileTruncated(false);
    } finally {
      if (previewLoadSeqRef.current === loadSeq) {
        setPreviewFileBusy(false);
      }
    }
  }

  function appendWorkspacePathMention(targetPath: string): void {
    const workspaceRoot = activeWorkspacePath.trim();
    const normalizedTargetPath = targetPath.trim();
    if (!workspaceRoot || !normalizedTargetPath) {
      return;
    }
    const relativePath = resolveWorkspaceRelativePath(normalizedTargetPath, workspaceRoot);
    const mention = `@${relativePath}`;
    setPrompt((current) => {
      const base = current.trimEnd();
      if (!base) {
        return mention;
      }
      return `${base} ${mention}`;
    });
    triggerMentionBlink(targetPath);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const input = promptInputRef.current;
        if (!input) {
          return;
        }
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }

  function clearFileNodeLongPressTimer(): void {
    if (fileNodeLongPressTimerRef.current) {
      clearTimeout(fileNodeLongPressTimerRef.current);
      fileNodeLongPressTimerRef.current = null;
    }
  }

  function clearMentionBlinkTimer(): void {
    if (mentionBlinkTimerRef.current) {
      clearTimeout(mentionBlinkTimerRef.current);
      mentionBlinkTimerRef.current = null;
    }
  }

  function triggerMentionBlink(targetPath: string): void {
    const normalizedPath = targetPath.trim();
    if (!normalizedPath) {
      return;
    }
    clearMentionBlinkTimer();
    setRecentMentionedPath('');
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        setRecentMentionedPath(normalizedPath);
      });
    } else {
      setRecentMentionedPath(normalizedPath);
    }
    mentionBlinkTimerRef.current = setTimeout(() => {
      setRecentMentionedPath('');
      mentionBlinkTimerRef.current = null;
    }, 850);
  }

  function startFileNodeLongPress(targetPath: string): void {
    clearFileNodeLongPressTimer();
    fileNodeLongPressTriggeredRef.current = false;
    fileNodeLongPressTimerRef.current = setTimeout(() => {
      fileNodeLongPressTriggeredRef.current = true;
      appendWorkspacePathMention(targetPath);
      fileNodeLongPressTimerRef.current = null;
    }, FILE_NODE_LONG_PRESS_MS);
  }

  function handleFileNodePressEnd(): void {
    clearFileNodeLongPressTimer();
  }

  async function handleCreateProject(): Promise<boolean> {
    if (!newProjectName.trim()) {
      return false;
    }

    setBusy(true);
    setError('');
    try {
      const backendConfig = buildCodexBackendConfig({
        model: newProjectDefaultModel,
        executionMode: newProjectExecutionMode,
      });
      const created = await apiRequest<Project>('/api/projects', {
        method: 'POST',
        body: {
          name: newProjectName.trim(),
          backend: newProjectBackend,
          backendConfig,
          ...(newProjectRepoPath.trim() ? { repoPath: newProjectRepoPath.trim() } : {}),
        },
      });
      await loadProjects();
      setSelectedProjectId(created.id);
      await loadSessions(created.id);
      return true;
    } catch (requestError) {
      setError(extractMessage(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSession(): Promise<boolean> {
    if (!selectedProjectId || !newSessionTitle.trim()) {
      return false;
    }

    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<Session>(`/api/projects/${selectedProjectId}/sessions`, {
        method: 'POST',
        body: {
          title: newSessionTitle.trim(),
        },
      });
      await loadSessions(selectedProjectId);
      setSelectedSessionId(created.id);
      await loadSessionHistory(created.id, {
        resumeStream: true,
        resetEventLog: true,
        resetInspectPanel: true,
      });
      return true;
    } catch (requestError) {
      setError(extractMessage(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleForkSession(input: { sessionId: string; projectId: string }): Promise<void> {
    const sourceSessionId = input.sessionId.trim();
    const sourceProjectId = input.projectId.trim();
    if (!sourceSessionId || !sourceProjectId) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const forked = await apiRequest<Session>(`/api/sessions/${sourceSessionId}/fork`, {
        method: 'POST',
        body: {},
      });
      setSelectedProjectId(sourceProjectId);
      await loadSessions(sourceProjectId);
      setSelectedSessionId(forked.id);
      await loadSessionHistory(forked.id, {
        resumeStream: true,
        resetEventLog: true,
        resetInspectPanel: true,
      });
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleManualCompact(): Promise<void> {
    const sessionId = selectedSessionId.trim();
    if (!sessionId || activeTurnId) {
      return;
    }

    setBusy(true);
    setCompactingContext(true);
    setError('');
    try {
      await apiRequest<{ accepted: boolean }>(`/api/sessions/${sessionId}/compact`, {
        method: 'POST',
      });
      await loadSessionHistory(sessionId, {
        resumeStream: false,
        resetEventLog: false,
        resetInspectPanel: false,
      });
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
      setCompactingContext(false);
    }
  }

  function requestCompactSession(): void {
    if (!canManualCompact) {
      return;
    }
    openActionPanel('confirmCompactSession');
  }

  async function handleConfirmCompactFromPanel(): Promise<void> {
    await handleManualCompact();
    closeActionPanel();
  }

  function handleOpenUploadDialog(): void {
    setUploadError('');
    uploadInputRef.current?.click();
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }
    await uploadSelectedFiles(Array.from(files));
    event.target.value = '';
  }

  async function uploadSelectedFiles(files: File[]): Promise<void> {
    const workspacePath = activeWorkspacePath.trim();
    if (!workspacePath) {
      setUploadError('Configure workspace path before uploading files');
      return;
    }
    if (files.length === 0) {
      return;
    }

    setUploadingFiles(true);
    setUploadError('');
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('workspacePath', workspacePath);
        formData.append('file', file, file.name);
        const uploaded = await uploadRequest<WorkspaceUploadResponse>('/api/fs/upload', formData);
        appendWorkspacePathMention(uploaded.path);
      }
      await loadWorkspaceTree(workspacePath);
    } catch (requestError) {
      setUploadError(extractMessage(requestError));
    } finally {
      setUploadingFiles(false);
    }
  }

  async function handleSendTurn(): Promise<void> {
    if (!canStartTurn && !canSteerTurn) {
      return;
    }

    const userContent = prompt.trim();
    let optimisticMessageId = '';

    setBusy(true);
    setError('');

    try {
      if (canSteerTurn && activeTurnId) {
        const steerContent = prompt.trim();
        const optimisticMessageId = `steer-${Date.now()}`;
        setMessages((current) => [
          ...current,
          {
            id: optimisticMessageId,
            role: 'user',
            content: steerContent,
            createdAt: new Date().toISOString(),
          },
        ]);
        setPrompt('');
        try {
          await apiRequest<TurnStatusResponse>(`/api/turns/${activeTurnId}/steer`, {
            method: 'POST',
            body: { content: steerContent },
          });
        } catch {
          setMessages((current) => current.filter((message) => message.id !== optimisticMessageId));
          setPrompt(steerContent);
          throw new Error('Failed to steer the current turn');
        }
        return;
      }

      optimisticMessageId = `user-${Date.now()}`;
      setMessages((current) => [
        ...current,
        {
          id: optimisticMessageId,
          role: 'user',
          content: userContent,
          createdAt: new Date().toISOString(),
        },
      ]);
      setPrompt('');
      setTimelineEvents([]);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setLatestDiffSummary('');
      setResumedTurnHint('');
      setTurnStatus('queued');
      setContextRemainingRatio(null);
      setStreamActive(true);
      const pendingBubbleId = `pending-${Date.now()}`;
      setStreamBubbleTurnId(pendingBubbleId);
      const createTurnController = new AbortController();
      pendingTurnCreateAbortRef.current = createTurnController;

      const result = await apiRequest<{ turnId: string; status: string }>(`/api/sessions/${selectedSessionId}/turns`, {
        method: 'POST',
        body: { content: userContent },
        signal: createTurnController.signal,
      });
      if (pendingTurnCreateAbortRef.current === createTurnController) {
        pendingTurnCreateAbortRef.current = null;
      }

      setActiveTurnId(result.turnId);
      setStreamBubbleTurnId(result.turnId);
      setTurnStatus(result.status);
      await loadSessionHistory(selectedSessionId, {
        resumeStream: false,
        resetEventLog: false,
        resetInspectPanel: false,
      });
      openStream(result.turnId, selectedSessionId);
    } catch (requestError) {
      if (optimisticMessageId.length > 0) {
        setMessages((current) => current.filter((message) => message.id !== optimisticMessageId));
      }
      if (isAbortError(requestError)) {
        setTurnStatus('idle');
        setStreamActive(false);
        setStreamBubbleTurnId('');
        setPrompt(userContent);
        return;
      }
      setError(extractMessage(requestError));
      setTurnStatus('idle');
      setStreamActive(false);
      setStreamBubbleTurnId('');
      setPrompt(userContent);
    } finally {
      pendingTurnCreateAbortRef.current = null;
      setBusy(false);
    }
  }

  async function handleCancelTurn(): Promise<void> {
    if (!activeTurnId) {
      const pendingCreateController = pendingTurnCreateAbortRef.current;
      if (!pendingCreateController) {
        return;
      }
      pendingCreateController.abort();
      pendingTurnCreateAbortRef.current = null;
      setTurnStatus('idle');
      setStreamActive(false);
      setStreamBubbleTurnId('');
      return;
    }

    const cancellingTurnId = activeTurnId;
    const cancellingSessionId = selectedSessionId;
    setBusy(true);
    setError('');
    try {
      const cancelled = await apiRequest<{ status: string }>(`/api/turns/${cancellingTurnId}/cancel`, {
        method: 'POST',
      });
      setTurnStatus(cancelled.status);
      await loadSessionHistory(cancellingSessionId, {
        resumeStream: false,
        resetEventLog: false,
        resetInspectPanel: false,
      });
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveApproval(decision: ApprovalDecisionInput): Promise<void> {
    if (!activeTurnId || !pendingApproval) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await apiRequest<TurnStatusResponse>(`/api/turns/${activeTurnId}/approval`, {
        method: 'POST',
        body: {
          approvalId: pendingApproval.id,
          decision,
        },
      });
      await syncTurnState(activeTurnId);
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function loadSessionHistory(
    sessionId: string,
    options: { resumeStream: boolean; resetEventLog: boolean; resetInspectPanel: boolean },
  ): Promise<void> {
    if (!sessionId) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      stopTurnStatusPolling();
      setMessages([]);
      setTurns([]);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setLatestDiffSummary('');
      setActiveTurnId('');
      setResumedTurnHint('');
      setTurnStatus('idle');
      setContextRemainingRatio(null);
      setPendingApproval(null);
      setStreamBubbleTurnId('');
      setStreamActive(false);
      if (options.resetEventLog) {
        setTimelineEvents([]);
      }
      return;
    }

    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    stopTurnStatusPolling();
    setError('');
    try {
      const history = await apiRequest<SessionHistory>(`/api/sessions/${sessionId}/history`, {
        method: 'GET',
      });
      setMessages(history.messages);
      setTurns(history.turns);
      setTurnStatus(history.activeTurnStatus ?? 'idle');
      const latestTurn = history.turns[history.turns.length - 1] ?? null;
      setContextRemainingRatio(latestTurn?.contextRemainingRatio ?? null);
      setActiveTurnId(history.activeTurnId ?? '');
      setPendingApproval(null);
      if (history.activeTurnId) {
        setStreamBubbleTurnId(history.activeTurnId);
        setStreamActive(true);
      } else {
        setStreamBubbleTurnId('');
        setStreamActive(false);
      }
      if (options.resetInspectPanel) {
        setAssistantText('');
        setReasoningText('');
        setLatestPlan('');
        setToolOutput('');
        setLatestDiffSummary('');
      }
      if (options.resetEventLog) {
        setTimelineEvents([]);
      }
      if (history.activeTurnId) {
        await syncTurnState(history.activeTurnId);
      }
      if (options.resumeStream && history.activeTurnId) {
        setResumedTurnHint(`Resumed in-flight turn: ${history.activeTurnId}`);
        openStream(history.activeTurnId, sessionId);
      } else {
        setResumedTurnHint('');
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    }
  }

  async function syncTurnState(turnId: string): Promise<void> {
    const status = await apiRequest<TurnStatusResponse>(`/api/turns/${turnId}`, {
      method: 'GET',
    });
    setTurnStatus(status.status);
    setContextRemainingRatio((current) => status.contextRemainingRatio ?? current);
    setPendingApproval(status.pendingApproval);
    if (status.status === 'failed' && status.failureMessage) {
      setError(status.failureMessage);
    }
  }

  function openStream(turnId: string, sessionId: string): void {
    eventSourceRef.current?.close();
    const streamUrl = `/api/turns/${turnId}/stream`;
    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    const appendTimelineEvent = (envelope: StreamEnvelope): void => {
      setTimelineEvents((current) => mergeTimelineEvent(current, envelope));
    };
    const appendSystemTimelineEvent = (title: string): void => {
      setTimelineEvents((current) => [
        ...current,
        {
          id: `system-${Date.now()}-${current.length}`,
          kind: 'system',
          title,
          seqStart: -1,
          seqEnd: -1,
          createdAt: new Date().toISOString(),
          details: [],
        },
      ]);
    };

    STREAM_EVENTS.forEach((eventType) => {
      source.addEventListener(eventType, (evt) => {
        const message = evt as MessageEvent<string>;
        const envelope = JSON.parse(message.data) as StreamEnvelope;
        appendTimelineEvent(envelope);

        if (envelope.type === 'assistant.delta') {
          const delta = envelope.payload.text;
          if (typeof delta === 'string') {
            setAssistantText((current) => current + delta);
          }
        }

        if (envelope.type === 'reasoning.delta') {
          const delta = envelope.payload.delta;
          if (typeof delta === 'string') {
            setReasoningText((current) => current + delta);
          }
        }

        if (envelope.type === 'plan.updated') {
          setLatestPlan(formatPlanPayload(envelope.payload));
        }

        if (envelope.type === 'thread.token_usage.updated') {
          const ratio = resolveRemainingContextRatio(envelope.payload);
          if (ratio !== null) {
            setContextRemainingRatio(ratio);
          }
        }

        if (envelope.type === 'tool.output') {
          const delta = envelope.payload.text;
          if (typeof delta === 'string') {
            setToolOutput((current) => current + delta);
          }
        }

        if (envelope.type === 'diff.updated') {
          const summary = formatDiffPayload(envelope.payload);
          if (summary) {
            setLatestDiffSummary(summary);
          }
        }

        if (envelope.type === 'turn.started') {
          setTurnStatus('running');
        }

        if (envelope.type === 'turn.approval.requested') {
          setTurnStatus('waiting_approval');
          setPendingApproval({
            id: String(envelope.payload.requestId ?? ''),
            kind: typeof envelope.payload.kind === 'string' ? envelope.payload.kind : 'approval',
            status: 'pending',
            decision: null,
            createdAt: envelope.createdAt,
            resolvedAt: null,
            payload: envelope.payload,
          });
        }

        if (envelope.type === 'turn.approval.resolved') {
          setTurnStatus('running');
          void syncTurnState(turnId).catch(() => {
            // Keep current UI state on transient sync failure.
          });
        }

        if (envelope.type === 'turn.completed' || envelope.type === 'turn.failed' || envelope.type === 'turn.cancelled') {
          setTurnStatus(envelope.type.replace('turn.', ''));
          setStreamActive(false);
          setResumedTurnHint('');
          setPendingApproval(null);
          stopTurnStatusPolling();
            if (sessionId) {
              void loadSessionHistory(sessionId, {
                resumeStream: false,
                resetEventLog: false,
                resetInspectPanel: false,
              });
            }
          source.close();
          eventSourceRef.current = null;
        }
      });
    });

    source.onerror = () => {
      appendSystemTimelineEvent('Stream disconnected');
      source.close();
      eventSourceRef.current = null;
      if (turnId) {
        appendSystemTimelineEvent('Switched to turn status polling');
        startTurnStatusPolling(turnId, sessionId);
      }
    };
  }

  function stopTurnStatusPolling(): void {
    if (turnPollTimerRef.current) {
      clearInterval(turnPollTimerRef.current);
      turnPollTimerRef.current = null;
    }
  }

  function startTurnStatusPolling(turnId: string, sessionId: string): void {
    stopTurnStatusPolling();
    turnPollTimerRef.current = setInterval(() => {
      void (async () => {
        try {
          const status = await apiRequest<TurnStatusResponse>(`/api/turns/${turnId}`, {
            method: 'GET',
          });
          setTurnStatus(status.status);
          setContextRemainingRatio((current) => status.contextRemainingRatio ?? current);
          setPendingApproval(status.pendingApproval);
          if (status.status === 'failed' && status.failureMessage) {
            setError(status.failureMessage);
          }
          if (TERMINAL_TURN_STATUSES.has(status.status)) {
            stopTurnStatusPolling();
            setActiveTurnId('');
            setStreamActive(false);
            setResumedTurnHint('');
            setPendingApproval(null);
            if (sessionId) {
              await loadSessionHistory(sessionId, {
                resumeStream: false,
                resetEventLog: false,
                resetInspectPanel: false,
              });
            }
          }
        } catch (requestError) {
          setError(extractMessage(requestError));
        }
      })();
    }, 1200);
  }

  async function handleCreateProjectFromPanel(): Promise<void> {
    const created = await handleCreateProject();
    if (created) {
      closeActionPanel();
    }
  }

  async function handleCreateSessionFromPanel(): Promise<void> {
    const created = await handleCreateSession();
    if (created) {
      closeActionPanel();
    }
  }

  async function handleUpdateProjectConfigFromPanel(): Promise<void> {
    if (!selectedProjectId || !projectConfigName.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const backendConfig = buildCodexBackendConfig({
        model: projectConfigDefaultModel,
        executionMode: projectConfigExecutionMode,
      });
      await apiRequest<Project>(`/api/projects/${selectedProjectId}`, {
        method: 'PATCH',
        body: {
          name: projectConfigName.trim(),
          repoPath: projectConfigRepoPath.trim() || null,
          backend: projectConfigBackend,
          backendConfig,
        },
      });
      await loadProjects();
      closeActionPanel();
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  function openActionPanel(mode: ActionPanelMode): void {
    if (mode === 'createProject') {
      setNewProjectBackend('codex');
      setNewProjectExecutionMode(DEFAULT_CODEX_EXECUTION_MODE);
      void loadAvailableModels('codex', { target: 'new' });
    }
    setActionPanelMode(mode);
  }

  function openManageUserPanel(user: AdminManagedUser): void {
    setManagedUserTarget(user);
    setManagedUserRoleDraft(user.role);
    setManagedUserActiveDraft(user.isActive);
    setManagedUserPasswordDraft('');
    setManagedUserDefaultWorkspaceRootDraft(user.defaultWorkspaceRoot ?? '');
    openActionPanel('manageUser');
  }

  function openCreateUserPanel(): void {
    setNewManagedUserEmail('');
    setNewManagedUserDisplayName('');
    setNewManagedUserPassword('');
    setNewManagedUserRole('user');
    setNewManagedUserIsActive(true);
    setNewManagedUserDefaultWorkspaceRoot('');
    openActionPanel('createUser');
  }

  function openProjectConfigPanel(project: Project): void {
    const backendConfig = readCodexBackendConfig(project.backendConfig);
    const backend = project.backend?.trim() || 'codex';
    setSelectedProjectId(project.id);
    setProjectConfigName(project.name);
    setProjectConfigRepoPath(project.repoPath ?? '');
    setProjectConfigBackend(backend);
    setProjectConfigDefaultModel(backendConfig.model);
    setProjectConfigExecutionMode(backendConfig.executionMode);
    void loadAvailableModels(backend, { target: 'config', preferredModel: backendConfig.model });
    openActionPanel('projectConfig');
  }

  function handleLeftSidebarButtonClick(): void {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches) {
      setMobileLeftSidebarOpen(true);
      return;
    }
    setLeftSidebarMode((current) => (current === 'closed' ? 'pin' : 'closed'));
  }

  function handleInsightsButtonClick(): void {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches) {
      setInsightsTab('events');
      setMobileInsightsOpen(true);
      return;
    }
    setRightSidebarMode((current) => {
      const next = current === 'closed' ? 'pop' : 'closed';
      if (next !== 'closed') {
        setInsightsTab('events');
      }
      return next;
    });
  }

  function handleRightPaneResizeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    if (typeof window === 'undefined' || window.matchMedia('(max-width: 860px)').matches || rightSidebarMode === 'closed') {
      return;
    }
    const paneElement = rightPaneRef.current;
    if (!paneElement) {
      return;
    }
    event.preventDefault();
    const paneRect = paneElement.getBoundingClientRect();
    rightPaneResizeStateRef.current = {
      rightEdge: paneRect.right,
      mode: rightSidebarMode,
      leftMode: leftSidebarMode,
      leftWidth: leftPaneWidth,
    };
  }

  function handleLeftPaneResizeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    if (
      typeof window === 'undefined' ||
      window.matchMedia('(max-width: 860px)').matches ||
      leftSidebarMode === 'closed' ||
      leftSidebarTab === 'config'
    ) {
      return;
    }
    const paneElement = leftPaneRef.current;
    if (!paneElement) {
      return;
    }
    event.preventDefault();
    const paneRect = paneElement.getBoundingClientRect();
    leftPaneResizeStateRef.current = {
      leftEdge: paneRect.left,
    };
  }

  function toggleLeftSidebarPinMode(): void {
    setLeftSidebarMode((current) => (current === 'pin' ? 'pop' : 'pin'));
  }

  function toggleRightSidebarPinMode(): void {
    setRightSidebarMode((current) => (current === 'pin' ? 'pop' : 'pin'));
  }

  function closeLeftSidebar(): void {
    if (mobileLeftSidebarOpen) {
      setMobileLeftSidebarOpen(false);
      setLeftSidebarMode('closed');
      return;
    }
    setLeftSidebarMode('closed');
  }

  function closeRightSidebar(): void {
    if (mobileInsightsOpen) {
      setMobileInsightsOpen(false);
      return;
    }
    setRightSidebarMode('closed');
  }

  async function toggleProjectExpansion(projectId: string): Promise<void> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      return;
    }
    const isExpanded = expandedProjectIds.includes(normalizedProjectId);
    setExpandedProjectIds((current) =>
      isExpanded ? current.filter((item) => item !== normalizedProjectId) : [...current, normalizedProjectId],
    );
    if (isExpanded || sessionsByProject[normalizedProjectId]) {
      return;
    }
    try {
      const items = (await apiRequest<Session[]>(`/api/projects/${normalizedProjectId}/sessions`, {
        method: 'GET',
      })) as Session[];
      setSessionsByProject((current) => ({ ...current, [normalizedProjectId]: items }));
      if (selectedProjectId === normalizedProjectId) {
        setSessions(items);
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    }
  }

  function requestProjectDelete(project: Project): void {
    setProjectDeleteTarget(project);
    setSessionDeleteTarget(null);
    openActionPanel('confirmDeleteProject');
  }

  function requestSessionDelete(session: Session): void {
    setSessionDeleteTarget(session);
    setProjectDeleteTarget(null);
    openActionPanel('confirmDeleteSession');
  }

  function closeActionPanel(): void {
    setActionPanelMode('closed');
    setProjectDeleteTarget(null);
    setSessionDeleteTarget(null);
    setManagedUserTarget(null);
    setManagedUserPasswordDraft('');
    setManagedUserDefaultWorkspaceRootDraft('');
    setProjectConfigName('');
    setProjectConfigRepoPath('');
    setProjectConfigDefaultModel(DEFAULT_CODEX_MODEL);
    setProjectConfigExecutionMode(DEFAULT_CODEX_EXECUTION_MODE);
  }

  async function handleApplyManagedUserFromPanel(): Promise<void> {
    if (!managedUserTarget) {
      return;
    }
    const patch: Partial<Pick<AdminManagedUser, 'role' | 'isActive' | 'defaultWorkspaceRoot'>> & { password?: string } = {};
    if (managedUserRoleDraft !== managedUserTarget.role) {
      patch.role = managedUserRoleDraft;
    }
    if (managedUserActiveDraft !== managedUserTarget.isActive) {
      patch.isActive = managedUserActiveDraft;
    }
    if (managedUserPasswordDraft.trim()) {
      patch.password = managedUserPasswordDraft.trim();
    }
    if ((managedUserDefaultWorkspaceRootDraft.trim() || null) !== (managedUserTarget.defaultWorkspaceRoot ?? null)) {
      patch.defaultWorkspaceRoot = managedUserDefaultWorkspaceRootDraft.trim() || null;
    }
    if (Object.keys(patch).length === 0) {
      closeActionPanel();
      return;
    }
    await handleUpdateManagedUser(managedUserTarget.id, patch);
    closeActionPanel();
  }

  async function handleConfirmDelete(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      if (actionPanelMode === 'confirmDeleteProject' && projectDeleteTarget) {
        const deletingSelectedProject = selectedProjectId === projectDeleteTarget.id;
        await apiRequest(`/api/projects/${projectDeleteTarget.id}`, {
          method: 'DELETE',
        });
        if (deletingSelectedProject) {
          setSelectedProjectId('');
          setSelectedSessionId('');
        }
        await loadProjects({ forceSelectFirst: deletingSelectedProject });
      }
      if (actionPanelMode === 'confirmDeleteSession' && sessionDeleteTarget) {
        if (!selectedProjectId) {
          throw new Error('No project selected');
        }
        const deletingSelectedSession = selectedSessionId === sessionDeleteTarget.id;
        await apiRequest(`/api/sessions/${sessionDeleteTarget.id}`, {
          method: 'DELETE',
        });
        if (deletingSelectedSession) {
          setSelectedSessionId('');
        }
        await loadSessions(selectedProjectId);
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
      closeActionPanel();
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (skillSuggestionVisible && filteredSkillSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSkillSuggestionIndex((current) => (current + 1) % filteredSkillSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSkillSuggestionIndex((current) =>
          current === 0 ? filteredSkillSuggestions.length - 1 : current - 1,
        );
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        if (selectedSkillSuggestion) {
          applySkillSuggestion(selectedSkillSuggestion);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkillSuggestionSuppressedKey(activeSkillSuggestionKey);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (busy || (!canStartTurn && !canSteerTurn)) {
      return;
    }
    void handleSendTurn();
  }

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const nextPrompt = event.target.value;
    const selectionStart = event.target.selectionStart ?? nextPrompt.length;
    setPrompt(nextPrompt);
    setPromptCursor(selectionStart);
  }

  function handlePromptSelection(event: SyntheticEvent<HTMLTextAreaElement>): void {
    const target = event.currentTarget;
    setPromptCursor(target.selectionStart ?? prompt.length);
  }

  function applySkillSuggestion(skill: SkillOption): void {
    if (!activeSkillToken) {
      return;
    }
    const replacement = `$${skill.name} `;
    const nextPrompt = `${prompt.slice(0, activeSkillToken.start)}${replacement}${prompt.slice(activeSkillToken.end)}`;
    const nextCursor = activeSkillToken.start + replacement.length;
    setPrompt(nextPrompt);
    setPromptCursor(nextCursor);
    setSkillSuggestionSuppressedKey('');
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const input = promptInputRef.current;
        if (!input) {
          return;
        }
        input.focus();
        input.setSelectionRange(nextCursor, nextCursor);
      });
    }
  }

  function renderFileBrowserLevel(parentPath: string) {
    const entries = fileBrowserNodes[parentPath] ?? [];
    return (
      <ul className="file-browser-children">
        {entries.map((entry) => {
          const expanded = fileBrowserExpandedPaths.includes(entry.path);
          return (
            <li key={entry.path}>
              <button
                type="button"
                className={`file-node-row ${entry.isDirectory ? 'directory' : 'file'} ${
                  recentMentionedPath === entry.path ? 'mention-blink' : ''
                }`}
                onClick={() => {
                  if (fileNodeLongPressTriggeredRef.current) {
                    fileNodeLongPressTriggeredRef.current = false;
                    return;
                  }
                  if (entry.isDirectory) {
                    toggleFileBrowserDirectory(entry.path);
                  }
                }}
                onDoubleClick={() => {
                  if (fileNodeLongPressTriggeredRef.current) {
                    fileNodeLongPressTriggeredRef.current = false;
                    return;
                  }
                  if (!entry.isDirectory) {
                    void openFilePreview(entry.path);
                  }
                }}
                onPointerDown={() => startFileNodeLongPress(entry.path)}
                onPointerUp={() => handleFileNodePressEnd()}
                onPointerLeave={() => handleFileNodePressEnd()}
                onPointerCancel={() => handleFileNodePressEnd()}
                title={entry.path}
              >
                {entry.isDirectory ? (
                  expanded ? (
                    <ChevronDown />
                  ) : (
                    <ChevronRight />
                  )
                ) : (
                  <span className="file-node-spacer" />
                )}
                {entry.isDirectory ? <Folder /> : <File />}
                <span className="file-node-label">{entry.name}</span>
              </button>
              {entry.isDirectory && expanded ? (
                fileBrowserNodes[entry.path] ? renderFileBrowserLevel(entry.path) : null
              ) : null}
            </li>
          );
        })}
        {entries.length === 0 ? <li className="tree-empty">Empty directory</li> : null}
      </ul>
    );
  }

  const insightsOpen = rightSidebarMode !== 'closed' || mobileInsightsOpen;

  return (
    <main className="sim-shell">
      <section className="sim-panel">
        <header className="sim-header shell-header">
          {authenticated ? (
            <div className="header-mobile-side header-mobile-left">
              <button
                type="button"
                className="icon-button"
                onClick={handleLeftSidebarButtonClick}
                aria-label="Toggle sidebar"
                title="Toggle sidebar"
              >
                <Menu />
              </button>
              {leftSidebarMode !== 'closed' ? (
                <button
                  type="button"
                  className={`icon-button desktop-only ${leftSidebarMode === 'pin' ? 'is-active' : ''}`}
                  onClick={() => toggleLeftSidebarPinMode()}
                  aria-label={leftSidebarMode === 'pin' ? 'Unpin sidebar' : 'Pin sidebar'}
                  title={leftSidebarMode === 'pin' ? 'Unpin sidebar' : 'Pin sidebar'}
                >
                  <Pin />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="header-title">
            <h1>
              {authenticated
                ? `${(selectedProject?.name ?? 'No Project').trim()} - ${(selectedSession?.title ?? 'No Session').trim()}`
                : 'AgentWaypoint'}
              {authenticated ? <span className="status-pill">{turnStatus}</span> : null}
              {authenticated && contextRemainingRatio !== null ? (
                <button
                  type="button"
                  className={`status-pill status-pill-action ${
                    compactingContext
                      ? 'status-pill-pending'
                      : contextRemainingRatio < 0.3
                        ? 'status-pill-critical'
                        : 'status-pill-good'
                  }`}
                  onClick={() => requestCompactSession()}
                  disabled={!canManualCompact}
                  aria-label="Compact session context"
                  title={
                    !selectedSessionId
                      ? 'Select a session before compacting'
                      : activeTurnId
                        ? 'Wait for the active turn to finish before compacting'
                        : 'Compact context now'
                  }
                >
                  {compactingContext ? 'compacting...' : `context left ${formatPercent(contextRemainingRatio)}`}
                </button>
              ) : null}
            </h1>
          </div>
          {authenticated ? (
            <div className="header-mobile-side header-mobile-right">
              {rightSidebarMode !== 'closed' ? (
                <button
                  type="button"
                  className={`icon-button desktop-only ${rightSidebarMode === 'pin' ? 'is-active' : ''}`}
                  onClick={() => toggleRightSidebarPinMode()}
                  aria-label={rightSidebarMode === 'pin' ? 'Unpin insights' : 'Pin insights'}
                  title={rightSidebarMode === 'pin' ? 'Unpin insights' : 'Pin insights'}
                >
                  <Pin />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button"
                onClick={handleInsightsButtonClick}
                aria-label="Toggle insights"
                title="Toggle insights"
              >
                {insightsOpen ? <EyeOff /> : <Eye />}
              </button>
            </div>
          ) : null}
          {authenticated && actionPanelMode !== 'closed' ? (
            <div className="action-panel">
              {actionPanelMode === 'createProject' ? (
                <div className="action-panel-body">
                  <h3>Create Project</h3>
                  <label>
                    Name
                    <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} />
                  </label>
                  <label>
                    Workspace Path
                    <div className="path-input-wrap">
                      <input
                        value={newProjectRepoPath}
                        onFocus={() => setProjectPathInputFocused(true)}
                        onChange={(event) => setNewProjectRepoPath(event.target.value)}
                        onBlur={(event) => {
                          setNewProjectRepoPath(
                            applyDirectorySuggestionSelection(event.target.value, workspaceSuggestions),
                          );
                          setProjectPathInputFocused(false);
                        }}
                        list={disableNativePathDatalist ? undefined : WORKSPACE_SUGGESTIONS_LIST_ID}
                      />
                      {disableNativePathDatalist && projectPathInputFocused && workspaceSuggestions.length > 0 ? (
                        <div className="path-suggestions">
                          {workspaceSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              className="path-suggestion-item"
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setNewProjectRepoPath(ensureTrailingSlash(suggestion));
                                setProjectPathInputFocused(true);
                              }}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {disableNativePathDatalist ? null : (
                      <datalist id={WORKSPACE_SUGGESTIONS_LIST_ID}>
                        {workspaceSuggestions.map((suggestion) => (
                          <option key={suggestion} value={suggestion} />
                        ))}
                      </datalist>
                    )}
                    <span className="sim-input-hint">
                      {workspaceSuggestionBusy
                        ? 'Loading suggestions…'
                        : 'Directory suggestions by prefix. Leave empty to auto-create under your default workspace root.'}
                    </span>
                  </label>
                  <label>
                    Backend
                    <select
                      value={newProjectBackend}
                      onChange={(event) => {
                        const nextBackend = event.target.value.trim() || 'codex';
                        setNewProjectBackend(nextBackend);
                        void loadAvailableModels(nextBackend, { target: 'new' });
                      }}
                    >
                      {PROJECT_BACKEND_OPTIONS.map((option) => (
                        <option key={`project-backend-${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default Model
                    <select
                      value={newProjectDefaultModel}
                      onChange={(event) => setNewProjectDefaultModel(event.target.value)}
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Execution Mode
                    <select value={newProjectExecutionMode} onChange={(event) => setNewProjectExecutionMode(event.target.value)}>
                      {EXECUTION_MODE_OPTIONS.map((option) => (
                        <option key={`project-execution-mode-${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="sim-actions action-panel-actions-inline">
                    <button type="button" onClick={() => void handleCreateProjectFromPanel()} disabled={busy}>
                      Create
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {actionPanelMode === 'createSession' ? (
                <div className="action-panel-body">
                  <h3>Create Session</h3>
                  <label>
                    Title
                    <input value={newSessionTitle} onChange={(event) => setNewSessionTitle(event.target.value)} />
                  </label>
                  <div className="sim-actions action-panel-actions-inline">
                    <button type="button" onClick={() => void handleCreateSessionFromPanel()} disabled={busy}>
                      Create
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {actionPanelMode === 'projectConfig' ? (
                <div className="action-panel-body">
                  <h3>Project Config</h3>
                  <label>
                    Name
                    <input value={projectConfigName} onChange={(event) => setProjectConfigName(event.target.value)} />
                  </label>
                  <label>
                    Workspace Path
                    <div className="path-input-wrap">
                      <input
                        value={projectConfigRepoPath}
                        onFocus={() => setProjectPathInputFocused(true)}
                        onChange={(event) => setProjectConfigRepoPath(event.target.value)}
                        onBlur={(event) => {
                          setProjectConfigRepoPath(
                            applyDirectorySuggestionSelection(event.target.value, workspaceSuggestions),
                          );
                          setProjectPathInputFocused(false);
                        }}
                        list={disableNativePathDatalist ? undefined : WORKSPACE_SUGGESTIONS_LIST_ID}
                      />
                      {disableNativePathDatalist && projectPathInputFocused && workspaceSuggestions.length > 0 ? (
                        <div className="path-suggestions">
                          {workspaceSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              className="path-suggestion-item"
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setProjectConfigRepoPath(ensureTrailingSlash(suggestion));
                                setProjectPathInputFocused(true);
                              }}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {disableNativePathDatalist ? null : (
                      <datalist id={WORKSPACE_SUGGESTIONS_LIST_ID}>
                        {workspaceSuggestions.map((suggestion) => (
                          <option key={suggestion} value={suggestion} />
                        ))}
                      </datalist>
                    )}
                    <span className="sim-input-hint">
                      {workspaceSuggestionBusy ? 'Loading suggestions…' : 'Directory suggestions by prefix.'}
                    </span>
                  </label>
                  <label>
                    Backend
                    <select
                      value={projectConfigBackend}
                      onChange={(event) => {
                        const nextBackend = event.target.value.trim() || 'codex';
                        setProjectConfigBackend(nextBackend);
                        void loadAvailableModels(nextBackend, { target: 'config' });
                      }}
                    >
                      {PROJECT_BACKEND_OPTIONS.map((option) => (
                        <option key={`project-config-backend-${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default Model
                    <select
                      value={projectConfigDefaultModel}
                      onChange={(event) => setProjectConfigDefaultModel(event.target.value)}
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Execution Mode
                    <select value={projectConfigExecutionMode} onChange={(event) => setProjectConfigExecutionMode(event.target.value)}>
                      {EXECUTION_MODE_OPTIONS.map((option) => (
                        <option key={`project-config-execution-mode-${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="sim-actions">
                    <button
                      type="button"
                      onClick={() => void handleUpdateProjectConfigFromPanel()}
                      disabled={busy || !projectConfigName.trim()}
                    >
                      Save
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {actionPanelMode === 'createUser' ? (
                <div className="action-panel-body">
                  <h3>Create User</h3>
                  <label>
                    Email
                    <input
                      value={newManagedUserEmail}
                      onChange={(event) => setNewManagedUserEmail(event.target.value)}
                      placeholder="user@agentwaypoint.local"
                    />
                  </label>
                  <label>
                    Display Name
                    <input
                      value={newManagedUserDisplayName}
                      onChange={(event) => setNewManagedUserDisplayName(event.target.value)}
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    Default Workspace Root
                    <input
                      value={newManagedUserDefaultWorkspaceRoot}
                      onChange={(event) => setNewManagedUserDefaultWorkspaceRoot(event.target.value)}
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    Initial Password
                    <input
                      type="password"
                      value={newManagedUserPassword}
                      onChange={(event) => setNewManagedUserPassword(event.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                  <div className="admin-user-create-row">
                    <label>
                      Role
                      <select
                        value={newManagedUserRole}
                        onChange={(event) => setNewManagedUserRole(event.target.value === 'admin' ? 'admin' : 'user')}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </label>
                    <label className="inline-checkbox">
                      Active
                      <input
                        type="checkbox"
                        checked={newManagedUserIsActive}
                        onChange={(event) => setNewManagedUserIsActive(event.target.checked)}
                      />
                    </label>
                  </div>
                  <div className="sim-actions">
                    <button
                      type="button"
                      onClick={async () => {
                        const created = await handleCreateManagedUser();
                        if (created) {
                          closeActionPanel();
                        }
                      }}
                      disabled={busy || !newManagedUserEmail.trim() || !newManagedUserPassword}
                    >
                      Create
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {actionPanelMode === 'manageUser' ? (
                <div className="action-panel-body">
                  <h3>Manage User</h3>
                  <p>{managedUserTarget?.email ?? '-'}</p>
                  <label>
                    Role
                    <select
                      value={managedUserRoleDraft}
                      onChange={(event) => setManagedUserRoleDraft(event.target.value === 'admin' ? 'admin' : 'user')}
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </label>
                  <label className="inline-checkbox">
                    Active
                    <input
                      type="checkbox"
                      checked={managedUserActiveDraft}
                      onChange={(event) => setManagedUserActiveDraft(event.target.checked)}
                    />
                  </label>
                  <label>
                    Reset Password
                    <input
                      type="password"
                      value={managedUserPasswordDraft}
                      onChange={(event) => setManagedUserPasswordDraft(event.target.value)}
                      placeholder="Leave empty to keep unchanged"
                    />
                  </label>
                  <label>
                    Default Workspace Root
                    <input
                      value={managedUserDefaultWorkspaceRootDraft}
                      onChange={(event) => setManagedUserDefaultWorkspaceRootDraft(event.target.value)}
                      placeholder="Optional"
                    />
                  </label>
                  <div className="sim-actions">
                    <button type="button" onClick={() => void handleApplyManagedUserFromPanel()} disabled={busy}>
                      Apply
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {actionPanelMode === 'confirmDeleteProject' || actionPanelMode === 'confirmDeleteSession' ? (
                <div className="action-panel-body">
                  <h3>Confirm Delete</h3>
                  <p>
                    {actionPanelMode === 'confirmDeleteProject'
                      ? `Delete project "${projectDeleteTarget?.name ?? '-'}"?`
                      : `Delete session "${sessionDeleteTarget?.title ?? '-'}"?`}
                  </p>
                  <div className="sim-actions">
                    <button type="button" onClick={() => void handleConfirmDelete()} disabled={busy}>
                      Confirm Delete
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {actionPanelMode === 'confirmCompactSession' ? (
                <div className="action-panel-body">
                  <h3>Compact Context</h3>
                  <p>{`Compact context for "${selectedSession?.title?.trim() || 'this session'}" now?`}</p>
                  <div className="sim-actions">
                    <button type="button" onClick={() => void handleConfirmCompactFromPanel()} disabled={busy || compactingContext}>
                      Confirm Compact
                    </button>
                    <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </header>

        {!authenticated ? (
          <section className="login-shell">
            <article className="sim-card login-card">
              <h2>Sign In</h2>
              <label>
                Email
                <input
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                  placeholder="admin@agentwaypoint.local"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  placeholder="Your password"
                />
              </label>
              <button type="button" onClick={() => void handleLogin()} disabled={busy || !authEmail.trim() || !authPassword}>
                Sign In
              </button>
            </article>
          </section>
        ) : null}

        {authenticated ? (
          <div className={shellGridClassName} style={shellGridStyle}>
            {leftSidebarMode !== 'closed' || mobileLeftSidebarOpen ? (
              <aside
                ref={leftPaneRef}
                className={`left-sidebar ${mobileLeftSidebarOpen ? 'mobile-open' : `mode-${leftSidebarMode}`} ${
                  leftSidebarTab === 'config' ? 'config-fullscreen' : ''
                }`}
              >
                {!mobileLeftSidebarOpen && leftSidebarTab !== 'config' ? (
                  <div
                    className="left-pane-resize-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize explorer panel"
                    onPointerDown={handleLeftPaneResizeStart}
                  />
                ) : null}
                <div className="mobile-sidebar-head mobile-sidebar-head-left">
                  <button type="button" className="icon-button" onClick={() => closeLeftSidebar()} aria-label="Close sidebar">
                    <Menu />
                  </button>
                </div>
                <div className="left-sidebar-body">
                  <div className="left-sidebar-rail">
                    <button
                      type="button"
                      className={`icon-button ${leftSidebarTab === 'explorer' ? 'tab-active' : ''}`}
                      aria-label="Explorer"
                      title="Explorer"
                      onClick={() => setLeftSidebarTab('explorer')}
                    >
                      <FolderTree />
                    </button>
                    <button
                      type="button"
                      className={`icon-button ${leftSidebarTab === 'fileBrowser' ? 'tab-active' : ''}`}
                      aria-label="File Browser"
                      title="File Browser"
                      onClick={() => setLeftSidebarTab('fileBrowser')}
                    >
                      <Folder />
                    </button>
                    <button
                      type="button"
                      className={`icon-button ${leftSidebarTab === 'config' ? 'tab-active' : ''}`}
                      aria-label="Config"
                      title="Config"
                      onClick={() => {
                        snapshotChatScrollState();
                        setLeftSidebarTab('config');
                      }}
                    >
                      <SlidersHorizontal />
                    </button>
                  </div>

                  <div className="left-sidebar-content">
                    {leftSidebarTab === 'explorer' ? (
                      <div className="explorer-tree">
                        <div className="explorer-head">
                          <h3>Explorer</h3>
                          <div className="tree-actions-top">
                            <button
                              type="button"
                              className="icon-button"
                              title="Create Project"
                              aria-label="Create Project"
                              onClick={() => openActionPanel('createProject')}
                            >
                              <FolderPlus />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              title="Refresh Projects"
                              aria-label="Refresh Projects"
                              onClick={() => void loadProjects()}
                            >
                              <RefreshCw />
                            </button>
                          </div>
                        </div>
                        <ul className="tree-root">
                          {projects.map((project) => {
                            const sessionsForProject = sessionsByProject[project.id] ?? [];
                            const projectExpanded = expandedProjectIds.includes(project.id);
                            return <li key={project.id}>
                              <div
                                className={`tree-row ${selectedProjectId === project.id ? 'active' : ''}`}
                                onDoubleClick={() => {
                                  void toggleProjectExpansion(project.id);
                                }}
                              >
                                <button
                                  type="button"
                                  className="icon-button"
                                  title={projectExpanded ? 'Collapse Sessions' : 'Expand Sessions'}
                                  aria-label={projectExpanded ? 'Collapse Sessions' : 'Expand Sessions'}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void toggleProjectExpansion(project.id);
                                  }}
                                >
                                  {projectExpanded ? '-' : '+'}
                                </button>
                                <span className="tree-label">{project.name}</span>
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    className="icon-button"
                                    title="Create Session"
                                    aria-label="Create Session"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelectedProjectId(project.id);
                                      openActionPanel('createSession');
                                    }}
                                  >
                                    <Plus />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button"
                                    title="Project Config"
                                    aria-label="Project Config"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openProjectConfigPanel(project);
                                    }}
                                  >
                                    <Settings />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button"
                                    title="Remove Project"
                                    aria-label="Remove Project"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      requestProjectDelete(project);
                                    }}
                                  >
                                    <Trash2 />
                                  </button>
                                </div>
                              </div>
                              {projectExpanded ? (
                                <ul className="tree-children">
                                  {sessionsForProject.length === 0 ? <li className="tree-empty">No sessions</li> : null}
                                  {sessionsForProject.map((session) => (
                                    <li key={session.id}>
                                      <div
                                        className={`tree-row session-row ${selectedSessionId === session.id ? 'active' : ''}`}
                                        onClick={() => {
                                          setSelectedProjectId(project.id);
                                          setSessions(sessionsForProject);
                                          setSelectedSessionId(session.id);
                                          void loadSessionHistory(session.id, {
                                            resumeStream: true,
                                            resetEventLog: true,
                                            resetInspectPanel: true,
                                          });
                                          setMobileLeftSidebarOpen(false);
                                        }}
                                        onDoubleClick={() => {
                                          void toggleProjectExpansion(project.id);
                                        }}
                                      >
                                        <span className="tree-label">{session.title}</span>
                                        <div className="row-actions">
                                          <button
                                            type="button"
                                            className="icon-button"
                                            title="Fork Session"
                                            aria-label="Fork Session"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void handleForkSession({ sessionId: session.id, projectId: project.id });
                                            }}
                                            disabled={busy}
                                          >
                                            <GitFork />
                                          </button>
                                          <button
                                            type="button"
                                            className="icon-button"
                                            title="Remove Session"
                                            aria-label="Remove Session"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              requestSessionDelete(session);
                                            }}
                                          >
                                            <Trash2 />
                                          </button>
                                        </div>
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          })}
                        </ul>
                      </div>
                    ) : null}

                    {leftSidebarTab === 'fileBrowser' ? (
                      <div className="file-browser">
                        <div className="explorer-head file-browser-head">
                          <h3>File Browser</h3>
                          <div className="tree-actions-top">
                            <button
                              type="button"
                              className="icon-button"
                              title="Refresh File Browser"
                              aria-label="Refresh File Browser"
                              onClick={() => {
                                if (!activeWorkspacePath) {
                                  return;
                                }
                                setFileBrowserNodes({});
                                setFileBrowserExpandedPaths([activeWorkspacePath]);
                                void loadWorkspaceTree(activeWorkspacePath);
                              }}
                              disabled={!activeWorkspacePath}
                            >
                              <RefreshCw />
                            </button>
                          </div>
                        </div>
                        {activeWorkspacePath ? (
                          <>
                            <button
                              type="button"
                              className={`file-node-row directory file-node-root ${
                                recentMentionedPath === activeWorkspacePath ? 'mention-blink' : ''
                              }`}
                              onClick={() => {
                                if (fileNodeLongPressTriggeredRef.current) {
                                  fileNodeLongPressTriggeredRef.current = false;
                                  return;
                                }
                                toggleFileBrowserDirectory(activeWorkspacePath);
                              }}
                              onPointerDown={() => startFileNodeLongPress(activeWorkspacePath)}
                              onPointerUp={() => handleFileNodePressEnd()}
                              onPointerLeave={() => handleFileNodePressEnd()}
                              onPointerCancel={() => handleFileNodePressEnd()}
                              title={activeWorkspacePath}
                            >
                              {fileBrowserExpandedPaths.includes(activeWorkspacePath) ? <ChevronDown /> : <ChevronRight />}
                              <Folder />
                              <span className="file-node-label">{activeWorkspaceDirName || activeWorkspacePath}</span>
                            </button>
                            <p className="file-browser-root-path" title={activeWorkspacePath}>
                              {activeWorkspacePath}
                            </p>
                            {fileBrowserError ? <p className="file-browser-state file-browser-error">{fileBrowserError}</p> : null}
                            {fileBrowserExpandedPaths.includes(activeWorkspacePath) && fileBrowserNodes[activeWorkspacePath]
                              ? renderFileBrowserLevel(activeWorkspacePath)
                              : null}
                          </>
                        ) : (
                          <p className="file-browser-state">Select a session to view its workspace tree.</p>
                        )}
                      </div>
                    ) : null}

                    {leftSidebarTab === 'config' ? (
                      <div className="left-config-panel">
                        <h2>Config</h2>
                        <p>Signed in as: <strong>{currentUserEmail}</strong></p>
                        <h3>Codex Rate Limits</h3>
                        {accountRateLimitsBusy ? <p>Loading Codex rate limits…</p> : null}
                        {!accountRateLimitsBusy ? (
                          <div className="rate-limit-list">
                            <div className="rate-limit-item">
                              <div className="rate-limit-head">
                                <strong>5h</strong>
                                <span>{formatRateLimitReset(accountRateLimits.fiveHour)}</span>
                              </div>
                              <div className="rate-limit-track">
                                <div
                                  className={`rate-limit-fill ${rateLimitFillClass(accountRateLimits.fiveHour)}`}
                                  style={{ width: `${formatRateLimitRemainingPercent(accountRateLimits.fiveHour)}%` }}
                                />
                              </div>
                            </div>
                            <div className="rate-limit-item">
                              <div className="rate-limit-head">
                                <strong>Week</strong>
                                <span>{formatRateLimitReset(accountRateLimits.weekly)}</span>
                              </div>
                              <div className="rate-limit-track">
                                <div
                                  className={`rate-limit-fill ${rateLimitFillClass(accountRateLimits.weekly)}`}
                                  style={{ width: `${formatRateLimitRemainingPercent(accountRateLimits.weekly)}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        ) : null}
                        <label className="inline-checkbox">
                          <span>Turn Steering</span>
                          <input
                            type="checkbox"
                            checked={turnSteerDraft}
                            onChange={(event) => setTurnSteerDraft(event.target.checked)}
                            disabled={busy}
                          />
                        </label>
                        <label>
                          Default Workspace Root
                          <input
                            value={defaultWorkspaceRootInput}
                            onChange={(event) => setDefaultWorkspaceRootInput(event.target.value)}
                            placeholder="$HOME/AgentWaypoint/workspaces"
                          />
                        </label>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void handleSaveAppSettings()}
                          disabled={busy || !appSettingsDirty}
                        >
                          Save Settings
                        </button>
                        <button type="button" className="button-secondary" onClick={() => void handleLogout()} disabled={busy}>
                          Sign Out
                        </button>
                        <h3>Password</h3>
                        <label>
                          Current Password
                          <input
                            type="password"
                            value={currentPasswordInput}
                            onChange={(event) => setCurrentPasswordInput(event.target.value)}
                            autoComplete="current-password"
                          />
                        </label>
                        <label>
                          New Password
                          <input
                            type="password"
                            value={nextPasswordInput}
                            onChange={(event) => setNextPasswordInput(event.target.value)}
                            autoComplete="new-password"
                          />
                        </label>
                        <label>
                          Confirm New Password
                          <input
                            type="password"
                            value={confirmNextPasswordInput}
                            onChange={(event) => setConfirmNextPasswordInput(event.target.value)}
                            autoComplete="new-password"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleChangePassword()}
                          disabled={busy || !currentPasswordInput || !nextPasswordInput || !confirmNextPasswordInput}
                        >
                          Update Password
                        </button>
                        {passwordChangeNotice ? <p className="sim-input-hint">{passwordChangeNotice}</p> : null}
                        {isAdmin ? (
                          <>
                            <h3>Admin Users</h3>
                            <div className="admin-user-list">
                              {adminUsers.length === 0 ? <p className="sim-subtitle">No users found.</p> : null}
                              {adminUsers.length > 0 ? (
                                <table className="admin-user-table">
                                  <thead>
                                    <tr>
                                      <th>Email</th>
                                      <th>Name</th>
                                      <th>Role</th>
                                      <th>Status</th>
                                      <th>Last Login</th>
                                      <th />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {adminUsers.map((user) => (
                                      <tr key={user.id}>
                                        <td>{user.email}</td>
                                        <td>{user.displayName || '-'}</td>
                                        <td>{user.role}</td>
                                        <td>{user.isActive ? 'active' : 'inactive'}</td>
                                        <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '-'}</td>
                                        <td>
                                          <button
                                            type="button"
                                            className="button-secondary"
                                            onClick={() => openManageUserPanel(user)}
                                            disabled={busy}
                                          >
                                            <UserCog /> Manage
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : null}
                              <button
                                type="button"
                                className="icon-button admin-user-create-bottom"
                                onClick={() => openCreateUserPanel()}
                                aria-label="Create User"
                                title="Create User"
                                disabled={busy}
                              >
                                <Plus />
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </aside>
            ) : null}

            {!configFullscreenActive ? <section className="chat-pane">
              <div className="chat-thread" ref={chatThreadRef} onScroll={handleChatScroll}>
                {displayedMessages.length === 0 ? <p className="chat-empty">No messages yet.</p> : null}
                {hiddenMessageCount > 0 ? (
                  <button
                    type="button"
                    className="button-secondary chat-show-more"
                    onClick={() => {
                      suppressBottomAutoCollapseRef.current = true;
                      setVisibleMessageCount((current) => Math.min(current + CHAT_VISIBLE_MESSAGE_STEP, displayedMessages.length));
                    }}
                  >
                    Show More
                  </button>
                ) : null}
                {visibleMessages.map((message) => (
                  <article
                    key={message.id}
                    className={`chat-message ${message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}`}
                  >
                    <header className="chat-message-meta">
                      <span>{message.role === 'user' ? 'You' : 'Assistant'}</span>
                      {'streaming' in message && message.streaming ? (
                        <div className="chat-streaming-actions">
                          <span className="status-pill">streaming</span>
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => void handleCancelTurn()}
                            disabled={!activeTurnId || busy}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : null}
                    </header>
                    <div className="chat-markdown">
                      <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}>
                        {renderChatMessageMarkdown(message.content)}
                      </ReactMarkdown>
                    </div>
                  </article>
                ))}
              </div>

              {pendingApproval ? (
                <article className="sim-approval">
                  <h3>Approval Required</h3>
                  <div className="sim-approval-body">
                    {(() => {
                      const reason = readApprovalTextField(pendingApproval.payload, 'reason');
                      const command = readApprovalCommand(pendingApproval.payload);
                      const cwd = readApprovalTextField(pendingApproval.payload, 'cwd');
                      return (
                        <>
                          <p>
                            <strong>{formatApprovalKind(pendingApproval.kind)}</strong>
                          </p>
                          <p className="sim-approval-meta">
                            Purpose: {reason ?? 'Not provided by runtime'}
                          </p>
                          {command ? (
                            <pre className="sim-approval-command">{command}</pre>
                          ) : (
                            <p className="sim-approval-meta">Command: Not provided by runtime</p>
                          )}
                          {cwd ? (
                            <p className="sim-approval-meta sim-approval-meta-cwd">
                              CWD: <code>{cwd}</code>
                            </p>
                          ) : (
                            <p className="sim-approval-meta">CWD: Not provided by runtime</p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  <div className="sim-actions sim-actions-approval">
                    {getApprovalActionOptions(pendingApproval).map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        className={option.secondary ? 'button-secondary' : undefined}
                        onClick={() => void handleResolveApproval(option.decision)}
                        disabled={busy}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </article>
              ) : null}

              <div className="chat-composer">
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  className="upload-input-hidden"
                  onChange={(event) => {
                    void handleFileInputChange(event);
                  }}
                />
                <div className="chat-composer-row">
                  <button
                    type="button"
                    className="icon-button composer-upload-button"
                    title="Upload File"
                    aria-label="Upload File"
                    onClick={handleOpenUploadDialog}
                    disabled={busy || uploadingFiles || !activeWorkspacePath}
                  >
                    <Paperclip />
                  </button>
                  <div className="composer-textarea-wrap">
                    <textarea
                      ref={promptInputRef}
                      value={prompt}
                      onChange={handlePromptChange}
                      onSelect={handlePromptSelection}
                      onClick={handlePromptSelection}
                      onKeyUp={handlePromptSelection}
                      onKeyDown={handlePromptKeyDown}
                      placeholder="Send a message..."
                      rows={3}
                    />
                    {skillSuggestionVisible ? (
                      <div className="composer-skill-suggestions">
                        {filteredSkillSuggestions.map((skill, index) => (
                          <button
                            key={skill.name}
                            type="button"
                            className={`composer-skill-suggestion-item ${index === skillSuggestionIndex ? 'active' : ''}`}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              applySkillSuggestion(skill);
                            }}
                          >
                            <span className="composer-skill-line">
                              <span className="composer-skill-name">${skill.name}</span>
                              <span className="composer-skill-description">{skill.description || 'Skill'}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="icon-button composer-send-button"
                    title={canSteerTurn ? 'Steer Current Turn' : 'Send'}
                    aria-label={canSteerTurn ? 'Steer Current Turn' : 'Send'}
                    onClick={() => void handleSendTurn()}
                    disabled={(!canStartTurn && !canSteerTurn) || busy}
                  >
                    <Send />
                  </button>
                </div>
                {uploadingFiles ? <p className="composer-upload-hint">Uploading file...</p> : null}
                {uploadError ? <p className="composer-upload-error">{uploadError}</p> : null}
              </div>
            </section> : null}

            {!configFullscreenActive && (rightSidebarMode !== 'closed' || mobileInsightsOpen) ? (
              <aside
                ref={rightPaneRef}
                className={`insights-pane ${mobileInsightsOpen ? 'mobile-open' : `mode-${rightSidebarMode}`}`}
              >
                {!mobileInsightsOpen ? (
                  <div
                    className="right-pane-resize-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize insights panel"
                    onPointerDown={handleRightPaneResizeStart}
                  />
                ) : null}
                <div className="mobile-sidebar-head mobile-sidebar-head-right">
                  <button type="button" className="icon-button" onClick={() => closeRightSidebar()} aria-label="Close insights">
                    <EyeOff />
                  </button>
                </div>
                <div className="insights-tabs">
                  <button type="button" className={insightsTab === 'preview' ? 'tab-active' : ''} onClick={() => setInsightsTab('preview')}>
                    Preview
                  </button>
                  <button type="button" className={insightsTab === 'diff' ? 'tab-active' : ''} onClick={() => setInsightsTab('diff')}>
                    Diff
                  </button>
                  <button type="button" className={insightsTab === 'events' ? 'tab-active' : ''} onClick={() => setInsightsTab('events')}>
                    Timeline
                  </button>
                </div>
                <div className="insights-content">
                  {insightsTab === 'preview' ? previewPanelView : null}
                  {insightsTab === 'diff' ? diffPanelView : null}
                  {insightsTab === 'events' ? (
                    <div className="timeline-list">
                      {timelineEvents.length === 0 ? <p className="timeline-empty">No events yet.</p> : null}
                      {timelineEvents.map((event) => (
                        <article key={event.id} className="timeline-event">
                          <header className="timeline-event-head">
                            <span className="timeline-event-title">{event.title}</span>
                            {event.status ? <span className="status-pill">{event.status}</span> : null}
                            {event.kind === 'diff' ? (
                              <button
                                type="button"
                                className="timeline-inline-button"
                                onClick={() => setInsightsTab('diff')}
                              >
                                View Diff
                              </button>
                            ) : null}
                            <span className="timeline-event-seq">
                              {event.seqStart >= 0
                                ? event.seqStart === event.seqEnd
                                  ? `#${event.seqStart}`
                                  : `#${event.seqStart}-#${event.seqEnd}`
                                : 'system'}
                            </span>
                          </header>
                          {event.details.length > 0 || (event.kind === 'diff' && Array.isArray(event.diffFiles) && event.diffFiles.length > 0) ? (
                            <div className="timeline-event-details">
                              {event.kind === 'diff' && Array.isArray(event.diffFiles) && event.diffFiles.length > 0
                                ? (
                                    <article className="timeline-diff-file">
                                      <header className="timeline-diff-file-title">{event.diffFiles.join('\n')}</header>
                                    </article>
                                  )
                                : event.details.map((detail, index) => {
                                    const detailKey = `${event.id}-${index}`;
                                    const normalizedDetail = typeof detail === 'string' ? detail : String(detail ?? '');
                                    const isToolDetail = event.kind === 'tool';
                                    const lineCount = normalizedDetail.length === 0 ? 0 : normalizedDetail.split('\n').length;
                                    const canToggle = isToolDetail && lineCount > 5;
                                    const expanded = expandedToolDetailKeys[detailKey] === true;
                                    return (
                                      <div key={detailKey} className="timeline-detail-box">
                                        {canToggle ? (
                                          <button
                                            type="button"
                                            className="icon-button timeline-detail-toggle"
                                            onClick={() =>
                                              setExpandedToolDetailKeys((current) => ({ ...current, [detailKey]: !expanded }))
                                            }
                                            title={expanded ? 'Collapse details' : 'Expand details'}
                                            aria-label={expanded ? 'Collapse details' : 'Expand details'}
                                          >
                                            <ChevronDown className={expanded ? 'timeline-toggle-icon is-open' : 'timeline-toggle-icon'} />
                                          </button>
                                        ) : null}
                                        <pre>{canToggle && !expanded ? tailLines(normalizedDetail, 5) : normalizedDetail}</pre>
                                      </div>
                                    );
                                  })}
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className={`session-info-wrap ${sessionInfoOpen ? 'open' : 'closed'}`}>
                  {sessionInfoOpen ? (
                    <article className="session-info-card">
                      <h3>Current Session</h3>
                      {SESSION_DEBUG_INFO_ENABLED ? (
                        <p className="session-debug-inline">Session ID: {selectedSessionId || '-'}</p>
                      ) : null}
                      <dl>
                        <dt>Workspace</dt>
                        <dd>{resolvedSessionInfo.workspace}</dd>
                        <dt>Model</dt>
                        <dd>{resolvedSessionInfo.model}</dd>
                        <dt>Execution Mode</dt>
                        <dd>{resolvedSessionInfo.executionMode}</dd>
                        <dt>Runtime Config</dt>
                        <dd>
                          {resolvedSessionInfo.runtimeEntries.length > 0
                            ? (
                              <pre className="session-debug-lines session-runtime-lines-capped">
                                {resolvedSessionInfo.runtimeEntries
                                  .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
                                  .join('\n')}
                              </pre>
                            )
                            : 'none'}
                        </dd>
                        {SESSION_DEBUG_INFO_ENABLED ? (
                          <>
                            <dt>Debug</dt>
                            <dd>
                              <pre className="session-debug-lines session-debug-lines-capped">{currentSessionDebugInfo}</pre>
                            </dd>
                          </>
                        ) : null}
                      </dl>
                    </article>
                  ) : null}
                  <button
                    type="button"
                    className="icon-button session-info-toggle"
                    onClick={() => setSessionInfoOpen((current) => !current)}
                    aria-label={sessionInfoOpen ? 'Hide current session info' : 'Show current session info'}
                    title={sessionInfoOpen ? 'Hide current session info' : 'Show current session info'}
                  >
                    <Info />
                  </button>
                </div>
              </aside>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="sim-error">{error}</p> : null}
      </section>
    </main>
  );
}

function clampLeftPaneWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return LEFT_PANE_DEFAULT_WIDTH;
  }
  if (typeof window === 'undefined') {
    return Math.max(LEFT_PANE_MIN_WIDTH, Math.round(value));
  }
  const viewportMax = Math.floor(window.innerWidth * LEFT_PANE_MAX_RATIO);
  const maxWidth = Math.max(LEFT_PANE_MIN_WIDTH, viewportMax);
  return Math.max(LEFT_PANE_MIN_WIDTH, Math.min(Math.round(value), maxWidth));
}

function clampRightPaneWidth(value: number, mode: SidebarMode, leftMode: SidebarMode, leftWidth: number): number {
  if (!Number.isFinite(value)) {
    return RIGHT_PANE_DEFAULT_WIDTH;
  }
  if (typeof window === 'undefined') {
    return Math.max(RIGHT_PANE_MIN_WIDTH, Math.round(value));
  }
  const clearanceMax = Math.floor(window.innerWidth - computeRightPopLeftClearance(leftMode, leftWidth));
  const pinRatioMax = Math.floor(window.innerWidth * RIGHT_PANE_MAX_PIN_RATIO);
  const viewportMax = mode === 'pop' ? clearanceMax : Math.min(pinRatioMax, clearanceMax);
  const maxWidth = Math.max(RIGHT_PANE_MIN_WIDTH, viewportMax);
  return Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(Math.round(value), maxWidth));
}

function computeRightPopLeftClearance(leftMode: SidebarMode, leftWidth: number): number {
  if (leftMode === 'pin') {
    return Math.round(leftWidth + RIGHT_PANE_POP_CHAT_CLEARANCE);
  }
  return RIGHT_PANE_POP_CHAT_CLEARANCE;
}

async function apiRequest<T>(
  path: string,
  input: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>; signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(path, {
    method: input.method,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: input.signal,
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let jsonPayload: unknown = null;
  if (text) {
    const looksLikeJson = contentType.includes('application/json') || /^[\[{]/.test(text.trim());
    if (looksLikeJson) {
      try {
        jsonPayload = JSON.parse(text) as unknown;
      } catch {
        jsonPayload = null;
      }
    }
  }
  if (!response.ok) {
    if (jsonPayload) {
      throw new Error(extractApiMessage(jsonPayload, `Request failed (${response.status})`));
    }
    const compactText = text.trim().replace(/\s+/g, ' ');
    const detail = compactText ? `: ${compactText.slice(0, 180)}` : '';
    throw new Error(`Request failed (${response.status})${detail}`);
  }
  return (jsonPayload ?? ({} as T)) as T;
}

async function uploadRequest<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    body,
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let jsonPayload: unknown = null;
  if (text) {
    const looksLikeJson = contentType.includes('application/json') || /^[\[{]/.test(text.trim());
    if (looksLikeJson) {
      try {
        jsonPayload = JSON.parse(text) as unknown;
      } catch {
        jsonPayload = null;
      }
    }
  }
  if (!response.ok) {
    if (jsonPayload) {
      throw new Error(extractApiMessage(jsonPayload, `Upload failed (${response.status})`));
    }
    const compactText = text.trim().replace(/\s+/g, ' ');
    const detail = compactText ? `: ${compactText.slice(0, 180)}` : '';
    throw new Error(`Upload failed (${response.status})${detail}`);
  }
  return (jsonPayload ?? ({} as T)) as T;
}

function extractApiMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string') {
    return record.message;
  }
  const error = record.error;
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === 'string') {
      return errorRecord.message;
    }
  }
  return fallback;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function readLastProjectId(userEmail: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const projectId = window.localStorage.getItem(lastProjectStorageKey(userEmail))?.trim() ?? '';
    return projectId.length > 0 ? projectId : null;
  } catch {
    return null;
  }
}

function writeLastProjectId(userEmail: string, projectId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return;
  }
  try {
    window.localStorage.setItem(lastProjectStorageKey(userEmail), normalizedProjectId);
  } catch {
    // Ignore storage errors so project selection still works without persistence.
  }
}

function lastProjectStorageKey(userEmail: string): string {
  return `${LAST_PROJECT_STORAGE_KEY_PREFIX}${userEmail.trim().toLowerCase()}`;
}

function readLastSessionId(userEmail: string, projectId: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const sessionId = window.localStorage.getItem(lastSessionStorageKey(userEmail, projectId))?.trim() ?? '';
    return sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

function writeLastSessionId(userEmail: string, projectId: string, sessionId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  const normalizedProjectId = projectId.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedProjectId || !normalizedSessionId) {
    return;
  }
  try {
    window.localStorage.setItem(lastSessionStorageKey(userEmail, normalizedProjectId), normalizedSessionId);
  } catch {
    // Ignore storage errors so session selection still works without persistence.
  }
}

function lastSessionStorageKey(userEmail: string, projectId: string): string {
  return `${LAST_SESSION_STORAGE_KEY_PREFIX}${userEmail.trim().toLowerCase()}:${projectId.trim()}`;
}

function readPanelLayout(userEmail: string): PanelLayoutPersistence | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(panelLayoutStorageKey(userEmail));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PanelLayoutPersistence>;
    if (!parsed.left || !parsed.right) {
      return null;
    }
    const leftMode = normalizeSidebarMode(parsed.left.mode);
    const rightMode = normalizeSidebarMode(parsed.right.mode);
    const leftWidth = readFiniteNumber(parsed.left.width) ?? LEFT_PANE_DEFAULT_WIDTH;
    const rightWidth = readFiniteNumber(parsed.right.width) ?? RIGHT_PANE_DEFAULT_WIDTH;
    return {
      left: {
        mode: leftMode,
        width: leftWidth,
        open: leftMode !== 'closed',
        pinned: leftMode === 'pin',
      },
      right: {
        mode: rightMode,
        width: rightWidth,
        open: rightMode !== 'closed',
        pinned: rightMode === 'pin',
      },
    };
  } catch {
    return null;
  }
}

function writePanelLayout(userEmail: string, value: PanelLayoutPersistence): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(panelLayoutStorageKey(userEmail), JSON.stringify(value));
  } catch {
    // Ignore storage errors so layout still works without persistence.
  }
}

function panelLayoutStorageKey(userEmail: string): string {
  return `${PANEL_LAYOUT_STORAGE_KEY_PREFIX}${userEmail.trim().toLowerCase()}`;
}

function normalizeSidebarMode(mode: unknown): SidebarMode {
  return mode === 'pin' || mode === 'pop' || mode === 'closed' ? mode : 'closed';
}

function applyDirectorySuggestionSelection(value: string, suggestions: string[]): string {
  if (!value) {
    return value;
  }
  return suggestions.includes(value) ? ensureTrailingSlash(value) : value;
}

function findSkillTokenContext(input: string, cursor: number): { start: number; end: number; prefix: string } | null {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const beforeCursor = input.slice(0, safeCursor);
  const match = beforeCursor.match(/(?:^|\s)\$([A-Za-z0-9_-]*)$/);
  if (!match) {
    return null;
  }
  const prefix = match[1] ?? '';
  const start = safeCursor - prefix.length - 1;
  if (start < 0) {
    return null;
  }
  if (start > 0 && !/\s/.test(input[start - 1] ?? '')) {
    return null;
  }
  let end = safeCursor;
  while (end < input.length && /[A-Za-z0-9_-]/.test(input[end] ?? '')) {
    end += 1;
  }
  return { start, end, prefix };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isImagePreviewPath(filePath: string): boolean {
  const normalized = filePath.trim().toLowerCase();
  return (
    normalized.endsWith('.png') ||
    normalized.endsWith('.jpg') ||
    normalized.endsWith('.jpeg') ||
    normalized.endsWith('.gif') ||
    normalized.endsWith('.webp') ||
    normalized.endsWith('.bmp') ||
    normalized.endsWith('.svg') ||
    normalized.endsWith('.tif') ||
    normalized.endsWith('.tiff')
  );
}

function isPdfPreviewPath(filePath: string): boolean {
  return filePath.trim().toLowerCase().endsWith('.pdf');
}

function isBinaryPreviewPath(filePath: string): boolean {
  return isPdfPreviewPath(filePath) || isImagePreviewPath(filePath);
}

function detectCodeLanguage(filePath: string): string {
  const normalized = filePath.trim().toLowerCase();
  if (normalized.endsWith('.md') || normalized.endsWith('.mdx') || normalized.endsWith('.markdown')) {
    return 'markdown';
  }
  if (normalized.endsWith('.ts') || normalized.endsWith('.tsx')) {
    return 'typescript';
  }
  if (normalized.endsWith('.js') || normalized.endsWith('.jsx') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs')) {
    return 'javascript';
  }
  if (normalized.endsWith('.json')) {
    return 'json';
  }
  if (normalized.endsWith('.css')) {
    return 'css';
  }
  if (normalized.endsWith('.html') || normalized.endsWith('.htm')) {
    return 'html';
  }
  if (normalized.endsWith('.sh') || normalized.endsWith('.bash') || normalized.endsWith('.zsh')) {
    return 'bash';
  }
  if (normalized.endsWith('.yml') || normalized.endsWith('.yaml')) {
    return 'yaml';
  }
  if (normalized.endsWith('.sql')) {
    return 'sql';
  }
  if (normalized.endsWith('.py')) {
    return 'python';
  }
  if (normalized.endsWith('.go')) {
    return 'go';
  }
  if (normalized.endsWith('.rs')) {
    return 'rust';
  }
  if (normalized.endsWith('.java')) {
    return 'java';
  }
  if (normalized.endsWith('.xml')) {
    return 'xml';
  }
  if (normalized.endsWith('.toml')) {
    return 'toml';
  }
  return 'text';
}

function resolveCodeMirrorExtensions(filePath: string): Extension[] {
  const normalized = filePath.trim().toLowerCase();
  const detected = detectCodeLanguage(filePath);
  const extensions: Extension[] = [EditorView.lineWrapping];

  if (detected === 'markdown') {
    extensions.push(markdown());
    return extensions;
  }
  if (detected === 'typescript') {
    extensions.push(javascript({ typescript: true, jsx: normalized.endsWith('.tsx') }));
    return extensions;
  }
  if (detected === 'javascript') {
    extensions.push(javascript({ jsx: normalized.endsWith('.jsx') }));
    return extensions;
  }
  if (detected === 'json') {
    extensions.push(json());
    return extensions;
  }
  if (detected === 'css') {
    extensions.push(css());
    return extensions;
  }
  if (detected === 'html') {
    extensions.push(html());
    return extensions;
  }
  if (detected === 'yaml') {
    extensions.push(yaml());
    return extensions;
  }
  if (detected === 'sql') {
    extensions.push(sql());
    return extensions;
  }
  if (detected === 'python') {
    extensions.push(python());
    return extensions;
  }
  if (detected === 'go') {
    extensions.push(go());
    return extensions;
  }
  if (detected === 'rust') {
    extensions.push(rust());
    return extensions;
  }
  if (detected === 'java') {
    extensions.push(java());
    return extensions;
  }
  if (detected === 'xml') {
    extensions.push(xml());
    return extensions;
  }
  return extensions;
}

function resolveWorkspaceRelativePath(targetPath: string, workspaceRoot: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRoot = normalize(workspaceRoot.trim());
  const normalizedTarget = normalize(targetPath.trim());
  if (!normalizedRoot || !normalizedTarget) {
    return '.';
  }
  if (normalizedTarget === normalizedRoot) {
    return '.';
  }
  const rootPrefix = `${normalizedRoot}/`;
  if (normalizedTarget.startsWith(rootPrefix)) {
    return normalizedTarget.slice(rootPrefix.length);
  }
  return normalizedTarget;
}

function formatApprovalKind(kind: string): string {
  if (kind === 'command_execution') {
    return 'Command execution';
  }
  if (kind === 'file_change') {
    return 'File change';
  }
  if (kind === 'permissions') {
    return 'Additional permissions';
  }
  return kind;
}

function mergeTimelineEvent(current: TimelineEvent[], envelope: StreamEnvelope): TimelineEvent[] {
  // Omit top-level wrapper events so the timeline focuses on the useful payload events.
  if (
    envelope.type === 'turn.started' ||
    envelope.type === 'turn.failed' ||
    envelope.type === 'turn.cancelled'
  ) {
    return current;
  }

  if (envelope.type === 'turn.completed') {
    const content = typeof envelope.payload.content === 'string' ? envelope.payload.content.trim() : '';
    const next: TimelineEvent[] = [...current];
    if (content.length > 0) {
      next.push({
        id: `assistant-final-${envelope.seq}`,
        kind: 'assistant',
        title: 'Assistant Message',
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: [content],
      });
    }
    next.push({
      id: `turn-completed-${envelope.seq}`,
      kind: 'event',
      title: 'Turn Completed',
      seqStart: envelope.seq,
      seqEnd: envelope.seq,
      createdAt: envelope.createdAt,
      details: [],
    });
    return next;
  }

  if (envelope.type === 'tool.started') {
    const toolKey = resolveToolKey(envelope);
    const title = resolveToolTitle(envelope.payload);
    return [
      ...current,
      {
        id: `tool-${toolKey}-${envelope.seq}`,
        kind: 'tool',
        title,
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: [],
        status: 'running',
        toolKey,
      },
    ];
  }

  if (envelope.type === 'tool.output') {
    const toolKey = resolveToolKey(envelope);
    const output = resolveToolOutputText(envelope.payload);
    if (!output) {
      return current;
    }
    const toolIndex = findTargetToolTimelineIndex(current, toolKey);
    if (toolIndex >= 0) {
      return current.map((item, index) => {
        if (index !== toolIndex) {
          return item;
        }
        return {
          ...item,
          seqEnd: Math.max(item.seqEnd, envelope.seq),
          details: appendOrMergeDetail(item.details, output),
        };
      });
    }
    return [
      ...current,
      {
        id: `tool-${toolKey}-${envelope.seq}`,
        kind: 'tool',
        title: resolveToolTitle(envelope.payload),
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: [output],
        status: 'running',
        toolKey,
      },
    ];
  }

  if (envelope.type === 'tool.completed') {
    const toolKey = resolveToolKey(envelope);
    const toolIndex = findTargetToolTimelineIndex(current, toolKey);
    if (toolIndex >= 0) {
      return current.map((item, index) => {
        if (index !== toolIndex) {
          return item;
        }
        const completedNote = resolveToolCompletedNote(envelope.payload);
        return {
          ...item,
          seqEnd: Math.max(item.seqEnd, envelope.seq),
          status: 'completed',
          details: completedNote ? appendOrMergeDetail(item.details, completedNote) : item.details,
        };
      });
    }
    return [
      ...current,
      {
        id: `tool-${toolKey}-${envelope.seq}`,
        kind: 'tool',
        title: resolveToolTitle(envelope.payload),
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: resolveToolCompletedNote(envelope.payload) ? [resolveToolCompletedNote(envelope.payload) as string] : [],
        status: 'completed',
        toolKey,
      },
    ];
  }

  if (envelope.type === 'reasoning.delta') {
    const delta = typeof envelope.payload.delta === 'string' ? envelope.payload.delta : '';
    if (!delta) {
      return current;
    }
    return appendOrMergeByKind(current, 'reasoning', 'Reasoning', envelope, delta);
  }

  if (envelope.type === 'assistant.delta') {
    return current;
  }

  if (envelope.type === 'plan.updated') {
    return [
      ...current,
      {
        id: `plan-${envelope.seq}`,
        kind: 'plan',
        title: 'Plan Updated',
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: [formatPlanPayload(envelope.payload)],
      },
    ];
  }

  if (envelope.type === 'diff.updated') {
    const files = extractDiffFilesFromPayload(envelope.payload);
    const details = files.length > 0 ? [files.join('\n')] : ['Diff updated'];
    return [
      ...current,
      {
        id: `diff-${envelope.seq}`,
        kind: 'diff',
        title: 'Diff Updated',
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details,
        diffFiles: files,
      },
    ];
  }

  if (envelope.type === 'thread.token_usage.updated') {
    const ratio = resolveRemainingContextRatio(envelope.payload);
    const detail = ratio === null ? '' : `${formatPercent(ratio)} left`;
    return [
      ...current,
      {
        id: `token-${envelope.seq}`,
        kind: 'token',
        title: 'Context Usage Updated',
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: detail ? [detail] : [],
      },
    ];
  }

  if (envelope.type === 'turn.approval.requested') {
    const kind = typeof envelope.payload.kind === 'string' ? envelope.payload.kind : 'approval';
    const reason = typeof envelope.payload.reason === 'string' ? envelope.payload.reason.trim() : '';
    return [
      ...current,
      {
        id: `approval-${envelope.seq}`,
        kind: 'approval',
        title: `${formatApprovalKind(kind)} Requested`,
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: reason ? [reason] : [],
      },
    ];
  }

  if (envelope.type === 'turn.approval.resolved') {
    const decision = typeof envelope.payload.decision === 'string' ? envelope.payload.decision : 'resolved';
    return [
      ...current,
      {
        id: `approval-${envelope.seq}`,
        kind: 'approval',
        title: 'Approval Resolved',
        seqStart: envelope.seq,
        seqEnd: envelope.seq,
        createdAt: envelope.createdAt,
        details: [decision],
      },
    ];
  }

  return [
    ...current,
    {
      id: `event-${envelope.seq}-${envelope.type}`,
      kind: 'event',
      title: envelope.type,
      seqStart: envelope.seq,
      seqEnd: envelope.seq,
      createdAt: envelope.createdAt,
      details: [],
    },
  ];
}

function appendOrMergeByKind(
  current: TimelineEvent[],
  kind: TimelineEvent['kind'],
  title: string,
  envelope: StreamEnvelope,
  text: string,
): TimelineEvent[] {
  const last = current[current.length - 1];
  if (last && last.kind === kind) {
    const updatedLast: TimelineEvent = {
      ...last,
      seqEnd: Math.max(last.seqEnd, envelope.seq),
      details: appendOrMergeDetail(last.details, text),
    };
    return [...current.slice(0, -1), updatedLast];
  }
  return [
    ...current,
    {
      id: `${kind}-${envelope.seq}`,
      kind,
      title,
      seqStart: envelope.seq,
      seqEnd: envelope.seq,
      createdAt: envelope.createdAt,
      details: [text],
    },
  ];
}

function appendOrMergeDetail(details: string[], text: string): string[] {
  if (details.length === 0) {
    return [text];
  }
  const last = details[details.length - 1];
  const merged = `${last}${text}`;
  return [...details.slice(0, -1), merged];
}

function renderChatMessageMarkdown(content: string): string {
  if (!content.includes('<think>')) {
    return content;
  }
  return content.replace(/<think>([\s\S]*?)<\/think>/gi, (_full, inner: string) => {
    const normalized = inner.trim();
    if (!normalized) {
      return '';
    }
    const italicLines = normalized
      .split('\n')
      .map((line) => `> _${line.trim()}_`)
      .join('\n');
    return `\n${italicLines}\n`;
  });
}

function resolveToolKey(envelope: StreamEnvelope): string {
  const payload = envelope.payload;
  const keyCandidate =
    payload.toolCallId ?? payload.tool_call_id ?? payload.toolId ?? payload.callId ?? payload.id ?? payload.title ?? payload.kind;
  if (typeof keyCandidate === 'string' && keyCandidate.trim().length > 0) {
    return keyCandidate.trim();
  }
  return `seq-${envelope.seq}`;
}

function resolveToolTitle(payload: Record<string, unknown>): string {
  return (
    typeof payload.title === 'string' && payload.title.trim().length > 0
      ? payload.title.trim()
      : typeof payload.kind === 'string' && payload.kind.trim().length > 0
        ? payload.kind.trim()
        : 'tool'
  );
}

function resolveToolOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    return payload.text;
  }
  if (typeof payload.output === 'string' && payload.output.length > 0) {
    return payload.output;
  }
  return '';
}

function resolveToolCompletedNote(payload: Record<string, unknown>): string {
  if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
    return payload.summary.trim();
  }
  if (typeof payload.result === 'string' && payload.result.trim().length > 0) {
    return payload.result.trim();
  }
  return '';
}

function extractDiffFilesFromPayload(payload: Record<string, unknown>): string[] {
  const fromFiles = payload.files;
  if (Array.isArray(fromFiles)) {
    const resolved = fromFiles
      .map((entry) => {
        if (typeof entry === 'string' && entry.trim().length > 0) {
          return entry.trim();
        }
        if (!entry || typeof entry !== 'object') {
          return '';
        }
        const record = entry as Record<string, unknown>;
        const pathCandidate =
          (typeof record.path === 'string' && record.path.trim()) ||
          (typeof record.newPath === 'string' && record.newPath.trim()) ||
          (typeof record.oldPath === 'string' && record.oldPath.trim()) ||
          '';
        return pathCandidate;
      })
      .filter((item) => item.length > 0);
    if (resolved.length > 0) {
      return Array.from(new Set(resolved));
    }
  }

  const diffText =
    (typeof payload.unifiedDiff === 'string' && payload.unifiedDiff) ||
    (typeof payload.diff === 'string' && payload.diff) ||
    '';
  if (!diffText) {
    return [];
  }
  const files: string[] = [];
  diffText.split('\n').forEach((line) => {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (match?.[1]) {
      files.push(match[1].trim());
    }
  });
  return Array.from(new Set(files));
}

function findTargetToolTimelineIndex(events: TimelineEvent[], toolKey: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (event.kind !== 'tool') {
      continue;
    }
    if (event.toolKey === toolKey) {
      return index;
    }
    if (event.status === 'running') {
      return index;
    }
  }
  return -1;
}

function resolveRemainingContextRatio(payload: Record<string, unknown>): number | null {
  const directRatio = readFiniteNumber(payload.remainingRatio);
  if (directRatio !== null) {
    return clamp01(directRatio);
  }

  const modelContextWindow = readFiniteNumber(payload.modelContextWindow);
  const totalTokens = readFiniteNumber(payload.totalTokens);
  if (modelContextWindow === null || totalTokens === null || modelContextWindow <= 0) {
    return null;
  }
  return clamp01((modelContextWindow - totalTokens) / modelContextWindow);
}

function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extract5hAndWeeklyLimits(response: CodexRateLimitsResponse): {
  fiveHour: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
} {
  const windows: RateLimitWindow[] = [];
  if (response.rateLimits?.primary) {
    windows.push(response.rateLimits.primary);
  }
  if (response.rateLimits?.secondary) {
    windows.push(response.rateLimits.secondary);
  }
  if (response.rateLimitsByLimitId) {
    Object.values(response.rateLimitsByLimitId).forEach((snapshot) => {
      if (snapshot.primary) {
        windows.push(snapshot.primary);
      }
      if (snapshot.secondary) {
        windows.push(snapshot.secondary);
      }
    });
  }

  return {
    fiveHour: findRateLimitWindowByMinutes(windows, 300),
    weekly: findRateLimitWindowByMinutes(windows, 10080),
  };
}

function findRateLimitWindowByMinutes(windows: RateLimitWindow[], minutes: number): RateLimitWindow | null {
  for (const window of windows) {
    if (window.windowDurationMins === minutes) {
      return window;
    }
  }
  return null;
}

function formatRateLimitWindow(window: RateLimitWindow | null): string {
  if (!window || window.usedPercent === null) {
    return 'unavailable';
  }
  const percent = `${Math.max(0, Math.round(window.usedPercent))}% used`;
  if (window.resetsAt === null) {
    return percent;
  }
  const resetTimestamp = window.resetsAt > 1e12 ? window.resetsAt : window.resetsAt * 1000;
  return `${percent}, resets ${new Date(resetTimestamp).toLocaleString()}`;
}

function formatRateLimitRemainingPercent(window: RateLimitWindow | null): number {
  if (!window || window.usedPercent === null) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

function formatRateLimitReset(window: RateLimitWindow | null): string {
  if (!window) {
    return 'Unavailable';
  }
  if (window.resetsAt === null) {
    return `${formatRateLimitRemainingPercent(window)}% left`;
  }
  const resetTimestamp = window.resetsAt > 1e12 ? window.resetsAt : window.resetsAt * 1000;
  return `${formatRateLimitRemainingPercent(window)}% left (Reset at ${new Date(resetTimestamp).toLocaleString()})`;
}

function rateLimitFillClass(window: RateLimitWindow | null): string {
  const remaining = formatRateLimitRemainingPercent(window);
  if (remaining < 10) {
    return 'rate-limit-fill-red';
  }
  if (remaining < 20) {
    return 'rate-limit-fill-yellow';
  }
  if (remaining > 50) {
    return 'rate-limit-fill-green';
  }
  return 'rate-limit-fill-blue';
}

function readApprovalCommand(payload: Record<string, unknown>): string | null {
  const command = payload.command;
  if (typeof command === 'string') {
    const trimmed = command.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(command)) {
    const joined = command
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .join(' ');
    return joined.length > 0 ? joined : null;
  }
  if (command && typeof command === 'object') {
    const record = command as Record<string, unknown>;
    if (Array.isArray(record.argv)) {
      const joined = record.argv
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
        .join(' ');
      if (joined.length > 0) {
        return joined;
      }
    }
    if (typeof record.command === 'string' && record.command.trim().length > 0) {
      return record.command.trim();
    }
  }
  return null;
}

function readApprovalTextField(payload: Record<string, unknown>, key: 'reason' | 'cwd'): string | null {
  const value = payload[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatPlanPayload(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof payload.explanation === 'string' && payload.explanation.length > 0) {
    lines.push(payload.explanation);
  }

  if (Array.isArray(payload.plan)) {
    payload.plan.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const record = entry as Record<string, unknown>;
      const step = typeof record.step === 'string' ? record.step : `Step ${index + 1}`;
      const status = typeof record.status === 'string' ? record.status : 'pending';
      lines.push(`[${status}] ${step}`);
    });
  }

  return lines.join('\n');
}

function formatDiffPayload(payload: Record<string, unknown>): string {
  if (typeof payload.unifiedDiff === 'string' && payload.unifiedDiff.length > 0) {
    return payload.unifiedDiff;
  }
  if (typeof payload.diff === 'string' && payload.diff.length > 0) {
    return payload.diff;
  }
  if (payload.diffStat && typeof payload.diffStat === 'object') {
    return JSON.stringify(payload.diffStat, null, 2);
  }
  if (payload.diffAvailable === true) {
    return 'Diff update available.';
  }
  return '';
}

function countDiffTextLines(diffText: string): number {
  if (diffText.length === 0) {
    return 0;
  }
  return diffText.split(/\r?\n/).length;
}

function countDiffFileLines(file: ParsedDiffFile): number {
  if (!Array.isArray(file.hunks)) {
    return 0;
  }
  return file.hunks.reduce((total, hunk) => {
    const changes = (hunk as unknown as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) {
      return total;
    }
    return total + changes.length;
  }, 0);
}

function tailLines(content: string, maxLines: number): string {
  if (maxLines <= 0) {
    return '';
  }
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return content;
  }
  return lines.slice(lines.length - maxLines).join('\n');
}

function formatDiffFileLabel(file: ParsedDiffFile): string {
  const oldPath = readDiffPath(file, 'oldPath');
  const newPath = readDiffPath(file, 'newPath');

  if (oldPath && newPath && oldPath !== newPath) {
    return `${oldPath} -> ${newPath}`;
  }
  if (newPath) {
    return newPath;
  }
  if (oldPath) {
    return oldPath;
  }
  return '(unknown file)';
}

function readDiffPath(file: ParsedDiffFile, key: 'oldPath' | 'newPath'): string | null {
  const value = (file as unknown as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getApprovalActionOptions(approval: PendingApproval): ApprovalActionOption[] {
  if (approval.kind !== 'command_execution') {
    return [
      { key: 'accept', label: 'Approve', decision: 'accept' },
      { key: 'decline', label: 'Reject', decision: 'decline', secondary: true },
    ];
  }

  const options: ApprovalActionOption[] = [];
  const available = normalizeAvailableDecisions(approval.payload.availableDecisions);
  const allowed = new Set(available);

  if (allowed.size === 0 || allowed.has('accept')) {
    options.push({ key: 'accept', label: 'Approve', decision: 'accept' });
  }
  if (allowed.has('acceptForSession')) {
    options.push({ key: 'acceptForSession', label: 'Approve for Session', decision: 'acceptForSession' });
  }

  const execPolicy = readExecpolicyAmendment(approval.payload.proposedExecpolicyAmendment);
  if (execPolicy.length > 0) {
    options.push({
      key: 'execpolicy',
      label: 'Approve + Remember Rule',
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execPolicy,
        },
      },
    });
  }

  const networkPolicies = readNetworkPolicyAmendments(approval.payload.proposedNetworkPolicyAmendments);
  networkPolicies.forEach((policy, index) => {
    options.push({
      key: `network-${index}`,
      label: `${policy.action === 'allow' ? 'Allow' : 'Deny'} ${policy.host}`,
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: policy,
        },
      },
    });
  });

  if (allowed.size === 0 || allowed.has('decline')) {
    options.push({ key: 'decline', label: 'Reject', decision: 'decline', secondary: true });
  }
  if (allowed.has('cancel')) {
    options.push({ key: 'cancel', label: 'Reject + Cancel Turn', decision: 'cancel', secondary: true });
  }

  return options;
}

function normalizeAvailableDecisions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [entry];
    }
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    if ('acceptWithExecpolicyAmendment' in entry) {
      return ['acceptWithExecpolicyAmendment'];
    }
    if ('applyNetworkPolicyAmendment' in entry) {
      return ['applyNetworkPolicyAmendment'];
    }
    return [];
  });
}

function readExecpolicyAmendment(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function readNetworkPolicyAmendments(value: unknown): Array<{ action: 'allow' | 'deny'; host: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const action = record.action;
    const host = record.host;
    if ((action === 'allow' || action === 'deny') && typeof host === 'string' && host.trim().length > 0) {
      return [{ action, host: host.trim() }];
    }
    return [];
  });
}
