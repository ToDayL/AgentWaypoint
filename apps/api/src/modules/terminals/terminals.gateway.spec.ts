import 'reflect-metadata';
import { createServer, type IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalsGateway } from './terminals.gateway';
import type { TerminalsService } from './terminals.service';
import type { AuthService } from '../auth/auth.service';
import type { TerminalNetwork } from './terminal-network';

const gateways: TerminalsGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.onModuleDestroy();
  vi.restoreAllMocks();
});

function setup() {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const auth = { resolveRequestPrincipal: vi.fn().mockResolvedValue(null) };
  const network = {
    check: vi.fn().mockReturnValue({ origin: 'http://localhost:3000' }),
  };
  const gateway = new TerminalsGateway(
    {} as TerminalsService,
    auth as unknown as AuthService,
    network as unknown as TerminalNetwork,
  );
  gateways.push(gateway);
  const server = createServer();
  gateway.install(server);
  const socket = new Socket();
  const request = (url: string) =>
    ({
      url,
      headers: {},
      socket: { remoteAddress: '192.0.2.1' },
    }) as IncomingMessage;
  return { server, socket, request, auth, warn };
}

describe('WebSocket upgrade connection errors', () => {
  it.each(['/', '/api/terminals/socket/'])(
    'closes unsupported upgrade %s and tolerates a peer reset',
    (pathname) => {
      const { server, socket, request, auth, warn } = setup();
      server.emit('upgrade', request(`${pathname}?ticket=do-not-log`), socket, Buffer.alloc(0));
      expect(socket.destroyed).toBe(true);
      expect(auth.resolveRequestPrincipal).not.toHaveBeenCalled();
      expect(() =>
        socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('192.0.2.1'));
      expect(warn.mock.calls.flat().join(' ')).not.toContain('do-not-log');
    },
  );

  it('handles a peer reset while authentication is pending', async () => {
    const { server, socket, request, auth } = setup();
    let finishAuth!: (value: null) => void;
    auth.resolveRequestPrincipal.mockReturnValue(
      new Promise((resolve) => {
        finishAuth = resolve;
      }),
    );
    server.emit('upgrade', request('/api/terminals/socket'), socket, Buffer.alloc(0));
    expect(auth.resolveRequestPrincipal).toHaveBeenCalledOnce();
    expect(() => socket.emit('error', new Error('read ECONNRESET'))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    finishAuth(null);
    await Promise.resolve();
    await Promise.resolve();
  });
});
