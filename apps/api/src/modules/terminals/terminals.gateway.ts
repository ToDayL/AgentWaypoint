import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { TerminalsService } from './terminals.service';
import { TerminalNetwork } from './terminal-network';

const dimensions = {
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
};
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(32768) }),
  z.object({ type: z.literal('inputBinary'), data: z.string().max(32768) }),
  z.object({ type: z.literal('resize'), ...dimensions }),
  z.object({ type: z.literal('takeControl') }),
  z.object({ type: z.literal('ack'), seq: z.number().int().nonnegative() }),
]);
type Ticket = {
  userId: string;
  terminalId: string;
  origin: string;
  cookieHash: string;
  expires: number;
};

@Injectable()
export class TerminalsGateway implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalsGateway.name);
  private readonly tickets = new Map<string, Ticket>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  private server?: Server;
  private policyRevision = '';
  private stopped = false;

  constructor(
    @Inject(TerminalsService) private readonly terminals: TerminalsService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TerminalNetwork) private readonly network: TerminalNetwork,
  ) {}

  ticket(userId: string, terminalId: string, request: IncomingMessage) {
    const entry = this.terminals.get(userId, terminalId);
    if (!['running', 'exited'].includes(entry.meta.state))
      throw new Error('Terminal is not attachable');
    const { origin } = this.network.check(request.headers);
    const now = Date.now();
    for (const [key, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(key);
    const revision = JSON.stringify(this.network.effective());
    if (revision !== this.policyRevision) {
      this.tickets.clear();
      this.policyRevision = revision;
    }
    if (this.tickets.size >= 4096) throw new Error('Too many pending terminal connections');
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      userId,
      terminalId,
      origin,
      cookieHash: this.cookieHash(request),
      expires: now + 30_000,
    });
    return {
      ticket,
      apiInstanceId: this.terminals.apiInstanceId,
      expiresAt: new Date(now + 30_000).toISOString(),
    };
  }

  private cookieHash(request: IncomingMessage) {
    return createHash('sha256')
      .update(request.headers.cookie ?? '')
      .digest('hex');
  }

  install(server: Server): void {
    this.server = server;
    server.on('upgrade', this.upgrade);
  }

  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (request.url?.split('?')[0] !== '/api/terminals/socket') return;
    socket.on('error', () => {});
    void (async () => {
      const context = this.network.check(request.headers);
      const principal = await this.auth.resolveRequestPrincipal({ headers: request.headers });
      if (!principal || principal.authMethod !== 'session' || socket.destroyed)
        throw new Error('Authentication required');
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.connection(ws, request, principal.userId, context.origin),
      );
    })().catch((error) => {
      this.logger.warn(
        `Terminal upgrade rejected: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
    });
  };

  private connection(
    ws: WebSocket,
    request: IncomingMessage,
    userId: string,
    origin: string,
  ): void {
    const peerId = randomUUID();
    let terminalId: string | null = null;
    let attaching = false;
    let alive = true;
    let checking = false;
    let pendingOutput = 0;
    const outstanding = new Map<number, number>();
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const payload = JSON.stringify(message);
      if (message.type === 'output' && typeof message.seq === 'number') {
        outstanding.set(message.seq, Buffer.byteLength(payload));
        pendingOutput += Buffer.byteLength(payload);
      }
      if (ws.bufferedAmount > 1024 * 1024 || pendingOutput > 1024 * 1024) {
        ws.close(1013, 'Output backlog; reconnect for a snapshot');
        return;
      }
      ws.send(payload);
    };
    const timeout = setTimeout(() => ws.close(1008, 'Attach timeout'), 5000);
    const unwatch = this.auth.onSessionRevoked({ headers: request.headers }, () => {
      for (const [key, ticket] of this.tickets)
        if (ticket.cookieHash === this.cookieHash(request)) this.tickets.delete(key);
      ws.close(1008, 'Login session revoked');
    });
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      if (checking) return;
      checking = true;
      void (async () => {
        this.network.check(request.headers);
        const principal = await this.auth.resolveRequestPrincipal({ headers: request.headers });
        if (!principal || principal.userId !== userId) ws.close(1008, 'Authentication expired');
      })()
        .catch(() => ws.close(1008, 'Access revoked'))
        .finally(() => {
          checking = false;
        });
    }, 25_000);
    heartbeat.unref();
    ws.on('message', (raw) => {
      void (async () => {
        const message = JSON.parse(raw.toString());
        if (!terminalId) {
          if (attaching || message.type !== 'attach' || typeof message.ticket !== 'string')
            throw new Error('Attach is required');
          attaching = true;
          if (JSON.stringify(this.network.effective()) !== this.policyRevision) {
            this.tickets.clear();
            throw new Error('Origin policy changed');
          }
          const ticket = this.tickets.get(message.ticket);
          this.tickets.delete(message.ticket);
          if (
            !ticket ||
            ticket.expires <= Date.now() ||
            ticket.userId !== userId ||
            ticket.origin !== origin ||
            ticket.cookieHash !== this.cookieHash(request)
          )
            throw new Error('Invalid attach ticket');
          this.network.check(request.headers);
          terminalId = ticket.terminalId;
          await this.terminals.attach(userId, terminalId, {
            id: peerId,
            send,
            disconnect: () => ws.close(1000, 'Terminal exited'),
          });
          clearTimeout(timeout);
          if (ws.readyState !== WebSocket.OPEN) this.terminals.detach(userId, terminalId, peerId);
          return;
        }
        const input = clientMessage.parse(message);
        if (input.type === 'input') this.terminals.input(userId, terminalId, peerId, input.data);
        if (input.type === 'inputBinary')
          this.terminals.input(userId, terminalId, peerId, Buffer.from(input.data, 'base64'));
        if (input.type === 'resize')
          this.terminals.resize(userId, terminalId, peerId, input.cols, input.rows);
        if (input.type === 'takeControl') this.terminals.takeControl(userId, terminalId, peerId);
        if (input.type === 'ack')
          for (const [seq, size] of outstanding)
            if (seq <= input.seq) {
              pendingOutput -= size;
              outstanding.delete(seq);
            }
      })().catch((error) => {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Terminal protocol error',
        });
        ws.close(1008, 'Terminal protocol error');
      });
    });
    const detach = () => {
      unwatch();
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (terminalId) this.terminals.detach(userId, terminalId, peerId);
    };
    ws.on('error', detach);
    ws.on('close', detach);
  }

  onModuleDestroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.server?.off('upgrade', this.upgrade);
    this.tickets.clear();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

export { dimensions };
