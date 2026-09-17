import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';

export function isTerminalPath(value: string): boolean {
  return /^\/api\/(?:terminals(?:\/|$)|sessions\/[^/]+\/terminals(?:\/|$))/.test(value);
}

export function terminalProxyHeaders(request: NextRequest): Record<string, string> {
  if (!process.env.AGENTWAYPOINT_HOME)
    throw new Error('Set AGENTWAYPOINT_HOME to the same isolated home as the API');
  const key = fs
    .readFileSync(path.join(process.env.AGENTWAYPOINT_HOME, 'run', 'terminal-ingress.key'), 'utf8')
    .trim();
  // Reconstruct instead of forwarding browser-supplied x-aw-* headers.
  return {
    'x-aw-terminal-key': key,
    'x-aw-terminal-external-origin': new URL(
      `${request.nextUrl.protocol}//${request.headers.get('host')}`,
    ).origin,
    ...(request.headers.get('origin') ? { origin: request.headers.get('origin')! } : {}),
  };
}
