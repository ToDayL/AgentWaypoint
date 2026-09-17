'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, Plus, X } from 'lucide-react';
import { TerminalView } from './TerminalView';
import { requestId, terminalRequest, type TerminalInfo } from './terminal-client';
import { TERMINAL_MOBILE_QUERY, useTerminalLayout } from './use-terminal-layout';

export function TerminalPanel({
  sessionId,
  userKey,
  onHide,
}: {
  sessionId: string;
  userKey: string;
  onHide: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const mobile = useTerminalLayout(panel);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [height, setHeight] = useState(320);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [available, setAvailable] = useState(false);
  const alive = useRef(true);
  const instance = useRef('');
  const drag = useRef<{ y: number; height: number } | null>(null);
  const preference = `aw-terminal:${userKey}:${sessionId}`;
  const preferred = useRef('');
  const operation = useRef(false);
  const clamp = (value: number) =>
    Math.max(Math.min(160, window.innerHeight * 0.7), Math.min(value, window.innerHeight * 0.7));

  const load = useCallback(async () => {
    const result = await terminalRequest<{ apiInstanceId: string; terminals: TerminalInfo[] }>(
      `/api/sessions/${sessionId}/terminals`,
    );
    if (!alive.current) return;
    if (instance.current && instance.current !== result.apiInstanceId) {
      setError('API restarted; previous terminals have ended. Create a new terminal to continue.');
      preferred.current = '';
    }
    instance.current = result.apiInstanceId;
    setTerminals(result.terminals);
    setActiveId((id) =>
      result.terminals.some((item) => item.id === id)
        ? id
        : result.terminals.some((item) => item.id === preferred.current)
          ? preferred.current
          : ((result.terminals.find((item) => item.state === 'running') ?? result.terminals[0])
              ?.id ?? ''),
    );
    return result.terminals;
  }, [sessionId]);
  const refresh = useCallback(() => {
    void load().catch((error) => {
      if (alive.current) setError(String(error.message));
    });
  }, [load]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    try {
      preferred.current = localStorage.getItem(preference) ?? '';
      const saved = Number(localStorage.getItem(`aw-terminal-height:${userKey}`));
      const desktopHeight = saved > 0 ? saved : 320;
      setHeight(
        window.matchMedia(TERMINAL_MOBILE_QUERY).matches ? desktopHeight : clamp(desktopHeight),
      );
    } catch {}
    void (async () => {
      const capabilities = await terminalRequest<{ enabled: boolean; reason: string | null }>(
        '/api/terminals/capabilities',
      );
      if (cancelled) return;
      setAvailable(capabilities.enabled);
      if (!capabilities.enabled) throw new Error(capabilities.reason ?? 'Terminal unavailable');
      const terminal = await terminalRequest<TerminalInfo>(
        `/api/sessions/${sessionId}/terminals/ensure`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: requestId(),
            cols: 80,
            rows: 24,
            ...(preferred.current ? { preferredId: preferred.current } : {}),
          }),
        },
      );
      if (cancelled) return;
      instance.current = terminal.apiInstanceId;
      setActiveId(terminal.id);
      await load();
    })()
      .catch((error) => {
        if (!cancelled) setError(error.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    const polling = setInterval(refresh, 5000);
    const resize = () => {
      if (!window.matchMedia(TERMINAL_MOBILE_QUERY).matches) setHeight((current) => clamp(current));
    };
    window.addEventListener('resize', resize);
    return () => {
      cancelled = true;
      alive.current = false;
      clearInterval(polling);
      window.removeEventListener('resize', resize);
    };
  }, [sessionId, userKey, preference, load, refresh]);

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(preference, activeId);
    } catch {}
  }, [activeId, preference]);
  useEffect(() => {
    if (mobile) return;
    try {
      localStorage.setItem(`aw-terminal-height:${userKey}`, String(height));
    } catch {}
  }, [height, userKey, mobile]);

  async function create() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const terminal = await terminalRequest<TerminalInfo>(`/api/sessions/${sessionId}/terminals`, {
        method: 'POST',
        body: JSON.stringify({ requestId: requestId(), cols: 80, rows: 24 }),
      });
      if (!alive.current) return;
      instance.current = terminal.apiInstanceId;
      setActiveId(terminal.id);
      await load();
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function close(id: string) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      await terminalRequest<void>(`/api/terminals/${id}`, { method: 'DELETE' });
      const remaining = await load();
      if (alive.current && remaining?.length === 0) onHide();
    } catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : String(error));
        refresh();
      }
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const active = terminals.find((terminal) => terminal.id === activeId);
  return (
    <section
      ref={panel}
      className="terminal-panel"
      style={{ '--terminal-desktop-height': `${height}px` } as CSSProperties}
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile ? true : undefined}
      aria-label="Session terminal"
    >
      <div
        className="terminal-resize"
        role="separator"
        aria-label="Resize terminal panel"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-valuenow={Math.round(height)}
        aria-valuemin={Math.min(160, height)}
        aria-valuemax={Math.round(typeof window === 'undefined' ? 800 : window.innerHeight * 0.7)}
        onPointerDown={(event) => {
          drag.current = { y: event.clientY, height };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - event.clientY));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            setHeight(clamp(height + (event.key === 'ArrowUp' ? 20 : -20)));
          }
        }}
      />
      <div className="terminal-toolbar">
        <button
          type="button"
          className="icon-button terminal-back"
          title="Back to chat (keeps terminals running)"
          aria-label="Back to chat"
          onClick={onHide}
        >
          <ArrowLeft size={20} />
        </button>
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {terminals.map((terminal) => (
            <div
              key={terminal.id}
              className={`terminal-tab ${terminal.id === activeId ? 'is-active' : ''}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={terminal.id === activeId}
                onClick={() => setActiveId(terminal.id)}
                title={terminal.initialCwd}
              >
                {terminal.title}
                {terminal.state !== 'running' ? ` · ${terminal.state}` : ''}
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={`Close ${terminal.title}`}
                title="Terminate this terminal and its tasks"
                disabled={busy}
                onClick={() => void close(terminal.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          title="New terminal"
          aria-label="New terminal"
          disabled={busy || !available}
          onClick={() => void create()}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="icon-button terminal-hide"
          title="Hide panel (does not immediately close terminals)"
          aria-label="Hide terminal panel"
          onClick={onHide}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {error ? (
        <div className="terminal-error" role="alert">
          {error}
        </div>
      ) : null}
      {active ? (
        <TerminalView key={active.id} terminal={active} refresh={refresh} />
      ) : (
        <div className="terminal-empty">
          {busy ? 'Opening terminal…' : 'No terminal running.'}
          {!busy && available ? (
            <button type="button" onClick={() => void create()}>
              New terminal
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
