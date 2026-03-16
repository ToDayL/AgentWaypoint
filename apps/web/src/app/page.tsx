'use client';

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  FolderPlus,
  FolderTree,
  GitFork,
  Info,
  Menu,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Settings,
  SlidersHorizontal,
  Trash2,
  UserCog,
} from 'lucide-react';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Project = {
  id: string;
  name: string;
  repoPath?: string | null;
  defaultModel?: string | null;
  defaultSandbox?: string | null;
  defaultApprovalPolicy?: string | null;
  createdAt: string;
};

type Session = {
  id: string;
  title: string;
  status: string;
  cwdOverride?: string | null;
  modelOverride?: string | null;
  sandboxOverride?: string | null;
  approvalPolicyOverride?: string | null;
  updatedAt: string;
};

type AvailableModel = {
  id: string;
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
  status: string;
  requestedCwd: string | null;
  requestedModel: string | null;
  requestedSandbox: string | null;
  requestedApprovalPolicy: string | null;
  effectiveCwd: string | null;
  effectiveModel: string | null;
  effectiveSandbox: string | null;
  effectiveApprovalPolicy: string | null;
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
type ParsedDiffFile = ReturnType<typeof parseDiff>[number];

type TurnStatusResponse = {
  id: string;
  sessionId: string;
  status: string;
  requestedCwd: string | null;
  requestedModel: string | null;
  requestedSandbox: string | null;
  requestedApprovalPolicy: string | null;
  effectiveCwd: string | null;
  effectiveModel: string | null;
  effectiveSandbox: string | null;
  effectiveApprovalPolicy: string | null;
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

type RateLimitWindow = {
  usedPercent: number | null;
  resetsAt: number | null;
  windowDurationMins: number | null;
};

type AccountRateLimitsResponse = {
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

const SANDBOX_OPTIONS = [
  { value: '', label: 'Use runner default' },
  { value: 'read-only', label: 'read-only' },
  { value: 'workspace-write', label: 'workspace-write' },
  { value: 'danger-full-access', label: 'danger-full-access' },
];

const APPROVAL_POLICY_OPTIONS = [
  { value: '', label: 'Use runner default' },
  { value: 'untrusted', label: 'untrusted' },
  { value: 'on-failure', label: 'on-failure' },
  { value: 'on-request', label: 'on-request' },
  { value: 'never', label: 'never' },
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
const SESSION_CWD_SUGGESTIONS_LIST_ID = 'session-cwd-path-suggestions';
type LeftSidebarTab = 'explorer' | 'config';
type InsightsTab = 'diff' | 'tools' | 'reasoning' | 'events';
type SidebarMode = 'closed' | 'pop' | 'pin';
type ActionPanelMode =
  | 'closed'
  | 'createProject'
  | 'createSession'
  | 'projectConfig'
  | 'createUser'
  | 'manageUser'
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
  const [workspaceSuggestions, setWorkspaceSuggestions] = useState<string[]>([]);
  const [workspaceSuggestionBusy, setWorkspaceSuggestionBusy] = useState(false);
  const [newProjectDefaultModel, setNewProjectDefaultModel] = useState('');
  const [newProjectDefaultSandbox, setNewProjectDefaultSandbox] = useState('');
  const [newProjectDefaultApprovalPolicy, setNewProjectDefaultApprovalPolicy] = useState('');
  const [projectConfigName, setProjectConfigName] = useState('');
  const [projectConfigRepoPath, setProjectConfigRepoPath] = useState('');
  const [projectConfigDefaultModel, setProjectConfigDefaultModel] = useState('');
  const [projectConfigDefaultSandbox, setProjectConfigDefaultSandbox] = useState('');
  const [projectConfigDefaultApprovalPolicy, setProjectConfigDefaultApprovalPolicy] = useState('');
  const [newSessionTitle, setNewSessionTitle] = useState('First Simulation Session');
  const [newSessionCwdOverride, setNewSessionCwdOverride] = useState('');
  const [sessionCwdSuggestions, setSessionCwdSuggestions] = useState<string[]>([]);
  const [sessionCwdSuggestionBusy, setSessionCwdSuggestionBusy] = useState(false);
  const [newSessionModelOverride, setNewSessionModelOverride] = useState('');
  const [newSessionSandboxOverride, setNewSessionSandboxOverride] = useState('');
  const [newSessionApprovalPolicyOverride, setNewSessionApprovalPolicyOverride] = useState('');
  const [prompt, setPrompt] = useState('');
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [assistantText, setAssistantText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [latestPlan, setLatestPlan] = useState('');
  const [toolOutput, setToolOutput] = useState('');
  const [diffSummaries, setDiffSummaries] = useState<string[]>([]);
  const [activeTurnId, setActiveTurnId] = useState('');
  const [resumedTurnHint, setResumedTurnHint] = useState('');
  const [turnStatus, setTurnStatus] = useState('idle');
  const [contextRemainingRatio, setContextRemainingRatio] = useState<number | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [streamBubbleTurnId, setStreamBubbleTurnId] = useState('');
  const [streamActive, setStreamActive] = useState(false);
  const [leftSidebarTab, setLeftSidebarTab] = useState<LeftSidebarTab>('explorer');
  const [leftSidebarMode, setLeftSidebarMode] = useState<SidebarMode>('pin');
  const [rightSidebarMode, setRightSidebarMode] = useState<SidebarMode>('closed');
  const [insightsTab, setInsightsTab] = useState<InsightsTab>('diff');
  const [sessionInfoOpen, setSessionInfoOpen] = useState(true);
  const [mobileLeftSidebarOpen, setMobileLeftSidebarOpen] = useState(false);
  const [mobileInsightsOpen, setMobileInsightsOpen] = useState(false);
  const [disableNativePathDatalist, setDisableNativePathDatalist] = useState(false);
  const [projectPathInputFocused, setProjectPathInputFocused] = useState(false);
  const [sessionPathInputFocused, setSessionPathInputFocused] = useState(false);
  const [actionPanelMode, setActionPanelMode] = useState<ActionPanelMode>('closed');
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const turnPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const chatAtBottomRef = useRef(true);

  const canStartTurn = !!selectedSessionId && prompt.trim().length > 0 && activeTurnId === '';
  const canSteerTurn =
    appSettings.turnSteerEnabled && !!activeTurnId && prompt.trim().length > 0 && pendingApproval === null;
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
    () => turns.find((item) => item.id === activeTurnId) ?? turns[0] ?? null,
    [turns, activeTurnId],
  );
  const resolvedSessionInfo = useMemo(() => {
    const workspace =
      sessionInfoTurn?.effectiveCwd?.trim() ||
      selectedSession?.cwdOverride?.trim() ||
      'not set';
    const model =
      sessionInfoTurn?.effectiveModel?.trim() ||
      selectedSession?.modelOverride?.trim() ||
      'runner default';
    const approval =
      sessionInfoTurn?.effectiveApprovalPolicy?.trim() ||
      selectedSession?.approvalPolicyOverride?.trim() ||
      'runner default';
    const sandbox =
      sessionInfoTurn?.effectiveSandbox?.trim() ||
      selectedSession?.sandboxOverride?.trim() ||
      'runner default';

    return { workspace, model, approval, sandbox };
  }, [sessionInfoTurn, selectedSession, selectedProject]);
  const displayedMessages = useMemo(() => {
    const base = messages.map((message) => ({ ...message, streaming: false }));
    if (assistantText.length === 0 || !streamBubbleTurnId) {
      return base;
    }

    return [
      ...base,
      {
        id: `stream-${streamBubbleTurnId}`,
        role: 'assistant' as const,
        content: assistantText,
        createdAt: new Date().toISOString(),
        streaming: streamActive,
      },
    ];
  }, [messages, assistantText, streamBubbleTurnId, streamActive]);
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
  const renderedDiffs = useMemo(() => {
    return diffSummaries.map((rawDiff, index) => ({
      id: `${index}-${rawDiff.length}`,
      files: parseDiff(rawDiff),
      rawDiff,
    }));
  }, [diffSummaries]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      stopTurnStatusPolling();
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
    if (!mounted || !authenticated) {
      return;
    }

    const prefix = newSessionCwdOverride.trim();
    if (!prefix) {
      setSessionCwdSuggestions([]);
      setSessionCwdSuggestionBusy(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSessionCwdSuggestionBusy(true);
      void apiRequest<{ data: string[] }>(
        `/api/fs/suggestions?${new URLSearchParams({ prefix, limit: '8' }).toString()}`,
        {
          method: 'GET',
          signal: controller.signal,
        },
      )
        .then((response) => {
          setSessionCwdSuggestions(response.data ?? []);
        })
        .catch((requestError) => {
          if (isAbortError(requestError)) {
            return;
          }
          setSessionCwdSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSessionCwdSuggestionBusy(false);
          }
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mounted, newSessionCwdOverride, authenticated]);

  useEffect(() => {
    if (!mounted || !authenticated || leftSidebarTab !== 'config') {
      return;
    }
    void loadAccountRateLimits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authenticated, leftSidebarTab]);

  useEffect(() => {
    const container = chatThreadRef.current;
    if (!container || !chatAtBottomRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [displayedMessages]);

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

  function handleChatScroll(): void {
    const container = chatThreadRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    chatAtBottomRef.current = distanceFromBottom <= 24;
  }

  async function loadAuthSession(): Promise<void> {
    try {
      const response = await apiRequest<AuthSessionResponse>('/api/auth/session', {
        method: 'GET',
      });
      if (response.authenticated) {
        setAuthenticated(true);
        setCurrentUserEmail(response.principal.email);
        setCurrentUserRole(response.principal.role);
        await loadAppSettings();
        if (response.principal.role === 'admin') {
          await loadAdminUsers();
        } else {
          setAdminUsers([]);
        }
        await loadAvailableModels();
        await loadProjects();
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
      setSelectedProjectId('');
      setSelectedSessionId('');
      setMessages([]);
      setTurns([]);
      setEventLog([]);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setDiffSummaries([]);
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
      const response = await apiRequest<AccountRateLimitsResponse>('/api/settings/account/rate-limits', {
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

  async function loadAvailableModels(): Promise<void> {
    try {
      const response = await apiRequest<{ data: AvailableModel[] }>('/api/models', {
        method: 'GET',
      });
      setAvailableModels(response.data ?? []);
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

  async function loadProjects(options?: { forceSelectFirst?: boolean }): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const items = (await apiRequest<Project[]>('/api/projects', {
        method: 'GET',
      })) as Project[];
      setProjects(items);
      const hasSelectedProject = items.some((item) => item.id === selectedProjectId);
      const shouldSelectFirst =
        options?.forceSelectFirst === true || !selectedProjectId || !hasSelectedProject;

      if (shouldSelectFirst && items[0]) {
        setSelectedProjectId(items[0].id);
        await loadSessions(items[0].id);
      } else if (shouldSelectFirst) {
        setSessions([]);
        setSelectedSessionId('');
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

  async function loadSessions(projectId: string): Promise<void> {
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
      if (items[0]) {
        setSelectedSessionId(items[0].id);
        await loadSessionHistory(items[0].id, {
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
        setDiffSummaries([]);
        setActiveTurnId('');
        setResumedTurnHint('');
        setTurnStatus('idle');
        setPendingApproval(null);
        setEventLog([]);
        setStreamBubbleTurnId('');
        setStreamActive(false);
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateProject(): Promise<boolean> {
    if (!newProjectName.trim()) {
      return false;
    }

    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<Project>('/api/projects', {
        method: 'POST',
        body: {
          name: newProjectName.trim(),
          ...(newProjectRepoPath.trim() ? { repoPath: newProjectRepoPath.trim() } : {}),
          ...(newProjectDefaultModel.trim() ? { defaultModel: newProjectDefaultModel.trim() } : {}),
          ...(newProjectDefaultSandbox.trim() ? { defaultSandbox: newProjectDefaultSandbox.trim() } : {}),
          ...(newProjectDefaultApprovalPolicy.trim()
            ? { defaultApprovalPolicy: newProjectDefaultApprovalPolicy.trim() }
            : {}),
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
          ...(newSessionCwdOverride.trim() ? { cwdOverride: newSessionCwdOverride.trim() } : {}),
          ...(newSessionModelOverride.trim() ? { modelOverride: newSessionModelOverride.trim() } : {}),
          ...(newSessionSandboxOverride.trim() ? { sandboxOverride: newSessionSandboxOverride.trim() } : {}),
          ...(newSessionApprovalPolicyOverride.trim()
            ? { approvalPolicyOverride: newSessionApprovalPolicyOverride.trim() }
            : {}),
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

  async function handleSendTurn(): Promise<void> {
    if (!canStartTurn && !canSteerTurn) {
      return;
    }

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

      setEventLog([]);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setDiffSummaries([]);
      setResumedTurnHint('');
      setTurnStatus('queued');
      setContextRemainingRatio(null);
      setStreamActive(true);

      const result = await apiRequest<{ turnId: string; status: string }>(`/api/sessions/${selectedSessionId}/turns`, {
        method: 'POST',
        body: { content: prompt.trim() },
      });

      setActiveTurnId(result.turnId);
      setStreamBubbleTurnId(result.turnId);
      setTurnStatus(result.status);
      await loadSessionHistory(selectedSessionId, {
        resumeStream: false,
        resetEventLog: false,
        resetInspectPanel: false,
      });
      openStream(result.turnId, selectedSessionId);
      setPrompt('');
    } catch (requestError) {
      setError(extractMessage(requestError));
      setTurnStatus('idle');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelTurn(): Promise<void> {
    if (!activeTurnId) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const cancelled = await apiRequest<{ status: string }>(`/api/turns/${activeTurnId}/cancel`, {
        method: 'POST',
      });
      setTurnStatus(cancelled.status);
      await loadSessionHistory(selectedSessionId, {
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
      setDiffSummaries([]);
      setActiveTurnId('');
      setResumedTurnHint('');
      setTurnStatus('idle');
      setContextRemainingRatio(null);
      setPendingApproval(null);
      setStreamBubbleTurnId('');
      setStreamActive(false);
      if (options.resetEventLog) {
        setEventLog([]);
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
        setDiffSummaries([]);
      }
      if (options.resetEventLog) {
        setEventLog([]);
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

    const appendEvent = (entry: string) => {
      setEventLog((current) => [...current, entry]);
    };

    STREAM_EVENTS.forEach((eventType) => {
      source.addEventListener(eventType, (evt) => {
        const message = evt as MessageEvent<string>;
        const envelope = JSON.parse(message.data) as StreamEnvelope;
        appendEvent(describeStreamEvent(envelope));

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
            setDiffSummaries((current) => mergeDiffSummaryHistory(current, summary));
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
          setPendingApproval(null);
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
      appendEvent('stream disconnected');
      source.close();
      eventSourceRef.current = null;
      if (turnId) {
        appendEvent('switching to turn status polling');
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
      await apiRequest<Project>(`/api/projects/${selectedProjectId}`, {
        method: 'PATCH',
        body: {
          name: projectConfigName.trim(),
          repoPath: projectConfigRepoPath.trim() || null,
          defaultModel: projectConfigDefaultModel.trim() || null,
          defaultSandbox: projectConfigDefaultSandbox.trim() || null,
          defaultApprovalPolicy: projectConfigDefaultApprovalPolicy.trim() || null,
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
    setSelectedProjectId(project.id);
    setProjectConfigName(project.name);
    setProjectConfigRepoPath(project.repoPath ?? '');
    setProjectConfigDefaultModel(project.defaultModel ?? '');
    setProjectConfigDefaultSandbox(project.defaultSandbox ?? '');
    setProjectConfigDefaultApprovalPolicy(project.defaultApprovalPolicy ?? '');
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
      setMobileInsightsOpen(true);
      return;
    }
    setRightSidebarMode((current) => (current === 'closed' ? 'pop' : 'closed'));
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
    setProjectConfigDefaultModel('');
    setProjectConfigDefaultSandbox('');
    setProjectConfigDefaultApprovalPolicy('');
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
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (busy || (!canStartTurn && !canSteerTurn)) {
      return;
    }
    void handleSendTurn();
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
                <span className="status-pill">{`context left ${formatPercent(contextRemainingRatio)}`}</span>
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
                    Default Model
                    <select
                      value={newProjectDefaultModel}
                      onChange={(event) => setNewProjectDefaultModel(event.target.value)}
                    >
                      <option value="">Use runner default</option>
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default Sandbox
                    <select
                      value={newProjectDefaultSandbox}
                      onChange={(event) => setNewProjectDefaultSandbox(event.target.value)}
                    >
                      {SANDBOX_OPTIONS.map((option) => (
                        <option key={`project-sandbox-${option.value || 'default'}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default Approval Policy
                    <select
                      value={newProjectDefaultApprovalPolicy}
                      onChange={(event) => setNewProjectDefaultApprovalPolicy(event.target.value)}
                    >
                      {APPROVAL_POLICY_OPTIONS.map((option) => (
                        <option key={`project-approval-${option.value || 'default'}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="sim-actions">
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
                  <label>
                    CWD Override
                    <div className="path-input-wrap">
                      <input
                        value={newSessionCwdOverride}
                        onFocus={() => setSessionPathInputFocused(true)}
                        onChange={(event) => setNewSessionCwdOverride(event.target.value)}
                        onBlur={(event) => {
                          setNewSessionCwdOverride(
                            applyDirectorySuggestionSelection(event.target.value, sessionCwdSuggestions),
                          );
                          setSessionPathInputFocused(false);
                        }}
                        list={disableNativePathDatalist ? undefined : SESSION_CWD_SUGGESTIONS_LIST_ID}
                      />
                      {disableNativePathDatalist && sessionPathInputFocused && sessionCwdSuggestions.length > 0 ? (
                        <div className="path-suggestions">
                          {sessionCwdSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              className="path-suggestion-item"
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setNewSessionCwdOverride(ensureTrailingSlash(suggestion));
                                setSessionPathInputFocused(true);
                              }}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {disableNativePathDatalist ? null : (
                      <datalist id={SESSION_CWD_SUGGESTIONS_LIST_ID}>
                        {sessionCwdSuggestions.map((suggestion) => (
                          <option key={suggestion} value={suggestion} />
                        ))}
                      </datalist>
                    )}
                    <span className="sim-input-hint">
                      {sessionCwdSuggestionBusy ? 'Loading suggestions…' : 'Directory suggestions by prefix.'}
                    </span>
                  </label>
                  <div className="sim-actions">
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
                    Default Model
                    <select
                      value={projectConfigDefaultModel}
                      onChange={(event) => setProjectConfigDefaultModel(event.target.value)}
                    >
                      <option value="">Use runner default</option>
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default Sandbox
                    <select
                      value={projectConfigDefaultSandbox}
                      onChange={(event) => setProjectConfigDefaultSandbox(event.target.value)}
                    >
                      {SANDBOX_OPTIONS.map((option) => (
                        <option key={`project-config-sandbox-${option.value || 'default'}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Default Approval Policy
                    <select
                      value={projectConfigDefaultApprovalPolicy}
                      onChange={(event) => setProjectConfigDefaultApprovalPolicy(event.target.value)}
                    >
                      {APPROVAL_POLICY_OPTIONS.map((option) => (
                        <option key={`project-config-approval-${option.value || 'default'}`} value={option.value}>
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
          <div className={shellGridClassName}>
            {leftSidebarMode !== 'closed' || mobileLeftSidebarOpen ? (
              <aside
                className={`left-sidebar ${mobileLeftSidebarOpen ? 'mobile-open' : `mode-${leftSidebarMode}`} ${
                  leftSidebarTab === 'config' ? 'config-fullscreen' : ''
                }`}
              >
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
                      className={`icon-button ${leftSidebarTab === 'config' ? 'tab-active' : ''}`}
                      aria-label="Config"
                      title="Config"
                      onClick={() => setLeftSidebarTab('config')}
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
                          {projects.map((project) => (
                            <li key={project.id}>
                              <div
                                className={`tree-row ${selectedProjectId === project.id ? 'active' : ''}`}
                                onClick={() => {
                                  setSelectedProjectId(project.id);
                                  void loadSessions(project.id);
                                  setMobileLeftSidebarOpen(false);
                                }}
                              >
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
                              {selectedProjectId === project.id ? (
                                <ul className="tree-children">
                                  {sessions.length === 0 ? <li className="tree-empty">No sessions</li> : null}
                                  {sessions.map((session) => (
                                    <li key={session.id}>
                                      <div
                                        className={`tree-row session-row ${selectedSessionId === session.id ? 'active' : ''}`}
                                        onClick={() => {
                                          setSelectedSessionId(session.id);
                                          void loadSessionHistory(session.id, {
                                            resumeStream: true,
                                            resetEventLog: true,
                                            resetInspectPanel: true,
                                          });
                                          setMobileLeftSidebarOpen(false);
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
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {leftSidebarTab === 'config' ? (
                      <div className="left-config-panel">
                        <h2>Config</h2>
                        <p>Signed in as: <strong>{currentUserEmail}</strong></p>
                        <h3>Rate Limits</h3>
                        {accountRateLimitsBusy ? <p>Loading account limits…</p> : null}
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
                {displayedMessages.map((message) => (
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
                      <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}>{message.content}</ReactMarkdown>
                    </div>
                  </article>
                ))}
              </div>

              {pendingApproval ? (
                <article className="sim-approval">
                  <h3>Approval Required</h3>
                  <p>
                    <strong>{formatApprovalKind(pendingApproval.kind)}</strong>
                    {typeof pendingApproval.payload.reason === 'string' && pendingApproval.payload.reason.length > 0
                      ? `: ${pendingApproval.payload.reason}`
                      : ''}
                  </p>
                  {pendingApproval.kind === 'command_execution' ? (
                    <>
                      {readApprovalCommand(pendingApproval.payload) ? (
                        <pre className="sim-approval-command">{readApprovalCommand(pendingApproval.payload)}</pre>
                      ) : null}
                      {typeof pendingApproval.payload.cwd === 'string' && pendingApproval.payload.cwd.length > 0 ? (
                        <p className="sim-approval-meta">
                          CWD: <code>{pendingApproval.payload.cwd}</code>
                        </p>
                      ) : null}
                    </>
                  ) : null}
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
                <div className="chat-composer-row">
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder="Send a message..."
                    rows={3}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    title={canSteerTurn ? 'Steer Current Turn' : 'Send'}
                    aria-label={canSteerTurn ? 'Steer Current Turn' : 'Send'}
                    onClick={() => void handleSendTurn()}
                    disabled={(!canStartTurn && !canSteerTurn) || busy}
                  >
                    <Send />
                  </button>
                </div>
              </div>
            </section> : null}

            {!configFullscreenActive && (rightSidebarMode !== 'closed' || mobileInsightsOpen) ? (
              <aside className={`insights-pane ${mobileInsightsOpen ? 'mobile-open' : `mode-${rightSidebarMode}`}`}>
                <div className="mobile-sidebar-head mobile-sidebar-head-right">
                  <button type="button" className="icon-button" onClick={() => closeRightSidebar()} aria-label="Close insights">
                    <EyeOff />
                  </button>
                </div>
                <div className="insights-tabs">
                  <button type="button" className={insightsTab === 'diff' ? 'tab-active' : ''} onClick={() => setInsightsTab('diff')}>
                    Diff
                  </button>
                  <button type="button" className={insightsTab === 'tools' ? 'tab-active' : ''} onClick={() => setInsightsTab('tools')}>
                    Tools
                  </button>
                  <button type="button" className={insightsTab === 'reasoning' ? 'tab-active' : ''} onClick={() => setInsightsTab('reasoning')}>
                    Reasoning
                  </button>
                  <button type="button" className={insightsTab === 'events' ? 'tab-active' : ''} onClick={() => setInsightsTab('events')}>
                    Events
                  </button>
                </div>
                <div className="insights-content">
                  {insightsTab === 'diff' ? (
                    <article className="sim-output">
                      <h3>Diff Summary</h3>
                      {diffSummaries.length === 0 ? <pre>No diff updates yet.</pre> : null}
                      {renderedDiffs.length > 0 ? (
                        <div className="diff-list">
                          {renderedDiffs.map((diff, diffIndex) => (
                            <section key={diff.id} className="diff-block">
                              <div className="diff-block-head">Diff #{diffIndex + 1}</div>
                              {diff.files.length === 0 ? <pre>{diff.rawDiff}</pre> : null}
                              {diff.files.length > 0 ? (
                                <div className="diff-rdv-shell">
                                  {diff.files.map((file, fileIndex) => (
                                    <div key={`diff-${diff.id}-file-${fileIndex}`} className="diff-file-block">
                                      <div className="diff-file-head">{formatDiffFileLabel(file)}</div>
                                      <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                                        {(hunks) => hunks.map((hunk, hunkIndex) => <Hunk key={hunkIndex} hunk={hunk} />)}
                                      </Diff>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </section>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ) : null}
                  {insightsTab === 'tools' ? (
                    <article className="sim-output">
                      <h3>Tool Output</h3>
                      <pre>{toolOutput || 'No tool output yet.'}</pre>
                    </article>
                  ) : null}
                  {insightsTab === 'reasoning' ? (
                    <>
                      <article className="sim-output">
                        <h3>Reasoning</h3>
                        <pre>{reasoningText || 'No reasoning deltas yet.'}</pre>
                      </article>
                      <article className="sim-output">
                        <h3>Latest Plan</h3>
                        <pre>{latestPlan || 'No plan updates yet.'}</pre>
                      </article>
                    </>
                  ) : null}
                  {insightsTab === 'events' ? (
                    <>
                      <article className="sim-events">
                        <h3>Event Timeline</h3>
                        <ul>
                          {eventLog.length === 0 ? <li>No events yet.</li> : null}
                          {eventLog.map((entry, index) => (
                            <li key={`${entry}-${index}`}>{entry}</li>
                          ))}
                        </ul>
                      </article>
                      <article className="sim-events">
                        <h3>Turn History</h3>
                        <ul>
                          {turns.length === 0 ? <li>No turns yet.</li> : null}
                          {turns.map((turn) => (
                            <li key={turn.id}>
                              <strong>{turn.status}</strong> {turn.id}
                            </li>
                          ))}
                        </ul>
                      </article>
                    </>
                  ) : null}
                </div>
                <div className={`session-info-wrap ${sessionInfoOpen ? 'open' : 'closed'}`}>
                  {sessionInfoOpen ? (
                    <article className="session-info-card">
                      <h3>Current Session</h3>
                      <dl>
                        <dt>Workspace</dt>
                        <dd>{resolvedSessionInfo.workspace}</dd>
                        <dt>Model</dt>
                        <dd>{resolvedSessionInfo.model}</dd>
                        <dt>Approval</dt>
                        <dd>{resolvedSessionInfo.approval}</dd>
                        <dt>Sandbox</dt>
                        <dd>{resolvedSessionInfo.sandbox}</dd>
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

function applyDirectorySuggestionSelection(value: string, suggestions: string[]): string {
  if (!value) {
    return value;
  }
  return suggestions.includes(value) ? ensureTrailingSlash(value) : value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
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

function describeStreamEvent(envelope: StreamEnvelope): string {
  if (envelope.type === 'thread.token_usage.updated') {
    const ratio = resolveRemainingContextRatio(envelope.payload);
    const suffix = ratio === null ? '' : `: ${formatPercent(ratio)} left`;
    return `#${envelope.seq} token usage updated${suffix}`;
  }

  if (envelope.type === 'plan.updated') {
    return `#${envelope.seq} plan updated`;
  }

  if (envelope.type === 'reasoning.delta') {
    return `#${envelope.seq} reasoning ${String(envelope.payload.kind ?? 'delta')}`;
  }

  if (envelope.type === 'diff.updated') {
    return `#${envelope.seq} diff updated`;
  }

  if (envelope.type === 'turn.approval.requested') {
    const kind = typeof envelope.payload.kind === 'string' ? envelope.payload.kind : 'approval';
    const reason =
      typeof envelope.payload.reason === 'string' && envelope.payload.reason.length > 0
        ? `: ${envelope.payload.reason}`
        : '';
    return `#${envelope.seq} ${formatApprovalKind(kind)} requested${reason}`;
  }

  if (envelope.type === 'turn.approval.resolved') {
    return `#${envelope.seq} approval ${String(envelope.payload.decision ?? 'resolved')}`;
  }

  if (envelope.type === 'tool.started' || envelope.type === 'tool.completed') {
    const title =
      typeof envelope.payload.title === 'string' && envelope.payload.title.length > 0
        ? envelope.payload.title
        : String(envelope.payload.kind ?? 'tool');
    return `#${envelope.seq} ${envelope.type.replace('tool.', 'tool ')}: ${title}`;
  }

  if (envelope.type === 'tool.output') {
    return `#${envelope.seq} tool output`;
  }

  return `#${envelope.seq} ${envelope.type}`;
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

function extract5hAndWeeklyLimits(response: AccountRateLimitsResponse): {
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

function mergeDiffSummaryHistory(current: string[], nextSummary: string): string[] {
  const next = nextSummary.trim();
  if (next.length === 0) {
    return current;
  }
  if (current.length === 0) {
    return [next];
  }

  const last = current[current.length - 1]?.trim() ?? '';
  if (last === next) {
    return current;
  }

  // Codex often emits cumulative snapshots; replace the prior entry rather than stacking near-duplicates.
  if ((last.length > 0 && next.includes(last)) || last.includes(next)) {
    return [...current.slice(0, -1), next];
  }

  return [...current, next];
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
