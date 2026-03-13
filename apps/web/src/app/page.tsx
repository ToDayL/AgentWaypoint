'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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
const WORKSPACE_SUGGESTIONS_LIST_ID = 'workspace-path-suggestions';
const SESSION_CWD_SUGGESTIONS_LIST_ID = 'session-cwd-path-suggestions';
type LeftSidebarTab = 'explorer' | 'user' | 'admin';
type InsightsTab = 'diff' | 'tools' | 'reasoning' | 'events';
type ActionPanelMode =
  | 'closed'
  | 'menu'
  | 'createProject'
  | 'createSession'
  | 'projectConfig'
  | 'confirmDeleteProject'
  | 'confirmDeleteSession';

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState('');
  const [currentUserRole, setCurrentUserRole] = useState<'admin' | 'user'>('user');
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>({ turnSteerEnabled: false });
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [newProjectName, setNewProjectName] = useState('Simulation Workspace');
  const [newProjectRepoPath, setNewProjectRepoPath] = useState('');
  const [workspaceSuggestions, setWorkspaceSuggestions] = useState<string[]>([]);
  const [workspaceSuggestionBusy, setWorkspaceSuggestionBusy] = useState(false);
  const [newProjectDefaultModel, setNewProjectDefaultModel] = useState('');
  const [newProjectDefaultSandbox, setNewProjectDefaultSandbox] = useState('');
  const [newProjectDefaultApprovalPolicy, setNewProjectDefaultApprovalPolicy] = useState('');
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
  const [diffSummary, setDiffSummary] = useState('');
  const [activeTurnId, setActiveTurnId] = useState('');
  const [resumedTurnHint, setResumedTurnHint] = useState('');
  const [turnStatus, setTurnStatus] = useState('idle');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [leftSidebarTab, setLeftSidebarTab] = useState<LeftSidebarTab>('explorer');
  const [insightsOpen, setInsightsOpen] = useState(true);
  const [insightsTab, setInsightsTab] = useState<InsightsTab>('diff');
  const [actionPanelMode, setActionPanelMode] = useState<ActionPanelMode>('closed');
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const turnPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canStartTurn = !!selectedSessionId && prompt.trim().length > 0 && activeTurnId === '';
  const canSteerTurn =
    appSettings.turnSteerEnabled && !!activeTurnId && prompt.trim().length > 0 && pendingApproval === null;
  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId),
    [projects, selectedProjectId],
  );
  const selectedSession = useMemo(
    () => sessions.find((item) => item.id === selectedSessionId),
    [sessions, selectedSessionId],
  );
  const isAdmin = currentUserRole === 'admin';

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
    if (!mounted || !authenticated) {
      return;
    }

    const prefix = newProjectRepoPath.trim();
    if (!prefix) {
      setWorkspaceSuggestions([]);
      setWorkspaceSuggestionBusy(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setWorkspaceSuggestionBusy(true);
      void apiRequest<{ data: string[] }>(
        `/api/sim/fs/suggestions?${new URLSearchParams({ prefix, limit: '8' }).toString()}`,
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
  }, [mounted, newProjectRepoPath, authenticated]);

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
        `/api/sim/fs/suggestions?${new URLSearchParams({ prefix, limit: '8' }).toString()}`,
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

  async function loadAuthSession(): Promise<void> {
    try {
      const response = await apiRequest<AuthSessionResponse>('/api/sim/auth/session', {
        method: 'GET',
      });
      if (response.authenticated) {
        setAuthenticated(true);
        setCurrentUserEmail(response.principal.email);
        setCurrentUserRole(response.principal.role);
        await loadAppSettings();
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
      await apiRequest<{ user: { email: string } }>('/api/sim/auth/login/password', {
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
      await apiRequest<{ success: boolean }>('/api/sim/auth/logout', {
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
      setDiffSummary('');
      setActiveTurnId('');
      setResumedTurnHint('');
      setTurnStatus('idle');
      setPendingApproval(null);
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function loadAppSettings(): Promise<void> {
    try {
      const response = await apiRequest<AppSettings>('/api/sim/settings', {
        method: 'GET',
      });
      setAppSettings({ turnSteerEnabled: !!response.turnSteerEnabled });
    } catch (requestError) {
      setError(extractMessage(requestError));
    }
  }

  async function loadAvailableModels(): Promise<void> {
    try {
      const response = await apiRequest<{ data: AvailableModel[] }>('/api/sim/models', {
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
      const items = (await apiRequest<Project[]>('/api/sim/projects', {
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

  async function handleTurnSteerToggle(enabled: boolean): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const response = await apiRequest<AppSettings>('/api/sim/settings', {
        method: 'POST',
        body: { turnSteerEnabled: enabled },
      });
      setAppSettings({ turnSteerEnabled: !!response.turnSteerEnabled });
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
      const items = (await apiRequest<Session[]>(`/api/sim/projects/${projectId}/sessions`, {
        method: 'GET',
      })) as Session[];
      setSessions(items);
      if (items[0]) {
        setSelectedSessionId(items[0].id);
        await loadSessionHistory(items[0].id, { resumeStream: true, resetEventLog: true });
      } else {
        setSelectedSessionId('');
        setMessages([]);
        setAssistantText('');
        setReasoningText('');
        setLatestPlan('');
        setToolOutput('');
        setDiffSummary('');
        setActiveTurnId('');
        setResumedTurnHint('');
        setTurnStatus('idle');
        setPendingApproval(null);
        setEventLog([]);
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateProject(): Promise<boolean> {
    if (!newProjectName.trim() || !newProjectRepoPath.trim()) {
      return false;
    }

    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<Project>('/api/sim/projects', {
        method: 'POST',
        body: {
          name: newProjectName.trim(),
          repoPath: newProjectRepoPath.trim(),
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
      const created = await apiRequest<Session>(`/api/sim/projects/${selectedProjectId}/sessions`, {
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
      await loadSessionHistory(created.id, { resumeStream: true, resetEventLog: true });
      return true;
    } catch (requestError) {
      setError(extractMessage(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleForkSession(): Promise<void> {
    if (!selectedSessionId || !selectedProjectId || activeTurnId) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const forked = await apiRequest<Session>(`/api/sim/sessions/${selectedSessionId}/fork`, {
        method: 'POST',
        body: {},
      });
      await loadSessions(selectedProjectId);
      setSelectedSessionId(forked.id);
      await loadSessionHistory(forked.id, { resumeStream: true, resetEventLog: true });
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
        await apiRequest<TurnStatusResponse>(`/api/sim/turns/${activeTurnId}/steer`, {
          method: 'POST',
          body: { content: steerContent },
        });
        setMessages((current) => [
          ...current,
          {
            id: `steer-${Date.now()}`,
            role: 'user',
            content: steerContent,
            createdAt: new Date().toISOString(),
          },
        ]);
        setPrompt('');
        return;
      }

      setEventLog([]);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setDiffSummary('');
      setResumedTurnHint('');
      setTurnStatus('queued');

      const result = await apiRequest<{ turnId: string; status: string }>(`/api/sim/sessions/${selectedSessionId}/turns`, {
        method: 'POST',
        body: { content: prompt.trim() },
      });

      setActiveTurnId(result.turnId);
      setTurnStatus(result.status);
      await loadSessionHistory(selectedSessionId, { resumeStream: false, resetEventLog: false });
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
      const cancelled = await apiRequest<{ status: string }>(`/api/sim/turns/${activeTurnId}/cancel`, {
        method: 'POST',
      });
      setTurnStatus(cancelled.status);
      await loadSessionHistory(selectedSessionId, { resumeStream: false, resetEventLog: false });
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
      await apiRequest<TurnStatusResponse>(`/api/sim/turns/${activeTurnId}/approval`, {
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
    options: { resumeStream: boolean; resetEventLog: boolean },
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
      setDiffSummary('');
      setActiveTurnId('');
      setResumedTurnHint('');
      setTurnStatus('idle');
      setPendingApproval(null);
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
      const history = await apiRequest<SessionHistory>(`/api/sim/sessions/${sessionId}/history`, {
        method: 'GET',
      });
      setMessages(history.messages);
      setTurns(history.turns);
      setTurnStatus(history.activeTurnStatus ?? 'idle');
      setActiveTurnId(history.activeTurnId ?? '');
      setPendingApproval(null);
      setAssistantText('');
      setReasoningText('');
      setLatestPlan('');
      setToolOutput('');
      setDiffSummary('');
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
    const status = await apiRequest<TurnStatusResponse>(`/api/sim/turns/${turnId}`, {
      method: 'GET',
    });
    setTurnStatus(status.status);
    setPendingApproval(status.pendingApproval);
    if (status.status === 'failed' && status.failureMessage) {
      setError(status.failureMessage);
    }
  }

  function openStream(turnId: string, sessionId: string): void {
    eventSourceRef.current?.close();
    const streamUrl = `/api/sim/turns/${turnId}/stream`;
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

        if (envelope.type === 'tool.output') {
          const delta = envelope.payload.text;
          if (typeof delta === 'string') {
            setToolOutput((current) => current + delta);
          }
        }

        if (envelope.type === 'diff.updated') {
          setDiffSummary(formatDiffPayload(envelope.payload));
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
          setActiveTurnId('');
          setResumedTurnHint('');
          setPendingApproval(null);
          setReasoningText('');
          stopTurnStatusPolling();
            if (sessionId) {
              void loadSessionHistory(sessionId, { resumeStream: false, resetEventLog: false });
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
          const status = await apiRequest<TurnStatusResponse>(`/api/sim/turns/${turnId}`, {
            method: 'GET',
          });
          setTurnStatus(status.status);
          setPendingApproval(status.pendingApproval);
          if (status.status === 'failed' && status.failureMessage) {
            setError(status.failureMessage);
          }
          if (TERMINAL_TURN_STATUSES.has(status.status)) {
            stopTurnStatusPolling();
            setActiveTurnId('');
            setResumedTurnHint('');
            setPendingApproval(null);
            setReasoningText('');
            if (sessionId) {
              await loadSessionHistory(sessionId, { resumeStream: false, resetEventLog: false });
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
      setActionPanelMode('closed');
    }
  }

  async function handleCreateSessionFromPanel(): Promise<void> {
    const created = await handleCreateSession();
    if (created) {
      setActionPanelMode('closed');
    }
  }

  function requestProjectDelete(project: Project): void {
    setProjectDeleteTarget(project);
    setSessionDeleteTarget(null);
    setActionPanelMode('confirmDeleteProject');
  }

  function requestSessionDelete(session: Session): void {
    setSessionDeleteTarget(session);
    setProjectDeleteTarget(null);
    setActionPanelMode('confirmDeleteSession');
  }

  function closeActionPanel(): void {
    setActionPanelMode('closed');
    setProjectDeleteTarget(null);
    setSessionDeleteTarget(null);
  }

  async function handleConfirmDelete(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      if (actionPanelMode === 'confirmDeleteProject' && projectDeleteTarget) {
        const deletingSelectedProject = selectedProjectId === projectDeleteTarget.id;
        await apiRequest(`/api/sim/projects/${projectDeleteTarget.id}`, {
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
        await apiRequest(`/api/sim/sessions/${sessionDeleteTarget.id}`, {
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

  return (
    <main className="sim-shell">
      <section className="sim-panel">
        <header className="sim-header shell-header">
          <div>
            <p className="sim-kicker">AgentWaypoint</p>
            <h1>Production UI Refactor</h1>
            <p className="sim-subtitle">
              {authenticated
                ? 'Left explorer + center chat + toggleable right insights.'
                : 'Sign in to access project and session workspace.'}
            </p>
          </div>
          {authenticated ? (
            <div className="header-actions">
              <button type="button" className="button-secondary" onClick={() => setInsightsOpen((value) => !value)}>
                {insightsOpen ? 'Hide Insights' : 'Show Insights'}
              </button>
            </div>
          ) : null}
          {authenticated ? (
            <div className="action-anchor">
              <button type="button" className="action-plus" onClick={() => setActionPanelMode('menu')}>
                +
              </button>
            </div>
          ) : null}
          {authenticated && actionPanelMode !== 'closed' ? (
            <div className="action-panel">
              {actionPanelMode === 'menu' ? (
                <div className="action-panel-body">
                  <h3>Actions</h3>
                  <button type="button" onClick={() => setActionPanelMode('createProject')}>
                    Create Project
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionPanelMode('createSession')}
                    disabled={!selectedProjectId}
                  >
                    Create Session
                  </button>
                  <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                    Close
                  </button>
                </div>
              ) : null}
              {actionPanelMode === 'createProject' ? (
                <div className="action-panel-body">
                  <h3>Create Project</h3>
                  <label>
                    Name
                    <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} />
                  </label>
                  <label>
                    Workspace Path
                    <input
                      value={newProjectRepoPath}
                      onChange={(event) =>
                        setNewProjectRepoPath(
                          applyDirectorySuggestionSelection(event.target.value, workspaceSuggestions),
                        )
                      }
                      list={WORKSPACE_SUGGESTIONS_LIST_ID}
                    />
                    <datalist id={WORKSPACE_SUGGESTIONS_LIST_ID}>
                      {workspaceSuggestions.map((suggestion) => (
                        <option key={suggestion} value={suggestion} />
                      ))}
                    </datalist>
                    <span className="sim-input-hint">
                      {workspaceSuggestionBusy ? 'Loading suggestions…' : 'Directory suggestions by prefix.'}
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
                    <input
                      value={newSessionCwdOverride}
                      onChange={(event) =>
                        setNewSessionCwdOverride(
                          applyDirectorySuggestionSelection(event.target.value, sessionCwdSuggestions),
                        )
                      }
                      list={SESSION_CWD_SUGGESTIONS_LIST_ID}
                    />
                    <datalist id={SESSION_CWD_SUGGESTIONS_LIST_ID}>
                      {sessionCwdSuggestions.map((suggestion) => (
                        <option key={suggestion} value={suggestion} />
                      ))}
                    </datalist>
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
                  <p className="sim-subtitle">Project config UI shell is ready. API wiring comes in next step.</p>
                  <button type="button" className="button-secondary" onClick={() => closeActionPanel()}>
                    Close
                  </button>
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
          <div className="shell-grid">
            <aside className="left-sidebar">
              <div className="sidebar-tabs">
                <button
                  type="button"
                  className={leftSidebarTab === 'explorer' ? 'tab-active' : ''}
                  onClick={() => setLeftSidebarTab('explorer')}
                >
                  Explorer
                </button>
                <button
                  type="button"
                  className={leftSidebarTab === 'user' ? 'tab-active' : ''}
                  onClick={() => setLeftSidebarTab('user')}
                >
                  User Config
                </button>
                {isAdmin ? (
                  <button
                    type="button"
                    className={leftSidebarTab === 'admin' ? 'tab-active' : ''}
                    onClick={() => setLeftSidebarTab('admin')}
                  >
                    Admin Config
                  </button>
                ) : null}
              </div>

              {leftSidebarTab === 'explorer' ? (
                <div className="explorer-tree">
                  <div className="tree-actions-top">
                    <button type="button" onClick={() => setActionPanelMode('createProject')}>
                      + Project
                    </button>
                    <button type="button" className="button-secondary" onClick={() => void loadProjects()}>
                      Refresh
                    </button>
                  </div>
                  <ul className="tree-root">
                    {projects.map((project) => (
                      <li key={project.id}>
                        <div
                          className={`tree-row ${selectedProjectId === project.id ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedProjectId(project.id);
                            void loadSessions(project.id);
                          }}
                        >
                          <span className="tree-label">{project.name}</span>
                          <div className="row-actions">
                            <button
                              type="button"
                              title="Create Session"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedProjectId(project.id);
                                setActionPanelMode('createSession');
                              }}
                            >
                              +S
                            </button>
                            <button
                              type="button"
                              title="Project Config"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedProjectId(project.id);
                                setActionPanelMode('projectConfig');
                              }}
                            >
                              Cfg
                            </button>
                            <button
                              type="button"
                              title="Remove Project"
                              onClick={(event) => {
                                event.stopPropagation();
                                requestProjectDelete(project);
                              }}
                            >
                              Del
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
                                    void loadSessionHistory(session.id, { resumeStream: true, resetEventLog: true });
                                  }}
                                >
                                  <span className="tree-label">{session.title}</span>
                                  <div className="row-actions">
                                    <button
                                      type="button"
                                      title="Remove Session"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        requestSessionDelete(session);
                                      }}
                                    >
                                      Del
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

              {leftSidebarTab === 'user' ? (
                <div className="sim-card">
                  <h2>User Config</h2>
                  <p>Signed in as: <strong>{currentUserEmail}</strong></p>
                  <label>
                    <span>Turn Steering</span>
                    <input
                      type="checkbox"
                      checked={appSettings.turnSteerEnabled}
                      onChange={(event) => void handleTurnSteerToggle(event.target.checked)}
                      disabled={busy}
                    />
                  </label>
                  <button type="button" className="button-secondary" onClick={() => void handleLogout()} disabled={busy}>
                    Sign Out
                  </button>
                </div>
              ) : null}

              {leftSidebarTab === 'admin' && isAdmin ? (
                <div className="sim-card">
                  <h2>Admin Config</h2>
                  <p className="sim-subtitle">Admin controls UI shell is ready for next backend wiring step.</p>
                </div>
              ) : null}
            </aside>

            <section className="chat-pane">
              <div className="chat-pane-head">
                <h2>{selectedSession?.title ?? 'Select a session'}</h2>
                <p>
                  Project: <strong>{selectedProject?.name ?? '-'}</strong> | CWD:{' '}
                  <strong>{selectedSession?.cwdOverride ?? selectedProject?.repoPath ?? '-'}</strong> | Status:{' '}
                  <span className="status-pill">{turnStatus}</span>
                </p>
                {resumedTurnHint ? <p>{resumedTurnHint}</p> : null}
              </div>

              <article className="sim-output chat-stream">
                <h3>Assistant Stream</h3>
                <pre>{assistantText || 'No active stream output.'}</pre>
              </article>

              <article className="sim-events chat-history">
                <h3>Chat History</h3>
                <ul>
                  {messages.length === 0 ? <li>No messages yet.</li> : null}
                  {messages.map((message) => (
                    <li key={message.id}>
                      <strong>{message.role}:</strong> {message.content}
                    </li>
                  ))}
                </ul>
              </article>

              {pendingApproval ? (
                <article className="sim-approval">
                  <h3>Approval Required</h3>
                  <p>
                    <strong>{formatApprovalKind(pendingApproval.kind)}</strong>
                    {typeof pendingApproval.payload.reason === 'string' && pendingApproval.payload.reason.length > 0
                      ? `: ${pendingApproval.payload.reason}`
                      : ''}
                  </p>
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

              <label>
                Prompt
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Send a prompt to start a turn..."
                  rows={4}
                />
              </label>
              <div className="sim-actions">
                <button
                  type="button"
                  onClick={() => void handleSendTurn()}
                  disabled={(!canStartTurn && !canSteerTurn) || busy}
                >
                  {canSteerTurn ? 'Steer Current Turn' : 'Start Turn'}
                </button>
                <button type="button" onClick={() => void handleCancelTurn()} disabled={!activeTurnId || busy}>
                  Cancel Turn
                </button>
              </div>
              <button type="button" className="button-secondary" onClick={() => void handleForkSession()} disabled={busy || !selectedSessionId || !!activeTurnId}>
                Fork Session
              </button>
            </section>

            {insightsOpen ? (
              <aside className="insights-pane">
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
                {insightsTab === 'diff' ? (
                  <article className="sim-output">
                    <h3>Diff Summary</h3>
                    <pre>{diffSummary || 'No diff updates yet.'}</pre>
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
    headers: {
      'content-type': 'application/json',
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: input.signal,
  });

  const text = await response.text();
  const jsonPayload = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    throw new Error(extractApiMessage(jsonPayload, `Request failed (${response.status})`));
  }
  return jsonPayload as T;
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
