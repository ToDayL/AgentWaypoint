'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Project = {
  id: string;
  name: string;
  createdAt: string;
};

type Session = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

type StreamEnvelope = {
  turnId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

const STREAM_EVENTS = [
  'turn.started',
  'assistant.delta',
  'tool.started',
  'tool.output',
  'tool.completed',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
];

export default function HomePage() {
  const [email, setEmail] = useState('demo@codexpanel.local');
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [newProjectName, setNewProjectName] = useState('Simulation Workspace');
  const [newSessionTitle, setNewSessionTitle] = useState('First Simulation Session');
  const [prompt, setPrompt] = useState('');
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [assistantText, setAssistantText] = useState('');
  const [activeTurnId, setActiveTurnId] = useState('');
  const [turnStatus, setTurnStatus] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);

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
    };
  }, []);

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      } else {
        setSelectedSessionId('');
      }
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateProject(): Promise<void> {
    if (!newProjectName.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<Project>('/api/sim/projects', {
        method: 'POST',
        email,
        body: { name: newProjectName.trim() },
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
    setTurnStatus('queued');

    try {
      const result = await apiRequest<{ turnId: string; status: string }>(`/api/sim/sessions/${selectedSessionId}/turns`, {
        method: 'POST',
        email,
        body: { content: prompt.trim() },
      });

      setActiveTurnId(result.turnId);
      setTurnStatus(result.status);
      openStream(result.turnId);
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
    } catch (requestError) {
      setError(extractMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  function openStream(turnId: string): void {
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
        appendEvent(`#${envelope.seq} ${envelope.type}`);

        if (envelope.type === 'assistant.delta') {
          const delta = envelope.payload.text;
          if (typeof delta === 'string') {
            setAssistantText((current) => current + delta);
          }
        }

        if (envelope.type === 'turn.started') {
          setTurnStatus('running');
        }

        if (envelope.type === 'turn.completed' || envelope.type === 'turn.failed' || envelope.type === 'turn.cancelled') {
          setTurnStatus(envelope.type.replace('turn.', ''));
          setActiveTurnId('');
          source.close();
          eventSourceRef.current = null;
        }
      });
    });

    source.onerror = () => {
      appendEvent('stream disconnected');
      source.close();
      eventSourceRef.current = null;
      setActiveTurnId('');
    };
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
            <button type="button" onClick={() => void handleCreateProject()} disabled={busy}>
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
              <select value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
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
              Status: <span className="status-pill">{turnStatus}</span>
            </p>
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

          <article className="sim-output">
            <h3>Assistant Stream</h3>
            <pre>{assistantText || 'Waiting for stream output...'}</pre>
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
