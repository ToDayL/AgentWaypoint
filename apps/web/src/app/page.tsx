'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Project = {
  id: string;
  name: string;
  repoPath?: string | null;
  createdAt: string;
};

type Session = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
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

const STREAM_EVENTS = [
  'turn.started',
  'assistant.delta',
  'turn.approval.requested',
  'turn.approval.resolved',
  'tool.started',
  'tool.output',
  'tool.completed',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
];
const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [email, setEmail] = useState('demo@codexpanel.local');
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [newProjectName, setNewProjectName] = useState('Simulation Workspace');
  const [newProjectRepoPath, setNewProjectRepoPath] = useState('');
  const [newSessionTitle, setNewSessionTitle] = useState('First Simulation Session');
  const [prompt, setPrompt] = useState('');
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantText, setAssistantText] = useState('');
  const [activeTurnId, setActiveTurnId] = useState('');
  const [resumedTurnHint, setResumedTurnHint] = useState('');
  const [turnStatus, setTurnStatus] = useState('idle');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const turnPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canSendTurn = !!selectedSessionId && prompt.trim().length > 0 && activeTurnId === '';
  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId),
    [projects, selectedProjectId],
  );
  const selectedSession = useMemo(
    () => sessions.find((item) => item.id === selectedSessionId),
    [sessions, selectedSessionId],
  );

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
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!mounted) {
    return (
      <main className="sim-shell">
        <section className="sim-panel">
          <header className="sim-header">
            <p className="sim-kicker">CodexPanel Simulation</p>
            <h1>Web Interface MVP</h1>
            <p className="sim-subtitle">Loading…</p>
          </header>
        </section>
      </main>
    );
  }

  async function loadProjects(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const items = (await apiRequest<Project[]>('/api/sim/projects', {
        method: 'GET',
        email,
      })) as Project[];
      setProjects(items);
      if (!selectedProjectId && items[0]) {
        setSelectedProjectId(items[0].id);
        await loadSessions(items[0].id);
      }
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
        email,
      })) as Session[];
      setSessions(items);
      if (items[0]) {
        setSelectedSessionId(items[0].id);
        await loadSessionHistory(items[0].id, { resumeStream: true });
      } else {
        setSelectedSessionId('');
        setMessages([]);
        setAssistantText('');
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

  async function handleCreateProject(): Promise<void> {
    if (!newProjectName.trim() || !newProjectRepoPath.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<Project>('/api/sim/projects', {
        method: 'POST',
        email,
        body: { name: newProjectName.trim(), repoPath: newProjectRepoPath.trim() },
      });
      await loadProjects();
      setSelectedProjectId(created.id);
      await loadSessions(created.id);
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSession(): Promise<void> {
    if (!selectedProjectId || !newSessionTitle.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<Session>(`/api/sim/projects/${selectedProjectId}/sessions`, {
        method: 'POST',
        email,
        body: { title: newSessionTitle.trim() },
      });
      await loadSessions(selectedProjectId);
      setSelectedSessionId(created.id);
      await loadSessionHistory(created.id, { resumeStream: true });
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleSendTurn(): Promise<void> {
    if (!canSendTurn) {
      return;
    }

    setBusy(true);
    setError('');
    setEventLog([]);
    setAssistantText('');
    setResumedTurnHint('');
    setTurnStatus('queued');

    try {
      const result = await apiRequest<{ turnId: string; status: string }>(`/api/sim/sessions/${selectedSessionId}/turns`, {
        method: 'POST',
        email,
        body: { content: prompt.trim() },
      });

      setActiveTurnId(result.turnId);
      setTurnStatus(result.status);
      await loadSessionHistory(selectedSessionId, { resumeStream: false });
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
        email,
      });
      setTurnStatus(cancelled.status);
      await loadSessionHistory(selectedSessionId, { resumeStream: false });
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveApproval(decision: 'approve' | 'reject'): Promise<void> {
    if (!activeTurnId || !pendingApproval) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await apiRequest<TurnStatusResponse>(`/api/sim/turns/${activeTurnId}/approval`, {
        method: 'POST',
        email,
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

  async function loadSessionHistory(sessionId: string, options: { resumeStream: boolean }): Promise<void> {
    if (!sessionId) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      stopTurnStatusPolling();
      setMessages([]);
      setAssistantText('');
      setActiveTurnId('');
      setResumedTurnHint('');
      setTurnStatus('idle');
      setPendingApproval(null);
      setEventLog([]);
      return;
    }

    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    stopTurnStatusPolling();
    setError('');
    try {
      const history = await apiRequest<SessionHistory>(`/api/sim/sessions/${sessionId}/history`, {
        method: 'GET',
        email,
      });
      setMessages(history.messages);
      setTurnStatus(history.activeTurnStatus ?? 'idle');
      setActiveTurnId(history.activeTurnId ?? '');
      setPendingApproval(null);
      setAssistantText('');
      setEventLog([]);
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
      email,
    });
    setTurnStatus(status.status);
    setPendingApproval(status.pendingApproval);
    if (status.status === 'failed' && status.failureMessage) {
      setError(status.failureMessage);
    }
  }

  function openStream(turnId: string, sessionId: string): void {
    eventSourceRef.current?.close();
    const streamUrl = `/api/sim/turns/${turnId}/stream?email=${encodeURIComponent(email)}`;
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
          stopTurnStatusPolling();
          if (sessionId) {
            void loadSessionHistory(sessionId, { resumeStream: false });
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
            email,
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
            if (sessionId) {
              await loadSessionHistory(sessionId, { resumeStream: false });
            }
          }
        } catch (requestError) {
          setError(extractMessage(requestError));
        }
      })();
    }, 1200);
  }

  return (
    <main className="sim-shell">
      <section className="sim-panel">
        <header className="sim-header">
          <p className="sim-kicker">CodexPanel Simulation</p>
          <h1>Web Interface MVP</h1>
          <p className="sim-subtitle">Project/session setup + mock turn streaming through the real API surface.</p>
        </header>

        <div className="sim-grid">
          <aside className="sim-card">
            <h2>Identity</h2>
            <label>
              User Email
              <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
            </label>
            <button type="button" onClick={() => void loadProjects()} disabled={busy}>
              Refresh Projects
            </button>
          </aside>

          <aside className="sim-card">
            <h2>Projects</h2>
            <label>
              New Project
              <input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="Project name"
              />
            </label>
            <label>
              Workspace Path
              <input
                value={newProjectRepoPath}
                onChange={(event) => setNewProjectRepoPath(event.target.value)}
                placeholder="/absolute/path/to/repo"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleCreateProject()}
              disabled={busy || !newProjectName.trim() || !newProjectRepoPath.trim()}
            >
              Create Project
            </button>
            <label>
              Current Project
              <select
                value={selectedProjectId}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedProjectId(value);
                  void loadSessions(value);
                }}
              >
                <option value="">Select a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </aside>

          <aside className="sim-card">
            <h2>Sessions</h2>
            <label>
              New Session
              <input
                value={newSessionTitle}
                onChange={(event) => setNewSessionTitle(event.target.value)}
                placeholder="Session title"
              />
            </label>
            <button type="button" onClick={() => void handleCreateSession()} disabled={busy || !selectedProjectId}>
              Create Session
            </button>
            <label>
              Current Session
              <select
                value={selectedSessionId}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedSessionId(value);
                  void loadSessionHistory(value, { resumeStream: true });
                }}
              >
                <option value="">Select a session</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
          </aside>
        </div>

        <section className="sim-chat">
          <div className="sim-chat-head">
            <h2>Turn Simulation</h2>
            <p>
              Project: <strong>{selectedProject?.name ?? '-'}</strong> | Session:{' '}
              <strong>{selectedSession?.title ?? '-'}</strong>
            </p>
            <p>
              Workspace: <strong>{selectedProject?.repoPath ?? '-'}</strong>
            </p>
            <p>
              Status: <span className="status-pill">{turnStatus}</span>
            </p>
            {resumedTurnHint ? <p>{resumedTurnHint}</p> : null}
          </div>

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
            <button type="button" onClick={() => void handleSendTurn()} disabled={!canSendTurn || busy}>
              Start Turn
            </button>
            <button type="button" onClick={() => void handleCancelTurn()} disabled={!activeTurnId || busy}>
              Cancel Turn
            </button>
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
              {typeof pendingApproval.payload.command === 'string' && pendingApproval.payload.command.length > 0 ? (
                <pre>{pendingApproval.payload.command}</pre>
              ) : null}
              {typeof pendingApproval.payload.cwd === 'string' && pendingApproval.payload.cwd.length > 0 ? (
                <p>
                  Working directory: <code>{pendingApproval.payload.cwd}</code>
                </p>
              ) : null}
              <div className="sim-actions sim-actions-approval">
                <button type="button" onClick={() => void handleResolveApproval('approve')} disabled={busy}>
                  Approve
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void handleResolveApproval('reject')}
                  disabled={busy}
                >
                  Reject
                </button>
              </div>
            </article>
          ) : null}

          <article className="sim-output">
            <h3>Assistant Stream</h3>
            <pre>{assistantText || 'No active stream output.'}</pre>
          </article>

          <article className="sim-events">
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

          <article className="sim-events">
            <h3>Event Timeline</h3>
            <ul>
              {eventLog.length === 0 ? <li>No events yet.</li> : null}
              {eventLog.map((entry, index) => (
                <li key={`${entry}-${index}`}>{entry}</li>
              ))}
            </ul>
          </article>
        </section>

        {error ? <p className="sim-error">{error}</p> : null}
      </section>
    </main>
  );
}

async function apiRequest<T>(
  path: string,
  input: { method: 'GET' | 'POST'; email: string; body?: Record<string, unknown> },
): Promise<T> {
  const response = await fetch(path, {
    method: input.method,
    headers: {
      'content-type': 'application/json',
      'x-user-email': input.email,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
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

  return `#${envelope.seq} ${envelope.type}`;
}
