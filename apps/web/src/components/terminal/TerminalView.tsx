'use client';

import { useEffect, useRef, useState } from 'react';
import { terminalRequest, terminalSocketUrl, type TerminalInfo } from './terminal-client';

export function TerminalView({
  terminal,
  refresh,
}: {
  terminal: TerminalInfo;
  refresh: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [readOnly, setReadOnly] = useState(true);

  useEffect(() => {
    let disposed = false;
    let ended = terminal.state === 'exited';
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let resizing: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let destroy = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !container.current) return;
      const xterm = new Terminal({
        cols: terminal.cols,
        rows: terminal.rows,
        scrollback: 2000,
        fontSize: 13,
        // Sans-serif monospace preserves terminal cell alignment without Courier's serifs.
        fontFamily:
          'Consolas, "SF Mono", Menlo, Monaco, "DejaVu Sans Mono", "Noto Sans Mono", monospace',
        cursorBlink: true,
        disableStdin: true,
        screenReaderMode: true,
        theme: { background: '#10151c', foreground: '#dde5ef' },
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(container.current);
      let ready = false;
      let writer = false;
      let connectionId = '';
      let sequence = 0;
      const send = (message: unknown) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      };
      const fitAndResize = () => {
        if (
          disposed ||
          !ready ||
          !writer ||
          !container.current?.clientHeight ||
          !container.current.clientWidth
        )
          return;
        const dimensions = fit.proposeDimensions();
        if (!dimensions) return;
        const cols = Math.max(2, Math.min(500, dimensions.cols));
        const rows = Math.max(1, Math.min(200, dimensions.rows));
        xterm.resize(cols, rows);
        send({ type: 'resize', cols, rows });
      };
      const observer = new ResizeObserver(() => {
        clearTimeout(resizing);
        resizing = setTimeout(fitAndResize, 80);
      });
      observer.observe(container.current);
      const input = xterm.onData((data) => {
        if (!ready || !writer || ended) return;
        // Avoid splitting UTF-16 surrogate pairs when chunking large pastes.
        let chunk = '';
        for (const char of data) {
          chunk += char;
          if (chunk.length >= 8192) {
            send({ type: 'input', data: chunk });
            chunk = '';
          }
        }
        if (chunk) send({ type: 'input', data: chunk });
      });
      const binary = xterm.onBinary((data) => {
        if (ready && writer && !ended) send({ type: 'inputBinary', data: btoa(data) });
      });
      async function connect() {
        if (disposed) return;
        ready = false;
        writer = false;
        xterm.options.disableStdin = true;
        setReadOnly(true);
        setStatus(retry ? 'Reconnecting… Input is disabled.' : 'Connecting…');
        try {
          const attached = await terminalRequest<{ ticket: string; apiInstanceId: string }>(
            `/api/terminals/${terminal.id}/attach`,
            { method: 'POST', body: '{}' },
          );
          if (disposed) return;
          if (attached.apiInstanceId !== terminal.apiInstanceId) {
            ended = true;
            setStatus('API restarted; this terminal has ended.');
            refresh();
            return;
          }
          const socket = new WebSocket(terminalSocketUrl(window.location));
          socketRef.current = socket;
          socket.onopen = () =>
            socket.send(JSON.stringify({ type: 'attach', ticket: attached.ticket }));
          socket.onmessage = (event) => {
            if (disposed || socketRef.current !== socket) return;
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'ready') {
                connectionId = message.connectionId;
                writer = message.writerId === connectionId;
                ended = message.terminal.state === 'exited';
              } else if (message.type === 'snapshot') {
                sequence = message.seq;
                xterm.reset();
                xterm.resize(message.cols, message.rows);
                xterm.write(message.data, () => {
                  if (
                    disposed ||
                    socketRef.current !== socket ||
                    socket.readyState !== WebSocket.OPEN
                  )
                    return;
                  ready = true;
                  retry = 0;
                  setReadOnly(!writer || ended);
                  xterm.options.disableStdin = !writer || ended;
                  setStatus(ended ? 'Exited' : writer ? '' : 'Read-only');
                  fitAndResize();
                  if (writer && !ended) xterm.focus();
                });
              } else if (message.type === 'output') {
                if (message.seq !== sequence + 1) {
                  socket.close();
                  return;
                }
                sequence = message.seq;
                xterm.write(message.data, () => {
                  if (socket.readyState === WebSocket.OPEN)
                    socket.send(JSON.stringify({ type: 'ack', seq: message.seq }));
                });
              } else if (message.type === 'resized') {
                if (message.seq !== sequence + 1) {
                  socket.close();
                  return;
                }
                sequence = message.seq;
                xterm.resize(message.cols, message.rows);
              } else if (message.type === 'controlChanged') {
                writer = message.writerId === connectionId;
                setReadOnly(!writer);
                xterm.options.disableStdin = !writer || !ready || ended;
                setStatus(writer ? '' : 'Read-only');
                if (writer) {
                  fitAndResize();
                  xterm.focus();
                }
              } else if (message.type === 'closing') {
                ended = true;
                writer = false;
                xterm.options.disableStdin = true;
                setReadOnly(true);
                setStatus('Closing…');
              } else if (message.type === 'exit') {
                ended = true;
                writer = false;
                xterm.options.disableStdin = true;
                setReadOnly(true);
                setStatus(
                  message.terminal.closeReason === 'unattached_timeout'
                    ? 'Closed after 12 hours without a connection'
                    : `Exited${message.terminal.exitCode === undefined ? '' : ` (${message.terminal.exitCode})`}`,
                );
                refresh();
              } else if (message.type === 'error') setStatus(message.message);
            } catch {
              socket.close(1002, 'Invalid terminal message');
            }
          };
          socket.onclose = () => {
            if (disposed || socketRef.current !== socket) return;
            ready = false;
            writer = false;
            xterm.options.disableStdin = true;
            setReadOnly(true);
            if (!ended) {
              setStatus('Disconnected. Input is disabled.');
              reconnect = setTimeout(
                () => void connect(),
                Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5)),
              );
            }
          };
          socket.onerror = () => socket.close();
        } catch (error) {
          if (disposed) return;
          setStatus(error instanceof Error ? error.message : 'Unable to connect');
          if (!ended)
            reconnect = setTimeout(
              () => {
                refresh();
                void connect();
              },
              Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5)),
            );
        }
      }
      destroy = () => {
        observer.disconnect();
        input.dispose();
        binary.dispose();
        xterm.dispose();
      };
      await connect();
    })().catch((error) => {
      if (!disposed) setStatus(String(error));
    });
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      clearTimeout(resizing);
      socketRef.current?.close();
      socketRef.current = null;
      destroy();
    };
  }, [terminal.id, terminal.apiInstanceId, refresh]);

  return (
    <>
      {status || (readOnly && terminal.state === 'running') ? (
        <div className="terminal-status" role="status">
          <span>{status}</span>
          {readOnly && terminal.state === 'running' ? (
            <button
              type="button"
              onClick={() =>
                socketRef.current?.readyState === WebSocket.OPEN &&
                socketRef.current.send(JSON.stringify({ type: 'takeControl' }))
              }
            >
              Take control
            </button>
          ) : null}
        </div>
      ) : null}
      <div ref={container} className="terminal-viewport" aria-label="Remote terminal" />
    </>
  );
}
